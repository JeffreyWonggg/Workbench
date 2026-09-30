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
      root.Sync.setRemote(remote);
      if (remember) await root.SyncCrypto.remember();
      else root.SyncCrypto.forget();
      const direction = await askDirection();
      if (!direction) {
        setNote("已连上，等你选好第一次同步的方向再开始", "info");
        return;
      }
      await root.Sync.firstRun(direction);
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
    setNote(result && result.ok
      ? "同步完成" + (result.conflicts ? "，产生了 " + result.conflicts + " 个冲突副本" : "")
      : ((result && result.message) || "同步失败"), result && result.ok ? "ok" : "error");
    busy = false;
    paint();
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

  function askDirection() {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "code-dialog";
      dialog.innerHTML = [
        "<h2>第一次同步</h2>",
        '<p class="sub">云端还没有这份数据（或者你在这台设备上换了个新环境）。'
          + "要拿哪边当底子？选错也不会丢东西——被覆盖的那边会存成冲突副本。</p>",
        '<div class="dialog-actions">',
        '  <button type="button" class="btn" data-dir="pull">以云端为准，覆盖本机</button>',
        '  <span class="dialog-spacer"></span>',
        '  <button type="button" class="btn" data-dir="cancel">取消</button>',
        '  <button type="button" class="btn primary" data-dir="push">以本机为准，推上去</button>',
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

  /* ===== 渲染 ===== */

  function buildHead(status) {
    const wrap = el("div", "sync-head");
    wrap.append(el("h3", null, "云同步"));
    const line = el("div", "sync-state");
    line.append(el("span", dotClass(status.state)), el("span", "sync-state-text", stateLabel(status)));
    const stamp = ago(status.lastSyncAt);
    if (stamp) line.append(el("span", "sync-when muted", "上次同步 " + stamp));
    wrap.append(line);
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
      site.autocomplete = "off";
      site.placeholder = "https://xxx.tcloudbaseapp.com";
      siteField.append(site);
      form.append(siteField);
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

  function buildActions(mode) {
    const row = el("div", "dialog-actions");
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "btn primary";
    primary.id = "wb-sync-go";
    primary.textContent = mode === "setup" ? "开启同步" : "解锁并同步";
    primary.disabled = busy;
    row.append(primary);

    if (mode === "ready") {
      const now = document.createElement("button");
      now.type = "button";
      now.className = "btn";
      now.id = "wb-sync-now";
      now.textContent = "立即同步";
      now.disabled = busy;
      row.append(now);
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
      return section;
    }

    section.append(el("p", "sub", "数据先在本地加密（PBKDF2 + AES-GCM），再传到腾讯云 CloudBase 云存储；"
      + "云端只存密文，主密码和 API Key 不上云。"));

    if (mode !== "ready") section.append(buildForm(mode));
    if (mode === "locked") {
      section.append(el("p", "sub muted", "这一页还没解锁。想省事可以勾上「在这台设备上记住」。"));
    }

    section.append(buildActions(mode));

    if (note) section.append(el("p", "sync-note is-" + noteKind, note));

    const conflicts = buildConflicts();
    if (conflicts) section.append(conflicts);

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
    const off = section.querySelector("#wb-sync-off");
    if (off) off.addEventListener("click", disable);

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
      if (param && param.trim()) return param.trim();
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
      root.Sync.onChange(() => paint());
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
