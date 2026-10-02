(function (root) {
  /* 「DeepSeek」卡片
     只显示官方接口 GET /user/balance 直接给回来的数字：
       充值余额 topped_up_balance、总额 total_balance、赠金 granted_balance。
     消费（当天 / 当月）这里不再显示。官方没有用量或账单接口，那两个数只能拿余额快照做减法，
     而减法遇到充值就会算出负数、被 Math.max(0) 压成 0，当天要等到花超充值额才重新有数，
     当月更是整月少算——算不准不如不算。要看消费请点「说明」里的平台用量页链接。
     余额缓存落在数据文件夹的 deepseek.json（明文，可读可改），断网时显示上次的数字。 */

  const ENDPOINT = "https://api.deepseek.com/user/balance";
  const FILE = "deepseek.json";
  const FRESH_MS = 5 * 60 * 1000;

  let store = null;
  let lastError = "";
  let busy = false;

  function emptyStore() {
    return { version: 3, currency: "CNY", last: null };
  }

  // 旧版本（v2）的 days 是给消费计算用的，直接丢掉；下次写盘时文件就跟着瘦下来
  function normalize(raw) {
    const base = emptyStore();
    if (!raw || typeof raw !== "object") return base;
    const last = raw.last && typeof raw.last === "object" ? raw.last : null;
    return {
      version: 3,
      currency: typeof raw.currency === "string" && raw.currency ? raw.currency : base.currency,
      last: last ? {
        at: String(last.at || ""),
        currency: String(last.currency || base.currency),
        total: String(last.total == null ? "" : last.total),
        granted: String(last.granted == null ? "" : last.granted),
        toppedUp: String(last.toppedUp == null ? "" : last.toppedUp),
        isAvailable: last.isAvailable !== false
      } : null
    };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function apiKey() {
    return String(root.DEEPSEEK_API_KEY || "").trim();
  }

  function money(value, currency) {
    const number = Number(value);
    const symbol = currency === "USD" ? "$" : "¥";
    return symbol + (Number.isFinite(number) ? number.toFixed(2) : "—");
  }

  function clockText(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /* ===== 取数 ===== */

  async function requestBalance() {
    const token = apiKey();
    if (!token) throw new Error("没有配置密钥：在 js/openrouter.local.js 里写 window.DEEPSEEK_API_KEY");
    let response;
    try {
      response = await fetch(ENDPOINT, {
        headers: { Authorization: "Bearer " + token, Accept: "application/json" }
      });
    } catch (err) {
      throw new Error("连不上 api.deepseek.com（检查网络或代理）");
    }
    if (response.status === 401) throw new Error("密钥被拒绝（401），检查 DEEPSEEK_API_KEY 是否有效");
    if (!response.ok) throw new Error(`接口返回 ${response.status}`);
    const payload = await response.json();
    const infos = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
    if (!infos.length) throw new Error("接口没有返回余额");
    const pick = infos.find((item) => item.currency === store.currency) || infos[0];
    return {
      at: new Date().toISOString(),
      currency: pick.currency || "CNY",
      total: String(pick.total_balance == null ? "" : pick.total_balance),
      granted: String(pick.granted_balance == null ? "" : pick.granted_balance),
      toppedUp: String(pick.topped_up_balance == null ? "" : pick.topped_up_balance),
      isAvailable: payload.is_available !== false
    };
  }

  async function refresh(manual) {
    if (busy) return;
    busy = true;
    paintBusy(true);
    try {
      const latest = await requestBalance();
      store.currency = latest.currency;
      store.last = latest;
      await Workbench.writeJson(FILE, store);
      lastError = "";
      if (manual) Nav.toast("余额已更新");
    } catch (err) {
      lastError = err && err.message ? err.message : "读取失败";
      if (manual) Nav.toast("没有更新：" + lastError);
    } finally {
      busy = false;
      paintBusy(false);
      render();
    }
  }

  /* ===== 渲染 ===== */

  function paintBusy(state) {
    const button = document.getElementById("usage-refresh");
    if (button) button.disabled = state;
  }

  function statBox(label, value) {
    const box = el("div", "usage-stat");
    box.append(el("span", "usage-label", label), el("strong", "usage-value", value));
    return box;
  }

  function render() {
    const card = document.getElementById("usage-card");
    const body = document.getElementById("usage-body");
    if (!card || !body) return;
    card.hidden = false;
    body.innerHTML = "";

    const last = store.last;
    if (!last) {
      const empty = el("p", "usage-foot muted");
      empty.textContent = lastError ? "读不到余额：" + lastError : "正在读取余额…";
      body.append(empty);
      if (lastError) body.append(button("重新读取", () => refresh(true)));
      return;
    }

    const currency = last.currency;
    const stats = el("div", "usage-stats");
    stats.append(statBox("充值余额", money(last.toppedUp, currency)));
    body.append(stats);

    const foot = el("p", "usage-foot muted");
    const parts = [
      "总额 " + money(last.total, currency),
      "赠金 " + money(last.granted, currency)
    ];
    if (last.isAvailable === false) parts.push("余额不足，接口已不可用");
    const clock = clockText(last.at);
    if (clock) parts.push(clock + " 更新");
    foot.textContent = parts.join(" · ");
    body.append(foot);

    if (lastError) {
      const warn = el("p", "usage-foot muted");
      warn.textContent = "上次刷新失败：" + lastError;
      body.append(warn);
    }
  }

  function button(label, onClick, iconName) {
    const node = el("button", "linkish");
    node.type = "button";
    if (iconName && root.Nav && Nav.icon) node.append(Nav.icon(iconName));
    node.append(document.createTextNode(label));
    node.addEventListener("click", onClick);
    return node;
  }

  /* ===== 说明弹窗 ===== */

  function noteDialog() {
    let dialog = document.getElementById("wb-usage-dialog");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "wb-usage-dialog";
    dialog.className = "code-dialog";
    dialog.innerHTML = [
      "<h2>DeepSeek 余额怎么来的</h2>",
      '<p class="sub">充值余额、总额、赠金都直接来自官方接口 <code>GET /user/balance</code>'
        + "（带 <code>Authorization: Bearer &lt;你的 Key&gt;</code>），浏览器直连，不经过本地服务。</p>",
      '<p class="sub">这里以前还显示「当天消费 / 当月消费」，已经去掉了：官方没有用量或账单接口，'
        + "那两个数只能拿余额快照做减法，可一充值就会被算成负数压到 0，"
        + "当天得等花超充值额才重新有数，当月更是整月少算。算不准不如不算。</p>",
      '<p class="sub">要看真实消费，用下面这个链接打开官方用量页。</p>',
      '<p class="sub">余额缓存写在数据文件夹的 <code>deepseek.json</code>（明文，可读可改）。</p>',
      '<div class="dialog-actions">',
      '  <a class="btn" href="https://platform.deepseek.com/usage" target="_blank" rel="noopener">打开平台用量页</a>',
      '  <span class="dialog-spacer"></span>',
      '  <button type="button" id="usage-note-close" class="btn primary">知道了</button>',
      "</div>"
    ].join("");
    document.body.append(dialog);
    dialog.querySelector("#usage-note-close").addEventListener("click", () => dialog.close());
    return dialog;
  }

  function openNote() {
    noteDialog().showModal();
  }

  /* ===== 入口 ===== */

  async function init() {
    const card = document.getElementById("usage-card");
    if (!card) return;
    document.getElementById("usage-refresh").addEventListener("click", () => refresh(true));
    document.getElementById("usage-note").addEventListener("click", openNote);
    try {
      store = normalize(await Workbench.readJson(FILE, emptyStore()));
    } catch (err) {
      store = emptyStore();
    }
    render();
    const age = store.last ? Date.now() - new Date(store.last.at).getTime() : Infinity;
    if (!Number.isFinite(age) || age > FRESH_MS) refresh(false);
  }

  root.DeepSeekCard = { init };
})(typeof window !== "undefined" ? window : globalThis);
