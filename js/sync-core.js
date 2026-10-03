(function (root) {
  /* 同步引擎：一台设备一份「基准」，云端一份清单，两边对基准做减法。
       清单 index.json：每个单元记 rev（单调递增）和 hash，用 rev 判新旧——
                        比时间戳可靠，设备时钟不准也不会判反。
       单元内容     ：每个文件（含每篇笔记正文）单独加密后存一个对象，
                        改动哪个推哪个，不用整包重写。
       冲突         ：本地改过 + 远端也改过 = 冲突。本地这版赢（用户刚在这台机器上改的），
                        远端那版落地成「冲突副本」，绝不静默丢数据。
     同步失败只影响同步本身，本地读写照常；这里的报错不会冒泡到页面。 */

  const STATE_FILE = "sync-state.json";   // 本机基准，不参与同步
  const DEBOUNCE_MS = 3000;
  const INDEX_VERSION = 1;
  const CAS_RETRY = 3;
  // 进页面时的预热同步：距上次「成功」同步不足这么久、本机又没有待推的改动，就整轮跳过。
  // 切页 / 刷新本来就不产生改动，这一轮只会白读一次云端清单；超过窗口照常同步一次。
  const IDLE_SYNC_MS = 30 * 1000;

  // files.json 不在这里：它指向 files/ 里的二进制本体，那些不上云，
  // 同步过去只会得到一堆打不开的卡片。
  // deepseek.json 也不在：那是本机查余额留下的缓存，每台设备各查各的，
  // 同步过去没有意义，还会因为两边都在写而反复产生冲突副本。
  const JSON_UNITS = ["todos.json", "reports.json", "notes.json", "recipes.json", "ledger.json", "software.json", "vault.json", "charts.json", "chart-settings.json"];
  const META_UNIT = "meta.json";          // 只同步项目清单，本机路径（工具、git 根目录）不外传
  // 记谱偏好只上云「人」的那两个字段（擅长和弦、推荐调权重），音量是设备属性，各留各的
  const CHART_SETTINGS_UNIT = "chart-settings.json";

  let state = null;
  let remote = null;
  let applying = false;
  let running = false;
  let timer = null;
  let listeners = [];
  let attachedVisible = false;   // 「回到页面时补一次同步」的监听只挂一次

  const status = {
    state: "off",        // off 未配置 / locked 待解锁 / syncing / ok / dirty / error
    message: "",
    // 失败时的机器可读标记：目前只有 key-mismatch（本机这把密钥对不上云端那份密文）。
    // 面板靠它把「用同步密码对上云端」的入口显示出来，不用去猜文案。
    code: "",
    lastSyncAt: "",
    pending: 0,
    conflicts: 0,
    deviceId: ""
  };

  function emit() {
    const snapshot = Object.assign({}, status);
    listeners.forEach((fn) => {
      try {
        fn(snapshot);
      } catch (err) {
        /* 监听方自己出错不影响别人 */
      }
    });
  }

  function setStatus(patch) {
    Object.assign(status, patch);
    emit();
  }

  function shortId() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID().slice(0, 8);
    return Math.random().toString(36).slice(2, 10);
  }

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await root.crypto.subtle.digest("SHA-256", bytes);
    return Array.prototype.map
      .call(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /* ===== 本机基准 ===== */

  async function loadState() {
    if (state) return state;
    let parsed = null;
    try {
      const text = await root.Workbench.readText(STATE_FILE);
      if (text && text.trim()) parsed = JSON.parse(text);
    } catch (err) {
      parsed = null;
    }
    state = {
      version: 1,
      deviceId: (parsed && parsed.deviceId) || shortId(),
      lastSyncAt: (parsed && parsed.lastSyncAt) || "",
      // 只记「成功」的那次：失败也吃节流的话，网络一恢复反而要等窗口过期才会重试
      lastOkAt: (parsed && parsed.lastOkAt) || "",
      // 最近一次失败也存：健康度面板靠它归类（网络 / 凭证 / 权限），刷新页面后不该消失
      lastError: (parsed && parsed.lastError) || null,
      base: (parsed && parsed.base && typeof parsed.base === "object") ? parsed.base : {},
      conflicts: Array.isArray(parsed && parsed.conflicts) ? parsed.conflicts : []
    };
    status.deviceId = state.deviceId;
    return state;
  }

  // 两个标签页各持一份内存基准（loadState 有缓存），整份覆盖写会互相冲掉对方的冲突记录：
  // 结果是磁盘上留着 .conflict-*.json，面板里却看不到、也删不掉。
  // 写之前先跟磁盘对一次：把别的标签页写进去的记录补进来；
  // 本页记着、但副本文件已经不在了的（用户在别处删掉的）跟着去掉——
  // 否则老标签页一保存就会把它写回来，面板上留一条点开是空的记录。
  async function mergeConflictsFromDisk() {
    if (!state || !root.Workbench || !root.Workbench.fs) return;
    let parsed = null;
    try {
      const text = await root.Workbench.readText(STATE_FILE);
      if (text && text.trim()) parsed = JSON.parse(text);
    } catch (err) {
      return;   // 读不出来就照本页这份写，最多退回老行为
    }
    if (!parsed || !Array.isArray(parsed.conflicts)) return;
    const kept = [];
    for (const item of state.conflicts) {
      if (!item || !item.path) continue;
      let exists = true;
      try {
        exists = (await root.Workbench.readText(item.path)) != null;
      } catch (err) {
        exists = true;   // 读不出（权限之类的）不等于文件没了，保守留下
      }
      if (exists) kept.push(item);
    }
    const seen = Object.create(null);
    kept.forEach((item) => {
      seen[item.path] = true;
    });
    parsed.conflicts.forEach((item) => {
      if (item && item.path && !seen[item.path]) kept.push(item);
    });
    state.conflicts = kept;
  }

  async function saveState() {
    await mergeConflictsFromDisk();
    const wasApplying = applying;
    applying = true;
    try {
      await root.Workbench.writeText(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
    } catch (err) {
      /* 基准写不进去最多影响下次多推一点，不影响使用 */
    } finally {
      applying = wasApplying;
    }
  }

  /* ===== 单元 ===== */

  function isUnit(path) {
    if (JSON_UNITS.indexOf(path) >= 0 || path === META_UNIT) return true;
    return /^notes\/[^/]+\.md$/.test(path);
  }

  async function localUnits() {
    const paths = JSON_UNITS.concat([META_UNIT]);
    let notes = [];
    try {
      notes = await root.Workbench.fs.list("notes/");
    } catch (err) {
      notes = [];
    }
    return paths.concat(notes.filter((path) => /\.md$/.test(path)));
  }

  // 面板「同步范围」里的中文名：路径 → 用户看得懂的名字
  const UNIT_INFO = {
    "todos.json": { label: "待办" },
    "reports.json": { label: "周报" },
    "notes.json": { label: "笔记索引" },
    "recipes.json": { label: "菜谱" },
    "ledger.json": { label: "记账" },
    "software.json": { label: "软件号" },
    "vault.json": { label: "资料库（加密）" },
    "charts.json": { label: "记谱" },
    "chart-settings.json": { label: "记谱偏好（擅长和弦、推荐调权重）" },
    "meta.json": { label: "项目清单（只同步项目名）" }
  };

  function unitLabel(path) {
    return UNIT_INFO[path] ? UNIT_INFO[path].label : path;
  }

  // meta.json 只带可移植字段上云：项目清单和「示例菜谱已灌过」标记
  function projectMeta(text) {
    if (text == null) return null;
    try {
      const meta = JSON.parse(text);
      return JSON.stringify({
        version: 1,
        projects: Array.isArray(meta.projects) ? meta.projects : [],
        recipesSeeded: !!meta.recipesSeeded
      });
    } catch (err) {
      return null;
    }
  }

  // 记谱偏好只带「人」的那一半上云：擅长和弦、推荐调权重。
  // 音量是设备属性——手机和电脑该各留各的，同步过去只会互相覆盖。
  // 这样算出的 hash 也不会因为调了一下音量就判定「本地改过」而白推一次。
  function portableChartSettings(text) {
    if (text == null) return null;
    try {
      const raw = JSON.parse(text);
      return JSON.stringify({
        favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
        weight: Number(raw.weight) || 0
      });
    } catch (err) {
      return null;
    }
  }

  // 拉回来的记谱偏好只盖那两个字段，音量保持本机这份
  async function applyChartSettings(text) {
    let incoming = null;
    try {
      incoming = JSON.parse(text);
    } catch (err) {
      return;   // 云端这份解不开就跳过，别把整轮同步带崩
    }
    const current = await root.Workbench.readText(CHART_SETTINGS_UNIT);
    let settings = {};
    if (current && current.trim()) {
      try {
        settings = JSON.parse(current);
      } catch (err) {
        settings = {};
      }
    }
    if (Array.isArray(incoming.favorites)) settings.favorites = incoming.favorites;
    if (incoming.weight != null) settings.weight = Number(incoming.weight) || 0;
    await root.Workbench.writeText(CHART_SETTINGS_UNIT, JSON.stringify(settings, null, 2) + "\n");
  }

  async function unitText(path) {
    const raw = await root.Workbench.readText(path);
    if (raw == null) return null;
    if (path === META_UNIT) return projectMeta(raw);
    if (path === CHART_SETTINGS_UNIT) return portableChartSettings(raw);
    return raw;
  }

  async function applyUnit(path, text) {
    if (path === META_UNIT) return applyMeta(text);
    if (path === CHART_SETTINGS_UNIT) return applyChartSettings(text);
    await root.Workbench.writeText(path, text);
  }

  // 拉取落地之后，拿「本机重新读回来的内容」跟「云端条目声明的 hash」对一次，
  // 对得上才返回哈希，对不上返回 null。
  //
  // 这一步是这台设备会不会「假装同步成功」的分水岭：基准里的 hash 记的是本机读回来的那份，
  // 以前不管落地成没成，都把新 rev 一起记进去。于是只要有一次落地没生效（写没进去、
  // 或者下载拿到的是缓存里的旧密文），这台设备就被钉死在「rev 最新、内容却是旧的」上——
  // 之后每一轮都算「没变化」，面板一直显示「已同步 / 云端不领先」，用户却永远看不到
  // 另一台设备新加的东西（手机端就是这么拿着 4.2 KB 的旧待办，对着 7.6 KB 的云端说已同步）。
  // 宁可返回 null：基准不动 = 下一轮还会再拉一次，问题不会被这份坏基准永久掩盖。
  async function landedHash(path, expected) {
    const back = await unitText(path);
    const hash = back == null ? null : await sha256(back);
    if (expected && hash !== expected) return null;
    return hash;
  }

  // 上面那种情况给一句人话。它最容易被当成「同步好了」——面板一切正常，数据却是旧的，
  // 所以要说清楚本机这份没被动过，以及下一轮还会再试。
  function staleMessage(paths) {
    if (!paths || !paths.length) return "";
    return paths.length + " 项从云端拉下来了，却没能在本机落地（" +
      paths.slice(0, 3).join("、") + (paths.length > 3 ? " 等" : "") +
      "）：本机这一份保持原样，下次同步会再试";
  }

  async function applyMeta(text) {
    const incoming = JSON.parse(text);
    const current = await root.Workbench.readText(META_UNIT);
    let meta = {};
    if (current && current.trim()) {
      try {
        meta = JSON.parse(current);
      } catch (err) {
        meta = {};
      }
    }
    if (Array.isArray(incoming.projects) && incoming.projects.length) meta.projects = incoming.projects;
    if (incoming.recipesSeeded) meta.recipesSeeded = true;
    await root.Workbench.writeText(META_UNIT, JSON.stringify(meta, null, 2) + "\n");
    if (root.Workbench.meta) {
      if (meta.projects) root.Workbench.meta.projects = meta.projects;
      if (meta.recipesSeeded) root.Workbench.meta.recipesSeeded = true;
    }
  }

  /* ===== 冲突副本 ===== */

  // 默认值那种空壳：合并 / 覆盖时不算「有内容」，不用为它留副本
  function isBlankUnit(text) {
    const trimmed = String(text == null ? "" : text).trim();
    return trimmed === "" || trimmed === "[]" || trimmed === "{}";
  }

  async function saveConflict(path, text, fromDevice) {
    const at = new Date().toISOString();
    const stamp = at.replace(/[:.]/g, "-").slice(0, 19);
    const label = fromDevice ? String(fromDevice).slice(0, 8) : "另一台设备";
    let record;
    if (/^notes\/[^/]+\.md$/.test(path)) {
      const id = root.Workbench.uid();
      const index = await root.Workbench.loadNoteIndex();
      const base = index.find((item) => item.id === path.slice(6, -3));
      const title = ((base && base.title) || "笔记") + `（冲突副本 · ${label}）`;
      index.unshift({
        id,
        title,
        kind: (base && base.kind) || "note",
        project: (base && base.project) || "",
        pinned: false,
        deletedAt: "",
        updatedAt: at
      });
      await root.Workbench.saveNoteIndex(index);
      await root.Workbench.writeText(`notes/${id}.md`, text);
      record = { path: `notes/${id}.md`, from: path, title, at };
    } else {
      const name = String(path).replace(/\.json$/, "") + ".conflict-" + stamp + ".json";
      await root.Workbench.writeText(name, text);
      record = { path: name, from: path, title: path, at };
    }
    state.conflicts.unshift(record);
    return record;
  }

  /* ===== 远端读写 ===== */

  function objectKey(path) {
    // 云存储的 key 不允许出现 "%"：整条路径 encodeURIComponent 会把分隔符 "/" 也变成 "%2F"，
    // 服务端按 key 的字符集校验时一律回 STORAGE_INVALID_KEY（上传/下载/删除全废，清单却不受影响，
    // 因为 index.json、probe.json 这些固定路径不含需要转义的字符，所以配置探测能过、一推数据才炸）。
    // 只对每一段单独编码、把 "/" 留作路径分隔符，段内的空格等特殊字符照样会被转义。
    return String(path || "")
      .replace(/^\/+/, "")
      .split("/")
      .filter((seg) => seg !== "")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
  }

  function emptyIndex() {
    return { version: INDEX_VERSION, updatedAt: "", files: {} };
  }

  async function fetchUnit(path) {
    const text = await remote.getObject(objectKey(path));
    if (text == null) return null;
    const payload = await root.SyncCrypto.open(text);
    return payload && typeof payload.text === "string" ? payload.text : null;
  }

  async function pushUnit(path, text, hash, baseRev) {
    const rev = (baseRev || 0) + 1;
    const at = new Date().toISOString();
    await remote.putObject(objectKey(path), await root.SyncCrypto.seal({ path, text, updatedAt: at }));
    return { rev, hash, size: text.length, updatedAt: at, deviceId: state.deviceId };
  }

  /* ===== 主流程 ===== */

  // 刚同步成功过、本机也没有待推的改动 —— 这一轮没事可做，整轮省掉（连那次读云端清单都不做）。
  // pending 是 refreshPending() 在本机算出来的，不碰云端；attach 里就在 runSync 之前刷过一次。
  function justSynced() {
    if (status.pending) return false;
    const at = Date.parse(state.lastOkAt || "");
    return !!at && Date.now() - at < IDLE_SYNC_MS;
  }

  async function runSync(options) {
    const opts = options || {};
    if (!remote) {
      setStatus({ state: "off", message: "" });
      return { ok: false, message: "未配置" };
    }
    // 本机没有可读写的落点时同步无从谈起：读第一个本地文件就是空指针。
    // 与其把崩溃原文丢进「最近一次失败」，不如说清楚缺的是什么。
    if (!root.Workbench || !root.Workbench.fs) {
      const message = "本机还没接上数据文件夹，先到「设置」里选一个";
      setStatus({ state: "off", message });
      return { ok: false, message };
    }
    if (!root.SyncCrypto.isUnlocked()) {
      setStatus({ state: "locked", message: "" });
      return { ok: false, message: "待解锁" };
    }
    // 手动同步（force）撞上正在跑的那一轮时——典型是刚进页面时的预热同步——
    // 直接返回「正在同步」等于把这次点击丢掉。旧的面板又不看返回值，照样报
    // 「已按云端内容覆盖本机」，看着成功、实际一个字都没拉，这种最难查。
    // 所以这里等它跑完再跑自己这一轮；只有非手动的那些路（预热 / 写完待推）才照旧让位。
    if (running) {
      if (!opts.force) return { ok: false, message: "正在同步" };
      const deadline = Date.now() + 20000;
      while (running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (running) return { ok: false, message: "正在同步" };
    }
    running = true;
    setStatus({ state: "syncing", message: "", code: "" });
    try {
      await loadState();
      if (opts.force) state.base = {};
      // 只有 attach 那一路带 idle 标记；手动点同步、写完待推、解锁后那几种照常走，不会漏掉改动
      if (opts.idle && !opts.force && justSynced()) {
        setStatus({ state: "ok", message: "", code: "", lastSyncAt: state.lastOkAt, conflicts: state.conflicts.length });
        return { ok: true, skipped: true, pulled: 0, pushed: 0, conflicts: 0 };
      }
      let got = await remote.getIndex();
      let index = emptyIndex();
      let rebuilt = false;
      if (got.text) {
        try {
          index = await root.SyncCrypto.open(got.text);
        } catch (err) {
          // 云端那份清单解不开（多半是上一次配置 / 另一台设备用别的密码写的）。
          // 「以本机为准」这种模式下它本来就要被这一版覆盖，卡在这里等于永远推不上去，
          // 所以按空清单继续；seq 留着做乐观锁。普通同步仍然如实报错，不静默覆盖。
          if (!opts.force) throw err;
          rebuilt = true;
        }
      }
      if (!index || typeof index.files !== "object") index = emptyIndex();

      const paths = [];
      (await localUnits()).forEach((p) => { if (paths.indexOf(p) < 0) paths.push(p); });
      Object.keys(index.files).forEach((p) => { if (paths.indexOf(p) < 0) paths.push(p); });

      const uploads = [];
      let pulled = 0;
      let conflicts = 0;
      // 拉下来却没能在本机落地的单元：基准不记、内容不变，下一轮重试
      const stalePaths = [];
      // 云端清单这一轮有没有真的变：没变就别写（写一次 = 一次读 + 一次写，白烧额度）
      let dirtyIndex = rebuilt;

      for (const path of paths) {
        if (!isUnit(path)) continue;
        const entry = index.files[path] || null;
        const base = state.base[path] || null;
        const local = await unitText(path);
        const localHash = local == null ? null : await sha256(local);
        const remoteChanged = !!(entry && (!base || entry.rev !== base.rev));
        const localChanged = base ? localHash !== base.hash : localHash != null;
        // 「版本号一样、内容哈希却不同」不是正常同步能走出来的状态，只可能来自上一次
        // 没落地的拉取（见 landedHash）：当时 rev 被记上了，内容没变。本机自己也没改过的话，
        // 就该把这份内容重新拉一次 —— 没有这一条，踩过的设备会永远停在旧内容上，
        // 因为 rev 已经对齐，remoteChanged 永远是 false。
        const drifted = !!(entry && base && entry.hash && !localChanged
          && entry.rev === base.rev && base.hash !== entry.hash);

        if (localHash == null && !entry) {
          if (base) delete state.base[path];
          continue;
        }

        // 本机没有这个文件、云端清单里有 —— 这里面藏着两种完全不同的情况，务必分开：
        //   ① 基准里也没有它的记录 = 这台设备从来没拿到过它（新设备，或者只是本机没打开过那个模块，
        //      所以本地文件压根不存在）。它应该被下载下来。绝不能当成"用户删了"去删云端 ——
        //      否则新设备第一次同步就会把云端清空，而自己还什么都没拿到（手机端踩过这个坑）。
        //   ② 基准里有记录 = 以前在本机同步过、现在没了，那才是真正的本地删除。
        if (localHash == null && entry) {
          if (!base && opts.force !== "push") {
            const remoteText = await fetchUnit(path);
            if (remoteText != null) {
              await applyUnit(path, remoteText);
              const landed = await landedHash(path, entry.hash);
              if (landed == null) {
                stalePaths.push(path);
              } else {
                state.base[path] = { rev: entry.rev, hash: landed };
                pulled += 1;
              }
            }
            continue;
          }
          let remoteText = null;
          // 留副本这件事不再排除 force 模式：对话框跟用户承诺过"被覆盖的那边会存成冲突副本"，
          // 而这条路删的是云端的文件，没有副本就不可逆。
          if (remoteChanged) remoteText = await fetchUnit(path);
          await remote.deleteObject(objectKey(path));
          delete index.files[path];
          delete state.base[path];
          dirtyIndex = true;
          if (remoteText != null) {
            await saveConflict(path, remoteText, entry.deviceId);
            conflicts += 1;
          }
          continue;
        }

        if (opts.force === "pull" && entry) {
          const remoteText = await fetchUnit(path);
          if (remoteText != null) {
            // 对话框跟用户承诺过「被覆盖的那边会存成冲突副本」，强制拉取这条路也得兑现：
            // 本机那份可能是离线时真改出来的（手机上勾掉的待办），覆盖掉就找不回来了。
            // 但默认值那种空壳（[] / {}）不留，否则新设备第一次同步平白多出一排副本。
            if (local != null && local !== remoteText && !isBlankUnit(local)) {
              await saveConflict(path, local, state.deviceId);
              conflicts += 1;
            }
            await applyUnit(path, remoteText);
            const landed = await landedHash(path, entry.hash);
            if (landed == null) {
              stalePaths.push(path);
            } else {
              state.base[path] = { rev: entry.rev, hash: landed };
              pulled += 1;
            }
          }
          continue;
        }

        // 两边内容其实一模一样：新增单元第一次同步时常这样（比如两台设备都还是默认偏好）。
        // 直接对齐基准就好，没必要留一份内容重复的冲突副本。
        if (remoteChanged && localChanged && entry.hash && entry.hash === localHash && !opts.force) {
          state.base[path] = { rev: entry.rev, hash: localHash };
          continue;
        }

        if (remoteChanged && localChanged && !opts.force) {
          const remoteText = await fetchUnit(path);
          if (remoteText != null) {
            await saveConflict(path, remoteText, entry.deviceId);
            conflicts += 1;
          }
          uploads.push({ path, text: local, hash: localHash, baseRev: entry.rev });
        } else if (!localChanged && (remoteChanged || drifted)) {
          const remoteText = await fetchUnit(path);
          if (remoteText != null) {
            await applyUnit(path, remoteText);
            const landed = await landedHash(path, entry.hash);
            if (landed == null) {
              stalePaths.push(path);
            } else {
              state.base[path] = { rev: entry.rev, hash: landed };
              pulled += 1;
            }
          }
        } else if (localChanged || !entry) {
          uploads.push({ path, text: local, hash: localHash, baseRev: entry ? entry.rev : 0 });
        } else if (entry) {
          state.base[path] = { rev: entry.rev, hash: localHash };
        }
      }

      for (const item of uploads) {
        index.files[item.path] = await pushUnit(item.path, item.text, item.hash, item.baseRev);
        state.base[item.path] = { rev: index.files[item.path].rev, hash: item.hash };
      }

      if (uploads.length) dirtyIndex = true;
      index.updatedAt = new Date().toISOString();
      // 没东西要写就直接认成功：云端清单一个字没变，再读写一遍纯属浪费额度
      let saved = !dirtyIndex;
      for (let attempt = 0; attempt < CAS_RETRY && !saved; attempt += 1) {
        saved = await remote.putIndex(await root.SyncCrypto.seal(index), got.etag || null);
        if (!saved) {
          // 别人先写进了清单：把他的 rev 抬过去，我的这版继续往上加
          const again = await remote.getIndex();
          let fresh = emptyIndex();
          if (again.text) {
            try {
              fresh = await root.SyncCrypto.open(again.text);
            } catch (err) {
              // 同上：以本机为准时，读不懂的清单不该挡路
              if (!opts.force) throw err;
            }
          }
          if (!fresh || typeof fresh.files !== "object") fresh = emptyIndex();
          const mine = index.files;
          index.files = {};
          for (const path of Object.keys(fresh.files || {})) {
            const theirs = fresh.files[path];
            const own = mine[path];
            if (!own) {
              index.files[path] = theirs;
              continue;
            }
            if (theirs.rev >= own.rev && !opts.force) {
              // 对方这版比我们的新：先留成副本，我们的再往上抬一个 rev
              const remoteText = await fetchUnit(path);
              if (remoteText != null) {
                await saveConflict(path, remoteText, theirs.deviceId);
                conflicts += 1;
              }
              index.files[path] = Object.assign({}, own, { rev: theirs.rev + 1 });
              state.base[path] = { rev: theirs.rev + 1, hash: own.hash };
            } else {
              index.files[path] = own;
            }
          }
          Object.keys(mine).forEach((path) => {
            if (!index.files[path]) index.files[path] = mine[path];
          });
          got = again;
        }
      }

      state.lastSyncAt = new Date().toISOString();
      if (!saved) {
        if (state) {
          state.lastError = {
            at: state.lastSyncAt,
            message: "清单写入被其它设备抢先，改动已上传，下次同步会自动合并",
            kind: "conflict"
          };
        }
        setStatus({
          state: "error",
          message: "清单写入被其它设备抢先，改动已上传，下次同步会自动合并",
          code: "",
          lastSyncAt: state.lastSyncAt,
          conflicts: state.conflicts.length
        });
      } else {
        state.lastOkAt = state.lastSyncAt;
        setStatus({
          state: "ok",
          message: rebuilt
            ? "云端原有清单解不开（另一把同步密码写的），已按「以本机为准」重建"
            : staleMessage(stalePaths),
          code: rebuilt ? "rebuild" : (stalePaths.length ? "stale" : ""),
          lastSyncAt: state.lastSyncAt,
          conflicts: state.conflicts.length
        });
      }
      await saveState();
      if (conflicts) emit();
      return { ok: saved, pulled, pushed: uploads.length, conflicts, stale: stalePaths.length, stalePaths };
    } catch (err) {
      const message = (err && err.message) || "同步失败";
      const code = (err && err.code) || "";
      // 留一份最近一次失败，健康度面板据此归类（网络 / 凭证 / 权限）
      if (state) state.lastError = { at: new Date().toISOString(), message, kind: classifyError(message), code };
      setStatus({ state: "error", message, code });
      return { ok: false, message, code };
    } finally {
      running = false;
      refreshPending();
    }
  }

  async function refreshPending() {
    if (!remote || !root.Workbench.fs) return;
    try {
      await loadState();
      const paths = await localUnits();
      let pending = 0;
      for (const path of paths) {
        const local = await unitText(path);
        const hash = local == null ? null : await sha256(local);
        const base = state.base[path];
        if (base ? hash !== base.hash : hash != null) pending += 1;
      }
      status.pending = pending;
      if (status.state !== "error" && status.state !== "syncing") {
        setStatus({ state: pending ? "dirty" : "ok", conflicts: state.conflicts.length });
      } else {
        emit();
      }
    } catch (err) {
      /* 算不出来就不显示，不影响使用 */
    }
  }

  // 面板「同步范围」用：只读本机，列出会同步的单元和各自的状态。
  // 刻意不调 loadState()：那会把内存里的基准重置一遍，可能带偏正在跑的同步；
  // 内存里没有基准时按「还没同步过」算，展示上不会出错。
  async function scope() {
    const base = (state && state.base) || {};
    let paths = [];
    try {
      paths = await localUnits();
    } catch (err) {
      paths = [];
    }
    const items = [];
    let noteCount = 0;
    let noteBytes = 0;
    let notePending = 0;
    for (const path of paths) {
      if (!isUnit(path)) continue;
      const text = await unitText(path);
      const hash = text == null ? null : await sha256(text);
      const known = base[path] || null;
      const pending = text != null && (!known || known.hash !== hash);
      // 笔记正文一篇一个文件，可能有几十上百篇，合成一条显示
      if (/^notes\//.test(path)) {
        if (text != null) { noteCount += 1; noteBytes += text.length; }
        if (pending) notePending += 1;
        continue;
      }
      items.push({
        path,
        label: unitLabel(path),
        exists: text != null,
        bytes: text == null ? 0 : text.length,
        pending
      });
    }
    // 一篇都没有时也列出来，用户才知道这一类在同步范围里
    items.push({
      path: "notes/*.md",
      label: "笔记正文",
      exists: noteCount > 0,
      count: noteCount,
      bytes: noteBytes,
      pending: notePending > 0,
      pendingCount: notePending
    });
    return { items };
  }

  /* ===== 触发 ===== */

  function schedulePush() {
    if (!remote || !root.SyncCrypto.isUnlocked()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      runSync({});
    }, DEBOUNCE_MS);
  }

  function onWrite(event) {
    if (applying) return;
    const path = event && event.detail ? event.detail.path : "";
    if (!path || path === STATE_FILE) return;
    if (!isUnit(path)) return;
    schedulePush();
  }

  async function attach(remoteImpl) {
    if (remoteImpl) remote = remoteImpl;
    if (!root.SyncCrypto.isUnlocked()) {
      // 配过了但这一页还没解锁（换了页面 / 刷新过），先试着用设备密钥恢复
      if (root.SyncCrypto.hasConfig()) {
        try {
          await root.SyncCrypto.recall();
        } catch (err) {
          /* 恢复不了就等用户输入密码 */
        }
      }
    }
    // 刷新 / 换页面之后：密钥能用设备密钥恢复，但云端适配器是内存对象，默认是空的。
    // 这里按本机保存的配置把它重建出来，否则面板看着「已解锁」，一点同步却回「未配置」。
    if (!remote && root.SyncCrypto.isUnlocked() && root.SyncCloudbase && root.SyncCrypto.config) {
      try {
        const saved = await root.SyncCrypto.config();
        if (saved) remote = await root.SyncCloudbase.create(saved);
      } catch (err) {
        /* 建不起来就等用户重新输密码解锁 */
      }
    }
    root.addEventListener("workbench-write", onWrite);
    await refreshPending();
    // 配过了、只是这一页还没解锁：状态如实标成「等待解锁」，别显示成「未开启」
    if (!remote && root.SyncCrypto.hasConfig() && !root.SyncCrypto.isUnlocked()) {
      setStatus({ state: "locked", message: "" });
    }
    // 回到这个页面时也补一次：手机上的标签页常年开着不刷新，光靠「打开页面 / 本机改动」
    // 触发的话，另一台设备新加的东西要等用户手动刷新才看得到。
    // 依旧走 idle 那条路（有 30 秒窗口兜着），不会因为切进切出就一直读云端清单。
    if (!attachedVisible) {
      attachedVisible = true;
      root.addEventListener("visibilitychange", () => {
        if (root.document && root.document.visibilityState !== "visible") return;
        // 没配 / 没解锁就别碰：runSync 开头会把状态改写成「未开启」，
        // 那会把 attach 标好的「等待解锁」抹掉。
        if (!remote || !root.SyncCrypto.isUnlocked()) return;
        runSync({ idle: true });
      });
    }
    // 进页面时先拉一次：这一步是等着的，页面渲染时看到的就是同步后的数据。
    // 带 idle：刚同步过又不缺东西就跳过，切页 / 刷新不再每次都读一遍云端清单。
    if (remote && root.SyncCrypto.isUnlocked()) await runSync({ idle: true });
  }

  function setRemote(impl) {
    remote = impl;
    emit();
  }

  /* ===== 健康度 ===== */

  // 同步报错只有一句 message，这里按文案归成几类，方便一眼看出该去查什么
  function classifyError(message) {
    const text = String(message || "");
    if (!text) return "";
    if (/抢先/.test(text)) return "conflict";
    // 解不开密文本质上是密钥问题（用错了密码 / 换过配置），不是「其它」
    if (/无法解密|密钥不匹配|内容已损坏|密文信封/.test(text)) return "credential";
    if (/匿名登录|anonymous|signIn|登录|密码|凭证|token|401|403/i.test(text)) return "credential";
    if (/环境 ID|环境|env|权限|authorized|存储返回异常/i.test(text)) return "permission";
    if (/网络|network|fetch|timeout|超时|连不上|offline|加载云 SDK/i.test(text)) return "network";
    return "unknown";
  }

  // 给「云同步」面板用：上次成功时间 / 冲突副本 / 版本差 / 最近一次失败归类。
  // 会去读一次云端清单（只读，不改），读不到也不算错，如实报出来即可。
  async function health() {
    await loadState();
    const times = state.conflicts.map((item) => item.at).filter(Boolean).sort();
    const report = {
      state: status.state,
      message: status.message,
      lastSyncAt: state.lastSyncAt || status.lastSyncAt || "",
      pending: status.pending,
      conflictCount: state.conflicts.length,
      oldestConflictAt: times[0] || "",
      newestConflictAt: times[times.length - 1] || "",
      remoteUpdatedAt: "",
      behind: 0,        // 云端 rev 比本机基准高的单元数
      behindMax: 0,     // 其中最大的版本号差
      mismatch: 0,      // 版本号追平了、内容却对不上的单元数（上一次拉取没落地留下的坏基准）
      mismatchPaths: [],
      remoteReachable: false,
      remoteMessage: "",
      remoteCode: "",
      lastError: state.lastError || null
    };

    if (!remote) {
      report.remoteMessage = "还没有配置云同步";
      return report;
    }
    if (!root.SyncCrypto.isUnlocked()) {
      report.remoteMessage = "同步尚未解锁";
      return report;
    }
    try {
      const got = await remote.getIndex();
      const index = got.text ? await root.SyncCrypto.open(got.text) : emptyIndex();
      const files = (index && index.files) || {};
      report.remoteUpdatedAt = (index && index.updatedAt) || "";
      report.remoteReachable = true;
      Object.keys(files).forEach((path) => {
        // 已经不在同步范围内的单元（云端可能还留着别的设备推过的旧副本）不该算进版本差，
        // 否则面板会永远显示「落后一条」，而这一台其实再也不会去拉它
        if (!isUnit(path)) return;
        const cloudRev = Number(files[path].rev) || 0;
        const baseRev = state.base[path] ? Number(state.base[path].rev) || 0 : 0;
        const gap = cloudRev - baseRev;
        if (gap > 0) {
          report.behind += 1;
          if (gap > report.behindMax) report.behindMax = gap;
        }
        // 版本号一样、内容哈希却不同：这是上一次拉取没落地留下的坏基准（见 landedHash）。
        // 只看 rev 的话它会显示成「云端不领先」，恰好把最该被看见的那种状态说反了。
        const baseRec = state.base[path];
        if (baseRec && files[path].hash && Number(baseRec.rev) === cloudRev && baseRec.hash !== files[path].hash) {
          report.mismatch += 1;
          report.mismatchPaths.push(path);
        }
      });
    } catch (err) {
      report.remoteMessage = (err && err.message) || "读不到云端清单";
      report.remoteCode = (err && err.code) || "";
    }
    return report;
  }

  /* ===== 对外 ===== */

  function onChange(fn) {
    listeners.push(fn);
    return () => {
      listeners = listeners.filter((item) => item !== fn);
    };
  }

  function getStatus() {
    return Object.assign({}, status, { conflicts: state ? state.conflicts.length : 0 });
  }

  function getConflicts() {
    return state ? state.conflicts.slice() : [];
  }

  async function restoreConflict(record) {
    await loadState();
    const text = await root.Workbench.readText(record.path);
    if (text == null) throw new Error("这份副本已经不在了");
    await applyUnit(record.from, text);
    state.conflicts = state.conflicts.filter((item) => item.path !== record.path);
    await root.Workbench.removeFile(record.path);
    if (/^notes\/[^/]+\.md$/.test(record.path)) {
      const index = await root.Workbench.loadNoteIndex();
      const id = record.path.slice(6, -3);
      await root.Workbench.saveNoteIndex(index.filter((item) => item.id !== id));
    }
    await saveState();
    await runSync({});
  }

  async function removeConflict(record) {
    await loadState();
    state.conflicts = state.conflicts.filter((item) => item.path !== record.path);
    applying = true;
    try {
      await root.Workbench.removeFile(record.path);
      if (/^notes\/[^/]+\.md$/.test(record.path)) {
        const index = await root.Workbench.loadNoteIndex();
        const id = record.path.slice(6, -3);
        await root.Workbench.saveNoteIndex(index.filter((item) => item.id !== id));
      }
    } finally {
      applying = false;
    }
    await saveState();
    emit();
  }

  function reset() {
    remote = null;
    state = null;
    setStatus({ state: "off", message: "", lastSyncAt: "", pending: 0, conflicts: 0 });
  }

  /* ===== 内存假远端：只用于本机自测，接真云时不会用到 ===== */

  function createMemoryRemote(seed) {
    const store = Object.assign({ index: null }, seed || {});
    let etag = "etag-0";
    return {
      kind: "memory",
      async getIndex() {
        return { etag, text: store.index };
      },
      async putIndex(text, expected) {
        if (expected && expected !== etag) return false;
        store.index = text;
        etag = "etag-" + (Number(etag.split("-")[1] || 0) + 1);
        return true;
      },
      async getObject(key) {
        const value = store["obj:" + key];
        return value == null ? null : value;
      },
      async putObject(key, body) {
        store["obj:" + key] = body;
      },
      async deleteObject(key) {
        delete store["obj:" + key];
      },
      async probe() {
        return { ok: true, message: "内存远端" };
      },
      dump() {
        return store;
      }
    };
  }

  root.Sync = {
    attach,
    setRemote,
    sync: runSync,
    firstRun: (direction) => runSync({ force: direction === "pull" ? "pull" : "push" }),
    status: getStatus,
    onChange,
    refresh: refreshPending,
    scope,
    conflicts: getConflicts,
    restoreConflict,
    removeConflict,
    health,
    classifyError,
    reset,
    isUnit,
    STATE_FILE,
    createMemoryRemote
  };
})(typeof window !== "undefined" ? window : globalThis);
