(function (root) {
  const PAGES = [
    { id: "home", href: "index.html", label: "工作台", icon: "home" },
    { id: "project", href: "project.html", label: "项目", icon: "project" },
    { id: "todo", href: "todo.html", label: "待办", icon: "todo" },
    { id: "weekly", href: "weekly.html", label: "周报", icon: "weekly" },
    { id: "notes", href: "notes.html", label: "笔记", icon: "notes" },
    { id: "resources", href: "resources.html", label: "资料库", icon: "resources" },
    { id: "ledger", href: "ledger.html", label: "记账", icon: "ledger" },
    { id: "recipes", href: "recipes.html", label: "菜谱", icon: "recipe" },
    { id: "chart", href: "chart.html", label: "记谱", icon: "chart" },
    { id: "shortcuts", href: "shortcuts.html", label: "快捷方式", icon: "shortcut" },
    { id: "clipboard", href: "clipboard.html", label: "剪贴板", icon: "clipboard" },
    { id: "files", href: "files.html", label: "收藏", icon: "files" },
    { id: "code", href: "code.html", label: "代码", icon: "code" },
    { id: "lan", href: "lan.html", label: "局域网传文件", icon: "lan" },
    { id: "sn", href: "sn.html", label: "产品目录查询", icon: "sn" },
    { id: "version", href: "version.html", label: "更新软件版本", icon: "version" },
    { id: "trash", href: "trash.html", label: "回收站", icon: "trash" },
    { id: "about", href: "about.html", label: "关于", icon: "info" }
  ];

  // 侧栏排序：拖动后存进 localStorage（每台设备各自记忆）。只认有效 id，
  // 认不出的（新版本加的页面）自动排在默认位置，删掉的不影响。
  const NAV_ORDER_KEY = "wb-nav-order";

  // 被「设置」里关掉的页面。关掉只是不显示（侧栏和 Ctrl+K 都不出现），
  // 页面本身还在，直接输网址照样能打开；排序位置也保留，重新打开时回到原来的位置。
  const HIDDEN_KEY = "wb-hidden-pages";

  function readIdList(key) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(raw) ? raw.filter((id) => PAGES.some((page) => page.id === id)) : [];
    } catch (err) {
      return []; // 存坏了就按默认
    }
  }

  function writeIdList(key, ids) {
    try { localStorage.setItem(key, JSON.stringify(ids)); } catch (err) { /* 隐私模式下存不了，只影响本次 */ }
  }

  // 全部页面的顺序（含被关掉的）：排序存的是完整列表，所以关掉再打开不会丢位置
  function navOrder() {
    const saved = readIdList(NAV_ORDER_KEY);
    const known = new Set(saved);
    return saved.map((id) => PAGES.find((page) => page.id === id))
      .concat(PAGES.filter((page) => !known.has(page.id)));
  }

  function hiddenPages() {
    return new Set(readIdList(HIDDEN_KEY));
  }

  function saveNavOrder(pages) {
    writeIdList(NAV_ORDER_KEY, pages.map((page) => page.id));
  }

  function setPageHidden(id, hidden) {
    const ids = hiddenPages();
    if (hidden) ids.add(id);
    else ids.delete(id);
    writeIdList(HIDDEN_KEY, Array.from(ids));
  }

  // 离开本机 exe 就活不了的页面：手机上不给入口，点了只会报错
  const DESKTOP_ONLY = ["code", "version", "sn", "clipboard", "lan"];

  // 本机地址 = 能用到 workbench-host.exe；通过托管域名或局域网 IP 访问都算「远程」
  function isLocalHost() {
    const host = location.hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  }

  // 侧栏和命令面板里实际展示的页面
  function navPages() {
    const hidden = hiddenPages();
    const remote = !isLocalHost();
    return navOrder().filter((page) => {
      if (hidden.has(page.id)) return false;
      if (remote && DESKTOP_ONLY.indexOf(page.id) >= 0) return false;
      return true;
    });
  }

  // 内联 SVG 图标，避免外部依赖。symbol 定义一次，全局用 <use> 引用。
  const ICONS = {
    home: '<path d="M4 11l8-6.5 8 6.5v8.5a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z"/>',
    todo: '<path d="M4 7.5l1.8 1.8L9 6"/><path d="M12.5 7.5h7.5M12.5 12.5h7.5M12.5 17.5h7.5"/><path d="M4 17.5l1.8 1.8L9 16"/>',
    weekly: '<path d="M6.5 4h7l4.5 4.5V20h-11z"/><path d="M13.5 4v4.5H18"/><path d="M9.5 13h5M9.5 16.5h5"/>',
    notes: '<path d="M5.5 4.5h8l5 5v10h-13z"/><path d="M13.5 4.5v5h5"/><path d="M8.5 14h7M8.5 17h4"/>',
    resources: '<path d="M4.5 7.5h15v12h-15z"/><path d="M8 7.5v-3h8v3M8.5 12h7M8.5 15.5h4"/>',
    lan: '<path d="M8 19V5M8 5l-3 3M8 5l3 3"/><path d="M16 5v14M16 19l-3-3M16 19l3 3"/>',
    sn: '<circle cx="10" cy="10" r="6"/><path d="M14.5 14.5L20 20"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
    version: '<path d="M6 3.5h8l4 4V20.5H6z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h6"/>',
    project: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
    run: '<path d="M4 5.5h16v13H4z"/><path d="M9.5 9.2l5 2.8-5 2.8z"/>',
    code: '<circle cx="6.5" cy="6.5" r="2.4"/><circle cx="6.5" cy="17.5" r="2.4"/><circle cx="17.5" cy="12" r="2.4"/><path d="M6.5 9v6"/><path d="M8.9 6.5h2.4a3.8 3.8 0 0 1 3.8 3.8"/>',
    recipe: '<path d="M4 11.5h13a6.5 6.5 0 0 1-6.5 6.5A6.5 6.5 0 0 1 4 11.5z"/><path d="M4 11.5c0-2 1.6-3.5 3.6-3.5h5.8c2 0 3.6 1.5 3.6 3.5"/><path d="M20 6.5v11"/><path d="M2.8 20.5h15.4"/>',
    shortcut: '<path d="M13.5 3.5L6 13h5l-1.5 7.5L17 10.5h-5z"/>',
    chart: '<path d="M9 17V5l10-2v12"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
    ledger: '<path d="M4.5 7.5h15v12h-15z"/><path d="M4.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h9.5"/><circle cx="15.8" cy="13.5" r="1.4"/>',
    clipboard: '<path d="M9 4.5H7.5A1.5 1.5 0 0 0 6 6v13a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V6a1.5 1.5 0 0 0-1.5-1.5H15"/><path d="M9 3.6h6v2.8H9z"/><path d="M9.2 12h5.6M9.2 15.5h3.6"/>',
    files: '<path d="M15.5 7.2l-6.1 6.1a2.9 2.9 0 0 0 4.1 4.1l6.1-6.1a4.8 4.8 0 0 0-6.8-6.8l-6.4 6.4a6.8 6.8 0 0 0 9.6 9.6l5-5"/>',
    refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5V9H15"/>',
    upload: '<path d="M12 19.5V8.5M7.5 13L12 8.5l4.5 4.5"/><path d="M5 4.5h14"/>',
    download: '<path d="M12 4.5v11M7.5 11L12 15.5l4.5-4.5"/><path d="M5 19.5h14"/>',
    copy: '<path d="M8.5 8.5h11v11h-11z"/><path d="M15.5 8.5v-4h-11v11h4"/>',
    tag: '<path d="M11.5 3.5H20v8.5l-8.6 8.6L2.9 12.1z"/><circle cx="16" cy="7.9" r="1.3"/>',
    chevron: '<path d="M9.5 5.5l6.5 6.5-6.5 6.5"/>',
    info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.7h.01M12 11.2v5.3"/>',
    check: '<path d="M4.5 12.5l5 5 10-11"/>',
    edit: '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M14.5 5.5l4 4"/>',
    trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    grip: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/>'
  };

  function mountSprite() {
    if (document.getElementById("icon-sprite")) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "icon-sprite";
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = Object.keys(ICONS)
      .map((key) => `<symbol id="i-${key}" viewBox="0 0 24 24">${ICONS[key]}</symbol>`)
      .join("");
    document.body.append(svg);
  }

  function icon(name, extra) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", extra ? `ico ${extra}` : "ico");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  // 第二个参数可选：{ label, onSelect } —— 用于「已删除 / 撤销」这类需要补救的动作
  function toast(message, action) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      document.body.appendChild(el);
    }
    clearTimeout(toast.timer);
    el.innerHTML = "";
    const text = document.createElement("span");
    text.className = "toast-text";
    text.textContent = message;
    el.append(text);
    if (action && action.label && typeof action.onSelect === "function") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toast-action";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        clearTimeout(toast.timer);
        el.classList.remove("show");
        action.onSelect();
      });
      el.append(button);
      toast.timer = setTimeout(() => el.classList.remove("show"), 6000);
    } else {
      toast.timer = setTimeout(() => el.classList.remove("show"), 1600);
    }
    el.classList.add("show");
  }

  const LOCAL_ORIGIN = "http://127.0.0.1:47321";

  if (location.protocol === "file:") {
    const pageName = location.pathname.split("/").pop() || "index.html";
    fetch(LOCAL_ORIGIN + "/index.html", { method: "HEAD" }).then((response) => {
      if (response.ok) location.replace(LOCAL_ORIGIN + "/" + pageName + location.search + location.hash);
    }).catch(() => {});
  }

  // 当前页面 id：设置里改了显示项之后要原地重画侧栏，得知道高亮哪一个
  let activePage = "";

  function mount(page) {
    activePage = page;
    mountSprite();
    const aside = document.getElementById("sidebar");
    aside.innerHTML = "";
    const brand = document.createElement("div");
    brand.className = "brand";
    const title = document.createElement("strong");
    title.textContent = "工作台";
    const sub = document.createElement("span");
    sub.textContent = "离线优先 · 本地存储";
    brand.append(title, sub);

    const nav = document.createElement("nav");
    nav.className = "nav-list";
    renderNavItems(nav, page);

    const foot = document.createElement("div");
    foot.className = "side-foot";
    const folder = document.createElement("div");
    folder.id = "folder-name";
    folder.className = "folder-name";
    const folderDot = document.createElement("span");
    folderDot.id = "folder-dot";
    folderDot.className = "folder-dot";
    folderDot.hidden = true;
    const folderLabel = document.createElement("span");
    folderLabel.id = "folder-label";
    folderLabel.className = "folder-label";
    folder.append(folderDot, folderLabel);
    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.id = "folder-btn";
    folderBtn.className = "btn ghost";
    folderBtn.textContent = "选择数据文件夹";
    const changeBtn = document.createElement("button");
    changeBtn.type = "button";
    changeBtn.id = "folder-change-btn";
    changeBtn.className = "btn ghost";
    changeBtn.textContent = "更换文件夹";
    changeBtn.hidden = true;
    const projectBtn = document.createElement("button");
    projectBtn.type = "button";
    projectBtn.id = "project-btn";
    projectBtn.className = "btn ghost";
    projectBtn.textContent = "项目";
    projectBtn.disabled = true;
    const themeBtn = document.createElement("button");
    themeBtn.type = "button";
    themeBtn.id = "theme-btn";
    themeBtn.className = "btn ghost";
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.id = "settings-btn";
    settingsBtn.className = "btn ghost";
    settingsBtn.textContent = "设置";
    const paletteHint = document.createElement("button");
    paletteHint.type = "button";
    paletteHint.className = "side-hint";
    paletteHint.textContent = "Ctrl+K 搜索";
    paletteHint.addEventListener("click", openPalette);
    foot.append(folder, folderBtn, changeBtn, projectBtn, themeBtn, settingsBtn, paletteHint);
    aside.append(brand, nav, foot);
    rememberNavScroll(nav);

    folderBtn.addEventListener("click", onFolderClick);
    changeBtn.addEventListener("click", () => connectFolder("pick"));
    projectBtn.addEventListener("click", openProjects);
    settingsBtn.addEventListener("click", () => openSettings());
    mountSyncBadge();
    setupBlockedLinks();
    setupTheme(themeBtn);
    setupMenuToggle();
    setupPalette();
    setupShortcuts();
  }

  function renderNavItems(nav, page) {
    const prevScroll = nav.scrollTop;
    nav.innerHTML = "";
    const pages = navPages();
    if (pages.length === 0) {
      // 全被关掉时给一句话，免得看着像坏了（入口在同一栏下方的「设置」）
      const empty = document.createElement("p");
      empty.className = "nav-empty muted";
      empty.textContent = "侧栏是空的。点下面「设置」把页面打开。";
      nav.append(empty);
      nav.scrollTop = prevScroll;
      return;
    }
    pages.forEach((item) => {
      const link = document.createElement("a");
      link.href = item.href;
      const label = document.createElement("span");
      label.textContent = item.label;
      link.append(icon(item.icon), label);
      if (item.id === page) link.setAttribute("aria-current", "page");
      makeNavItemDraggable(link, item, nav, page);
      nav.append(link);
    });
    nav.scrollTop = prevScroll;
  }

  /* 侧栏每一项都是整页跳转（location.href = item.href），新页面会把侧栏整个重画，
     滚动位置必然回到最上面。这里把位置存进 sessionStorage，渲染后还原。 */
  const NAV_SCROLL_KEY = "wb-nav-scroll";

  function rememberNavScroll(nav) {
    let saved = null;
    try {
      saved = sessionStorage.getItem(NAV_SCROLL_KEY);
    } catch (err) {
      saved = null;
    }
    const apply = () => {
      const value = Number(saved);
      if (Number.isFinite(value) && value > 0) nav.scrollTop = value;
    };
    apply();
    // 字体、角标等加载完高度还会变，下一帧再补一次
    requestAnimationFrame(apply);
    nav.addEventListener("scroll", () => {
      try {
        sessionStorage.setItem(NAV_SCROLL_KEY, String(nav.scrollTop));
      } catch (err) {
        // 存不下就算了，不影响使用
      }
    });
  }

  // 拖动排序：HTML5 拖拽，按鼠标在目标项的上/下半边决定插到它前面还是后面。
  // drop 上 preventDefault，避免浏览器把链接当 URL 导航。
  function makeNavItemDraggable(link, item, nav, page) {
    link.draggable = true;
    link.title = item.label + "（拖动可调整顺序）";
    link.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", item.id);
      event.dataTransfer.effectAllowed = "move";
      link.classList.add("dragging");
    });
    link.addEventListener("dragend", () => {
      link.classList.remove("dragging");
      clearDropMarks(nav);
    });
    link.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = link.getBoundingClientRect();
      const before = (event.clientY - rect.top) < rect.height / 2;
      clearDropMarks(nav);
      link.classList.add(before ? "drop-before" : "drop-after");
    });
    link.addEventListener("dragleave", () => {
      link.classList.remove("drop-before", "drop-after");
    });
    link.addEventListener("drop", (event) => {
      event.preventDefault();
      clearDropMarks(nav);
      const dragId = event.dataTransfer.getData("text/plain");
      if (!dragId || dragId === item.id) return;
      const rect = link.getBoundingClientRect();
      const after = !((event.clientY - rect.top) < rect.height / 2);
      // 排序在完整列表上做：被关掉的页面位置也一起保存，重新打开时回到原位
      const pages = navOrder();
      const from = pages.findIndex((candidate) => candidate.id === dragId);
      if (from < 0) return;
      const moved = pages.splice(from, 1)[0];
      let to = pages.findIndex((candidate) => candidate.id === item.id);
      if (to < 0) return;
      if (after) to += 1;
      pages.splice(to, 0, moved);
      saveNavOrder(pages);
      renderNavItems(nav, page);
      refreshBadges();
    });
  }

  function clearDropMarks(nav) {
    nav.querySelectorAll(".drop-before, .drop-after").forEach((el) => {
      el.classList.remove("drop-before", "drop-after");
    });
  }

  function dotClassOf(state) {
    if (state === "syncing") return "sync-dot is-syncing";
    if (state === "ok") return "sync-dot is-ok";
    if (state === "error") return "sync-dot is-error";
    if (state === "dirty" || state === "locked") return "sync-dot is-dirty";
    return "sync-dot is-off";
  }

  // 顶栏同步状态：小圆点 + 「同步」，点开是云同步面板。手机上比翻侧栏方便。
  // 插在页面操作按钮左边，让「工具」这类按钮始终占据最右。
  function mountSyncBadge() {
    if (!root.Sync || !root.SyncUI) return;
    const head = document.querySelector(".page-head");
    if (!head || head.querySelector("#sync-badge")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "sync-badge";
    button.className = "sync-badge";
    const dot = document.createElement("span");
    dot.className = dotClassOf(root.Sync.status().state);
    button.append(dot, document.createTextNode("同步"));
    button.addEventListener("click", () => root.SyncUI.openDialog());
    const actions = head.querySelector(".row-actions, .seg");
    if (actions && actions.parentElement === head) head.insertBefore(button, actions);
    else head.append(button);
    root.Sync.onChange((status) => {
      dot.className = dotClassOf(status.state);
      button.title = status.state === "error" ? (status.message || "同步失败") : "云同步";
    });
  }

  function setupTheme(btn) {
    const render = () => {
      const dark = document.documentElement.dataset.theme === "dark";
      btn.textContent = "";
      btn.append(icon(dark ? "sun" : "moon"), document.createTextNode(dark ? "浅色模式" : "深色模式"));
    };
    render();
    btn.addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme !== "dark";
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      try { localStorage.setItem("wb-theme", dark ? "dark" : "light"); } catch (e) {}
      render();
    });
  }

  function setupMenuToggle() {
    const shell = document.getElementById("shell");
    let btn = document.getElementById("menu-toggle");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "menu-toggle";
      btn.className = "menu-toggle";
      btn.setAttribute("aria-label", "打开菜单");
      btn.append(icon("menu"));
      document.body.append(btn);
    }
    btn.addEventListener("click", () => shell.classList.toggle("nav-open"));
    shell.addEventListener("click", (event) => {
      if (shell.classList.contains("nav-open") && !event.target.closest("#sidebar")) {
        shell.classList.remove("nav-open");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") shell.classList.remove("nav-open");
    });
  }

  function setStatus(status) {
    const folderBtn = document.getElementById("folder-btn");
    const changeBtn = document.getElementById("folder-change-btn");
    const projectBtn = document.getElementById("project-btn");
    if (status.ok) {
      paintFolder(status.folderName || "已连接", "ok");
      folderBtn.textContent = "更换文件夹";
      changeBtn.hidden = true;
      projectBtn.disabled = false;
    } else if (status.needsPermission) {
      paintFolder(status.folderName ? `待授权 · ${status.folderName}` : "待授权", "pending");
      folderBtn.textContent = "允许访问";
      changeBtn.hidden = false;
      projectBtn.disabled = true;
    } else {
      paintFolder(status.unsupported ? "当前浏览器不可用" : "未选择文件夹", "");
      folderBtn.textContent = "选择数据文件夹";
      changeBtn.hidden = true;
      projectBtn.disabled = true;
    }
  }

  function paintFolder(text, dot) {
    const folder = document.getElementById("folder-name");
    const label = document.getElementById("folder-label");
    const dotEl = document.getElementById("folder-dot");
    label.textContent = text;
    folder.title = text;
    if (dot) {
      dotEl.hidden = false;
      dotEl.dataset.state = dot;
    } else {
      dotEl.hidden = true;
      delete dotEl.dataset.state;
    }
  }

  function onFolderClick() {
    const status = Workbench.status || {};
    // 手机这类没有文件夹可用的环境，按钮改成进云同步设置
    if (status.unsupported) {
      if (root.SyncUI) openSettings(null, "sync");
      return undefined;
    }
    return connectFolder(status.needsPermission ? "grant" : "pick");
  }

  async function connectFolder(mode) {
    try {
      if (mode === "grant") await Workbench.requestAccess();
      else await Workbench.pickDirectory();
      location.reload();
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (err && err.name === "NotAllowedError") {
        toast("浏览器没有放行，请再点一次并确认允许");
        return;
      }
      toast(err && err.message ? err.message : "无法连接文件夹");
    }
  }

  function fillGate(status) {
    const gate = document.getElementById("gate");
    gate.innerHTML = "";
    gate.className = "gate";
    const card = document.createElement("div");
    card.className = "card gate-card";
    const heading = document.createElement("h1");
    const text = document.createElement("p");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn primary";
    if (status.unsupported && window.isSecureContext === false) {
      // 局域网 IP + 明文 HTTP：文件夹读写 API 被浏览器整体禁用，换任何浏览器都一样。
      // 这时劝人"换 Edge/Chrome"是误导，要说清楚真正的限制。
      heading.textContent = "数据功能仅限本机使用";
      text.textContent = "你正在通过局域网地址访问。浏览器出于安全限制，只允许在本机地址"
        + "（127.0.0.1）读写本地文件夹，所以待办、周报、笔记这类数据页面在其它设备上用不了"
        + "（换 Edge 或 Chrome 也一样）。「局域网传文件」等不需要数据文件夹的页面不受影响。"
        + "完整使用请回到主机上打开。";
      button.hidden = true;
    } else if (status.unsupported) {
      // 手机浏览器、或者非安全上下文：没有文件夹可读，但云同步能顶上
      heading.textContent = "没有可用的数据文件夹";
      text.textContent = "这个环境不支持文件夹读写（手机浏览器、或用非本机地址访问时都这样）。"
        + "在电脑上打开工作台配好云同步，这里就能直接用了——数据存在本机浏览器里，云端是权威副本。";
      if (root.SyncUI) button.textContent = "设置云同步";
      else button.hidden = true;
    } else if (status.needsPermission) {
      heading.textContent = "允许访问文件夹";
      text.textContent = "这个文件夹之前选过。浏览器需要你再允许一次读写。工作台只写自己的文件。";
      button.textContent = "允许访问";
    } else if (status.error) {
      heading.textContent = "数据没有打开";
      text.textContent = status.error;
      button.textContent = "重新选择文件夹";
    } else {
      heading.textContent = "选择数据文件夹";
      text.textContent = "待办、周报和笔记会写进你选的文件夹。不会读取现有的 Obsidian 笔记。";
      button.textContent = "选择文件夹";
    }
    const actions = document.createElement("div");
    actions.className = "gate-actions";
    button.addEventListener("click", onFolderClick);
    actions.append(button);
    if (status.needsPermission) {
      const change = document.createElement("button");
      change.type = "button";
      change.className = "btn";
      change.textContent = "更换文件夹";
      change.addEventListener("click", () => connectFolder("pick"));
      actions.append(change);
    }
    card.append(heading, text, actions);
    gate.append(card);
    gate.hidden = false;
    document.getElementById("content").hidden = true;
  }

  // 数据文件读不出来（多半是 JSON 被改坏、或上次写到一半）：
  // 与其留下一片空白加一句看不懂的报错，不如说清楚是哪个文件、还能怎么办
  function showDataError(err) {
    const gate = document.getElementById("gate");
    gate.innerHTML = "";
    gate.className = "gate";
    const card = document.createElement("div");
    card.className = "card gate-card";
    const heading = document.createElement("h1");
    heading.textContent = "数据读不出来";
    const text = document.createElement("p");
    text.textContent = (err && err.message) ? err.message : "这个页面的数据文件读不出来。";
    const actions = document.createElement("div");
    actions.className = "gate-actions";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "btn primary";
    reload.textContent = "重新加载";
    reload.addEventListener("click", () => location.reload());
    actions.append(reload);
    card.append(heading, text, actions);
    gate.append(card);
    gate.hidden = false;
    document.getElementById("content").hidden = true;
  }

  // 云同步能不能顶替本地文件夹：配过、并且这一页已经拿到密钥（输过密码，或本机记住过）
  async function cloudReady() {
    if (!root.Sync || !root.SyncCrypto) return false;
    if (!root.SyncCrypto.hasConfig()) return false;
    if (root.SyncCrypto.isUnlocked()) return true;
    try {
      return await root.SyncCrypto.recall();
    } catch (err) {
      return false;
    }
  }

  async function boot(page, onReady, options) {
    mount(page);
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      toast(reason && reason.message ? reason.message : "保存失败");
    });
    let status;
    try {
      status = await Workbench.open();
    } catch (err) {
      status = { ok: false, error: err && err.message ? err.message : "打开失败" };
      Workbench.status = status;
    }
    setStatus(status);
    refreshBadges();
    window.addEventListener("workbench-todos", refreshBadges);
    // 项目清单在别处改了（另一台设备同步过来、或别的标签页）：
    // 转成现有事件，各页的筛选下拉框自己会补上，不用每个页面各写一遍
    if (root.Workbench && root.Workbench.onChange) {
      root.Workbench.onChange(["meta.json"], () => {
        root.dispatchEvent(new CustomEvent("workbench-projects"));
      });
    }
    // 没有数据文件夹时（手机、非安全上下文）只要云同步能用就放行：
    // 数据落在 IndexedDB，云端才是权威副本。
    if (!status.ok && !(options && options.optionalFolder) && !(await cloudReady())) {
      fillGate(status);
      return;
    }
    document.getElementById("gate").hidden = true;
    document.getElementById("content").hidden = false;
    // 托盘菜单里的「打开同步状态」会带 ?sync=1 进来
    if (new URLSearchParams(location.search).get("sync") === "1" && root.SyncUI) {
      setTimeout(() => root.SyncUI.openDialog(), 300);
    }
    startShotReceiver();
    if (root.Sync) {
      try {
        await root.Sync.attach();
      } catch (err) {
        // 同步没跑起来不影响本地使用
      }
    }
    try {
      await onReady();
    } catch (err) {
      // 页面初始化炸了（最常见是某个 JSON 读不出来）就摆明说，
      // 别留一个渲染了一半的页面让人以为数据没了
      showDataError(err);
    }
  }

  function openProjects() {
    if (!Workbench.meta) return;
    let dialog = document.getElementById("project-dialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "project-dialog";
      document.body.append(dialog);
    }
    renderProjects(dialog);
    if (!dialog.open) dialog.showModal();
  }

  function renderProjects(dialog) {
    dialog.innerHTML = "";
    const heading = document.createElement("h2");
    heading.textContent = "项目";
    const sub = document.createElement("p");
    sub.className = "sub";
    sub.textContent = "待办、周报和笔记共用这份名单。";
    const rows = document.createElement("div");
    Workbench.meta.projects.forEach((name, index) => {
      const row = document.createElement("div");
      row.className = "project-row";
      const label = document.createElement("span");
      label.textContent = name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn";
      remove.textContent = "删除";
      remove.disabled = Workbench.meta.projects.length <= 1;
      remove.addEventListener("click", async () => {
        Workbench.meta.projects.splice(index, 1);
        await Workbench.saveMeta();
        renderProjects(dialog);
        root.dispatchEvent(new CustomEvent("workbench-projects"));
      });
      row.append(label, remove);
      rows.append(row);
    });
    const addRow = document.createElement("div");
    addRow.className = "add-inline";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "新项目名称";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn";
    add.textContent = "添加";
    add.addEventListener("click", async () => {
      const name = input.value.trim();
      if (!name || Workbench.meta.projects.includes(name)) return;
      Workbench.meta.projects.push(name);
      await Workbench.saveMeta();
      input.value = "";
      renderProjects(dialog);
      root.dispatchEvent(new CustomEvent("workbench-projects"));
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        add.click();
      }
    });
    addRow.append(input, add);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn primary";
    close.textContent = "关闭";
    close.addEventListener("click", () => dialog.close());
    dialog.append(heading, sub, rows, addRow, close);
  }

  function fillProjects(select, selected) {
    const current = selected == null ? select.value : selected;
    select.innerHTML = "";
    Workbench.projects(current).forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.append(option);
    });
    if (current) select.value = current;
  }

  // ===== 侧栏角标：逾期 / 今天到期条数 =====

  async function refreshBadges() {
    const link = document.querySelector('.nav-list a[href="todo.html"]');
    if (!link) return;
    let count = 0;
    try {
      const todos = await Workbench.loadTodos();
      const today = Workbench.todayIso();
      count = todos.filter((todo) => !Workbench.isDeleted(todo) && todo.state !== "DONE" && todo.due && todo.due <= today).length;
    } catch (err) {
      count = 0;
    }
    let badge = link.querySelector(".nav-badge");
    if (!count) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "nav-badge";
      link.append(badge);
    }
    badge.textContent = String(count);
    link.title = count + " 条已逾期或今天到期";
  }

  // ===== 命令面板 =====

  let paletteItems = [];
  let paletteIndex = 0;
  let paletteData = null;

  function setupPalette() {
    const overlay = document.createElement("div");
    overlay.id = "palette";
    overlay.className = "palette";
    overlay.hidden = true;

    const box = document.createElement("div");
    box.className = "palette-box";
    const input = document.createElement("input");
    input.id = "palette-input";
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = "跳转页面，或搜索待办 / 笔记 / 资料 / 软件号 / 菜谱…";
    input.setAttribute("aria-label", "命令面板");
    const list = document.createElement("div");
    list.id = "palette-list";
    list.className = "palette-list";
    box.append(input, list);
    overlay.append(box);

    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) closePalette();
    });
    input.addEventListener("input", () => {
      paletteIndex = 0;
      renderPalette();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        paletteIndex = Math.min(paletteIndex + 1, paletteItems.length - 1);
        renderPalette();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        paletteIndex = Math.max(paletteIndex - 1, 0);
        renderPalette();
      } else if (event.key === "Enter") {
        event.preventDefault();
        activatePalette(paletteItems[paletteIndex]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
      }
    });

    document.body.append(overlay);
  }

  function openPalette() {
    const overlay = document.getElementById("palette");
    if (!overlay) return;
    overlay.hidden = false;
    const input = document.getElementById("palette-input");
    input.value = "";
    paletteIndex = 0;
    renderPalette();
    input.focus();
    loadPaletteData();
  }

  function closePalette() {
    const overlay = document.getElementById("palette");
    if (overlay) overlay.hidden = true;
  }

  async function loadPaletteData() {
    if (paletteData) return;
    paletteData = { todos: [], notes: [], resources: [] };
    try {
      paletteData.todos = Workbench.activeItems(await Workbench.loadTodos());
    } catch (err) { /* 未连接数据文件夹 */ }
    try {
      paletteData.notes = Workbench.activeItems(await Workbench.loadNoteIndex());
    } catch (err) { /* ignore */ }
    // 资料库是加密的：只有本标签页解锁过才搜得到，关掉标签页即失效
    const session = Workbench.readVaultSession();
    paletteData.resources = session ? Workbench.activeItems(session.records) : [];
    paletteData.vaultLocked = !session;
    // 软件号已经迁到明文的 software.json，不用解锁也能搜
    try {
      paletteData.software = Workbench.activeItems(await Workbench.loadSoftware());
    } catch (err) { /* ignore */ }
    try {
      paletteData.recipes = Workbench.activeItems(await Workbench.loadRecipes());
    } catch (err) { /* ignore */ }
    renderPalette();
  }

  function renderPalette() {
    const list = document.getElementById("palette-list");
    const input = document.getElementById("palette-input");
    if (!list || !input) return;
    const q = input.value.trim().toLowerCase();
    const data = paletteData || { todos: [], notes: [], resources: [] };
    const items = [];

    // 被「设置」关掉的页面不在这里出现，和侧栏保持一致
    navPages().forEach((page) => {
      if (!q || page.label.toLowerCase().includes(q)) {
        items.push({ kind: "页面", label: page.label, href: page.href });
      }
    });
    if (q) {
      data.todos.forEach((todo) => {
        if (String(todo.title || "").toLowerCase().includes(q)) {
          items.push({ kind: "待办", label: todo.title, href: "todo.html#" + todo.id });
        }
      });
      data.notes.forEach((note) => {
        if (String(note.title || "").toLowerCase().includes(q)) {
          items.push({ kind: "笔记", label: note.title || "未命名", href: "notes.html?id=" + encodeURIComponent(note.id) });
        }
      });
      (data.resources || []).forEach((record) => {
        const text = [record.name, record.username, record.host, record.softwareId, record.path, record.project]
          .filter(Boolean).join(" ");
        if (text.toLowerCase().includes(q)) {
          items.push({ kind: "资料", label: record.name || text, href: "resources.html" });
        }
      });
      (data.software || []).forEach((item) => {
        const text = [item.name, item.softwareId, item.project, item.notes].filter(Boolean).join(" ");
        if (text.toLowerCase().includes(q)) {
          items.push({ kind: "软件号", label: item.name || text, href: "code.html" });
        }
      });
      (data.recipes || []).forEach((item) => {
        const text = [item.name, item.category].concat(item.ingredients || [], item.steps || [])
          .filter(Boolean).join(" ");
        if (text.toLowerCase().includes(q)) {
          items.push({ kind: "菜谱", label: item.name || text, href: "recipes.html#" + encodeURIComponent(item.id) });
        }
      });
    }

    paletteItems = items.slice(0, 40);
    if (paletteIndex >= paletteItems.length) paletteIndex = Math.max(paletteItems.length - 1, 0);
    list.innerHTML = "";
    if (!paletteItems.length) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = q ? "没有匹配结果" : "输入关键词开始搜索";
      list.append(empty);
      return;
    }
    paletteItems.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "palette-item" + (index === paletteIndex ? " on" : "");
      const label = document.createElement("span");
      label.className = "palette-label";
      label.textContent = item.label;
      const kind = document.createElement("span");
      kind.className = "palette-kind";
      kind.textContent = item.kind;
      button.append(label, kind);
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        activatePalette(item);
      });
      list.append(button);
    });
    const on = list.querySelector(".palette-item.on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }

  function activatePalette(item) {
    if (!item) return;
    closePalette();
    if (!item.href) return;
    // Ctrl+K 里搜到的待办/笔记也会指到对应页面，同样不能跳到已关掉的页面
    const page = pageOfHref(item.href);
    if (page && page.id !== activePage && hiddenPages().has(page.id)) {
      blockNotice(page);
      return;
    }
    location.href = item.href;
  }

  // ===== 快捷键 =====

  function isTyping(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
  }

  function setupShortcuts() {
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPalette();
        return;
      }
      if (isTyping(document.activeElement) || event.ctrlKey || event.metaKey || event.altKey) return;
      const overlay = document.getElementById("palette");
      const opened = overlay && !overlay.hidden;
      if (event.key === "Escape" && opened) {
        event.preventDefault();
        closePalette();
        return;
      }
      if (opened) return;
      if (event.key === "/") {
        event.preventDefault();
        const search = document.querySelector("#note-search, #resource-search, #sn-input, #recipe-search");
        if (search) search.focus();
        else openPalette();
        return;
      }
      if (event.key.toLowerCase() === "n") {
        const trigger = document.getElementById("new-note") || document.getElementById("add-toggle");
        if (trigger && !trigger.hidden) {
          event.preventDefault();
          trigger.click();
        }
      }
    });
  }

  /* ===== 公共路径选择器 =====
     版本页（挑 UpdateVersion.ini）和代码页（挑代码根目录）共用这一份实现，都走本地服务 /fs/list。
     pickPath({ mode, extensions, start, title, hint, confirmLabel }) → Promise<string|null>
       mode: "dir" 选目录（确认时用当前这一级）| "file" 选文件（点文件即选中） */

  let browsePicker = null;

  function buildBrowseDialog() {
    const dialog = document.createElement("dialog");
    dialog.id = "wb-browse-dialog";
    dialog.className = "code-dialog wb-browse";
    dialog.innerHTML = [
      '<h2 id="wb-browse-title">选择目录</h2>',
      '<p class="sub" id="wb-browse-hint"></p>',
      '<div class="dir-bar">',
      '  <button type="button" id="wb-browse-native" class="btn">浏览…</button>',
      '  <button type="button" id="wb-browse-up" class="btn">上一级</button>',
      '  <button type="button" id="wb-browse-roots" class="btn">驱动器</button>',
      '  <input id="wb-browse-path" type="text" placeholder="也可以直接粘贴路径" aria-label="路径">',
      '  <button type="button" id="wb-browse-go" class="btn">打开</button>',
      "</div>",
      '<div id="wb-browse-list" class="dir-list"></div>',
      '<p id="wb-browse-note" class="browse-note"></p>',
      '<div class="dialog-actions">',
      '  <span class="dialog-spacer"></span>',
      '  <button type="button" id="wb-browse-cancel" class="btn">取消</button>',
      '  <button type="button" id="wb-browse-ok" class="btn primary">选择此目录</button>',
      "</div>"
    ].join("");
    document.body.append(dialog);

    const find = (id) => dialog.querySelector("#" + id);
    dialog.addEventListener("close", () => settleBrowse(null));
    find("wb-browse-cancel").addEventListener("click", () => settleBrowse(null));
    find("wb-browse-native").addEventListener("click", pickNative);
    find("wb-browse-roots").addEventListener("click", () => loadBrowse(""));
    find("wb-browse-up").addEventListener("click", () => {
      if (dialog.dataset.parent) loadBrowse(dialog.dataset.parent);
    });
    find("wb-browse-go").addEventListener("click", () => loadBrowse(find("wb-browse-path").value.trim()));
    find("wb-browse-ok").addEventListener("click", () => {
      if (browsePicker && browsePicker.mode === "file") {
        const typed = find("wb-browse-path").value.trim();
        if (typed) settleBrowse(typed);
        return;
      }
      settleBrowse(dialog.dataset.current || "");
    });
    find("wb-browse-list").addEventListener("click", (event) => {
      const row = event.target.closest("[data-path]");
      if (!row) return;
      if (row.dataset.kind === "file") settleBrowse(row.dataset.path);
      else loadBrowse(row.dataset.path);
    });
    return dialog;
  }

  function ensureBrowseDialog() {
    return document.getElementById("wb-browse-dialog") || buildBrowseDialog();
  }

  function settleBrowse(value) {
    const picker = browsePicker;
    browsePicker = null;
    const dialog = document.getElementById("wb-browse-dialog");
    if (dialog && dialog.open) dialog.close();
    if (picker) picker.resolve(value || null);
  }

  async function loadBrowse(path) {
    const dialog = ensureBrowseDialog();
    const list = dialog.querySelector("#wb-browse-list");
    const note = dialog.querySelector("#wb-browse-note");
    const mode = browsePicker ? browsePicker.mode : "dir";
    const extensions = browsePicker ? browsePicker.extensions : [];
    list.replaceChildren();
    note.textContent = "读取中…";

    let data;
    try {
      const response = await fetch("/fs/list" + (path ? "?path=" + encodeURIComponent(path) : ""), { cache: "no-store" });
      if (!response.ok) throw new Error("list failed");
      data = await response.json();
    } catch (err) {
      note.textContent = "读不到目录。请先双击「打开工作台」启动本地服务。";
      return;
    }
    if (data.error) {
      dialog.querySelector("#wb-browse-path").value = path || "";
      note.textContent = data.error;
      return;
    }

    dialog.dataset.parent = data.parent || "";
    dialog.dataset.current = data.path || "";
    dialog.querySelector("#wb-browse-path").value = data.path || "";
    dialog.querySelector("#wb-browse-up").disabled = !data.parent;

    const rows = [];
    (data.dirs || []).forEach((dir) => rows.push({ kind: "dir", path: dir.path, label: dir.name }));
    const isRoot = !data.path;
    if (mode === "file") {
      (data.files || []).forEach((file) => {
        const name = String(file.name || "");
        if (extensions.length && !extensions.some((ext) => name.toLowerCase().endsWith(ext))) return;
        rows.push({ kind: "file", path: file.path, label: name, size: file.size });
      });
    }
    rows.forEach((item) => list.append(browseRow(item)));

    if (!rows.length) {
      note.textContent = isRoot
        ? "没有可用的驱动器。"
        : (mode === "file" ? "这个目录里没有子目录，也没有匹配的文件。" : "这个目录里没有子目录。");
    } else if (data.truncated) {
      note.textContent = "条目太多，只列出了前 500 项。可以直接把完整路径粘到输入框。";
    } else {
      note.textContent = "";
    }
  }

  function browseRow(item) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dir-row";
    row.dataset.path = item.path;
    row.dataset.kind = item.kind;
    const label = document.createElement("span");
    label.className = "dir-name";
    label.textContent = item.label;
    row.append(label);
    if (item.kind === "file") {
      const size = document.createElement("span");
      size.className = "muted";
      size.textContent = formatFileSize(item.size);
      row.append(size);
    }
    return row;
  }

  // 走 Windows 原生对话框：选目录用文件夹对话框，选文件用打开对话框。
  // 弹窗是在服务端进程里弹的（/pick-file），没连上本地服务或版本太旧时会失败，
  // 失败不抛错，退回页内列表继续用。
  async function pickNative() {
    const dialog = ensureBrowseDialog();
    const picker = browsePicker;
    if (!picker) return;
    const button = dialog.querySelector("#wb-browse-native");
    const note = dialog.querySelector("#wb-browse-note");
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "等待选择…";
    note.textContent = "已打开 Windows 对话框，请在那里选择";
    try {
      const payload = {
        mode: picker.mode,
        path: dialog.querySelector("#wb-browse-path").value.trim() || dialog.dataset.current || ""
      };
      if (picker.title) payload.title = picker.title;
      if (picker.mode === "file" && picker.extensions.length) payload.extensions = picker.extensions;
      const response = await fetch("/pick-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      let data = null;
      try {
        data = await response.json();
      } catch (err) {
        note.textContent = "本地服务没有回应（可能版本太旧，需要重新编译 workbench-host.exe）。用上面的列表选。";
        return;
      }
      if (!response.ok || !data || !data.ok) {
        note.textContent = (data && data.error) || "打不开 Windows 对话框。用上面的列表选。";
        return;
      }
      if (data.cancelled || !data.path) {
        note.textContent = "已取消";
        return;
      }
      settleBrowse(data.path);
    } catch (err) {
      note.textContent = "打不开 Windows 对话框（需要本地服务）。用上面的列表选。";
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  function formatFileSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
    return (value / 1024 / 1024).toFixed(1) + " MB";
  }

  function pickPath(options) {
    const opts = options || {};
    const dialog = ensureBrowseDialog();
    return new Promise((resolve) => {
      browsePicker = {
        resolve,
        mode: opts.mode === "file" ? "file" : "dir",
        title: String(opts.title || ""),
        extensions: Array.isArray(opts.extensions)
          ? opts.extensions.map((item) => String(item).toLowerCase())
          : []
      };
      dialog.dataset.mode = browsePicker.mode;
      dialog.querySelector("#wb-browse-title").textContent = opts.title
        || (browsePicker.mode === "file" ? "选择文件" : "选择目录");
      dialog.querySelector("#wb-browse-hint").textContent = opts.hint
        || (browsePicker.mode === "file"
          ? "点文件即可选中；也可以把完整路径粘贴到输入框再点「用这个路径」。"
          : "点目录进入下一级，「" + (opts.confirmLabel || "选择此目录") + "」用的是当前这一级。");
      dialog.querySelector("#wb-browse-ok").textContent = browsePicker.mode === "file"
        ? "用这个路径"
        : (opts.confirmLabel || "选择此目录");
      dialog.showModal();
      loadBrowse(opts.start || "");
    });
  }

  /* ===== 统一确认弹窗 =====
     替代浏览器原生 confirm()：原生弹窗由系统绘制，和本项目的毛玻璃弹窗不是一套观感。
     ask({ title, text, okText, cancelText, danger }) → Promise<boolean>
       点「确定」为 true；点「取消」、按 Esc、点窗口外的遮罩都算取消 false。
     文案里的换行 \n 会原样显示。 */

  let confirmAsk = null;

  function buildConfirmDialog() {
    const dialog = document.createElement("dialog");
    dialog.id = "wb-confirm-dialog";
    dialog.className = "code-dialog wb-confirm";
    dialog.innerHTML = [
      '<h2 id="wb-confirm-title">确认</h2>',
      '<p class="sub" id="wb-confirm-text"></p>',
      '<div class="dialog-actions">',
      '  <span class="dialog-spacer"></span>',
      '  <button type="button" id="wb-confirm-cancel" class="btn">取消</button>',
      '  <button type="button" id="wb-confirm-ok" class="btn primary">确定</button>',
      "</div>"
    ].join("");
    document.body.append(dialog);
    const find = (id) => dialog.querySelector("#" + id);
    find("wb-confirm-cancel").addEventListener("click", () => settleConfirm(false));
    find("wb-confirm-ok").addEventListener("click", () => settleConfirm(true));
    // Esc 和任何 dialog.close() 都按取消处理
    dialog.addEventListener("close", () => settleConfirm(false));
    // 点遮罩（落在 dialog 元素自身且不在窗口矩形内）按取消处理
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom;
      if (outside) settleConfirm(false);
    });
    return dialog;
  }

  function ensureConfirmDialog() {
    return document.getElementById("wb-confirm-dialog") || buildConfirmDialog();
  }

  function settleConfirm(value) {
    const ask = confirmAsk;
    confirmAsk = null;
    const dialog = document.getElementById("wb-confirm-dialog");
    if (dialog && dialog.open) dialog.close();
    if (ask) ask.resolve(value);
  }

  function ask(options) {
    const opts = typeof options === "string" ? { text: options } : (options || {});
    const dialog = ensureConfirmDialog();
    if (confirmAsk) settleConfirm(false); // 上一次还没关（正常流程不会发生），按取消收尾
    return new Promise((resolve) => {
      confirmAsk = { resolve };
      dialog.querySelector("#wb-confirm-title").textContent = opts.title || "确认";
      dialog.querySelector("#wb-confirm-text").textContent = String(opts.text || "");
      const cancel = dialog.querySelector("#wb-confirm-cancel");
      const ok = dialog.querySelector("#wb-confirm-ok");
      cancel.textContent = opts.cancelText || "取消";
      ok.textContent = opts.okText || "确定";
      ok.className = opts.danger ? "btn danger" : "btn primary";
      dialog.showModal();
      // 危险操作默认落在「取消」上，避免一路回车把东西删了
      (opts.danger ? cancel : ok).focus();
    });
  }

  /* ===== 设置面板 =====
     目前只有一项能力：把不用的页面从侧栏（和 Ctrl+K）里关掉。
     关掉只影响显示——页面本身不动，直接输网址照样能打开，排序位置也留着。 */

  function settingsDialog() {
    let dialog = document.getElementById("wb-settings-dialog");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "wb-settings-dialog";
    dialog.className = "code-dialog wb-settings";
    dialog.innerHTML = [
      "<h2>设置</h2>",
      '<div class="settings-tabs" role="tablist">',
      '  <button type="button" class="settings-tab is-active" data-tab="pages" role="tab" aria-selected="true">页面</button>',
      '  <button type="button" class="settings-tab" data-tab="sync" role="tab" aria-selected="false">云同步</button>',
      "</div>",
      '<div class="settings-pane" data-pane="pages" role="tabpanel">',
      '  <p class="sub">关掉不用的页面，侧栏和 Ctrl+K 搜索里都不再出现。'
        + "页面本身还在，直接输网址照样能打开；位置也保留，重新打开时回到原处。</p>",
      '  <div class="settings-list" id="wb-settings-list"></div>',
      "</div>",
      '<div class="settings-pane" data-pane="sync" role="tabpanel" hidden>',
      '  <div class="sync-slot" id="wb-sync-slot"></div>',
      "</div>",
      '<div class="dialog-actions">',
      '  <button type="button" id="wb-settings-all" class="btn">全部打开</button>',
      '  <span class="dialog-spacer"></span>',
      '  <button type="button" id="wb-settings-close" class="btn primary">完成</button>',
      "</div>"
    ].join("");
    document.body.append(dialog);
    dialog.querySelector("#wb-settings-close").addEventListener("click", () => dialog.close());
    dialog.querySelector("#wb-settings-all").addEventListener("click", () => {
      writeIdList(HIDDEN_KEY, []);
      paintSettings();
      repaintNav();
    });
    dialog.querySelectorAll(".settings-tab").forEach((tab) => {
      tab.addEventListener("click", () => switchSettingsTab(dialog, tab.dataset.tab));
    });
    return dialog;
  }

  // 两个标签页各管一类：页面开关、云同步。只显示当前那一页，
  // 「全部打开」只对页面这页有意义，跟着一起收起来。
  function switchSettingsTab(dialog, name) {
    dialog.querySelectorAll(".settings-tab").forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    dialog.querySelectorAll(".settings-pane").forEach((pane) => {
      pane.hidden = pane.dataset.pane !== name;
    });
    const all = dialog.querySelector("#wb-settings-all");
    if (all) all.hidden = name !== "pages";
  }

  function paintSettings() {
    const dialog = settingsDialog();
    const list = dialog.querySelector("#wb-settings-list");
    const hidden = hiddenPages();
    list.innerHTML = "";
    navOrder().forEach((page) => {
      const row = document.createElement("label");
      row.className = "settings-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !hidden.has(page.id);
      box.dataset.page = page.id;
      box.addEventListener("change", () => {
        setPageHidden(page.id, !box.checked);
        repaintNav();
        paintSettingsFooter(dialog);
      });
      const name = document.createElement("span");
      name.className = "settings-name";
      name.textContent = page.label;
      const hint = document.createElement("span");
      hint.className = "settings-hint muted";
      hint.textContent = page.href;
      row.append(box, name, hint, moveRow(page.id));
      list.append(row);
    });
    paintSettingsFooter(dialog);
    mountSyncPanel(dialog);
  }

  // 触屏拖不动侧栏顺序，给一对上下按钮
  function moveRow(id) {
    const move = document.createElement("span");
    move.className = "settings-move";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "linkish";
    up.textContent = "↑";
    up.title = "上移";
    up.addEventListener("click", () => movePage(id, -1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "linkish";
    down.textContent = "↓";
    down.title = "下移";
    down.addEventListener("click", () => movePage(id, 1));
    move.append(up, down);
    return move;
  }

  function movePage(id, delta) {
    const pages = navOrder();
    const from = pages.findIndex((page) => page.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= pages.length) return;
    const moved = pages.splice(from, 1)[0];
    pages.splice(to, 0, moved);
    saveNavOrder(pages);
    repaintNav();
    paintSettings();
  }

  // 云同步分区：模块没加载（比如没引 js/sync-ui.js）就什么都不显示
  function mountSyncPanel(dialog) {
    const slot = dialog.querySelector("#wb-sync-slot");
    if (slot && root.SyncUI) root.SyncUI.mount(slot);
  }

  function paintSettingsFooter(dialog) {
    const hidden = hiddenPages().size;
    const all = dialog.querySelector("#wb-settings-all");
    all.disabled = hidden === 0;
    all.textContent = hidden ? "全部打开（已关 " + hidden + " 个）" : "全部打开";
  }

  function repaintNav() {
    const nav = document.querySelector(".nav-list");
    if (nav) renderNavItems(nav, activePage);
  }

  // tab 传 "sync" 就落在云同步那一页（默认「页面」）；focusId 用来高亮某一行
  function openSettings(focusId, tab) {
    paintSettings();
    const dialog = settingsDialog();
    switchSettingsTab(dialog, tab === "sync" ? "sync" : "pages");
    if (!dialog.open) dialog.showModal();
    if (focusId) highlightSetting(dialog, focusId);
  }

  // 从「这个页面关掉了」弹窗点过来时，把对应的那一行标出来并滚到眼前
  function highlightSetting(dialog, id) {
    const rows = Array.prototype.slice.call(dialog.querySelectorAll(".settings-row"));
    const row = rows.find((item) => item.querySelector("input").dataset.page === id);
    if (!row) return;
    row.classList.add("settings-hit");
    const list = dialog.querySelector("#wb-settings-list");
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    list.scrollTop += rowRect.top - listRect.top - (listRect.height - rowRect.height) / 2;
  }

  /* ===== 关掉的页面：链接不再跳过去 =====
     页面在「设置」里关掉之后，别的页面上的链接（项目页的待办/笔记/代码…）
     如果还照跳，进去只会看到"侧栏里没有它"，像坏了一样。统一拦下来，弹窗说清楚，
     并给一个「打开设置」的入口。 */

  // 链接指向哪个页面：必须同源、文件名对得上
  function pageOfHref(href) {
    if (!href) return null;
    let url;
    try {
      url = new URL(href, location.href);
    } catch (err) {
      return null;
    }
    if (url.origin !== location.origin) return null;
    const file = url.pathname.split("/").pop();
    if (!file) return null;
    return PAGES.find((page) => page.href === file) || null;
  }

  function hiddenTargetOf(link) {
    if (!link || link.hasAttribute("download") || link.target === "_blank") return null;
    const href = link.getAttribute("href");
    if (!href || href.charAt(0) === "#") return null;
    const page = pageOfHref(href);
    if (!page || page.id === activePage) return null; // 本页自己的链接不管
    return hiddenPages().has(page.id) ? page : null;
  }

  function blockNotice(page) {
    ask({
      title: "「" + page.label + "」已在设置里关闭",
      text: "这个页面在「设置」里被关掉了，所以这里的链接不再跳转。\n\n"
        + "需要用它的话，可以在设置里重新打开（" + page.href + "）。",
      okText: "打开设置",
      cancelText: "知道了"
    }).then((openIt) => {
      if (openIt) openSettings(page.id);
    });
  }

  // 冒泡阶段处理：页面自己已经 preventDefault 的（自己接管了跳转）就不插手
  function setupBlockedLinks() {
    document.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      const link = target && target.closest ? target.closest("a[href]") : null;
      const page = hiddenTargetOf(link);
      if (!page) return;
      event.preventDefault();
      blockNotice(page);
    });
  }

  /* ===== 截图领取 =====
     Alt+A 截完图点「保存」不再弹系统「另存为」，PNG 先暂存在本地服务里。
     这里轮询认领，写进数据文件夹的 screenshot/，并记一条「收藏」。
     浏览器拿不到数据文件夹的盘符，所以落盘只能在这一侧做。 */

  const HOST_ORIGIN = "http://127.0.0.1:47321";
  const SHOT_POLL_MS = 4000;
  let shotTimer = null;

  function startShotReceiver() {
    if (!isLocalHost() || shotTimer) return;
    shotTimer = setInterval(pollShots, SHOT_POLL_MS);
    pollShots();
  }

  async function pollShots() {
    // 数据文件夹没打开就没地方落盘，等打开了下一轮自然会接上
    if (!root.Workbench || !root.Workbench.fs) return;
    let list = null;
    try {
      const response = await fetch(HOST_ORIGIN + "/shots", { cache: "no-store" });
      if (!response.ok) return;
      list = await response.json();
    } catch (err) {
      return;   // 服务没在跑 / 断网，都当没有截图
    }
    if (!Array.isArray(list) || !list.length) return;
    for (const shot of list) await claimShot(shot);
  }

  async function claimShot(shot) {
    try {
      const response = await fetch(HOST_ORIGIN + "/shot?id=" + encodeURIComponent(shot.id), { cache: "no-store" });
      if (!response.ok) return;
      const blob = await response.blob();

      const index = (await root.Workbench.loadFiles()).slice();
      const taken = index.map((item) => item.path);
      const name = String(shot.name || ("截图-" + Date.now() + ".png")).replace(/[\\/:*?"<>|]/g, "_");
      let fileName = name;
      let path = "screenshot/" + fileName;
      if (taken.indexOf(path) >= 0) {
        fileName = name.replace(/\.png$/i, "") + "-" + shot.id.slice(0, 4) + ".png";
        path = "screenshot/" + fileName;
      }

      await root.Workbench.writeFile(path, blob);
      index.push({
        id: root.Workbench.uid(),
        name: fileName,
        path: path,
        size: blob.size,
        type: blob.type || "image/png",
        kind: "screenshot",
        project: "",
        note: "",
        addedAt: new Date().toISOString(),
        deletedAt: ""
      });
      await root.Workbench.saveFiles(index);
      await fetch(HOST_ORIGIN + "/shot/ack", { method: "POST", body: shot.id });
      toast("截图已存到 收藏 · screenshot/");
    } catch (err) {
      // 没落地就不 ack，下一轮再试
    }
  }

  root.Nav = { boot, toast, fillProjects, setStatus, icon, openPalette, refreshBadges, pickPath, ask, openSettings, isLocal: isLocalHost };
})(typeof window !== "undefined" ? window : globalThis);
