(function () {
  "use strict";

  let todos = [];
  let notes = [];

  Nav.boot("trash", async () => {
    todos = await Workbench.loadTodos();
    notes = await Workbench.loadNoteIndex();
    document.getElementById("trash-purge").addEventListener("click", purgeAll);
    render();
  });

  function deletedTodos() {
    return Workbench.deletedItems(todos)
      .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  }

  function deletedNotes() {
    return Workbench.deletedItems(notes)
      .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  }

  // 资料是加密存储的，只有本标签页解锁过才看得到，且只能在资料库页面恢复
  function deletedResources() {
    const session = Workbench.readVaultSession();
    return session ? Workbench.deletedItems(session.records) : null;
  }

  function render() {
    const todoRows = deletedTodos();
    const noteRows = deletedNotes();
    const resourceRows = deletedResources();

    renderSection("todo", todoRows, (todo) => ({
      title: todo.title || "未命名",
      meta: [todo.project, todo.state ? Workbench.stateLabel(todo.state) : ""].filter(Boolean).join(" · "),
      stamp: todo.deletedAt,
      restore: () => restoreTodo(todo.id),
      purge: () => purgeTodo(todo.id)
    }));

    renderSection("note", noteRows, (note) => ({
      title: note.title || "未命名",
      meta: note.project || "未分类",
      stamp: note.deletedAt,
      restore: () => restoreNote(note.id),
      purge: () => purgeNote(note.id)
    }));

    renderResources(resourceRows);

    const total = todoRows.length + noteRows.length + (resourceRows ? resourceRows.length : 0);
    document.getElementById("trash-summary").textContent = total === 0
      ? "回收站是空的。删除的待办和笔记会先放到这里，可以随时恢复。"
      : `共 ${total} 项。恢复后回到原来的位置；「彻底删除」不可撤销。`;
  }

  function renderSection(kind, rows, describe) {
    const list = document.getElementById(`trash-${kind}-list`);
    const count = document.getElementById(`trash-${kind}-count`);
    list.innerHTML = "";
    count.textContent = rows.length ? `${rows.length} 项` : "";
    if (rows.length === 0) {
      list.append(emptyLine(kind === "todo" ? "没有待办在回收站。" : "没有笔记在回收站。"));
      return;
    }
    rows.forEach((item) => {
      const info = describe(item);
      list.append(row(info.title, info.meta, info.stamp, info.restore, info.purge));
    });
  }

  function renderResources(rows) {
    const list = document.getElementById("trash-resource-list");
    const count = document.getElementById("trash-resource-count");
    list.innerHTML = "";
    if (!rows) {
      count.textContent = "";
      const line = document.createElement("div");
      line.className = "empty";
      line.textContent = "资料库是加密的。解锁资料库后，可在「资料库」页面用它自己的回收站恢复，这里不重复操作。";
      list.append(line);
      return;
    }
    count.textContent = rows.length ? `${rows.length} 项` : "";
    if (rows.length === 0) {
      list.append(emptyLine("没有资料在回收站。"));
      return;
    }
    rows.forEach((record) => {
      const names = { credential: "账号", path: "路径", host: "主机", software: "软件号" };
      const line = document.createElement("div");
      line.className = "trash-row";
      const main = document.createElement("div");
      main.className = "trash-main";
      const title = document.createElement("strong");
      title.textContent = record.name || "未命名";
      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = [names[record.type] || record.type, record.project, agoText(record.deletedAt)]
        .filter(Boolean).join(" · ");
      main.append(title, meta);
      const actions = document.createElement("div");
      actions.className = "trash-actions";
      const link = document.createElement("a");
      link.className = "btn";
      link.href = "resources.html";
      link.textContent = "去资料库处理";
      actions.append(link);
      line.append(main, actions);
      list.append(line);
    });
  }

  function row(title, meta, stamp, onRestore, onPurge) {
    const line = document.createElement("div");
    line.className = "trash-row";

    const main = document.createElement("div");
    main.className = "trash-main";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const sub = document.createElement("span");
    sub.className = "muted";
    sub.textContent = [meta, agoText(stamp)].filter(Boolean).join(" · ");
    main.append(strong, sub);

    const actions = document.createElement("div");
    actions.className = "trash-actions";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "btn";
    restore.textContent = "恢复";
    restore.addEventListener("click", onRestore);
    const purge = document.createElement("button");
    purge.type = "button";
    purge.className = "btn danger";
    purge.textContent = "彻底删除";
    purge.addEventListener("click", onPurge);
    actions.append(restore, purge);

    line.append(main, actions);
    return line;
  }

  function emptyLine(text) {
    const el = document.createElement("div");
    el.className = "empty";
    el.textContent = text;
    return el;
  }

  function agoText(stamp) {
    const date = new Date(stamp);
    if (!stamp || isNaN(date.getTime())) return "";
    const days = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (days <= 0) return "今天删除";
    if (days === 1) return "昨天删除";
    if (days < 30) return `${days} 天前删除`;
    return `${days} 天前删除（建议清理）`;
  }

  /* ===== 操作 ===== */

  async function restoreTodo(id) {
    const todo = todos.find((item) => item.id === id);
    if (!todo) return;
    todo.deletedAt = "";
    todo.updatedAt = new Date().toISOString();
    await Workbench.saveTodos(todos);
    Nav.refreshBadges();
    render();
    Nav.toast("已恢复到待办");
  }

  async function purgeTodo(id) {
    const todo = todos.find((item) => item.id === id);
    if (!todo) return;
    if (!confirm(`彻底删除「${todo.title || "未命名"}」？不可恢复。`)) return;
    todos = todos.filter((item) => item.id !== id);
    await Workbench.saveTodos(todos);
    Nav.refreshBadges();
    render();
    Nav.toast("已彻底删除");
  }

  async function restoreNote(id) {
    const note = notes.find((item) => item.id === id);
    if (!note) return;
    note.deletedAt = "";
    note.updatedAt = new Date().toISOString();
    await Workbench.saveNoteIndex(notes);
    render();
    Nav.toast("已恢复到笔记");
  }

  async function purgeNote(id) {
    const note = notes.find((item) => item.id === id);
    if (!note) return;
    if (!confirm(`彻底删除「${note.title || "未命名"}」？正文文件会一起删除，不可恢复。`)) return;
    await Workbench.deleteNote(id);
    notes = await Workbench.loadNoteIndex();
    render();
    Nav.toast("已彻底删除");
  }

  async function purgeAll() {
    const todoRows = deletedTodos();
    const noteRows = deletedNotes();
    if (todoRows.length === 0 && noteRows.length === 0) {
      Nav.toast("回收站里没有可清理的待办或笔记");
      return;
    }
    const message = `彻底删除 ${todoRows.length} 条待办和 ${noteRows.length} 篇笔记？不可恢复。`;
    if (!confirm(message)) return;
    todos = Workbench.activeItems(todos);
    await Workbench.saveTodos(todos);
    for (const note of noteRows) {
      await Workbench.deleteNote(note.id);
    }
    notes = await Workbench.loadNoteIndex();
    Nav.refreshBadges();
    render();
    Nav.toast("回收站已清空");
  }
})();
