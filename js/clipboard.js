(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  // 剪贴板历史由本地服务（Alt+Q / Alt+E 那套）写在 Workbench 根目录的
  // clipboard-history.json，浏览器直接取这个静态文件即可，不需要数据文件夹。
  const HISTORY_URL = "clipboard-history.json";
  // 清空历史得让服务端做，用绝对地址调：它按 Origin 头认「是不是本机页面」，
  // 相对地址在别的 origin 下会被拒（和 git 那几个接口同理）
  const HOST_ORIGIN = "http://127.0.0.1:47321";
  const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
  const PREVIEW_LINES = 4;
  const PAGE_SIZE = 20;   // 每页显示这么多条，其余翻页看

  // 历史总条数的上限不在这里管：由本地服务维护（scripts/workbench-host.cs 的 ClipMaxItems），
  // 超出时那边会把最老的一条删掉。这一页只是把读到的历史分页显示出来。

  const isLocal = LOOPBACK.indexOf(location.hostname) >= 0;

  const state = {
    items: [],          // [{ text, at }]，服务端已按「最新的在最前」排好
    updatedAt: "",      // 文件里记的写入时间
    keyword: "",
    page: 1,            // 当前页（从 1 开始）；搜索、刷新都会回到第 1 页
    expanded: new Set() // 展开了全文的下标（对应 state.items 里的位置，翻页也不会串）
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
      state.page = 1;   // 最新的在最前，刷新后回到第 1 页才看得到
      await load();
      Nav.toast("已刷新");
    });

    $("clip-clear").addEventListener("click", clearAll);

    const search = $("clip-search");
    search.addEventListener("input", () => {
      state.keyword = search.value.trim().toLowerCase();
      state.page = 1;   // 换了关键词，结果集变了，留在原来那页多半是空的
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

    // 结果集变了（搜了关键词、刷新过）页码可能越界，先夹回有效范围再切
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;

    const parts = [];
    if (total) parts.push("共 " + total + " 条");
    if (total && rows.length !== total) parts.push("当前显示 " + rows.length + " 条");
    if (state.updatedAt) parts.push("记录于 " + state.updatedAt);
    $("clip-count").textContent = parts.join(" · ");

    // 没有记录时按钮点不动，省得点了才发现没什么可清的
    const clear = $("clip-clear");
    if (clear) clear.disabled = total === 0;

    if (rows.length === 0) {
      box.append(emptyRow(total ? "没有匹配的记录，换个关键词试试。" : "这里还是空的。"));
      return;
    }
    const start = (state.page - 1) * PAGE_SIZE;
    rows.slice(start, start + PAGE_SIZE).forEach(({ item, index }) => box.append(row(item, index)));
    if (pages > 1) box.append(pager(rows.length, pages));
  }

  // 分页条：跟在列表底部（同一个方框里），样式复用「代码」页那一套
  function pager(total, pages) {
    const box = document.createElement("div");
    box.className = "list-pager";

    const info = document.createElement("span");
    info.className = "muted";
    info.textContent = "共 " + total + " 条 · 第 " + state.page + "/" + pages + " 页";

    const spacer = document.createElement("span");
    spacer.className = "dialog-spacer";

    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "btn";
    prev.textContent = "上一页";
    prev.disabled = state.page <= 1;
    prev.addEventListener("click", () => goPage(state.page - 1));

    const next = document.createElement("button");
    next.type = "button";
    next.className = "btn";
    next.textContent = "下一页";
    next.disabled = state.page >= pages;
    next.addEventListener("click", () => goPage(state.page + 1));

    box.append(info, spacer, prev, next);
    return box;
  }

  function goPage(page) {
    if (page === state.page) return;
    state.page = page;
    render();
    // 翻页后把列表头带回视野，不然从第 1 页翻过来还停在屏幕中间
    const box = $("clip-list");
    if (box && box.scrollIntoView) box.scrollIntoView({ block: "start" });
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

  // 清空全部历史。交给本地服务做——历史在它内存里也有一份，
  // 只删文件的话下次复制又会把旧的写回来。
  // 剪贴板本来就不进回收站，所以这是真删，确认文案里把这点说清楚。
  async function clearAll() {
    const total = state.items.length;
    if (!total) return;
    const ok = await Nav.ask({
      title: "清空剪贴板历史",
      text: "现在这 " + total + " 条会全部删掉，不进回收站、也找不回来。",
      okText: "清空",
      danger: true
    });
    if (!ok) return;

    const button = $("clip-clear");
    button.disabled = true;
    try {
      const response = await fetch(HOST_ORIGIN + "/clipboard/clear", { method: "POST" });
      if (response.status === 403) {
        Nav.toast("被本地服务拒绝（403）。请用「打开工作台.bat」以 http://127.0.0.1:47321 打开本页");
        button.disabled = false;
        return;
      }
      if (!response.ok) throw new Error("HTTP " + response.status);
    } catch (err) {
      Nav.toast("清空失败，本地服务可能没在跑");
      button.disabled = false;
      return;
    }
    state.expanded.clear();
    state.page = 1;
    await load();      // 重新读一遍：文件现在是一份空历史，头部条数会跟着归零
    Nav.toast("已清空剪贴板历史");
  }
})();
