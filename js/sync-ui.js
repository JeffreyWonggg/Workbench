(function (root) {
  /* 云同步面板：挂在「设置」里，手机上也可以单独打开（顶栏那个小圆点）。
     面板只负责收输入和显示状态，真正干活的是 Sync（引擎）和 SyncCrypto（加解密）。 */

  const ENV_HINT_KEY = "wb-sync-env";

  let container = null;
  let listening = false;
  let note = "";        // 行内提示：失败原因或上一次操作的结果
  let noteKind = "info";
  let busy = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // 面板构建戳：手机 / 别人电脑上打开「设置 → 云同步」，拉到底看这一行。
  // 和电脑端显示的一致 = 页面跑的是最新代码；显示的是旧的那串（或压根没有这行）
  // = 页面没重开，浏览器还在用内存 / 缓存里的旧 JS。
  // 每次改 sync-*.js 或同步面板样式并重新发布后，把下面的时间改成发布时间。
  const BUILD = "2026-10-03 16:40";

  function buildStamp() {
    return el("p", "sync-build muted", "同步面板构建 " + BUILD);
  }

  function toast(text) {
    if (root.Nav && root.Nav.toast) root.Nav.toast(text);
  }

  function setNote(text, kind) {
    note = text || "";
    noteKind = kind || "info";
  }

  function syncReady() {
    return !!(root.Sync && root.SyncCrypto);
  }

  function dotClass(state) {
    if (state === "syncing") return "sync-dot is-syncing";
    if (state === "ok") return "sync-dot is-ok";
    if (state === "dirty") return "sync-dot is-dirty";
    if (state === "error") return "sync-dot is-error";
    if (state === "locked") return "sync-dot is-locked";
    return "sync-dot is-off";
  }

  function stateLabel(status) {
    if (!syncReady()) return "同步模块没加载";
    switch (status.state) {
      case "syncing": return "正在同步…";
      case "ok": return "已同步";
      case "dirty": return status.pending ? "有 " + status.pending + " 项待推送" : "有改动待推送";
      case "error": return status.message || "同步失败";
      case "locked": return "已配置，等待解锁";
      default: return "未开启";
    }
  }

  function ago(iso) {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "";
    const minutes = Math.floor((Date.now() - then) / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return minutes + " 分钟前";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + " 小时前";
    return Math.floor(hours / 24) + " 天前";
  }

  /* ===== 动作 ===== */

  async function remoteFrom(config) {
    if (!root.SyncCloudbase) throw new Error("云适配器没加载");
    return root.SyncCloudbase.create(config);
  }

  async function enable(config, password, remember) {
    busy = true;
    setNote("正在连接云开发环境…", "info");
    paint();
    try {
      await root.SyncCrypto.setup(password, config);
      rememberConfig(config);
      saveEnvHint(config.env);
      const remote = await remoteFrom(config);
      const probe = await remote.probe();
      if (!probe.ok) {
        await root.SyncCrypto.clear();
        setNote(probe.message, "error");
        return;
      }
      // 云端可能早就有数据了（电脑上配过）：盐在密文信封里，本机刚生成的这把对不上，
      // 同样的密码也解不开。先试着采用云端的盐；密码不对就当场退回，不带着废密钥往下走。
      let hasRemote = false;
      try {
        const head = await remote.getIndex();
        if (head.text) hasRemote = await root.SyncCrypto.adoptRemote(password, head.text);
      } catch (err) {
        await root.SyncCrypto.clear();
        setNote((err && err.message) || "云端数据解不开", "error");
        return;
      }
      root.Sync.setRemote(remote);
      if (remember) await root.SyncCrypto.remember();
      else root.SyncCrypto.forget();
      const direction = await askDirection(hasRemote);
      if (!direction) {
        setNote("已连上，等你选好第一次同步的方向再开始", "info");
        return;
      }
      // 这一步的返回值以前是丢掉的：同步失败（网络 / 凭证 / 权限）也照样打出
      // 「已按云端内容覆盖本机」，面板看着像成功了，实际一个字都没拉下来 ——
      // 排查时最容易被这句话带偏，所以这里按真实结果说话。
      const result = await root.Sync.firstRun(direction);
      if (!result || !result.ok) {
        setNote((result && result.message) || "第一次同步没成功，展开下面的「健康度」看原因", "error");
        return;
      }
      const warn = root.Sync.status ? root.Sync.status().message : "";
      if (warn) {
        setNote(warn, "info");
        return;
      }
      setNote(direction === "pull" ? "已按云端内容覆盖本机" : "已把本机数据推上去", "ok");
      toast("云同步已开启");
    } catch (err) {
      setNote((err && err.message) || "开启失败", "error");
    } finally {
      busy = false;
      paint();
    }
  }

  async function unlock(password, remember) {
    busy = true;
    setNote("", "info");
    paint();
    try {
      const config = await root.SyncCrypto.unlock(password);
      rememberConfig(config);
      saveEnvHint(config.env);
      const remote = await remoteFrom(config);
      root.Sync.setRemote(remote);
      if (remember) await root.SyncCrypto.remember();
      else root.SyncCrypto.forget();
      setNote("已解锁", "ok");
      root.Sync.sync({});
    } catch (err) {
      setNote((err && err.message) || "解锁失败", "error");
    } finally {
      busy = false;
      paint();
    }
  }

  async function syncNow() {
    busy = true;
    setNote("", "info");
    paint();
    const result = await root.Sync.sync({});
    if (result && result.ok) {
      // 把这一轮实际拉回 / 推上去的数量报出来：手机上「看不到电脑刚加的东西」时，
      // 「拉回 0 项」（云端就没有 / 这台设备没在同步）和「拉回 1 项但页面没变」
      // （数据已经到了本机，是当前这一页没重画）是两条完全不同的排查方向。
      const bits = [];
      if (result.pulled) bits.push("从云端拉回 " + result.pulled + " 项");
      if (result.pushed) bits.push("推上去 " + result.pushed + " 项");
      if (result.conflicts) bits.push("产生 " + result.conflicts + " 个冲突副本");
      if (result.stale) {
        bits.push("有 " + result.stale + " 项拉下来却没落到本机（"
          + (result.stalePaths || []).slice(0, 3).join("、") + "）");
      }
      setNote("同步完成" + (bits.length ? "（" + bits.join("，") + "）" : "（两边本来就一致，没有要动的）"),
        result.stale ? "error" : "ok");
    } else {
      setNote((result && result.message) || "同步失败", "error");
    }
    busy = false;
    paint();
  }

  // 「以云端为准」：不走「哪边新」那一套判定，逐个单元把云端那份拿下来覆盖本机。
  // 之所以要有这个手动出口：「立即同步」在两份被认为一样新的时候什么都不做，
  // 而本机内容其实是旧的（坏基准、或者读到的清单本身是缓存的旧副本）时，
  // 它会一直回「两边本来就一致」，怎么点都出不来数据。
  // 本机被换掉的内容引擎会留成冲突副本（内容是默认空壳的不留），所以不是不可逆操作。
  async function pullFromCloud() {
    if (busy) return;
    const ok = root.Nav && root.Nav.ask
      ? await root.Nav.ask({
          title: "以云端为准",
          text: "把云端那份完整拉下来，覆盖这台设备上的同步数据（待办、周报、笔记、记账、菜谱、软件号、记谱）。"
            + "这台设备上还没推上去的改动会先存成冲突副本，不会直接丢掉。现在拉吗？",
          okText: "以云端为准"
        })
      : true;
    if (!ok) return;
    busy = true;
    setNote("正在按云端那份覆盖本机…", "info");
    paint();
    let result = null;
    try {
      result = await root.Sync.sync({ force: "pull" });
    } catch (err) {
      result = { ok: false, message: (err && err.message) || "同步失败" };
    }
    if (result && result.ok) {
      const bits = [];
      if (result.pulled) bits.push("从云端拉回 " + result.pulled + " 项");
      if (result.conflicts) bits.push("本机原来的内容存成了 " + result.conflicts + " 个冲突副本");
      if (result.stale) {
        bits.push("有 " + result.stale + " 项没能落到本机（"
          + (result.stalePaths || []).slice(0, 3).join("、") + "）");
      }
      setNote("已按云端为准" + (bits.length ? "（" + bits.join("，") + "）" : ""),
        result.stale ? "error" : "ok");
    } else {
      setNote((result && result.message) || "没能按云端覆盖本机", "error");
    }
    busy = false;
    // 刚覆盖过，健康度那一格必须按新状态重算，不能被 5 秒缓存挡住
    healthCache = { at: 0, data: null };
    paint();
  }

  // 「检测连接」：往云端真写一次再读回来，并单独验一次防缓存读取通道，结论原样显示。
  // 已配置的设备也能点，不用为了看这一句去「关闭同步 → 重新开启」。
  async function testConnection() {
    if (busy) return;
    busy = true;
    setNote("正在测云端读写与防缓存读取通道…", "info");
    paint();
    try {
      const config = await root.SyncCrypto.config();
      if (!config) {
        setNote("本机配置读不出来，先在下面重新配一次", "error");
        return;
      }
      const remote = await remoteFrom(config);
      const probe = await remote.probe();
      setNote(probe.message, probe.ok ? "ok" : "error");
    } catch (err) {
      setNote((err && err.message) || "检测失败", "error");
    } finally {
      busy = false;
      paint();
    }
  }

  // 「本机这把钥匙解不开云端那份密文」时的修法：拿用户输的密码 + 云端信封里的盐
  // 重派一次密钥（adoptRemote 会当场验一遍密文，验不过就抛），再让他选一次方向。
  // 以前这段只能靠「关闭同步 → 重新开启」凑出来：配置和基准被清掉、还得自己记得选哪边，
  // 而另一台设备重建过云端之后，这台设备点多少次「立即同步」都只会重复报同一句错。
  async function realignTo(password, remember) {
    busy = true;
    setNote("正在用这把密码对上云端…", "info");
    paint();
    try {
      const config = await root.SyncCrypto.config();
      if (!config) {
        setNote("本机配置读不出来，先在下面重新配一次", "error");
        return;
      }
      const remote = await remoteFrom(config);
      const head = await remote.getIndex();
      root.Sync.setRemote(remote);
      if (!head.text) {
        setNote("云端还没有数据，直接同步就行", "info");
        await root.Sync.sync({});
        return;
      }
      const adopted = await root.SyncCrypto.adoptRemote(password, head.text);
      if (!adopted) {
        setNote("云端那份不像本工作台的密文（信封读不出来），不敢改本机密钥", "error");
        return;
      }
      rememberConfig(config);
      if (remember) await root.SyncCrypto.remember();
      else root.SyncCrypto.forget();
      const direction = await askDirection(true, "密钥已对上云端，再选一次以哪边为准");
      if (!direction) {
        setNote("密钥已经和云端对上了，选好方向再同步一次", "info");
        return;
      }
      const result = await root.Sync.firstRun(direction);
      if (!result || !result.ok) {
        setNote((result && result.message) || "对上云端后第一次同步没成功，看下面的「健康度」", "error");
        return;
      }
      setNote(direction === "pull" ? "已对上云端，并按云端内容覆盖本机" : "已对上云端，并把本机数据推了上去", "ok");
      toast("已对上云端");
    } catch (err) {
      setNote((err && err.message) || "对上云端失败", "error");
    } finally {
      busy = false;
      paint();
    }
  }

  async function disable() {
    const ok = root.Nav && root.Nav.ask
      ? await root.Nav.ask({
        title: "关闭云同步",
        text: "只会清掉这台设备上的同步配置和基准，云端已经上传的加密数据不动。\n\n本机数据也照样还在。",
        okText: "关闭同步",
        cancelText: "再想想",
        danger: true
      })
      : true;
    if (!ok) return;
    root.SyncCrypto.clear();
    root.Sync.reset();
    current = null;
    clearEnvHint();
    setNote("已关闭云同步", "info");
    paint();
  }

  function askDirection(hasRemote, title) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "code-dialog";
      // 云端有数据时把「以云端为准」摆成主按钮：新设备（手机第一次配）上本机往往只有
      // 默认的空列表，若顺手点了「以本机为准」，就会把云端那份覆盖掉，另一台机器跟着遭殃。
      // 哪边全由用户判断，但默认该偏向云端。
      const pullClass = hasRemote ? "btn primary" : "btn";
      const pushClass = hasRemote ? "btn" : "btn primary";
      dialog.innerHTML = [
        "<h2>" + (title || "第一次同步") + "</h2>",
        '<p class="sub">' + (hasRemote
          ? "云端已经有一份数据了，密码也验过是对的。"
          : "云端还没有这份数据（或者你在这台设备上换了个新环境）。")
          + "要拿哪边当底子？选错也不会丢东西——被覆盖的那边会存成冲突副本。</p>",
        hasRemote
          ? '<p class="sub muted">云端那份是各台设备共用的：选「以本机为准」会把其它设备看到的内容换成这台设备的版本。'
            + "刚配的手机、刚换的浏览器通常该选「以云端为准」。</p>"
          : "",
        '<div class="dialog-actions">',
        '  <button type="button" class="' + pullClass + '" data-dir="pull">以云端为准，覆盖本机</button>',
        '  <span class="dialog-spacer"></span>',
        '  <button type="button" class="btn" data-dir="cancel">取消</button>',
        '  <button type="button" class="' + pushClass + '" data-dir="push">以本机为准，推上去</button>',
        "</div>"
      ].join("");
      const close = (value) => {
        if (dialog.open) dialog.close();
        if (dialog.parentNode) dialog.remove();
        resolve(value);
      };
      dialog.addEventListener("click", (event) => {
        const button = event.target.closest ? event.target.closest("button[data-dir]") : null;
        if (!button) return;
        const dir = button.dataset.dir;
        close(dir === "cancel" ? null : dir);
      });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  /* ===== 健康度 ===== */

  const HEALTH_TTL = 5000;
  const ERROR_KIND_LABEL = { network: "网络", credential: "凭证", permission: "权限", conflict: "冲突", unknown: "其它" };
  const ERROR_KIND_HINT = {
    network: "连不上云开发环境：先看网络 / 代理，再确认环境 ID 没写错。",
    credential: "登录或密码没过：到控制台确认「身份认证 → 登录方式」里匿名登录已开启，并把工作台访问地址加进 WEB 安全域名；提示「同步密码不对」就先重新解锁一次。",
    permission: "像是权限或环境不对：确认环境 ID 属于你自己的账号，云存储没有被停用。",
    conflict: "另一台设备同时改了同一份数据：下次同步会自动合并，被覆盖的那版会存成冲突副本。",
    unknown: "原因没归出来，看上面状态里的原始报错。"
  };

  let healthCache = { at: 0, data: null };

  function kindLabel(kind) {
    return ERROR_KIND_LABEL[kind] || ERROR_KIND_LABEL.unknown;
  }

  function kindHint(kind) {
    return ERROR_KIND_HINT[kind] || ERROR_KIND_HINT.unknown;
  }

  function buildHealthBox(mode) {
    const box = el("div", "sync-health");
    if (!syncReady() || mode === "setup" || !root.Sync.health) {
      box.hidden = true;
      return box;
    }
    box.append(el("div", "sync-health-head", "健康度"));
    const body = el("div", "sync-health-body", "正在检查…");
    box.append(body);
    fillHealth(body);
    return box;
  }

  async function fillHealth(body) {
    try {
      if (!healthCache.data || Date.now() - healthCache.at > HEALTH_TTL) {
        healthCache = { at: Date.now(), data: await root.Sync.health() };
      }
      const data = healthCache.data;
      body.className = "sync-health-body";
      body.textContent = "";
      body.append(healthGrid(data));
      healthHints(data).forEach((text) => body.append(el("div", "sync-health-hint muted", text)));
    } catch (err) {
      body.textContent = "健康度读取失败：" + ((err && err.message) || "未知错误");
    }
  }

  function healthGrid(data) {
    const grid = el("div", "sync-health-grid");
    grid.append(
      healthItem("上次同步成功",
        data.lastSyncAt ? ago(data.lastSyncAt) : "还没有成功过",
        data.lastSyncAt ? "is-ok" : "is-warn"),
      healthItem("冲突副本",
        data.conflictCount
          ? `${data.conflictCount} 份 · 最早 ${ago(data.oldestConflictAt)}`
          : "没有",
        data.conflictCount ? "is-warn" : "is-ok"),
      healthItem("版本差", versionText(data),
        (data.behind || data.pending || data.mismatch) ? "is-warn" : "is-ok"),
      healthItem("最近一次失败",
        data.lastError ? `${kindLabel(data.lastError.kind)} · ${ago(data.lastError.at)}` : "没有失败记录",
        data.lastError ? "is-bad" : "is-ok")
    );
    return grid;
  }

  function healthItem(label, value, tone) {
    const item = el("div", "sync-health-item " + (tone || ""));
    item.append(el("span", "sync-health-label", label));
    item.append(el("b", "sync-health-value", value));
    return item;
  }

  function versionText(data) {
    if (!data.remoteReachable) return "云端读不到";
    const cloud = data.behind
      ? `云端领先 ${data.behind} 项（最大差 ${data.behindMax}）`
      : "云端不领先";
    const local = data.pending ? `本地待推 ${data.pending} 项` : "本地无待推";
    // 版本号追平了、内容却对不上：只看 rev 的话这里会写成「云端不领先」，
    // 而这句话恰恰是最误导的——本机拿着旧内容，面板却说一切都好。
    const drift = data.mismatch ? ` · 有 ${data.mismatch} 项内容对不上云端` : "";
    // 云端清单的更新时间一并报出来：它若明显旧于另一台设备刚同步过的时间，
    // 那就不是「云端真的没变」，而是这台设备读到的清单是缓存的旧副本。
    const when = data.remoteUpdatedAt ? `（云端清单更新于 ${ago(data.remoteUpdatedAt)}）` : "";
    return cloud + " · " + local + drift + when;
  }

  // 「本机密钥对不上云端」按归类属于凭证，但病因跟匿名登录 / 域名那些完全不是一回事：
  // 照着通用提示跑去控制台改只会白折腾，所以这一种单独给说法。
  function mismatchHintText() {
    const unlocked = syncReady() && root.SyncCrypto.isUnlocked();
    return unlocked
      ? "本机密钥解不开云端那份密文：在上面的密码框里填一次当初那把同步密码，点「用同步密码对上云端」，"
        + "再选「以云端为准」就能接回来。反复点「立即同步」不会有别的结果。"
      : "本机密钥解不开云端那份密文：先在下面解锁这一页，再填一次当初那把同步密码点「用同步密码对上云端」。";
  }

  function healthHints(data) {
    const hints = [];
    const mismatchNow = !!(root.Sync.status && root.Sync.status().code === "key-mismatch");
    const mismatchLast = !!(data.lastError && data.lastError.code === "key-mismatch");
    if (data.lastError) {
      hints.push("最近一次失败（" + kindLabel(data.lastError.kind) + "）：" + data.lastError.message
        + ((mismatchNow || mismatchLast) ? "" : "　→　" + kindHint(data.lastError.kind)));
    }
    if (mismatchNow) hints.push(mismatchHintText());
    if (data.conflictCount) {
      hints.push(`冲突副本最早的一份是 ${ago(data.oldestConflictAt)}，下面「冲突副本」里可以查看 / 恢复 / 删除。`);
    }
    if (data.mismatch) {
      hints.push("有 " + data.mismatch + " 项本机内容和云端对不上（"
        + (data.mismatchPaths || []).slice(0, 3).join("、")
        + "）：上一次从云端拉下来的内容没能落到本机，这边还是旧的。点上面的「立即同步」会让它重新拉一遍；"
        + "要是反复出现，把这一句发我。");
    }
    if (!data.remoteReachable && data.remoteMessage) {
      // 文案本身已经在上面那条「最近一次失败」里给过了，这里只补「该怎么做」；
      // key-mismatch 不能按凭证类的通用建议去引，那会把人带去控制台白改一通。
      if (data.remoteCode === "key-mismatch") hints.push(mismatchHintText());
      else {
        const kind = root.Sync.classifyError ? root.Sync.classifyError(data.remoteMessage) : "unknown";
        hints.push("云端清单读不到（" + kindLabel(kind) + "）：" + data.remoteMessage + "　→　" + kindHint(kind));
      }
    }
    return hints;
  }

  /* ===== 同步范围：让用户直接看见「哪些数据会上云」 ===== */

  const SCOPE_TTL = 5000;
  let scopeCache = { at: 0, data: null };

  function formatBytes(size) {
    const n = Number(size) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  // 没有参数：配置前也显示，新用户最需要先知道哪些数据会上云
  function buildScope() {
    const box = el("div", "sync-scope");
    if (!syncReady() || !root.Sync.scope) {
      box.hidden = true;
      return box;
    }
    box.append(el("div", "sync-scope-head", "会同步哪些数据"));
    const body = el("div", "sync-scope-body", "正在读取…");
    box.append(body);
    fillScope(body);
    return box;
  }

  async function fillScope(body) {
    try {
      if (!scopeCache.data || Date.now() - scopeCache.at > SCOPE_TTL) {
        scopeCache = { at: Date.now(), data: await root.Sync.scope() };
      }
      const items = (scopeCache.data && scopeCache.data.items) || [];
      body.textContent = "";
      if (!items.length) {
        body.append(el("p", "sync-scope-hint muted", "这台设备上还没读到可同步的数据。"));
        return;
      }
      const list = el("div", "sync-scope-list");
      items.forEach((item) => list.append(scopeRow(item)));
      body.append(list);
      body.append(el("p", "sync-scope-hint muted",
        "只有这几类会上云，且都是在本机加密之后才上传。收藏的附件与截图（files/、screenshot/）与收藏清单、"
        + "记谱的音量设置、剪贴板历史、产品目录、局域网收到的文件、API Key 和本机路径都不在内。"));
    } catch (err) {
      body.textContent = "同步范围读取失败：" + ((err && err.message) || "未知错误");
    }
  }

  function scopeRow(item) {
    const row = el("div", "sync-scope-item" + (item.pending ? " is-pending" : ""));
    row.append(el("span", "sync-dot " + (item.pending ? "is-dirty" : (item.exists ? "is-ok" : "is-off"))));
    const name = el("span", "sync-scope-name");
    name.append(el("span", null, item.label));
    name.append(el("span", "sync-scope-path muted", item.path));
    row.append(name);
    row.append(el("span", "sync-scope-status", scopeStatus(item)));
    return row;
  }

  function scopeStatus(item) {
    if (item.pending) return item.pendingCount ? item.pendingCount + " 篇待推送" : "待推送";
    if (!item.exists) return "本机没有";
    if (item.count) return item.count + " 篇 · " + formatBytes(item.bytes);
    return "已同步 · " + formatBytes(item.bytes);
  }

  /* ===== 渲染 ===== */

  function buildHead(status) {
    const wrap = el("div", "sync-head");
    wrap.append(el("h3", null, "云同步"));
    const line = el("div", "sync-state");
    line.append(el("span", dotClass(status.state)), el("span", "sync-state-text", stateLabel(status)));
    const stamp = ago(status.lastSyncAt);
    if (stamp) line.append(el("span", "sync-when muted", "上次同步 " + stamp));
    wrap.append(line);
    // 同步本身成功了、但拉下来的东西没落地：状态灯还是绿的，只在这句里说实话。
    // 不写出来的话，用户看到的就是「已同步」，却一直拿着旧数据。
    if (status.state === "ok" && status.message) {
      wrap.append(el("div", "sync-note is-error", status.message));
    }
    return wrap;
  }

  function buildForm(mode) {
    const form = el("div", "sync-form");
    const envField = el("label", "sync-field");
    envField.append(el("span", null, "环境 ID"));
    const env = document.createElement("input");
    env.type = "text";
    env.id = "wb-sync-env";
    env.autocomplete = "off";
    env.placeholder = "例如 workbench-1a2b3c";
    env.value = presetEnv() || "";
    envField.append(env);
    form.append(envField);

    if (mode === "setup") {
      const siteField = el("label", "sync-field");
      siteField.append(el("span", null, "手机访问地址（选填，用来生成配置二维码）"));
      const site = document.createElement("input");
      site.type = "text";
      site.id = "wb-sync-site";
      // 这框要的是网址，不是账号名，明确标成不需要自动填充；
      // Chrome / Edge 常无视 autocomplete=off，把上次填过的环境 ID 塞进来，
      // 所以渲染后再兜一次：不是网址就清掉，免得当成「手机访问地址」生成二维码。
      site.autocomplete = "off";
      site.setAttribute("data-form-type", "other");
      site.setAttribute("data-lpignore", "true");
      site.name = "wb-sync-site-url";
      site.placeholder = "https://xxx.tcloudbaseapp.com";
      site.value = "";
      siteField.append(site);
      form.append(siteField);
      // 延迟一拍再清：浏览器自动填充往往发生在 DOM 就绪之后
      setTimeout(() => {
        if (site.isConnected && site.value && !/^https?:\/\//i.test(site.value.trim())) site.value = "";
      }, 80);
    }

    const pwField = el("label", "sync-field");
    pwField.append(el("span", null, mode === "setup" ? "同步密码（自己设一个，别和资料库主密码一样）" : "同步密码"));
    const pw = document.createElement("input");
    pw.type = "password";
    pw.id = "wb-sync-password";
    pw.autocomplete = "off";
    pwField.append(pw);
    form.append(pwField);

    const rememberField = el("label", "sync-check");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "wb-sync-remember";
    box.checked = root.SyncCrypto.remembered();
    rememberField.append(box, el("span", null, "在这台设备上记住（密钥由本机设备密钥包裹后存放，不存密码明文）"));
    form.append(rememberField);
    return form;
  }

  // 只有引擎那边明确报了 key-mismatch 才出现：本机这把密钥解不开云端那份密文。
  // 这类状态没有别的出路——点「立即同步」永远报同一句错，「关闭同步」重配又太重，
  // 所以直接给条一步到位的路。
  function buildRealign() {
    const box = el("div", "sync-realign");
    box.append(el("div", "sync-realign-head", "本机密钥对不上云端那份数据"));
    box.append(el("p", "sub muted",
      "这台设备的同步密钥和云端那份密文不是同一把（多半是另一台设备重建过云端，或者换过一次配置）。"
      + "填当初那把同步密码，让这台设备对上云端，再选一次以哪边为准就能继续同步；本机文件不会被清掉。"));
    const field = el("label", "sync-field");
    field.append(el("span", null, "同步密码"));
    const pw = document.createElement("input");
    pw.type = "password";
    pw.id = "wb-sync-realign-password";
    pw.autocomplete = "off";
    field.append(pw);
    box.append(field);

    const rememberField = el("label", "sync-check");
    const box2 = document.createElement("input");
    box2.type = "checkbox";
    box2.id = "wb-sync-realign-remember";
    box2.checked = root.SyncCrypto.remembered();
    rememberField.append(box2, el("span", null, "在这台设备上记住（重新对上云端后旧的那份密钥包会失效，所以这里要重新勾一次）"));
    box.append(rememberField);

    const row = el("div", "dialog-actions");
    const go = document.createElement("button");
    go.type = "button";
    go.className = "btn primary";
    go.id = "wb-sync-realign-go";
    go.textContent = "用同步密码对上云端";
    go.disabled = busy;
    row.append(go);
    box.append(row);
    return box;
  }

  function buildActions(mode) {
    const row = el("div", "dialog-actions");
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "btn primary";
    primary.id = "wb-sync-go";
    primary.textContent = mode === "setup" ? "开启同步" : "解锁并同步";
    primary.disabled = busy;
    // ready 模式不渲染密码框（见 build()），这个按钮却照旧渲染，
    // 点下去只能取到空密码，unlock() 必然回「同步密码不对」——而这时候其实早就解锁了。
    // 只有「未配置」和「已配置但本页未解锁」这两种状态才需要它。
    if (mode !== "ready") row.append(primary);

    if (mode === "ready") {
      const now = document.createElement("button");
      now.type = "button";
      now.className = "btn";
      now.id = "wb-sync-now";
      now.textContent = "立即同步";
      now.disabled = busy;
      row.append(now);

      // 「立即同步」是按「哪边新」判定的：本机这份要是被认为不比云端旧，它一个字都不会动，
      // 只回一句「两边本来就一致」。这台设备手上拿着旧内容、面板却说一切正常时，
      // 就只剩这一条路能强制把云端那份拉下来（首次配置的对话框里本来就有，配好之后再也点不到）。
      const pull = document.createElement("button");
      pull.type = "button";
      pull.className = "btn";
      pull.id = "wb-sync-pull";
      pull.textContent = "以云端为准";
      pull.disabled = busy;
      row.append(pull);

      // 「检测连接」以前只在首次开启同步时自动跑一次（见 enable），配好之后就没入口了；
      // 而它报的「防缓存读取通道：可用 / 不可用（原因）」正是排查「电脑上改了、
      // 这台设备怎么同步都看不到」最关键的一句话，所以留一个随时能点的按钮。
      const test = document.createElement("button");
      test.type = "button";
      test.className = "btn";
      test.id = "wb-sync-test";
      test.textContent = "检测连接";
      test.disabled = busy;
      row.append(test);
    }

    row.append(el("span", "dialog-spacer"));

    if (mode === "ready") {
      const off = document.createElement("button");
      off.type = "button";
      off.className = "btn";
      off.id = "wb-sync-off";
      off.textContent = "关闭同步";
      row.append(off);
    }
    return row;
  }

  function buildConflicts() {
    const list = root.Sync.conflicts();
    if (!list.length) return null;
    const box = el("div", "sync-conflicts");
    box.append(el("div", "sync-conflict-head", list.length + " 个冲突副本（两台设备都改过同一处，被覆盖的那份留在这里）"));
    list.slice(0, 8).forEach((item) => {
      const row = el("div", "sync-conflict");
      row.append(el("span", "sync-conflict-title", item.title || item.path));
      const when = item.at ? new Date(item.at) : null;
      row.append(el("span", "muted", when ? `${when.getMonth() + 1}.${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}` : ""));
      const actions = el("div", "sync-conflict-actions");
      const view = document.createElement("button");
      view.type = "button";
      view.className = "linkish";
      view.textContent = "查看";
      view.addEventListener("click", () => viewConflict(item));
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "linkish";
      restore.textContent = "恢复";
      restore.addEventListener("click", () => restoreConflict(item));
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "linkish";
      drop.textContent = "删除";
      drop.addEventListener("click", () => dropConflict(item));
      actions.append(view, restore, drop);
      row.append(actions);
      box.append(row);
    });
    return box;
  }

  function buildQr(config) {
    if (!config || !config.env) return null;
    const box = el("div", "sync-qr");
    if (config.site && typeof root.qrcode === "function") {
      const target = String(config.site).replace(/\/+$/, "") + "/?sync=" + encodeURIComponent(config.env);
      const holder = el("div", "sync-qr-box");
      try {
        const qr = root.qrcode(0, "M");
        qr.addData(target);
        qr.make();
        holder.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
      } catch (err) {
        holder.textContent = target;
      }
      box.append(el("div", "sync-qr-head", "用手机相机扫一下：会打开工作台并自动带上环境 ID，再输一次同步密码就能用"));
      box.append(holder);
      box.append(el("div", "muted", target));
    } else {
      box.append(el("div", "sync-qr-head", "手机上怎么配"));
      box.append(el("div", "muted", "在手机浏览器打开工作台，进「设置 → 云同步」，填同样的环境 ID（" + config.env + "）和同步密码。"));
    }
    return box;
  }

  function build() {
    const status = syncReady() ? root.Sync.status() : { state: "off", message: "", lastSyncAt: "", pending: 0, conflicts: 0 };
    const configured = syncReady() && root.SyncCrypto.hasConfig();
    const unlocked = syncReady() && root.SyncCrypto.isUnlocked();
    const mode = !configured ? "setup" : (unlocked ? "ready" : "locked");

    const section = el("section", "sync-panel");
    section.append(buildHead(status));

    if (!syncReady()) {
      section.append(el("p", "sub muted", "同步模块没加载，检查页面是否引入了 js/sync-*.js。"));
      section.append(buildStamp());
      return section;
    }

    section.append(el("p", "sub", "数据先在本地加密（PBKDF2 + AES-GCM），再传到腾讯云 CloudBase 云存储；"
      + "云端只存密文，主密码和 API Key 不上云。"));

    if (mode !== "ready") section.append(buildForm(mode));
    if (mode === "locked") {
      section.append(el("p", "sub muted", "这一页还没解锁。想省事可以勾上「在这台设备上记住」。"));
    }

    section.append(buildActions(mode));

    // key-mismatch 只在解锁后能给操作入口：锁着的时候密码框就是下面那个解锁框，
    // 让用户先解锁，状态一变这里自己就出来了。
    if (mode === "ready" && status.code === "key-mismatch") section.append(buildRealign());

    if (note) section.append(el("p", "sync-note is-" + noteKind, note));

    section.append(buildScope());

    const conflicts = buildConflicts();
    if (conflicts) section.append(conflicts);

    section.append(buildHealthBox(mode));

    if (mode === "ready") {
      const config = currentConfig();
      const qr = buildQr(config);
      if (qr) section.append(qr);
    }

    // 事件绑定：整块重画之后重新挂一次，简单直接
    const go = section.querySelector("#wb-sync-go");
    if (go) {
      go.addEventListener("click", () => {
        const env = String((section.querySelector("#wb-sync-env") || {}).value || "").trim();
        const site = String((section.querySelector("#wb-sync-site") || {}).value || "").trim();
        const password = String((section.querySelector("#wb-sync-password") || {}).value || "");
        const remember = !!(section.querySelector("#wb-sync-remember") || {}).checked;
        if (mode === "setup") {
          if (!env) {
            setNote("先填环境 ID", "error");
            paint();
            return;
          }
          if (password.length < 6) {
            setNote("同步密码至少 6 位", "error");
            paint();
            return;
          }
          enable({ env, site }, password, remember);
        } else {
          unlock(password, remember);
        }
      });
    }
    const now = section.querySelector("#wb-sync-now");
    if (now) now.addEventListener("click", syncNow);
    const pullNow = section.querySelector("#wb-sync-pull");
    if (pullNow) pullNow.addEventListener("click", pullFromCloud);
    const testNow = section.querySelector("#wb-sync-test");
    if (testNow) testNow.addEventListener("click", testConnection);
    const realign = section.querySelector("#wb-sync-realign-go");
    if (realign) {
      realign.addEventListener("click", () => {
        const password = String((section.querySelector("#wb-sync-realign-password") || {}).value || "");
        const remember = !!(section.querySelector("#wb-sync-realign-remember") || {}).checked;
        if (!password) {
          setNote("先填同步密码", "error");
          paint();
          return;
        }
        realignTo(password, remember);
      });
    }
    const off = section.querySelector("#wb-sync-off");
    if (off) off.addEventListener("click", disable);

    section.append(buildStamp());

    return section;
  }

  function paint() {
    if (!container) return;
    container.innerHTML = "";
    container.append(build());
  }

  /* ===== 冲突副本操作 ===== */

  async function viewConflict(item) {
    const text = await root.Workbench.readText(item.path);
    const short = text == null ? "这份副本已经不在了" : String(text).slice(0, 800);
    if (root.Nav && root.Nav.ask) {
      root.Nav.ask({ title: item.title || item.path, text: short, okText: "知道了", cancelText: "关闭" });
    }
  }

  async function restoreConflict(item) {
    try {
      await root.Sync.restoreConflict(item);
      setNote("已恢复：" + (item.title || item.path), "ok");
      toast("已恢复");
    } catch (err) {
      setNote((err && err.message) || "恢复失败", "error");
    }
    paint();
  }

  async function dropConflict(item) {
    try {
      await root.Sync.removeConflict(item);
      setNote("已删除副本", "info");
    } catch (err) {
      setNote((err && err.message) || "删除失败", "error");
    }
    paint();
  }

  /* ===== 配置读取 ===== */

  let current = null;   // 解锁后拿到的配置（含 env/site）

  function currentConfig() {
    return current;
  }

  function presetEnv() {
    try {
      const param = new URLSearchParams(location.search).get("sync");
      // ?sync=1 是托盘菜单「打开同步状态」的开关，不是环境 ID，别回填
      const value = param ? param.trim() : "";
      if (value && value !== "1") return value;
    } catch (err) {
      /* 地址栏没带参数 */
    }
    try {
      return localStorage.getItem(ENV_HINT_KEY) || "";
    } catch (err) {
      return "";
    }
  }

  // 环境 ID 不算秘密（导到手机上的链接里也带着），留一份明文只为回显，省得每次重填
  function saveEnvHint(env) {
    try {
      localStorage.setItem(ENV_HINT_KEY, env || "");
    } catch (err) {
      /* 隐私模式写不了就算了 */
    }
  }

  function clearEnvHint() {
    try {
      localStorage.removeItem(ENV_HINT_KEY);
    } catch (err) {
      /* 忽略 */
    }
  }

  /* ===== 独立对话框（手机端顶栏入口） ===== */

  function openDialog() {
    let dialog = document.getElementById("wb-sync-dialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "wb-sync-dialog";
      dialog.className = "code-dialog wb-sync";
      dialog.innerHTML = '<div class="sync-slot"></div><div class="dialog-actions">'
        + '<span class="dialog-spacer"></span>'
        + '<button type="button" class="btn primary" id="wb-sync-dialog-close">完成</button></div>';
      document.body.append(dialog);
      dialog.querySelector("#wb-sync-dialog-close").addEventListener("click", () => dialog.close());
    }
    mount(dialog.querySelector(".sync-slot"));
    if (!dialog.open) dialog.showModal();
  }

  function mount(node) {
    if (!node) return;
    container = node;
    if (!listening && syncReady()) {
      root.Sync.onChange(() => {
        // 同步跑完状态就变了，健康度和同步范围都得重新取一次
        healthCache = { at: 0, data: null };
        scopeCache = { at: 0, data: null };
        paint();
      });
      listening = true;
    }
    paint();
  }

  // 解锁成功后把配置留一份，二维码要用
  function rememberConfig(config) {
    current = config;
  }

  root.SyncUI = { mount, openDialog, paint: () => paint(), rememberConfig };
})(typeof window !== "undefined" ? window : globalThis);
