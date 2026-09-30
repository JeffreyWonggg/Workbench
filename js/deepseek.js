(function (root) {
  /* 「DeepSeek」卡片
     余额：官方接口 GET /user/balance（需 Authorization: Bearer <API Key>）。
           实测该接口回显 access-control-allow-origin，浏览器可以直连，
           不必经过本地服务，也不用重编译 workbench-host.exe。
     当天 / 当月消费：官方只提供 Chat/Responses/FIM/模型列表/余额/文件，
           **没有用量或账单接口**，所以只能拿余额快照做减法：
             当天消费 = 当天最早一次记录到的余额 − 当前余额
             当月消费 = 当月最早一次记录到的余额 − 当前余额
           每次打开首页或点「刷新」记一次，一天一条（留当天首次和末次）。
           因此这两个数字只覆盖「开始记录之后」的时段；中途充值会让数字偏小。
     记录落在数据文件夹的 deepseek.json（明文，可读可改）。 */

  const ENDPOINT = "https://api.deepseek.com/user/balance";
  const FILE = "deepseek.json";
  const FRESH_MS = 5 * 60 * 1000;
  const KEEP_DAYS = 62;

  let store = null;
  let lastError = "";
  let busy = false;

  function emptyStore() {
    return { version: 2, currency: "CNY", last: null, days: [] };
  }

  function normalizeDay(raw) {
    if (!raw || typeof raw !== "object") return null;
    const day = String(raw.d || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const first = Number(raw.first);
    const last = Number(raw.last);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
    return {
      d: day,
      firstAt: String(raw.firstAt || ""),
      first: first,
      lastAt: String(raw.lastAt || ""),
      last: last
    };
  }

  function normalize(raw) {
    const base = emptyStore();
    if (!raw || typeof raw !== "object") return base;
    const last = raw.last && typeof raw.last === "object" ? raw.last : null;
    const days = (Array.isArray(raw.days) ? raw.days : [])
      .map(normalizeDay)
      .filter(Boolean)
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    return {
      version: 2,
      currency: typeof raw.currency === "string" && raw.currency ? raw.currency : base.currency,
      last: last ? {
        at: String(last.at || ""),
        currency: String(last.currency || base.currency),
        total: String(last.total == null ? "" : last.total),
        granted: String(last.granted == null ? "" : last.granted),
        toppedUp: String(last.toppedUp == null ? "" : last.toppedUp),
        isAvailable: last.isAvailable !== false
      } : null,
      days: days.slice(-KEEP_DAYS)
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

  const pad2 = (n) => String(n).padStart(2, "0");

  function dayKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function monthKey(date) {
    return dayKey(date).slice(0, 7);
  }

  // "2026-09-30" → "9月30日"
  function dayText(key) {
    const parts = String(key).split("-");
    return `${Number(parts[1])}月${Number(parts[2])}日`;
  }

  /* ===== 快照：一天一条，留当天首次与末次余额 ===== */

  function recordSample(latest) {
    const total = Number(latest.total);
    if (!Number.isFinite(total)) return;
    const key = dayKey(new Date(latest.at));
    const row = store.days.find((item) => item.d === key);
    if (row) {
      row.lastAt = latest.at;
      row.last = total;
    } else {
      store.days.push({ d: key, firstAt: latest.at, first: total, lastAt: latest.at, last: total });
    }
    store.days.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const cutoff = dayKey(new Date(Date.now() - (KEEP_DAYS - 1) * 86400000));
    store.days = store.days.filter((item) => item.d >= cutoff);
  }

  function currentTotal() {
    const value = store.last ? Number(store.last.total) : NaN;
    return Number.isFinite(value) ? value : null;
  }

  // 用某段时间最早那条快照做基准，减去当前余额
  function spentSince(rows) {
    const current = currentTotal();
    if (!rows.length || current == null) return null;
    return { value: Math.max(0, rows[0].first - current), from: rows[0] };
  }

  function todaySpent() {
    const key = dayKey(new Date());
    return spentSince(store.days.filter((item) => item.d === key));
  }

  function monthSpent() {
    const key = monthKey(new Date());
    return spentSince(store.days.filter((item) => item.d.slice(0, 7) === key));
  }

  function sinceText(row) {
    if (row.d === dayKey(new Date())) {
      const clock = clockText(row.firstAt);
      return clock ? `自今天 ${clock} 起` : "自今天起";
    }
    return `自 ${dayText(row.d)} 起`;
  }

  function monthSinceText(row) {
    if (row.d === monthKey(new Date()) + "-01") return "自月初起";
    return sinceText(row);
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
      recordSample(latest);
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

  function statBox(label, value, hint) {
    const box = el("div", "usage-stat");
    box.append(el("span", "usage-label", label), el("strong", "usage-value", value));
    if (hint) box.append(el("span", "usage-hint", hint));
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
    const today = todaySpent();
    const month = monthSpent();
    const stats = el("div", "usage-stats");
    stats.append(statBox("充值余额", money(last.toppedUp, currency)));
    stats.append(today
      ? statBox("当天消费", money(today.value, currency), sinceText(today.from))
      : statBox("当天消费", "—", "等下一次记录"));
    stats.append(month
      ? statBox("当月消费", money(month.value, currency), monthSinceText(month.from))
      : statBox("当月消费", "—", "等下一次记录"));
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
      "<h2>DeepSeek 三个数字怎么来的</h2>",
      '<p class="sub">充值余额、总额、赠金直接来自官方接口 <code>GET /user/balance</code>。</p>',
      '<p class="sub">官方**没有**用量或账单接口，所以当天 / 当月消费是按余额快照做减法：'
        + "当天消费 = 当天最早一次记录到的余额 − 当前余额，当月消费同理取当月最早那次。"
        + "每次打开首页或点「刷新」记一次，一天一条。</p>",
      '<p class="sub">也就是说这两个数字只覆盖「开始记录之后」的时段：'
        + "今天是第一次记录，当天消费就得从这次记录的时刻算起；"
        + "月中才开始记录，当月消费只能从那天算起。中途充值会让数字偏小。</p>",
      '<p class="sub">快照存在数据文件夹的 <code>deepseek.json</code>（明文，可读可改），只留最近 62 天。</p>',
      '<div class="dialog-actions">',
      '  <a class="btn" href="https://platform.deepseek.com/usage" target="_blank" rel="noopener">打开平台用量页核对</a>',
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
    // 一条快照都没有时（第一次用，或从旧版本升上来），先用手上这条余额建基线，
    // 免得当天 / 当月只显示「—」等下一次刷新。
    if (!store.days.length && store.last && Number.isFinite(Number(store.last.total))) {
      recordSample(store.last);
      try {
        await Workbench.writeJson(FILE, store);
      } catch (err) {
        /* 写不进去也不影响本次显示 */
      }
    }
    render();
    const age = store.last ? Date.now() - new Date(store.last.at).getTime() : Infinity;
    if (!Number.isFinite(age) || age > FRESH_MS) refresh(false);
  }

  root.DeepSeekCard = { init };
})(typeof window !== "undefined" ? window : globalThis);
