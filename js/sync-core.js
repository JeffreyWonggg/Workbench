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

  // files.json 不在这里：它指向 files/ 里的二进制本体，那些不上云，
  // 同步过去只会得到一堆打不开的卡片。
  const JSON_UNITS = ["todos.json", "reports.json", "notes.json", "recipes.json", "ledger.json", "software.json", "vault.json", "deepseek.json"];
  const META_UNIT = "meta.json";          // 只同步项目清单，本机路径（工具、git 根目录）不外传

  let state = null;
  let remote = null;
  let applying = false;
  let running = false;
  let timer = null;
  let listeners = [];

  const status = {
    state: "off",        // off 未配置 / locked 待解锁 / syncing / ok / dirty / error
    message: "",
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
      base: (parsed && parsed.base && typeof parsed.base === "object") ? parsed.base : {},
      conflicts: Array.isArray(parsed && parsed.conflicts) ? parsed.conflicts : []
    };
    status.deviceId = state.deviceId;
    return state;
  }

  async function saveState() {
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

  async function unitText(path) {
    const raw = await root.Workbench.readText(path);
    if (raw == null) return null;
    return path === META_UNIT ? projectMeta(raw) : raw;
  }

  async function applyUnit(path, text) {
    if (path === META_UNIT) return applyMeta(text);
    await root.Workbench.writeText(path, text);
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
    return encodeURIComponent(path);
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

  async function runSync(options) {
    const opts = options || {};
    if (!remote) {
      setStatus({ state: "off", message: "" });
      return { ok: false, message: "未配置" };
    }
    if (!root.SyncCrypto.isUnlocked()) {
      setStatus({ state: "locked", message: "" });
      return { ok: false, message: "待解锁" };
    }
    if (running) return { ok: false, message: "正在同步" };
    running = true;
    setStatus({ state: "syncing", message: "" });
    try {
      await loadState();
      if (opts.force) state.base = {};
      let got = await remote.getIndex();
      let index = got.text ? await root.SyncCrypto.open(got.text) : emptyIndex();
      if (!index || typeof index.files !== "object") index = emptyIndex();

      const paths = [];
      (await localUnits()).forEach((p) => { if (paths.indexOf(p) < 0) paths.push(p); });
      Object.keys(index.files).forEach((p) => { if (paths.indexOf(p) < 0) paths.push(p); });

      const uploads = [];
      let pulled = 0;
      let conflicts = 0;

      for (const path of paths) {
        if (!isUnit(path)) continue;
        const entry = index.files[path] || null;
        const base = state.base[path] || null;
        const local = await unitText(path);
        const localHash = local == null ? null : await sha256(local);
        const remoteChanged = !!(entry && (!base || entry.rev !== base.rev));
        const localChanged = base ? localHash !== base.hash : localHash != null;

        if (localHash == null && !entry) {
          if (base) delete state.base[path];
          continue;
        }

        // 本地删了：远端跟着删；若远端期间改过，先把远端那版存成副本再删
        if (localHash == null && entry) {
          let remoteText = null;
          if (remoteChanged && !opts.force) remoteText = await fetchUnit(path);
          await remote.deleteObject(objectKey(path));
          delete index.files[path];
          delete state.base[path];
          if (remoteText != null) {
            await saveConflict(path, remoteText, entry.deviceId);
            conflicts += 1;
          }
          continue;
        }

        if (opts.force === "pull" && entry) {
          const remoteText = await fetchUnit(path);
          if (remoteText != null) {
            await applyUnit(path, remoteText);
            state.base[path] = { rev: entry.rev, hash: await sha256(await unitText(path)) };
            pulled += 1;
          }
          continue;
        }

        if (remoteChanged && localChanged && !opts.force) {
          const remoteText = await fetchUnit(path);
          if (remoteText != null) {
            await saveConflict(path, remoteText, entry.deviceId);
            conflicts += 1;
          }
          uploads.push({ path, text: local, hash: localHash, baseRev: entry.rev });
        } else if (remoteChanged && !localChanged) {
          const remoteText = await fetchUnit(path);
          if (remoteText != null) {
            await applyUnit(path, remoteText);
            state.base[path] = { rev: entry.rev, hash: await sha256(await unitText(path)) };
            pulled += 1;
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

      index.updatedAt = new Date().toISOString();
      let saved = false;
      for (let attempt = 0; attempt < CAS_RETRY && !saved; attempt += 1) {
        saved = await remote.putIndex(await root.SyncCrypto.seal(index), got.etag || null);
        if (!saved) {
          // 别人先写进了清单：把他的 rev 抬过去，我的这版继续往上加
          const again = await remote.getIndex();
          const fresh = again.text ? await root.SyncCrypto.open(again.text) : emptyIndex();
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
          lastSyncAt: state.lastSyncAt,
          conflicts: state.conflicts.length
        });
      } else {
        setStatus({
          state: "ok",
          message: "",
          lastSyncAt: state.lastSyncAt,
          conflicts: state.conflicts.length
        });
      }
      await saveState();
      if (conflicts) emit();
      return { ok: saved, pulled, pushed: uploads.length, conflicts };
    } catch (err) {
      const message = (err && err.message) || "同步失败";
      // 留一份最近一次失败，健康度面板据此归类（网络 / 凭证 / 权限）
      if (state) state.lastError = { at: new Date().toISOString(), message, kind: classifyError(message) };
      setStatus({ state: "error", message });
      return { ok: false, message };
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
    root.addEventListener("workbench-write", onWrite);
    await refreshPending();
    // 进页面时先拉一次：这一步是等着的，页面渲染时看到的就是同步后的数据
    if (remote && root.SyncCrypto.isUnlocked()) await runSync({});
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
      remoteReachable: false,
      remoteMessage: "",
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
        const cloudRev = Number(files[path].rev) || 0;
        const baseRev = state.base[path] ? Number(state.base[path].rev) || 0 : 0;
        const gap = cloudRev - baseRev;
        if (gap > 0) {
          report.behind += 1;
          if (gap > report.behindMax) report.behindMax = gap;
        }
      });
    } catch (err) {
      report.remoteMessage = (err && err.message) || "读不到云端清单";
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
