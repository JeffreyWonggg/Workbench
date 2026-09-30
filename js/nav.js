(function (root) {
  const PAGES = [
    { id: "home", href: "index.html", label: "工作台", icon: "home" },
    { id: "project", href: "project.html", label: "项目", icon: "project" },
    { id: "todo", href: "todo.html", label: "待办", icon: "todo" },
    { id: "weekly", href: "weekly.html", label: "周报", icon: "weekly" },
    { id: "notes", href: "notes.html", label: "笔记", icon: "notes" },
    { id: "resources", href: "resources.html", label: "资料库", icon: "resources" },
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

  function navPages() {
    let saved = [];
    try {
      const raw = JSON.parse(localStorage.getItem(NAV_ORDER_KEY) || "[]");
      if (Array.isArray(raw)) saved = raw.filter((id) => PAGES.some((page) => page.id === id));
    } catch (err) { /* 存的顺序坏了就用默认 */ }
    const known = new Set(saved);
    return saved.map((id) => PAGES.find((page) => page.id === id))
      .concat(PAGES.filter((page) => !known.has(page.id)));
  }

  function saveNavOrder(pages) {
    try { localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(pages.map((page) => page.id))); } catch (err) { }
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

  function mount(page) {
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
    const paletteHint = document.createElement("button");
    paletteHint.type = "button";
    paletteHint.className = "side-hint";
    paletteHint.textContent = "Ctrl+K 搜索";
    paletteHint.addEventListener("click", openPalette);
    foot.append(folder, folderBtn, changeBtn, projectBtn, themeBtn, paletteHint);
    aside.append(brand, nav, foot);

    folderBtn.addEventListener("click", onFolderClick);
    changeBtn.addEventListener("click", () => connectFolder("pick"));
    projectBtn.addEventListener("click", openProjects);
    setupTheme(themeBtn);
    setupMenuToggle();
    setupPalette();
    setupShortcuts();
  }

  function renderNavItems(nav, page) {
    nav.innerHTML = "";
    navPages().forEach((item) => {
      const link = document.createElement("a");
      link.href = item.href;
      const label = document.createElement("span");
      label.textContent = item.label;
      link.append(icon(item.icon), label);
      if (item.id === page) link.setAttribute("aria-current", "page");
      makeNavItemDraggable(link, item, nav, page);
      nav.append(link);
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
      const pages = navPages();
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
      heading.textContent = "浏览器版本太旧";
      text.textContent = "当前的浏览器不支持文件夹读写（需要 Edge 90+ 或 Chrome 86+）。请升级或换用新版 Edge / Chrome 打开本页面。";
      button.hidden = true;
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
    if (!status.ok && !(options && options.optionalFolder)) {
      fillGate(status);
      return;
    }
    document.getElementById("gate").hidden = true;
    document.getElementById("content").hidden = false;
    await onReady();
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
    input.placeholder = "跳转页面，或搜索待办 / 笔记 / 资料…";
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
    renderPalette();
  }

  function renderPalette() {
    const list = document.getElementById("palette-list");
    const input = document.getElementById("palette-input");
    if (!list || !input) return;
    const q = input.value.trim().toLowerCase();
    const data = paletteData || { todos: [], notes: [], resources: [] };
    const items = [];

    PAGES.forEach((page) => {
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
    if (item.href) location.href = item.href;
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
        const search = document.querySelector("#note-search, #resource-search, #sn-input");
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

  root.Nav = { boot, toast, fillProjects, setStatus, icon, openPalette, refreshBadges, pickPath };
})(typeof window !== "undefined" ? window : globalThis);
