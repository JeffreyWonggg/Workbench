(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  // 剪贴板历史由本地服务（Alt+Q / Alt+E 那套）写在 Workbench 根目录的
  // clipboard-history.json，浏览器直接取这个静态文件即可，不需要数据文件夹。
  const HISTORY_URL = "clipboard-history.json";
  const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
  const PREVIEW_LINES = 4;

  const isLocal = LOOPBACK.indexOf(location.hostname) >= 0;

  const state = {
    items: [],          // [{ text, at }]，服务端已按「最新的在最前」排好
    updatedAt: "",      // 文件里记的写入时间
    keyword: "",
    expanded: new Set() // 展开了全文的下标
  };

  Nav.boot("clipboard", async () => {
    bind();
    if (!isLocal) {
      // 剪贴板里可能有密码、密钥，只在 127.0.0.1 这一页展示
      notice("剪贴板历史只在本机（127.0.0.1）显示。请用「打开工作台.bat」在本机打开这一页。");
      return;
    }
    await load();
  }, { optionalFolder: true });

  function bind() {
    $("clip-refresh").addEventListener("click", async () => {
      state.expanded.clear();
      await load();
      Nav.toast("已刷新");
    });

    const search = $("clip-search");
    search.addEventListener("input", () => {
      state.keyword = search.value.trim().toLowerCase();
      render();
    });

    $("clip-list").addEventListener("click", (event) => {
      const copy = event.target.closest("[data-copy]");
      if (copy) {
        copyText(Number(copy.dataset.copy));
        return;
      }
      const toggle = event.target.closest("[data-toggle]");
      if (toggle) toggleOne(Number(toggle.dataset.toggle));
    });
  }

  /* ===== 读取 ===== */

  async function load() {
    let payload = null;
    let failed = "";
    try {
      const response = await fetch(HISTORY_URL, { cache: "no-store" });
      if (response.status === 404) {
        failed = "empty";
      } else if (response.ok) {
        payload = await response.json();
      } else {
        failed = "read";
      }
    } catch (err) {
      failed = "offline";
    }

    if (failed === "offline") {
      notice("连不上本地服务。请先双击「打开工作台.bat」，再打开这一页。");
      state.items = [];
      state.updatedAt = "";
      render();
      return;
    }
    if (failed === "read") {
      notice("读取 clipboard-history.json 失败，稍后再试。");
      state.items = [];
      state.updatedAt = "";
      render();
      return;
    }

    const raw = payload && Array.isArray(payload.items) ? payload.items : [];
    state.items = raw.filter((item) => item && typeof item.text === "string" && item.text.length > 0);
    state.updatedAt = (payload && payload.updatedAt) || "";
    render();
    if (state.items.length === 0) {
      notice("还没有记录。复制一段文字（Ctrl+C）后，本地服务会自动记下来，再点「刷新」就能看到。");
    } else {
      notice("");
    }
  }

  function notice(message) {
    const el = $("clip-notice");
    el.textContent = message || "";
    el.hidden = !message;
  }

  /* ===== 列表 ===== */

  function visible() {
    const keyword = state.keyword;
    return state.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !keyword || item.text.toLowerCase().indexOf(keyword) >= 0);
  }

  function render() {
    const box = $("clip-list");
    box.innerHTML = "";
    const rows = visible();
    const total = state.items.length;

    const parts = [];
    if (total) parts.push("共 " + total + " 条");
    if (total && rows.length !== total) parts.push("当前显示 " + rows.length + " 条");
    if (state.updatedAt) parts.push("记录于 " + state.updatedAt);
    $("clip-count").textContent = parts.join(" · ");

    if (rows.length === 0) {
      box.append(emptyRow(total ? "没有匹配的记录，换个关键词试试。" : "这里还是空的。"));
      return;
    }
    rows.forEach(({ item, index }) => box.append(row(item, index)));
  }

  function emptyRow(text) {
    const el = document.createElement("div");
    el.className = "empty";
    el.textContent = text;
    return el;
  }

  function row(item, index) {
    const expanded = state.expanded.has(index);
    const lines = item.text.split("\n").length;
    const long = lines > PREVIEW_LINES || item.text.length > 400;

    const el = document.createElement("div");
    el.className = "clip-row";

    const head = document.createElement("div");
    head.className = "clip-head";

    const time = document.createElement("span");
    time.className = "muted clip-stamp mono";
    time.textContent = item.at || "";
    head.append(time);

    const meta = document.createElement("span");
    meta.className = "muted clip-meta";
    meta.textContent = item.text.length + " 字" + (lines > 1 ? " · " + lines + " 行" : "");
    head.append(meta);

    const spacer = document.createElement("span");
    spacer.className = "dialog-spacer";
    head.append(spacer);

    if (long) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "linkish";
      toggle.dataset.toggle = String(index);
      toggle.textContent = expanded ? "收起" : "展开";
      head.append(toggle);
    }

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "linkish";
    copy.dataset.copy = String(index);
    copy.title = "把这段文字写回剪贴板";
    copy.textContent = "复制";
    head.append(copy);

    const body = document.createElement("pre");
    body.className = "clip-text" + (long && !expanded ? " is-clamped" : "");
    body.textContent = item.text;

    el.append(head, body);
    return el;
  }

  function toggleOne(index) {
    if (state.expanded.has(index)) state.expanded.delete(index);
    else state.expanded.add(index);
    render();
  }

  async function copyText(index) {
    const item = state.items[index];
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.text);
      Nav.toast("已复制到剪贴板");
    } catch (err) {
      Nav.toast("浏览器不允许写剪贴板，请手动选中复制");
    }
  }
})();
