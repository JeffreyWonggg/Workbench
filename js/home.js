(function () {
  Nav.boot("home", async () => {
    bindCapture();
    setupCards();
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

  function collapseCapture() {
    const fields = document.getElementById("capture-fields");
    const toggle = document.getElementById("capture-toggle");
    if (fields.hidden) return;
    fields.hidden = true;
    toggle.hidden = false;
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  }

  /* ===== 首页卡片布局：拖动排序 + 收起不看的 =====
     顺序和收起状态存在 localStorage（跟着浏览器走，和侧栏排序一个道理）。 */

  const LAYOUT_KEY = "wb-home-cards";
  const CARD_KEYS = ["usage", "focus", "doing", "week", "notes", "git", "ledger"];

  let layout = readLayout();
  let editing = false;
  let dragCard = null;

  function readLayout() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    } catch (err) {
      saved = null;
    }
    const order = (saved && Array.isArray(saved.order) ? saved.order : [])
      .filter((key) => CARD_KEYS.indexOf(key) >= 0);
    CARD_KEYS.forEach((key) => {
      if (order.indexOf(key) < 0) order.push(key);
    });
    const hidden = (saved && Array.isArray(saved.hidden) ? saved.hidden : [])
      .filter((key) => CARD_KEYS.indexOf(key) >= 0);
    return { order, hidden };
  }

  function writeLayout() {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch (err) {
      // 存不下就算了，下次打开回到默认顺序
    }
  }

  function allCards() {
    return Array.prototype.slice.call(document.querySelectorAll("#home-cards .home-card"));
  }

  function cardOf(key) {
    return document.querySelector('#home-cards .home-card[data-card="' + key + '"]');
  }

  function applyLayout() {
    const box = document.getElementById("home-cards");
    layout.order.forEach((key) => {
      const card = cardOf(key);
      if (card) box.append(card);
    });
    allCards().forEach((card) => {
      card.classList.toggle("is-collapsed", layout.hidden.indexOf(card.dataset.card) >= 0);
    });
  }

  function setupCards() {
    allCards().forEach((card) => {
      const head = card.querySelector(".card-head");
      if (!head || head.querySelector(".card-tools")) return;
      const key = card.dataset.card;

      const tools = document.createElement("div");
      tools.className = "card-tools";

      const grip = document.createElement("span");
      grip.className = "card-grip";
      grip.title = "拖动排序";
      grip.setAttribute("aria-hidden", "true");
      grip.append(Nav.icon("grip"));

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "linkish card-collapse";
      toggle.addEventListener("click", () => toggleCard(key));

      tools.append(grip, toggle);
      head.append(tools);
      paintToggle(card);

      card.addEventListener("dragstart", (event) => {
        if (!editing) {
          event.preventDefault();
          return;
        }
        dragCard = card;
        card.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        try {
          event.dataTransfer.setData("text/plain", key);
        } catch (err) {
          // 某些浏览器对 setData 有额外限制，拖拽本身不依赖它
        }
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        dragCard = null;
        // 拖完就以真实 DOM 顺序为准，别再自己算一遍
        layout.order = allCards().map((item) => item.dataset.card);
        writeLayout();
      });
    });

    const box = document.getElementById("home-cards");
    box.addEventListener("dragover", onDragOver);
    box.addEventListener("drop", (event) => event.preventDefault());
    document.getElementById("home-layout").addEventListener("click", () => setEditing(!editing));
    applyLayout();
  }

  // 边拖边排：指针压到哪张卡的哪半边，就直接把被拖的卡插过去
  function onDragOver(event) {
    if (!editing || !dragCard) return;
    event.preventDefault();
    const cards = allCards().filter((card) => card !== dragCard);
    let index = cards.length;
    for (let i = 0; i < cards.length; i += 1) {
      const rect = cards[i].getBoundingClientRect();
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
    const box = document.getElementById("home-cards");
    if (index >= cards.length) {
      if (box.lastElementChild !== dragCard) box.append(dragCard);
      return;
    }
    if (cards[index].previousElementSibling !== dragCard) box.insertBefore(dragCard, cards[index]);
  }

  function setEditing(value) {
    editing = value;
    document.getElementById("home-cards").classList.toggle("is-editing", editing);
    const button = document.getElementById("home-layout");
    button.textContent = editing ? "完成" : "布局";
    button.setAttribute("aria-pressed", editing ? "true" : "false");
    allCards().forEach((card) => {
      card.draggable = editing;
      paintToggle(card);
    });
    if (editing) Nav.toast("拖动卡片调整顺序，点「收起」把不常用的收起来");
  }

  function toggleCard(key) {
    const at = layout.hidden.indexOf(key);
    if (at >= 0) layout.hidden.splice(at, 1);
    else layout.hidden.push(key);
    writeLayout();
    const card = cardOf(key);
    if (card) card.classList.toggle("is-collapsed", at < 0);
    paintToggle(card);
  }

  function paintToggle(card) {
    if (!card) return;
    const button = card.querySelector(".card-collapse");
    if (!button) return;
    const collapsed = layout.hidden.indexOf(card.dataset.card) >= 0;
    button.textContent = collapsed ? "显示" : "收起";
    button.setAttribute("aria-label", (collapsed ? "显示" : "收起") + "这张卡片");
  }

  /* ===== 代码仓库卡片 ===== */

  async function renderGit() {
    const box = document.getElementById("git-box");
    const card = cardOf("git");
    if (!box || !card) return;
    box.innerHTML = "";
    const repos = Workbench.gitConfig().repos || [];
    if (!repos.length || typeof GitApi === "undefined") {
      card.hidden = true;
      return;
    }
    const result = await GitApi.status(repos.slice(0, 6).map((repo) => repo.path), {});
    if (!result || !result.ok) {
      card.hidden = true;
      return;
    }
    const names = {};
    repos.forEach((repo) => {
      names[String(repo.path).toLowerCase()] = repo.name;
    });
    const items = (result.repos || []).filter((item) => !item.error);
    if (!items.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const dirty = items.filter((item) => (item.staged || 0) + (item.unstaged || 0) > 0);
    if (!dirty.length) {
      box.append(empty("所有仓库都是干净的。"));
      return;
    }
    dirty.slice(0, 6).forEach((item) => {
      const row = document.createElement("a");
      row.className = "stack-item";
      row.href = "code.html";
      const title = document.createElement("strong");
      title.textContent = names[String(item.path).toLowerCase()] || item.path;
      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = [item.branch || "无分支", `${(item.staged || 0) + (item.unstaged || 0)} 处未提交`].join(" · ");
      row.append(title, meta);
      box.append(row);
    });
    if (dirty.length > 6) {
      const more = document.createElement("a");
      more.className = "stack-item";
      more.href = "code.html";
      more.textContent = `还有 ${dirty.length - 6} 个仓库有未提交改动`;
      box.append(more);
    }
  }

  /* ===== 本月记账卡片 ===== */

  async function renderLedger() {
    const box = document.getElementById("ledger-box");
    const card = cardOf("ledger");
    if (!box || !card) return;
    box.innerHTML = "";
    const items = Workbench.activeItems(await Workbench.loadLedgers());
    if (!items.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const month = Workbench.todayIso().slice(0, 7);
    const monthItems = items.filter((item) => String(item.date).slice(0, 7) === month);
    const expense = sumAmount(monthItems.filter((item) => item.kind === "expense"));
    const income = sumAmount(monthItems.filter((item) => item.kind === "income"));

    const total = document.createElement("div");
    total.className = "total-hours";
    total.append(document.createTextNode((income - expense).toFixed(2)));
    const unit = document.createElement("span");
    unit.textContent = "本月结余";
    total.append(unit);
    box.append(total);

    if (!monthItems.length) {
      box.append(empty("这个月还没有记账。"));
      return;
    }
    box.append(line("支出", expense.toFixed(2)));
    box.append(line("收入", income.toFixed(2)));
  }

  function sumAmount(items) {
    return items.reduce((total, item) => total + (Number(item.amount) || 0), 0);
  }

  function line(left, right) {
    const row = document.createElement("div");
    row.className = "hours-line";
    const name = document.createElement("span");
    name.textContent = left;
    const value = document.createElement("span");
    value.className = "muted";
    value.textContent = right;
    row.append(name, value);
    return row;
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
    const recent = notes.slice(0, 3);
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

    await renderGit();
    await renderLedger();
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
