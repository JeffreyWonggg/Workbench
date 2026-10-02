(function () {
  "use strict";

  let todos = [];
  let notes = [];
  let reports = [];
  let resources = null; // null 表示资料库在本标签页未解锁
  let library = null; // null 表示还没有读到文件归属；解锁资料库后才有
  let software = [];
  let repos = [];

  Nav.boot("project", async () => {
    todos = Workbench.activeItems(await Workbench.loadTodos());
    notes = Workbench.activeItems(await Workbench.loadNoteIndex());
    reports = await Workbench.loadReports();
    const session = Workbench.readVaultSession();
    resources = session ? Workbench.activeItems(session.records) : null;
    library = session && session.library ? session.library : null;
    software = Workbench.activeItems(await Workbench.loadSoftware());
    repos = Workbench.gitConfig().repos;

    bindLayout();
    const wanted = new URLSearchParams(location.search).get("name");
    if (wanted && projectNames().includes(wanted)) renderDetail(wanted);
    else renderOverview();
  });

  // 只显示侧栏「项目」名单。笔记、待办里残留的旧项目名不再把已删除的项目补回来。
  function projectNames() {
    return Workbench.meta.projects.slice();
  }

  function stats(name) {
    const projectTodos = todos.filter((todo) => todo.project === name);
    const openTodos = projectTodos.filter((todo) => todo.state !== "DONE");
    const today = Workbench.todayIso();
    const overdue = openTodos.filter((todo) => todo.due && todo.due < today).length;
    const projectNotes = notes.filter((note) => note.project === name);
    const sections = [];
    reports.forEach((report) => {
      (report.sections || []).forEach((section) => {
        if (section.project === name) sections.push({ report, section });
      });
    });
    const hours = sections.reduce((sum, item) => sum + (Number(item.section.hours) || 0), 0);
    const week = Workbench.isoWeek(new Date());
    const weekSection = sections.find((item) => item.report.year === week.year && item.report.week === week.week);
    const projectResources = resources ? resources.filter((record) => record.project === name) : null;
    const projectFiles = filesFor(name);
    const projectSoftware = software.filter((item) => item.project === name);
    const projectRepos = repos.filter((repo) => repo.project === name);
    return {
      todos: projectTodos,
      openTodos,
      overdue,
      noteCount: projectNotes.length,
      notes: projectNotes,
      hours,
      weekHours: weekSection ? Number(weekSection.section.hours) || 0 : 0,
      sections: sections.sort((a, b) => (b.report.year - a.report.year) || (b.report.week - a.report.week)),
      resourceCount: projectResources ? projectResources.length : null,
      resources: projectResources,
      files: projectFiles,
      software: projectSoftware,
      repos: projectRepos
    };
  }

  /* ===== 总览 ===== */

  function renderOverview() {
    document.getElementById("project-overview").hidden = false;
    document.getElementById("project-detail").hidden = true;
    // 总览只留「布局」；「在待办里打开 / 去记笔记」是针对某个项目的，进详情才出现
    document.getElementById("project-actions").hidden = false;
    document.getElementById("project-layout").hidden = false;
    document.getElementById("project-todo-link").hidden = true;
    document.getElementById("project-note-link").hidden = true;
    document.getElementById("project-kicker").textContent = "全部项目";
    document.getElementById("project-title").textContent = "项目";

    const box = document.getElementById("project-overview");
    box.innerHTML = "";
    const names = projectNames();
    if (names.length === 0) {
      box.append(empty("还没有项目。先在待办或笔记里用一下项目字段。"));
      return;
    }
    names.forEach((name) => {
      const data = stats(name);
      const tile = document.createElement("a");
      tile.className = "card project-tile";
      tile.href = "project.html?name=" + encodeURIComponent(name);

      const head = document.createElement("div");
      head.className = "card-head";
      const title = document.createElement("h2");
      title.textContent = name;
      const hint = document.createElement("span");
      hint.className = "muted";
      hint.textContent = data.overdue > 0 ? `逾期 ${data.overdue}` : (data.openTodos.length ? "进行中" : "空闲");
      head.append(title, hint);

      const line = document.createElement("div");
      line.className = "muted";
      line.textContent = data.openTodos.length
        ? data.openTodos.slice(0, 1).map((todo) => todo.title).join("")
        : "没有未完成的待办";

      const statsRow = document.createElement("div");
      statsRow.className = "project-tile-stats";
      statsRow.append(
        stat(data.openTodos.length, "未完成"),
        stat(data.weekHours, "本周 h"),
        stat(data.noteCount, "笔记"),
        stat(data.resourceCount == null ? "—" : data.resourceCount, "资料"),
        stat(data.files == null ? "—" : data.files.length, "文件"),
        stat(data.repos.length, "仓库"),
        stat(data.software.length, "软件号")
      );

      tile.append(head, line, statsRow);
      setupTile(tile, name);
      box.append(tile);
    });
  }

  /* ===== 总览布局：拖动磁贴调整项目先后顺序 =====
     顺序写进 meta.json 的 projects —— 它是**数据**不是本机偏好：
     待办/笔记等页面的项目下拉框、这边的总览都按这个顺序来，换台设备也该一致，
     所以让它跟着云同步走（而不是像侧栏排序、首页卡片那样存 localStorage）。 */

  let layoutEditing = false;
  let dragTile = null;

  function tileList() {
    return Array.prototype.slice.call(document.querySelectorAll("#project-overview .project-tile"));
  }

  // 只绑一次：磁贴每次重绘都会重建，但按钮和容器不会
  function bindLayout() {
    const button = document.getElementById("project-layout");
    const box = document.getElementById("project-overview");
    if (!button || !box) return;
    button.addEventListener("click", () => setLayoutEditing(!layoutEditing));
    box.addEventListener("dragover", onTileDragOver);
    box.addEventListener("drop", (event) => event.preventDefault());
  }

  function setLayoutEditing(value) {
    layoutEditing = value;
    document.getElementById("project-overview").classList.toggle("is-editing", layoutEditing);
    const button = document.getElementById("project-layout");
    button.textContent = layoutEditing ? "完成" : "布局";
    button.setAttribute("aria-pressed", layoutEditing ? "true" : "false");
    tileList().forEach((tile) => { tile.draggable = layoutEditing; });
    if (layoutEditing) Nav.toast("拖动卡片调整项目顺序，拖完点「完成」");
  }

  function setupTile(tile, name) {
    tile.dataset.project = name;
    tile.draggable = layoutEditing;
    // 布局模式下点卡片是"想拖它"，别跳进详情页
    tile.addEventListener("click", (event) => {
      if (layoutEditing) event.preventDefault();
    });
    tile.addEventListener("dragstart", (event) => {
      if (!layoutEditing) {
        event.preventDefault();
        return;
      }
      dragTile = tile;
      tile.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      try {
        event.dataTransfer.setData("text/plain", name);
      } catch (err) {
        // 某些浏览器对 setData 有额外限制，拖拽本身不依赖它
      }
    });
    tile.addEventListener("dragend", () => {
      tile.classList.remove("dragging");
      dragTile = null;
      // 拖完以真实 DOM 顺序为准，别再自己算一遍
      commitProjectOrder();
    });

    const head = tile.querySelector(".card-head");
    if (head && !head.querySelector(".card-tools")) {
      const tools = document.createElement("div");
      tools.className = "card-tools";
      const grip = document.createElement("span");
      grip.className = "card-grip";
      grip.title = "拖动排序";
      grip.setAttribute("aria-hidden", "true");
      grip.append(Nav.icon("grip"));
      tools.append(grip);
      head.append(tools);
    }
  }

  // 边拖边排：指针压到哪张磁贴的哪半边，就把被拖的那张插过去
  function onTileDragOver(event) {
    if (!layoutEditing || !dragTile) return;
    event.preventDefault();
    const tiles = tileList().filter((tile) => tile !== dragTile);
    let index = tiles.length;
    for (let i = 0; i < tiles.length; i += 1) {
      const rect = tiles[i].getBoundingClientRect();
      const inRow = event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (inRow && event.clientX < rect.left + rect.width / 2) {
        index = i;
        break;
      }
      if (!inRow && event.clientY < rect.top + rect.height / 2) {
        index = i;
        break;
      }
    }
    const box = document.getElementById("project-overview");
    if (index >= tiles.length) {
      if (box.lastElementChild !== dragTile) box.append(dragTile);
      return;
    }
    if (tiles[index].previousElementSibling !== dragTile) box.insertBefore(dragTile, tiles[index]);
  }

  async function commitProjectOrder() {
    const names = tileList().map((tile) => tile.dataset.project);
    const previous = Workbench.meta.projects;
    if (names.length !== previous.length) return;
    if (names.every((name, index) => name === previous[index])) return;   // 没变就不写盘
    Workbench.meta.projects = names;
    try {
      await Workbench.saveMeta();
      Nav.toast("项目顺序已保存");
    } catch (err) {
      // 写不进去就把内存里的顺序改回去，免得页面和磁盘不一致
      Workbench.meta.projects = previous;
      renderOverview();
      Nav.toast("顺序没存上：" + (err && err.message ? err.message : "未知错误"));
    }
  }

  function stat(value, label) {
    const el = document.createElement("span");
    el.className = "project-stat";
    const strong = document.createElement("b");
    strong.textContent = String(value);
    const text = document.createElement("i");
    text.textContent = label;
    text.style.fontStyle = "normal";
    el.append(strong, text);
    return el;
  }

  /* ===== 详情 ===== */

  function renderDetail(name) {
    document.getElementById("project-overview").hidden = true;
    document.getElementById("project-detail").hidden = false;
    // 详情页没有磁贴可排，收掉「布局」，换成属于这个项目的两个跳转
    document.getElementById("project-actions").hidden = false;
    document.getElementById("project-layout").hidden = true;
    document.getElementById("project-todo-link").hidden = false;
    document.getElementById("project-note-link").hidden = false;
    document.getElementById("project-kicker").textContent = "项目";
    document.getElementById("project-title").textContent = name;
    document.getElementById("project-todo-link").href = "todo.html?project=" + encodeURIComponent(name);
    document.getElementById("project-note-link").href = "notes.html";

    const data = stats(name);
    renderTodos(name, data);
    renderNotes(data);
    renderReports(data);
    renderResources(name, data);
    renderFiles(name, data);
    renderSoftware(name, data);
    renderRepos(data);
    renderTimeline(name, data);
  }

  function renderTodos(name, data) {
    const list = document.getElementById("project-todo-list");
    const count = document.getElementById("project-todo-count");
    list.innerHTML = "";
    const rows = data.openTodos.slice().sort((a, b) => {
      const aDue = a.due || "9999";
      const bDue = b.due || "9999";
      return String(aDue).localeCompare(String(bDue));
    });
    count.textContent = rows.length ? `${rows.length} 条未完成` : "";
    if (rows.length === 0) {
      list.append(empty("这个项目没有未完成的待办。"));
      return;
    }
    const today = Workbench.todayIso();
    rows.slice(0, 12).forEach((todo) => {
      const link = document.createElement("a");
      link.className = "note-link";
      link.href = "todo.html#" + encodeURIComponent(todo.id);
      const title = document.createElement("strong");
      title.textContent = todo.title;
      const meta = document.createElement("span");
      meta.className = "muted";
      const due = todo.due
        ? (todo.due < today ? `逾期 ${daysBetween(todo.due, today)} 天` : Workbench.formatShortDate(todo.due) + " 到期")
        : "无截止";
      meta.textContent = [Workbench.stateLabel(todo.state), due].filter(Boolean).join(" · ");
      link.append(title, meta);
      list.append(link);
    });
    if (rows.length > 12) {
      const more = document.createElement("a");
      more.className = "note-link";
      more.href = "todo.html?project=" + encodeURIComponent(name);
      more.textContent = `还有 ${rows.length - 12} 条`;
      list.append(more);
    }
  }

  function renderNotes(data) {
    const list = document.getElementById("project-note-list");
    const count = document.getElementById("project-note-count");
    list.innerHTML = "";
    const rows = data.notes.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    count.textContent = rows.length ? `${rows.length} 篇` : "";
    if (rows.length === 0) {
      list.append(empty("这个项目还没有笔记。"));
      return;
    }
    rows.slice(0, 12).forEach((note) => {
      const link = document.createElement("a");
      link.className = "note-link";
      link.href = "notes.html?id=" + encodeURIComponent(note.id);
      const title = document.createElement("strong");
      title.textContent = note.title || "未命名";
      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = Workbench.formatShortDate(note.updatedAt);
      link.append(title, meta);
      list.append(link);
    });
    if (rows.length > 12) {
      const more = document.createElement("a");
      more.className = "note-link";
      more.href = "notes.html";
      more.textContent = `还有 ${rows.length - 12} 篇`;
      list.append(more);
    }
  }

  function renderReports(data) {
    const box = document.getElementById("project-report-box");
    const count = document.getElementById("project-report-count");
    box.innerHTML = "";
    count.textContent = data.sections.length ? `${data.sections.length} 周` : "";
    const total = document.createElement("div");
    total.className = "project-hours";
    total.append(document.createTextNode(Workbench.formatHours(data.hours)));
    const unit = document.createElement("span");
    unit.textContent = " 小时累计";
    total.append(unit);
    box.append(total);
    if (data.sections.length === 0) {
      box.append(empty("周报里还没有这个项目的记录。"));
      return;
    }
    data.sections.slice(0, 6).forEach(({ report, section }) => {
      const line = document.createElement("div");
      line.className = "hours-line";
      const name = document.createElement("span");
      name.textContent = `第 ${report.week} 周`;
      const hours = document.createElement("span");
      hours.className = "muted";
      const items = (section.items || []).map((item) => String(item).trim()).filter(Boolean);
      hours.textContent = `${Workbench.formatHours(section.hours)}h · ${items.length} 条`;
      line.append(name, hours);
      box.append(line);
      items.slice(0, 3).forEach((item) => {
        const detail = document.createElement("div");
        detail.className = "muted clamp";
        detail.textContent = "· " + item;
        box.append(detail);
      });
    });
  }

  function renderResources(name, data) {
    const list = document.getElementById("project-resource-list");
    const count = document.getElementById("project-resource-count");
    list.innerHTML = "";
    if (!data.resources) {
      count.textContent = "";
      const line = empty("资料库是加密的，本标签页还没解锁。");
      const link = document.createElement("a");
      link.className = "note-link";
      link.href = "resources.html?project=" + encodeURIComponent(name);
      link.textContent = "去解锁资料库";
      list.append(line, link);
      return;
    }
    count.textContent = data.resources.length ? `${data.resources.length} 条` : "";
    if (data.resources.length === 0) {
      list.append(empty("这个项目还没有关联资料。在资料库里给条目选上项目即可。"));
      return;
    }
    const labels = { credential: "账号", path: "路径", host: "主机", software: "软件号" };
    data.resources.forEach((record) => {
      const line = document.createElement("a");
      line.className = "note-link";
      line.href = "resources.html?project=" + encodeURIComponent(name);
      const title = document.createElement("strong");
      title.textContent = record.name || "未命名";
      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = [labels[record.type] || record.type, record.username || record.host || record.path || record.softwareId]
        .filter(Boolean).join(" · ");
      line.append(title, meta);
      list.append(line);
    });
  }

  function filesFor(name) {
    if (!library || !library.assignments) return null;
    return Object.keys(library.assignments).filter((path) => library.assignments[path] === name).map((path) => {
      const parts = String(path).split("/").filter(Boolean);
      return { path, name: parts.length ? parts[parts.length - 1] : path };
    }).sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }

  function renderFiles(name, data) {
    const list = document.getElementById("project-file-list");
    const count = document.getElementById("project-file-count");
    list.innerHTML = "";
    const href = "resources.html?project=" + encodeURIComponent(name) + "&view=file";
    if (!data.files) {
      count.textContent = "";
      const line = empty("资料库还没在这个标签页解锁，文件归属读不到。");
      const link = document.createElement("a");
      link.className = "note-link";
      link.href = href;
      link.textContent = "去解锁资料库";
      list.append(line, link);
      return;
    }
    count.textContent = data.files.length ? data.files.length + " 个" : "";
    if (data.files.length === 0) {
      const line = empty("这个项目还没有关联文件。在资料库的「文件」里给条目选上项目即可。");
      const link = document.createElement("a");
      link.className = "note-link";
      link.href = href;
      link.textContent = "去资料库";
      list.append(line, link);
      return;
    }
    data.files.forEach((file) => {
      const line = document.createElement("a");
      line.className = "note-link";
      line.href = href + "&path=" + encodeURIComponent(file.path);
      const title = document.createElement("strong");
      title.textContent = file.name;
      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = file.path;
      line.append(title, meta);
      list.append(line);
    });
  }

  // 软件号现在是明文的 software.json（从加密资料库迁出）
  function renderSoftware(name, data) {
    const list = document.getElementById("project-software-list");
    const count = document.getElementById("project-software-count");
    list.innerHTML = "";
    count.textContent = data.software.length ? `${data.software.length} 条` : "";
    if (data.software.length === 0) {
      const line = empty("这个项目还没有软件号。在「代码」页的软件号页签里新增并选上项目。");
      const link = document.createElement("a");
      link.className = "note-link";
      link.href = "code.html?tab=software";
      link.textContent = "去代码页";
      list.append(line, link);
      return;
    }
    data.software.forEach((item) => {
      const line = document.createElement("div");
      line.className = "project-software-row";

      const link = document.createElement("a");
      link.className = "note-link";
      link.href = "code.html?tab=software&software=" + encodeURIComponent(item.id);
      const title = document.createElement("strong");
      title.textContent = item.name || "未命名";
      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = [item.softwareId, item.notes].filter(Boolean).join(" · ");
      link.append(title, meta);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "linkish";
      remove.textContent = "删除";
      remove.setAttribute("aria-label", "删除软件号 " + (item.name || item.softwareId || ""));
      remove.addEventListener("click", () => deleteProjectSoftware(name, item.id));

      line.append(link, remove);
      list.append(line);
    });
  }

  // 项目页原先只有一条链到代码页，而且不带软件号页签，点进去删不到这条绑定
  async function deleteProjectSoftware(projectName, id) {
    const all = await Workbench.loadSoftware();
    const target = all.find((entry) => entry.id === id);
    if (!target || Workbench.isDeleted(target)) return;
    const previous = target.deletedAt || "";
    target.deletedAt = new Date().toISOString();
    target.updatedAt = target.deletedAt;
    try {
      await Workbench.saveSoftware(all);
    } catch (err) {
      target.deletedAt = previous;
      Nav.toast(err && err.message ? err.message : "删除失败");
      return;
    }
    software = Workbench.activeItems(all);
    Nav.toast("「" + (target.name || "未命名") + "」已删除", {
      label: "撤销",
      onSelect: async () => {
        target.deletedAt = previous;
        target.updatedAt = new Date().toISOString();
        try {
          await Workbench.saveSoftware(all);
        } catch (err) {
          Nav.toast(err && err.message ? err.message : "恢复失败");
          return;
        }
        software = Workbench.activeItems(all);
        renderDetail(projectName);
      }
    });
    renderDetail(projectName);
  }

  // 仓库状态是现算的：先占位再异步补上分支与改动数
  async function renderRepos(data) {
    const list = document.getElementById("project-code-list");
    const count = document.getElementById("project-code-count");
    list.innerHTML = "";
    count.textContent = data.repos.length ? `${data.repos.length} 个` : "";
    if (data.repos.length === 0) {
      const line = empty("这个项目还没有绑定仓库。在「代码」页给仓库选上项目即可。");
      const link = document.createElement("a");
      link.className = "note-link";
      link.href = "code.html";
      link.textContent = "去代码页绑定";
      list.append(line, link);
      return;
    }

    const metas = new Map();
    data.repos.forEach((repo) => {
      const line = document.createElement("a");
      line.className = "note-link";
      line.href = "code.html";
      const title = document.createElement("strong");
      title.textContent = repo.name;
      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = "读取中…";
      line.append(title, meta);
      list.append(line);
      metas.set(repo.path.toLowerCase(), meta);
    });

    const result = await GitApi.status(data.repos.map((repo) => repo.path), {});
    if (!result || !result.ok) {
      metas.forEach((meta) => { meta.textContent = "读不到仓库状态"; });
      return;
    }
    (result.repos || []).forEach((item) => {
      const meta = metas.get(String(item.path).toLowerCase());
      if (!meta) return;
      if (item.error) {
        meta.textContent = item.error;
        return;
      }
      const dirty = (item.staged || 0) + (item.unstaged || 0);
      const parts = [item.branch || "无提交", dirty ? `${dirty} 处改动` : "干净"];
      if (item.ahead) parts.push(`↑${item.ahead}`);
      if (item.behind) parts.push(`↓${item.behind}`);
      if (item.last) parts.push(item.last.subject);
      meta.textContent = parts.join(" · ");
      meta.classList.toggle("repo-dirty", dirty > 0);
    });
  }

  /* ===== 时间线 ===== */

  // 各类事件在时间线上的标签文案
  const TIMELINE_KINDS = {
    todo: "待办",
    todoDone: "完成",
    note: "笔记",
    report: "周报",
    commit: "提交",
    release: "发布",
    software: "软件号"
  };

  // 把项目相关的待办、笔记、周报工时、git 提交、发布流水、软件号
  // 按时间搓成一条轴。时间字段各源都不一样（ISO 字符串 / 秒级 epoch /
  // 日期 / ISO 周），统一折算成毫秒再排。
  async function renderTimeline(name, data) {
    const box = document.getElementById("project-timeline");
    const count = document.getElementById("project-timeline-count");
    if (!box) return;
    box.innerHTML = "";
    count.textContent = "读取中…";

    const events = [];
    const push = (at, kind, title, meta, href) => {
      const time = toTime(at);
      if (!time) return;
      events.push({ at: time, kind, title, meta: meta || "", href: href || "" });
    };

    data.todos.forEach((todo) => {
      push(todo.createdAt || todo.date, "todo", "新建待办 · " + todo.title,
        Workbench.stateLabel(todo.state) + (todo.due ? " · 截止 " + todo.due : ""),
        "todo.html#" + todo.id);
      if (todo.doneAt) {
        push(todo.doneAt, "todoDone", "完成待办 · " + todo.title, "", "todo.html#" + todo.id);
      }
    });

    data.notes.forEach((note) => {
      push(note.updatedAt, "note", "笔记 · " + (note.title || "未命名"), "",
        "notes.html?id=" + encodeURIComponent(note.id));
    });

    data.sections.forEach((item) => {
      const hours = Number(item.section.hours) || 0;
      if (!hours) return;
      const items = (item.section.items || []).map((text) => String(text).trim()).filter(Boolean);
      push(Workbench.weekMonday(item.report.year, item.report.week), "report",
        `第 ${item.report.week} 周 · ${Workbench.formatHours(hours)}h`,
        items.slice(0, 2).join("；"), "weekly.html");
    });

    // 发布流水：项目名对得上，或者仓库属于这个项目
    const repoPaths = data.repos.map((repo) => String(repo.path || "").toLowerCase());
    (Workbench.gitConfig().releases || []).forEach((release) => {
      const own = release.project === name
        || repoPaths.indexOf(String(release.repo || "").toLowerCase()) >= 0;
      if (!own) return;
      push(release.at, "release", "发布 · " + (release.tag || "未命名标签"),
        release.repo ? String(release.repo) : "", "code.html");
    });

    data.software.forEach((item) => {
      push(item.updatedAt, "software", "软件号 · " + (item.name || "未命名"),
        item.softwareId, "code.html?tab=software&software=" + encodeURIComponent(item.id));
    });

    // git 提交：仓库逐个取最近 20 条；最多读 8 个仓库，免得打开一个项目页打一堆请求
    const reposToRead = data.repos.slice(0, 8);
    const logs = await Promise.all(reposToRead.map((repo) => {
      try {
        return GitApi.log(repo.path, { limit: 20 });
      } catch (err) {
        return null;
      }
    }));
    logs.forEach((result, index) => {
      if (!result || !result.ok) return;
      const repo = reposToRead[index];
      (result.commits || []).forEach((commit) => {
        push(Number(commit.at) * 1000, "commit", commit.subject || "(没有提交信息)",
          [repo.name, commit.author, shortHash(commit.hash)].filter(Boolean).join(" · "),
          "code.html");
      });
    });

    events.sort((a, b) => b.at - a.at);
    count.textContent = events.length ? events.length + " 条" : "";
    if (!events.length) {
      box.append(empty("这个项目还没有可回溯的事件。"));
      return;
    }

    const shown = events.slice(0, 120);
    let currentDay = "";
    shown.forEach((event) => {
      const day = dayKey(event.at);
      if (day !== currentDay) {
        currentDay = day;
        const head = document.createElement("div");
        head.className = "timeline-day";
        head.textContent = formatDay(event.at);
        box.append(head);
      }
      box.append(timelineRow(event));
    });
    if (events.length > shown.length) {
      const more = document.createElement("div");
      more.className = "muted timeline-more";
      more.textContent = `还有 ${events.length - shown.length} 条更早的记录`;
      box.append(more);
    }
  }

  function timelineRow(event) {
    const row = document.createElement("div");
    row.className = "timeline-row";

    const dot = document.createElement("span");
    dot.className = "timeline-dot is-" + event.kind;

    const body = event.href ? document.createElement("a") : document.createElement("div");
    body.className = "timeline-body";
    if (event.href) body.href = event.href;

    const head = document.createElement("div");
    head.className = "timeline-title";
    const tag = document.createElement("span");
    tag.className = "timeline-tag is-" + event.kind;
    tag.textContent = TIMELINE_KINDS[event.kind] || "";
    const title = document.createElement("strong");
    title.textContent = event.title;
    head.append(tag, title);

    const meta = document.createElement("span");
    meta.className = "muted timeline-meta clamp";
    meta.textContent = [clockText(event.at), event.meta].filter(Boolean).join(" · ");

    body.append(head, meta);
    row.append(dot, body);
    return row;
  }

  /* ===== 小工具 ===== */

  // 各种时间源统一成毫秒时间戳；认不出来的返回 0（该条不显示）
  function toTime(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const text = String(value == null ? "" : value).trim();
    if (!text) return 0;
    if (/^\d{10}$/.test(text)) return Number(text) * 1000;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function dayKey(time) {
    const date = new Date(time);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  function formatDay(time) {
    const date = new Date(time);
    const week = "日一二三四五六"[date.getDay()];
    return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · 周${week}`;
  }

  function clockText(time) {
    const date = new Date(time);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function shortHash(hash) {
    return String(hash || "").slice(0, 7);
  }

  function empty(text) {
    const el = document.createElement("div");
    el.className = "empty";
    el.textContent = text;
    return el;
  }

  function daysBetween(fromIso, toIso) {
    const from = Workbench.dateFromIso(fromIso);
    const to = Workbench.dateFromIso(toIso);
    if (!from || !to) return 0;
    return Math.round((to - from) / 86400000);
  }
})();
