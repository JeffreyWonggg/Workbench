(function () {
  let todos = [];
  let projectFilter = "全部";
  let stateFilter = "open";
  let editingId = null;
  let stateMenuId = null;
  let selectMode = false;
  const selected = new Set();
  // 勾选前记下原状态，取消勾选时回到原状态而不是一律 DOING
  const lastOpenState = new Map();

  Nav.boot("todo", async () => {
    todos = await Workbench.loadTodos();
    bind();
    // 支持从项目主页 deep link 过来，直接落在某个项目上
    const wantedProject = new URLSearchParams(location.search).get("project");
    if (wantedProject && Workbench.meta.projects.includes(wantedProject)) projectFilter = wantedProject;
    document.addEventListener("click", (event) => {
      if (!stateMenuId || event.target.closest(".state-picker")) return;
      stateMenuId = null;
      render();
    });
    render();
    const hash = location.hash.slice(1);
    if (hash) {
      const todo = todos.find((item) => item.id === hash);
      if (todo) {
        if (todo.state === "DONE") stateFilter = "DONE";
        editingId = todo.id;
        render();
        const node = document.getElementById("todo-" + todo.id);
        if (node) node.scrollIntoView({ block: "center" });
      }
    }
    window.addEventListener("workbench-projects", () => {
      Nav.fillProjects(document.getElementById("todo-project"));
      render();
    });
  });

  function bind() {
    document.getElementById("batch-toggle").addEventListener("click", toggleSelectMode);
    Nav.fillProjects(document.getElementById("todo-project"), Workbench.meta.projects[0]);
    const stateSelect = document.getElementById("todo-state");
    stateSelect.innerHTML = "";
    Workbench.STATES.forEach((state) => {
      const option = document.createElement("option");
      option.value = state.id;
      option.textContent = state.label;
      stateSelect.append(option);
    });
    document.getElementById("todo-date").value = Workbench.todayIso();
    // 持续天数：填了就自动把截止日期算成「记录日期 + N 天」，不用手填截止日期
    const addDate = document.getElementById("todo-date");
    const addDue = document.getElementById("todo-due");
    const addSpan = document.getElementById("todo-span");
    const syncAddDue = () => {
      const days = Number(addSpan.value);
      if (!Number.isFinite(days) || days < 1) return;
      const iso = addDays(addDate.value, days);
      if (iso) addDue.value = iso;
    };
    addSpan.addEventListener("input", syncAddDue);
    addDate.addEventListener("change", syncAddDue);
    const addToggle = document.getElementById("add-toggle");
    addToggle.addEventListener("click", () => {
      document.getElementById("add-fields").hidden = false;
      addToggle.hidden = true;
      addToggle.setAttribute("aria-expanded", "true");
      document.getElementById("todo-title").focus();
    });
    document.getElementById("todo-add").addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      collapseAdd();
    });
    document.getElementById("todo-add").addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = document.getElementById("todo-title").value.trim();
      if (!title) return;
      const now = new Date().toISOString();
      const state = document.getElementById("todo-state").value;
      todos.unshift({
        id: Workbench.uid(),
        title,
        project: document.getElementById("todo-project").value,
        state,
        date: document.getElementById("todo-date").value,
        due: document.getElementById("todo-due").value,
        remark: "",
        doneAt: state === "DONE" ? Workbench.todayIso() : "",
        createdAt: now,
        updatedAt: now
      });
      await Workbench.saveTodos(todos);
      document.getElementById("todo-title").value = "";
      document.getElementById("todo-due").value = "";
      // 持续天数保留着，顺手给下一条也把截止日期填好
      syncAddDue();
      Nav.toast("已添加");
      render();
      document.getElementById("todo-title").focus();
    });
  }

  function collapseAdd() {
    const fields = document.getElementById("add-fields");
    const toggle = document.getElementById("add-toggle");
    if (fields.hidden) return;
    fields.hidden = true;
    toggle.hidden = false;
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  }

  function visibleTodos() {
    return todos.filter((todo) => {
      if (Workbench.isDeleted(todo)) return false;
      if (projectFilter !== "全部" && todo.project !== projectFilter) return false;
      if (stateFilter === "open") return todo.state !== "DONE";
      if (stateFilter === "all") return true;
      return todo.state === stateFilter;
    }).sort((a, b) => {
      const stateDelta = stateRank(a.state) - stateRank(b.state);
      if (stateDelta) return stateDelta;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
  }

  function stateRank(state) {
    const index = Workbench.STATES.findIndex((item) => item.id === state);
    return index < 0 ? 9 : index;
  }

  function render() {
    const counts = { DOING: 0, "NO START": 0, HOLD: 0, DONE: 0 };
    todos.forEach((todo) => {
      if (Workbench.isDeleted(todo)) return;
      if (counts[todo.state] != null) counts[todo.state] += 1;
    });
    document.getElementById("todo-counts").textContent =
      `进行中 ${counts.DOING} · 未开始 ${counts["NO START"]} · 暂停 ${counts.HOLD} · 已完成 ${counts.DONE}${stateFilter === "open" ? " 已收起" : ""}`;

    const projectRow = document.getElementById("project-filters");
    projectRow.innerHTML = "";
    ["全部"].concat(Workbench.meta.projects).forEach((name) => {
      projectRow.append(chip(name, projectFilter === name, () => {
        projectFilter = name;
        render();
      }));
    });

    const stateRow = document.getElementById("state-filters");
    stateRow.innerHTML = "";
    const stateChips = [{ id: "open", label: "未完成" }, { id: "all", label: "全部" }].concat(
      Workbench.STATES.map((state) => ({ id: state.id, label: state.label }))
    );
    stateChips.forEach((item) => {
      const button = chip(item.label, stateFilter === item.id, () => {
        stateFilter = item.id;
        render();
      });
      if (item.id !== "open" && item.id !== "all") button.dataset.state = item.id;
      stateRow.append(button);
    });

    const list = document.getElementById("todo-list");
    list.innerHTML = "";
    const rows = visibleTodos();
    if (selectMode) list.append(bulkBar(rows));
    if (rows.length === 0) {
      const card = document.createElement("div");
      card.className = "card empty";
      card.textContent = stateFilter === "open" ? "没有未完成的待办。" : "这一组是空的。";
      list.append(card);
      return;
    }
    // 只有存在截止日期时才分组，否则维持原来的扁平列表
    const buckets = groupByDue(rows);
    if (!buckets) {
      list.append(listCard(rows));
      return;
    }
    buckets.forEach((bucket) => {
      const head = document.createElement("div");
      head.className = "todo-group";
      head.textContent = bucket.label;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(bucket.items.length);
      head.append(count);
      list.append(head, listCard(bucket.items));
    });
  }

  function listCard(items) {
    const card = document.createElement("div");
    card.className = "card";
    items.forEach((todo) => card.append(rowFor(todo)));
    return card;
  }

  function rowFor(todo) {
    if (selectMode) return selectRow(todo);
    if (editingId === todo.id) return editRow(todo);
    return viewRow(todo);
  }

  // ===== 截止日期分组 =====

  const DUE_BUCKETS = [
    { id: "overdue", label: "已逾期" },
    { id: "today", label: "今天" },
    { id: "week", label: "本周" },
    { id: "later", label: "以后" },
    { id: "none", label: "无截止" },
    { id: "done", label: "已完成" }
  ];

  function weekEndIso() {
    const now = new Date();
    const day = now.getDay() || 7;
    return Workbench.todayIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + (7 - day)));
  }

  function overdue(todo) {
    return todo.state !== "DONE" && !!todo.due && todo.due < Workbench.todayIso();
  }

  function dueBucket(todo) {
    if (todo.state === "DONE") return "done";
    if (!todo.due) return "none";
    const today = Workbench.todayIso();
    if (todo.due < today) return "overdue";
    if (todo.due === today) return "today";
    if (todo.due <= weekEndIso()) return "week";
    return "later";
  }

  function groupByDue(rows) {
    if (!rows.some((todo) => todo.due)) return null;
    const map = new Map();
    rows.forEach((todo) => {
      const key = dueBucket(todo);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(todo);
    });
    return DUE_BUCKETS.filter((bucket) => map.has(bucket.id)).map((bucket) => ({
      label: bucket.label,
      items: sortBucket(map.get(bucket.id), bucket.id)
    }));
  }

  function sortBucket(items, bucketId) {
    const byDue = bucketId !== "none" && bucketId !== "done";
    return items.slice().sort((a, b) => {
      const stateDelta = stateRank(a.state) - stateRank(b.state);
      if (stateDelta) return stateDelta;
      if (byDue) {
        const dueDelta = String(a.due || "").localeCompare(String(b.due || ""));
        if (dueDelta) return dueDelta;
      }
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
  }

  function diffDays(fromIso, toIso) {
    const from = Workbench.dateFromIso(fromIso);
    const to = Workbench.dateFromIso(toIso);
    if (!from || !to) return 0;
    return Math.round((to - from) / 86400000);
  }

  // 本地日期加减天数：和 dateFromIso / todayIso 一致，都按本地时区，避免跨时区差一天
  function addDays(iso, days) {
    const date = Workbench.dateFromIso(iso);
    if (!date) return "";
    date.setDate(date.getDate() + days);
    return Workbench.todayIso(date);
  }

  function dueNode(todo) {
    if (!todo.due) return null;
    const span = document.createElement("span");
    const today = Workbench.todayIso();
    if (todo.state === "DONE") {
      span.className = "due";
      span.textContent = "截止 " + Workbench.formatShortDate(todo.due);
      return span;
    }
    if (todo.due < today) {
      span.className = "due due-late";
      span.textContent = "逾期 " + diffDays(todo.due, today) + " 天";
      return span;
    }
    if (todo.due === today) {
      span.className = "due due-today";
      span.textContent = "今天到期";
      return span;
    }
    span.className = "due";
    span.textContent = "截止 " + Workbench.formatShortDate(todo.due);
    return span;
  }

  function chip(label, on, onclick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip" + (on ? " on" : "");
    button.textContent = label;
    button.addEventListener("click", onclick);
    return button;
  }

  function viewRow(todo) {
    const done = todo.state === "DONE";
    const row = document.createElement("article");
    row.className = "todo" + (done ? " is-done" : "") + (overdue(todo) ? " is-overdue" : "") +
      (stateMenuId === todo.id ? " menu-open" : "");
    row.id = "todo-" + todo.id;

    const check = document.createElement("button");
    check.type = "button";
    check.className = "todo-check";
    check.setAttribute("role", "checkbox");
    check.setAttribute("aria-checked", done ? "true" : "false");
    check.setAttribute("aria-label", done ? "标记为未完成" : "标记为已完成");
    check.append(Nav.icon("check"));
    check.addEventListener("click", () => toggleDone(todo));

    const main = document.createElement("div");
    main.className = "todo-main";
    const title = document.createElement("div");
    title.className = "todo-title";
    title.textContent = todo.title;
    const meta = document.createElement("div");
    meta.className = "todo-meta";
    const metaText = [todo.project, Workbench.formatShortDate(todo.date)].filter(Boolean).join(" · ");
    if (metaText) {
      const span = document.createElement("span");
      span.textContent = metaText;
      meta.append(span);
    }
    const due = dueNode(todo);
    if (due) meta.append(due);
    meta.append(statePicker(todo));
    main.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "todo-actions";
    actions.append(iconButton("edit", "编辑", () => {
      editingId = todo.id;
      render();
    }));
    actions.append(iconButton("trash", "删除", () => remove(todo.id), "danger"));

    const top = document.createElement("div");
    top.className = "todo-top";
    top.append(check, main, actions);
    row.addEventListener("click", (event) => {
      if (event.target.closest("button, a, .state-menu")) return;
      stateMenuId = null;
      editingId = todo.id;
      render();
    });
    row.append(top);
    if (todo.remark) {
      const remark = document.createElement("p");
      remark.className = "todo-remark";
      remark.textContent = todo.remark;
      row.append(remark);
    }
    return row;
  }

  function statePicker(todo) {
    const wrap = document.createElement("span");
    wrap.className = "state-picker";
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill";
    pill.dataset.state = todo.state;
    pill.textContent = Workbench.stateLabel(todo.state);
    pill.setAttribute("aria-label", "更改状态");
    pill.setAttribute("aria-expanded", stateMenuId === todo.id ? "true" : "false");
    pill.addEventListener("click", (event) => {
      event.stopPropagation();
      stateMenuId = stateMenuId === todo.id ? null : todo.id;
      render();
    });
    wrap.append(pill);
    if (stateMenuId !== todo.id) return wrap;
    const menu = document.createElement("div");
    menu.className = "state-menu";
    menu.setAttribute("role", "menu");
    Workbench.STATES.forEach((item) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "state-option" + (item.id === todo.state ? " on" : "");
      option.textContent = item.label;
      option.addEventListener("click", async (event) => {
        event.stopPropagation();
        stateMenuId = null;
        if (item.id === todo.state) render();
        else await setState(todo.id, item.id);
      });
      menu.append(option);
    });
    wrap.append(menu);
    return wrap;
  }

  function editRow(todo) {
    const row = document.createElement("article");
    row.className = "todo";
    row.id = "todo-" + todo.id;
    const form = document.createElement("form");
    form.className = "todo-edit";
    const title = field("text", todo.title);
    const grid = document.createElement("div");
    grid.className = "todo-edit-row";
    const project = document.createElement("select");
    Nav.fillProjects(project, todo.project);
    const state = document.createElement("select");
    Workbench.STATES.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      state.append(option);
    });
    state.value = todo.state;
    const date = field("date", todo.date || "", "记录日期");
    // 已有记录日期和截止日期时，把当前跨度反算出来显示，方便接着调
    let spanText = "";
    if (todo.date && todo.due) {
      const days = diffDays(todo.date, todo.due);
      if (days > 0) spanText = String(days);
    }
    const span = field("number", spanText, "持续天数");
    span.min = "1";
    span.step = "1";
    span.placeholder = "天数";
    const due = field("date", todo.due || "", "截止日期");
    const syncEditDue = () => {
      const days = Number(span.value);
      if (!Number.isFinite(days) || days < 1) return;
      const iso = addDays(date.value, days);
      if (iso) due.value = iso;
    };
    span.addEventListener("input", syncEditDue);
    date.addEventListener("change", syncEditDue);
    grid.append(project, state, date, span, due);
    const remark = document.createElement("textarea");
    remark.rows = 3;
    remark.placeholder = "备注";
    remark.value = todo.remark || "";
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const save = document.createElement("button");
    save.className = "btn primary";
    save.type = "submit";
    save.textContent = "保存";
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
      editingId = null;
      render();
    });
    actions.append(save, cancel);
    form.append(title, grid, remark, actions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const nextTitle = title.value.trim();
      if (!nextTitle) return;
      const previous = todo.state;
      todo.title = nextTitle;
      todo.project = project.value;
      todo.state = state.value;
      todo.date = date.value;
      todo.due = due.value;
      todo.remark = remark.value.trim();
      if (todo.state === "DONE" && previous !== "DONE") todo.doneAt = Workbench.todayIso();
      if (todo.state !== "DONE") todo.doneAt = "";
      todo.updatedAt = new Date().toISOString();
      await Workbench.saveTodos(todos);
      editingId = null;
      Nav.toast("已保存");
      render();
    });
    row.append(form);
    return row;
  }

  function field(type, value, label) {
    const input = document.createElement("input");
    input.type = type;
    input.value = value || "";
    if (label) {
      input.setAttribute("aria-label", label);
      input.title = label;
    }
    return input;
  }

  function iconButton(name, label, onclick, extra) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-btn" + (extra ? " " + extra : "");
    button.setAttribute("aria-label", label);
    button.title = label;
    button.append(Nav.icon(name));
    button.addEventListener("click", onclick);
    return button;
  }

  // ===== 批量操作 =====

  function toggleSelectMode() {
    selectMode = !selectMode;
    selected.clear();
    editingId = null;
    stateMenuId = null;
    const button = document.getElementById("batch-toggle");
    button.classList.toggle("primary", selectMode);
    button.setAttribute("aria-pressed", selectMode ? "true" : "false");
    button.textContent = selectMode ? "退出批量" : "批量";
    render();
  }

  function toggleSelected(id) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    render();
  }

  function selectRow(todo) {
    const on = selected.has(todo.id);
    const row = document.createElement("article");
    row.className = "todo" + (on ? " selected" : "");
    row.id = "todo-" + todo.id;

    const box = document.createElement("button");
    box.type = "button";
    box.className = "todo-check select";
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", on ? "true" : "false");
    box.setAttribute("aria-label", (on ? "取消选择 " : "选择 ") + todo.title);
    box.append(Nav.icon("check"));
    box.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSelected(todo.id);
    });

    const main = document.createElement("div");
    main.className = "todo-main";
    const title = document.createElement("div");
    title.className = "todo-title";
    title.textContent = todo.title;
    const meta = document.createElement("div");
    meta.className = "todo-meta";
    const metaText = [todo.project, Workbench.formatShortDate(todo.date)].filter(Boolean).join(" · ");
    if (metaText) {
      const span = document.createElement("span");
      span.textContent = metaText;
      meta.append(span);
    }
    const due = dueNode(todo);
    if (due) meta.append(due);
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.dataset.state = todo.state;
    pill.textContent = Workbench.stateLabel(todo.state);
    meta.append(pill);
    main.append(title, meta);

    const top = document.createElement("div");
    top.className = "todo-top";
    top.append(box, main);
    row.append(top);
    row.addEventListener("click", () => toggleSelected(todo.id));
    return row;
  }

  function bulkBar(rows) {
    const bar = document.createElement("div");
    bar.className = "bulk-bar";
    const info = document.createElement("span");
    info.className = "bulk-info";
    info.textContent = selected.size ? "已选 " + selected.size + " 条" : "点击条目选择";
    bar.append(info);

    const actions = document.createElement("div");
    actions.className = "bulk-actions";
    const empty = selected.size === 0;

    Workbench.STATES.forEach((state) => {
      const button = chip(state.label, false, () => bulkState(state.id));
      button.disabled = empty;
      actions.append(button);
    });

    const project = document.createElement("select");
    project.setAttribute("aria-label", "移动到项目");
    project.disabled = empty;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "移动到…";
    project.append(placeholder);
    Workbench.meta.projects.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      project.append(option);
    });
    project.addEventListener("change", () => {
      const value = project.value;
      project.value = "";
      if (value) bulkProject(value);
    });
    actions.append(project);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "btn danger";
    removeButton.textContent = "删除";
    removeButton.disabled = empty;
    removeButton.addEventListener("click", bulkRemove);
    actions.append(removeButton);

    const all = document.createElement("button");
    all.type = "button";
    all.className = "btn";
    const allSelected = rows.length > 0 && selected.size === rows.length;
    all.textContent = allSelected ? "取消全选" : "全选";
    all.disabled = rows.length === 0;
    all.addEventListener("click", () => {
      if (allSelected) selected.clear();
      else rows.forEach((todo) => selected.add(todo.id));
      render();
    });
    actions.append(all);

    bar.append(actions);
    return bar;
  }

  async function bulkState(state) {
    if (!selected.size) return;
    const count = selected.size;
    const now = new Date().toISOString();
    selected.forEach((id) => {
      const todo = todos.find((item) => item.id === id);
      if (!todo) return;
      todo.state = state;
      todo.doneAt = state === "DONE" ? Workbench.todayIso() : "";
      todo.updatedAt = now;
    });
    await Workbench.saveTodos(todos);
    selected.clear();
    Nav.toast("已更新 " + count + " 条");
    render();
  }

  async function bulkProject(project) {
    if (!selected.size) return;
    const count = selected.size;
    const now = new Date().toISOString();
    selected.forEach((id) => {
      const todo = todos.find((item) => item.id === id);
      if (!todo) return;
      todo.project = project;
      todo.updatedAt = now;
    });
    await Workbench.saveTodos(todos);
    selected.clear();
    Nav.toast("已移动 " + count + " 条");
    render();
  }

  async function bulkRemove() {
    if (!selected.size) return;
    const targets = todos.filter((item) => selected.has(item.id));
    selected.clear();
    await softRemove(targets);
  }

  // 删除先移入回收站，可撤销
  async function softRemove(targets) {
    if (!targets || !targets.length) return;
    const stamp = new Date().toISOString();
    const backup = targets.map((todo) => ({
      id: todo.id,
      deletedAt: todo.deletedAt || "",
      updatedAt: todo.updatedAt
    }));
    targets.forEach((todo) => {
      todo.deletedAt = stamp;
      todo.updatedAt = stamp;
    });
    await Workbench.saveTodos(todos);
    render();
    Nav.refreshBadges();
    const label = targets.length === 1 ? `「${targets[0].title}」` : `${targets.length} 条待办`;
    Nav.toast(`${label}已移入回收站`, {
      label: "撤销",
      onSelect: async () => {
        backup.forEach((item) => {
          const todo = todos.find((entry) => entry.id === item.id);
          if (!todo) return;
          todo.deletedAt = item.deletedAt;
          todo.updatedAt = item.updatedAt;
        });
        await Workbench.saveTodos(todos);
        render();
        Nav.refreshBadges();
        Nav.toast("已恢复");
      }
    });
  }

  async function toggleDone(todo) {
    if (todo.state === "DONE") {
      const back = lastOpenState.get(todo.id) || "DOING";
      lastOpenState.delete(todo.id);
      await setState(todo.id, back);
    } else {
      lastOpenState.set(todo.id, todo.state);
      await setState(todo.id, "DONE");
    }
    refocusCheck(todo.id);
  }

  // 勾选后行可能因筛选而移出列表，退回到第一条，避免焦点丢失
  function refocusCheck(id) {
    const row = document.getElementById("todo-" + id);
    const button = (row && row.querySelector(".todo-check")) || document.querySelector("#todo-list .todo-check");
    if (button) button.focus();
  }

  async function setState(id, state) {
    const todo = todos.find((item) => item.id === id);
    if (!todo) return;
    todo.state = state;
    if (state === "DONE") todo.doneAt = Workbench.todayIso();
    else todo.doneAt = "";
    todo.updatedAt = new Date().toISOString();
    await Workbench.saveTodos(todos);
    render();
  }

  async function remove(id) {
    const todo = todos.find((item) => item.id === id);
    if (!todo) return;
    await softRemove([todo]);
  }
})();
