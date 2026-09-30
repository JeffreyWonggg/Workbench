(function () {
  Nav.boot("home", async () => {
    bindCapture();
    bindTools();
    await render();
    // 余额卡片自己取数、自己渲染，失败也不影响首页其它部分
    DeepSeekCard.init().catch((err) => {
      Nav.toast("余额卡片出错：" + (err && err.message ? err.message : "未知错误"));
    });
    window.addEventListener("workbench-projects", () => {
      Nav.fillProjects(document.getElementById("capture-project"));
    });
  });

  function bindCapture() {
    const form = document.getElementById("capture");
    const toggle = document.getElementById("capture-toggle");
    const fields = document.getElementById("capture-fields");
    toggle.addEventListener("click", () => {
      fields.hidden = false;
      toggle.hidden = true;
      toggle.setAttribute("aria-expanded", "true");
      document.getElementById("capture-text").focus();
    });
    form.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      collapseCapture();
    });
    form.addEventListener("submit", onCapture);
    Nav.fillProjects(document.getElementById("capture-project"), Workbench.meta.projects[0]);
  }

  async function onCapture(event) {
    event.preventDefault();
    const input = document.getElementById("capture-text");
    const text = input.value.trim();
    if (!text) return;
    const project = document.getElementById("capture-project").value || "其他";
    const todos = await Workbench.loadTodos();
    const now = new Date().toISOString();
    todos.unshift({
      id: Workbench.uid(),
      title: text,
      project,
      state: "DOING",
      date: Workbench.todayIso(),
      remark: "",
      createdAt: now,
      updatedAt: now
    });
    await Workbench.saveTodos(todos);
    input.value = "";
    Nav.toast("已收下");
    await render();
    input.focus();
  }

  /* ===== 工具菜单：清单来自 meta.json，服务端只负责按路径启动 ===== */

  function bindTools() {
    const menu = document.getElementById("tool-menu");
    document.getElementById("tool-menu-toggle").addEventListener("click", (event) => {
      event.stopPropagation();
      setMenuOpen(menu.hidden);
    });
    document.addEventListener("click", (event) => {
      if (!menu.hidden && !event.target.closest(".tool-wrap")) setMenuOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) setMenuOpen(false);
    });
    document.getElementById("tool-add").addEventListener("click", () => addToolRow({}));
    document.getElementById("tool-cancel").addEventListener("click", closeToolDialog);
    document.getElementById("tool-form").addEventListener("submit", saveTools);
    renderToolMenu();
  }

  function setMenuOpen(open) {
    document.getElementById("tool-menu").hidden = !open;
    document.getElementById("tool-menu-toggle").setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderToolMenu();
  }

  function renderToolMenu() {
    const menu = document.getElementById("tool-menu");
    // 没有本机服务时（手机、托管地址）「启动外部程序」根本跑不了，整个入口收起来
    if (typeof Nav.isLocal === "function" && !Nav.isLocal()) {
      const toggle = document.getElementById("tool-menu-toggle");
      if (toggle) toggle.hidden = true;
      menu.hidden = true;
      return;
    }
    menu.innerHTML = "";
    const tools = Workbench.meta.tools || [];
    if (tools.length === 0) {
      const hint = document.createElement("div");
      hint.className = "palette-empty";
      hint.textContent = "还没有配置工具。";
      menu.append(hint);
    }
    tools.forEach((tool) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = tool.label;
      button.title = tool.exe;
      button.addEventListener("click", () => {
        setMenuOpen(false);
        runTool(tool);
      });
      menu.append(button);
    });
    const sep = document.createElement("div");
    sep.className = "tool-menu-sep";
    menu.append(sep);
    const manage = document.createElement("button");
    manage.type = "button";
    manage.textContent = "管理工具…";
    manage.addEventListener("click", () => {
      setMenuOpen(false);
      openToolDialog();
    });
    menu.append(manage);
  }

  async function runTool(tool) {
    const toggle = document.getElementById("tool-menu-toggle");
    toggle.disabled = true;
    try {
      const response = await fetch("http://127.0.0.1:47321/run-tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exe: tool.exe, args: tool.args || "", cwd: tool.cwd || "" })
      });
      if (response.status === 400) {
        const reason = await response.text();
        Nav.toast(`没有启动：${reason}`);
        return;
      }
      if (!response.ok) throw new Error("run failed");
      Nav.toast(`已启动 ${tool.label}`);
    } catch (err) {
      Nav.toast("没有启动。请先双击「打开工作台」再试");
    } finally {
      toggle.disabled = false;
    }
  }

  function openToolDialog() {
    const rows = document.getElementById("tool-rows");
    rows.innerHTML = "";
    (Workbench.meta.tools || []).forEach((tool) => addToolRow(tool));
    if (!rows.children.length) addToolRow({});
    setToolError("");
    document.getElementById("tool-dialog").showModal();
  }

  function closeToolDialog() {
    const dialog = document.getElementById("tool-dialog");
    if (dialog.open) dialog.close();
  }

  function setToolError(message) {
    const el = document.getElementById("tool-error");
    el.textContent = message || "";
    el.hidden = !message;
  }

  function addToolRow(tool) {
    const row = document.createElement("div");
    row.className = "tool-row";
    row.dataset.args = tool.args || "";
    row.dataset.cwd = tool.cwd || "";

    const label = document.createElement("input");
    label.type = "text";
    label.dataset.field = "label";
    label.placeholder = "按钮名称";
    label.value = tool.label || "";

    const exe = document.createElement("input");
    exe.type = "text";
    exe.dataset.field = "exe";
    exe.placeholder = "C:\\路径\\程序.exe";
    exe.value = tool.exe || "";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn danger";
    remove.textContent = "移除";
    remove.addEventListener("click", () => row.remove());

    row.append(label, exe, remove);
    document.getElementById("tool-rows").append(row);
  }

  async function saveTools(event) {
    event.preventDefault();
    const rows = Array.prototype.slice.call(document.querySelectorAll("#tool-rows .tool-row"));
    const tools = rows.map((row) => ({
      label: row.querySelector('[data-field="label"]').value.trim(),
      exe: row.querySelector('[data-field="exe"]').value.trim(),
      args: row.dataset.args || "",
      cwd: row.dataset.cwd || ""
    })).filter((tool) => tool.exe);
    Workbench.meta.tools = Workbench.normalizeTools(tools);
    try {
      await Workbench.saveMeta();
      closeToolDialog();
      renderToolMenu();
      Nav.toast("工具已保存");
    } catch (err) {
      setToolError(err && err.message ? err.message : "保存失败");
    }
  }

  function collapseCapture() {
    const fields = document.getElementById("capture-fields");
    const toggle = document.getElementById("capture-toggle");
    if (fields.hidden) return;
    fields.hidden = true;
    toggle.hidden = false;
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  }

  async function render() {
    const week = Workbench.isoWeek(new Date());
    const monday = Workbench.weekMonday(week.year, week.week);
    const sunday = Workbench.addUtcDays(monday, 6);
    document.getElementById("week-kicker").textContent =
      `第 ${week.week} 周 · ${Workbench.formatUtcMonthDay(monday)} – ${Workbench.formatUtcMonthDay(sunday)}`;

    const todos = await Workbench.loadTodos();
    // 保留完整数组用于写回，展示时只取未删除的，避免软删除的条目被写没
    const live = Workbench.activeItems(todos);

    // 今天要做的：已逾期 + 今天到期
    const today = Workbench.todayIso();
    const focus = live
      .filter((todo) => todo.state !== "DONE" && todo.due && todo.due <= today)
      .sort((a, b) => String(a.due).localeCompare(String(b.due)));
    const focusCard = document.getElementById("focus-card");
    const focusBox = document.getElementById("focus-list");
    focusBox.innerHTML = "";
    if (focus.length === 0) {
      focusCard.hidden = true;
    } else {
      focusCard.hidden = false;
      focus.slice(0, 8).forEach((todo) => focusBox.append(focusItem(todo, today, todos)));
      if (focus.length > 8) {
        const more = document.createElement("a");
        more.href = "todo.html";
        more.className = "focus-more";
        more.textContent = `还有 ${focus.length - 8} 条`;
        focusBox.append(more);
      }
    }

    const doing = live
      .filter((todo) => todo.state === "DOING")
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const doingBox = document.getElementById("doing-list");
    doingBox.innerHTML = "";
    if (doing.length === 0) {
      doingBox.append(empty("没有进行中的事。在上面写一条。"));
    } else {
      doing.slice(0, 8).forEach((todo) => doingBox.append(doingItem(todo)));
      if (doing.length > 8) {
        const more = document.createElement("a");
        more.href = "todo.html";
        more.className = "stack-item";
        more.textContent = `还有 ${doing.length - 8} 条进行中`;
        doingBox.append(more);
      }
    }

    const report = await Workbench.getReport(week.year, week.week);
    const weekBox = document.getElementById("week-box");
    weekBox.innerHTML = "";
    const sections = report && Array.isArray(report.sections) ? report.sections.filter((section) => section.project) : [];
    if (sections.length === 0) {
      weekBox.append(empty("这周还没有周报。"));
    } else {
      const total = sections.reduce((sum, section) => sum + (Number(section.hours) || 0), 0);
      const totalEl = document.createElement("div");
      totalEl.className = "total-hours";
      totalEl.append(document.createTextNode(Workbench.formatHours(total)));
      const unit = document.createElement("span");
      unit.textContent = "小时";
      totalEl.append(unit);
      weekBox.append(totalEl);
      sections.forEach((section) => {
        const line = document.createElement("div");
        line.className = "hours-line";
        const name = document.createElement("span");
        name.textContent = section.project;
        const hours = document.createElement("span");
        hours.className = "muted";
        const count = (section.items || []).map((item) => String(item).trim()).filter(Boolean).length;
        hours.textContent = `${Workbench.formatHours(section.hours)}h · ${count} 条`;
        line.append(name, hours);
        weekBox.append(line);
      });
    }

    const notes = Workbench.activeItems(await Workbench.loadNoteIndex());
    const recent = notes.slice(0, 5);
    const noteBox = document.getElementById("note-box");
    noteBox.innerHTML = "";
    if (recent.length === 0) {
      noteBox.append(empty("还没有笔记。"));
    } else {
      recent.forEach((note) => {
        const link = document.createElement("a");
        link.className = "note-link";
        link.href = `notes.html?id=${encodeURIComponent(note.id)}`;
        const title = document.createElement("strong");
        title.textContent = note.title || "未命名";
        const meta = document.createElement("span");
        meta.className = "muted";
        meta.textContent = `${note.project || "未分类"} · ${Workbench.formatShortDate(note.updatedAt)}`;
        link.append(title, meta);
        noteBox.append(link);
      });
    }
  }

  function doingItem(todo) {
    const row = document.createElement("a");
    row.className = "stack-item";
    row.href = `todo.html#${todo.id}`;
    const title = document.createElement("strong");
    title.textContent = todo.title;
    const meta = document.createElement("span");
    meta.className = "muted";
    const date = Workbench.formatShortDate(todo.date);
    meta.textContent = [todo.project, date].filter(Boolean).join(" · ");
    row.append(title, meta);
    if (todo.remark) {
      const remark = document.createElement("span");
      remark.className = "muted clamp";
      remark.textContent = todo.remark;
      row.append(remark);
    }
    return row;
  }

  function focusItem(todo, today, all) {
    const row = document.createElement("div");
    row.className = "focus-item";

    const check = document.createElement("button");
    check.type = "button";
    check.className = "todo-check";
    check.setAttribute("aria-label", "标记为已完成");
    check.append(Nav.icon("check"));
    check.addEventListener("click", async () => {
      todo.state = "DONE";
      todo.doneAt = Workbench.todayIso();
      todo.updatedAt = new Date().toISOString();
      await Workbench.saveTodos(all);
      Nav.toast("已完成");
      await render();
    });

    const link = document.createElement("a");
    link.className = "focus-title";
    link.href = "todo.html#" + todo.id;
    link.textContent = todo.title;

    const late = todo.due < today;
    const due = document.createElement("span");
    due.className = "due " + (late ? "due-late" : "due-today");
    due.textContent = late ? "逾期 " + daysBetween(todo.due, today) + " 天" : "今天到期";

    row.append(check, link, due);
    return row;
  }

  function daysBetween(fromIso, toIso) {
    const from = Workbench.dateFromIso(fromIso);
    const to = Workbench.dateFromIso(toIso);
    if (!from || !to) return 0;
    return Math.round((to - from) / 86400000);
  }

  function empty(text) {
    const el = document.createElement("div");
    el.className = "empty";
    el.textContent = text;
    return el;
  }
})();
