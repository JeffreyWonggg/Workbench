(function () {
  /* 记账：明文 ledger.json。金额只存正数，收支由 kind 区分，
     月度合计、分类筛选、跨月跳转都在这里算，不依赖任何后端。 */

  const KIND_LABEL = { expense: "支出", income: "收入" };
  const DEFAULT_CATEGORIES = ["餐饮", "交通", "购物", "住房", "日用", "医疗", "娱乐", "学习", "人情", "其他"];

  const state = {
    items: [],      // 完整数组（含软删除的，写回时必须带全）
    month: "",      // "YYYY-MM"
    kind: "all",
    keyword: "",
    editingId: ""
  };

  Nav.boot("ledger", async () => {
    state.month = currentMonth();
    state.items = await Workbench.loadLedgers();
    bind();
    render();
    // 记账在别处被改就重新读一遍再渲染
    Workbench.onChange(["ledger.json"], async () => {
      state.items = await Workbench.loadLedgers();
      render();
    });
  });

  /* ===== 绑定 ===== */

  function bind() {
    document.getElementById("ledger-add").addEventListener("click", () => openEditor(""));
    document.getElementById("prev-month").addEventListener("click", () => shiftMonth(-1));
    document.getElementById("next-month").addEventListener("click", () => shiftMonth(1));
    document.getElementById("this-month").addEventListener("click", () => {
      state.month = currentMonth();
      render();
    });
    document.getElementById("ledger-search").addEventListener("input", (event) => {
      state.keyword = event.target.value.trim();
      paintList();
    });
    document.getElementById("ledger-cancel").addEventListener("click", closeEditor);
    document.getElementById("ledger-form").addEventListener("submit", save);
    document.getElementById("ledger-kind").addEventListener("click", (event) => {
      const button = event.target.closest("[data-kind]");
      if (button) setKind(button.dataset.kind);
    });
    document.getElementById("ledger-category").addEventListener("change", (event) => {
      const isCustom = event.target.value === "__custom__";
      document.getElementById("ledger-category-custom-wrap").hidden = !isCustom;
      if (isCustom) document.getElementById("ledger-category-custom").focus();
    });
    window.addEventListener("workbench-ledger", async () => {
      state.items = await Workbench.loadLedgers();
      render();
    });
    // Ctrl+K 之类的改动不经过本页时，切回标签页也能看到最新的
    window.addEventListener("workbench-write", (event) => {
      if (event.detail && event.detail.path === "ledger.json") {
        Workbench.loadLedgers().then((list) => {
          state.items = list;
          render();
        });
      }
    });
  }

  /* ===== 渲染 ===== */

  function render() {
    const live = Workbench.activeItems(state.items);
    paintTitle(live);
    paintStats(live);
    paintKindChips(live);
    paintList();
  }

  function paintTitle(live) {
    const year = state.month.slice(0, 4);
    const month = Number(state.month.slice(5, 7));
    const isCurrent = state.month === currentMonth();
    document.getElementById("ledger-title").textContent =
      (isCurrent ? "本月 · " : "") + `${year} 年 ${month} 月`;
    const count = live.filter((item) => monthOf(item) === state.month).length;
    document.getElementById("ledger-summary").textContent =
      count === 0 ? "这个月还没有记录。" : `这个月共 ${count} 笔记录`;
  }

  function paintStats(live) {
    const monthItems = live.filter((item) => monthOf(item) === state.month);
    const expenseItems = monthItems.filter((item) => item.kind === "expense");
    const incomeItems = monthItems.filter((item) => item.kind === "income");
    const expense = sum(expenseItems);
    const income = sum(incomeItems);

    setText("stat-expense", money(expense));
    setText("stat-income", money(income));
    setText("stat-balance", money(income - expense));
    setText("stat-expense-sub", subtitleFor(expenseItems, expense, state.month));
    setText("stat-income-sub", subtitleFor(incomeItems, income, state.month));

    const lastKey = monthKeyOffset(state.month, -1);
    const lastBalance = live
      .filter((item) => monthOf(item) === lastKey)
      .reduce((sum2, item) => sum2 + (item.kind === "income" ? item.amount : -item.amount), 0);
    const hasLast = live.some((item) => monthOf(item) === lastKey);
    const diff = (income - expense) - lastBalance;
    document.getElementById("stat-balance-sub").textContent = hasLast
      ? `比上月 ${diff >= 0 ? "+" : "-"}${money(Math.abs(diff))}`
      : "上个月没有记录";

    const balanceEl = document.getElementById("stat-balance");
    balanceEl.classList.toggle("is-income", income - expense > 0);
    balanceEl.classList.toggle("is-expense", income - expense < 0);
  }

  function subtitleFor(items, total, month) {
    if (!items.length) return "还没有记录";
    const days = daysInMonth(month);
    const today = new Date();
    const elapsed = month === currentMonth() && today.getFullYear() === Number(state.month.slice(0, 4))
      ? Number(today.getDate())
      : days;
    return `${items.length} 笔 · 日均 ${money(total / Math.max(elapsed, 1))}`;
  }

  function paintKindChips(live) {
    const box = document.getElementById("ledger-kinds");
    box.innerHTML = "";
    const options = [
      { id: "all", label: "全部" },
      { id: "expense", label: "只看支出" },
      { id: "income", label: "只看收入" }
    ];
    options.forEach((option) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (state.kind === option.id ? " on" : "");
      chip.textContent = option.label;
      chip.addEventListener("click", () => {
        state.kind = option.id;
        paintKindChips(live);
        paintList();
      });
      box.append(chip);
    });
  }

  function paintList() {
    const box = document.getElementById("ledger-list");
    box.innerHTML = "";
    const keyword = state.keyword.toLowerCase();
    const items = Workbench.activeItems(state.items)
      .filter((item) => monthOf(item) === state.month)
      .filter((item) => state.kind === "all" || item.kind === state.kind)
      .filter((item) => {
        if (!keyword) return true;
        return [item.category, item.note]
          .join(" ")
          .toLowerCase()
          .includes(keyword);
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty card";
      empty.textContent = state.keyword
        ? "这个月没有匹配的记录。"
        : "这个月还没有记录，点右上角「记一笔」。";
      box.append(empty);
      return;
    }

    const daySum = {};
    items.forEach((item) => {
      daySum[item.date] = (daySum[item.date] || 0) + (item.kind === "income" ? item.amount : -item.amount);
    });

    let currentDate = "";
    items.forEach((item) => {
      if (item.date !== currentDate) {
        currentDate = item.date;
        const head = document.createElement("div");
        head.className = "ledger-day";
        const label = document.createElement("span");
        label.textContent = formatDay(item.date);
        const sumEl = document.createElement("span");
        sumEl.className = "muted";
        sumEl.textContent = `当日合计 ${daySum[item.date] >= 0 ? "+" : "-"}${money(Math.abs(daySum[item.date]))}`;
        head.append(label, sumEl);
        box.append(head);
      }
      box.append(row(item));
    });
  }

  function row(item) {
    const el = document.createElement("article");
    el.className = "card ledger-row";

    const main = document.createElement("div");
    main.className = "ledger-row-main";
    const title = document.createElement("strong");
    title.textContent = item.category || KIND_LABEL[item.kind];
    main.append(title);
    const meta = [item.note].filter(Boolean).join(" · ");
    if (meta) {
      const sub = document.createElement("span");
      sub.className = "muted clamp";
      sub.textContent = meta;
      main.append(sub);
    }

    const amount = document.createElement("b");
    amount.className = "ledger-amount " + (item.kind === "income" ? "is-income" : "is-expense");
    amount.textContent = (item.kind === "income" ? "+" : "-") + money(item.amount);

    const actions = document.createElement("div");
    actions.className = "ledger-row-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "linkish";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => openEditor(item.id));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "linkish danger";
    del.textContent = "删除";
    del.addEventListener("click", () => remove(item));
    actions.append(edit, del);

    el.append(main, amount, actions);
    return el;
  }

  /* ===== 新增 / 编辑 ===== */

  function openEditor(id) {
    state.editingId = id || "";
    const item = id ? state.items.find((entry) => entry.id === id) : null;
    document.getElementById("ledger-dialog-title").textContent = item ? "编辑记录" : "记一笔";
    setKind(item ? item.kind : "expense");
    document.getElementById("ledger-amount").value = item ? String(item.amount) : "";
    document.getElementById("ledger-date").value = item ? item.date : Workbench.todayIso();
    fillCategorySelect();
    const cat = item ? item.category : "";
    const select = document.getElementById("ledger-category");
    const customWrap = document.getElementById("ledger-category-custom-wrap");
    const customInput = document.getElementById("ledger-category-custom");
    const known = Array.from(select.options).some((option) => option.value === cat);
    if (cat && !known) {
      select.value = "__custom__";
      customWrap.hidden = false;
      customInput.value = cat;
    } else {
      select.value = cat;
      customWrap.hidden = true;
      customInput.value = "";
    }
    document.getElementById("ledger-note").value = item ? item.note : "";
    setError("");
    document.getElementById("ledger-dialog").showModal();
    document.getElementById("ledger-amount").focus();
  }

  function closeEditor() {
    const dialog = document.getElementById("ledger-dialog");
    if (dialog.open) dialog.close();
  }

  function fillCategorySelect() {
    const live = Workbench.activeItems(state.items);
    const history = unique(live.map((item) => item.category).filter(Boolean));
    const categories = unique(DEFAULT_CATEGORIES.concat(history));
    const select = document.getElementById("ledger-category");
    select.innerHTML = "";
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "（无分类）";
    select.append(emptyOption);
    categories.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    });
    const customOption = document.createElement("option");
    customOption.value = "__custom__";
    customOption.textContent = "➕ 自定义…";
    select.append(customOption);
    const datalist = document.getElementById("ledger-category-options");
    datalist.innerHTML = "";
    categories.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      datalist.append(option);
    });
  }

  function setKind(kind) {
    document.querySelectorAll("#ledger-kind .seg-btn").forEach((button) => {
      button.classList.toggle("on", button.dataset.kind === kind);
    });
  }

  function selectedKind() {
    const on = document.querySelector("#ledger-kind .seg-btn.on");
    return on ? on.dataset.kind : "expense";
  }

  async function save(event) {
    event.preventDefault();
    const amount = Number(document.getElementById("ledger-amount").value);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("金额要填一个大于 0 的数");
      return;
    }
    const date = document.getElementById("ledger-date").value || Workbench.todayIso();
    const now = new Date().toISOString();
    const catSelect = document.getElementById("ledger-category");
    let category = catSelect.value;
    if (category === "__custom__") category = document.getElementById("ledger-category-custom").value.trim();
    const patch = {
      kind: selectedKind(),
      amount: Math.abs(amount),
      date,
      category,
      note: document.getElementById("ledger-note").value.trim(),
      updatedAt: now
    };

    const list = state.items.slice();
    const index = list.findIndex((item) => item.id === state.editingId);
    if (index >= 0) {
      list[index] = Object.assign({}, list[index], patch);
    } else {
      list.push(Object.assign({ id: Workbench.uid(), createdAt: now, deletedAt: "" }, patch));
    }

    try {
      await Workbench.saveLedgers(list);
      state.items = list;
      closeEditor();
      // 跳到这笔记录所在的月份，免得"存好了却看不见"
      state.month = date.slice(0, 7);
      render();
      Nav.toast(index >= 0 ? "已更新" : "已记下");
    } catch (err) {
      setError(err && err.message ? err.message : "保存失败");
    }
  }

  async function remove(item) {
    const ok = await Nav.ask({
      title: "删除这笔记录",
      text: `${item.date} · ${KIND_LABEL[item.kind]} ${money(item.amount)}`
        + (item.category ? " · " + item.category : "")
        + (item.note ? "\n" + item.note : ""),
      okText: "删除",
      cancelText: "取消",
      danger: true
    });
    if (!ok) return;

    const list = state.items.slice();
    const index = list.findIndex((entry) => entry.id === item.id);
    if (index < 0) return;
    const backup = list[index].deletedAt || "";
    const stamp = new Date().toISOString();
    list[index] = Object.assign({}, list[index], { deletedAt: stamp, updatedAt: stamp });
    await Workbench.saveLedgers(list);
    state.items = list;
    render();

    Nav.toast("已删除", {
      label: "撤销",
      onSelect: async () => {
        const back = state.items.slice();
        const at = back.findIndex((entry) => entry.id === item.id);
        if (at < 0) return;
        back[at] = Object.assign({}, back[at], { deletedAt: backup, updatedAt: new Date().toISOString() });
        await Workbench.saveLedgers(back);
        state.items = back;
        render();
      }
    });
  }

  /* ===== 小工具 ===== */

  function monthOf(item) {
    return String(item.date || "").slice(0, 7);
  }

  function currentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  function monthKeyOffset(month, delta) {
    const year = Number(month.slice(0, 4));
    const index = Number(month.slice(5, 7)) - 1 + delta;
    const date = new Date(year, index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function shiftMonth(delta) {
    state.month = monthKeyOffset(state.month, delta);
    render();
  }

  function daysInMonth(month) {
    return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  }

  function formatDay(iso) {
    const date = Workbench.dateFromIso(iso);
    if (!date) return iso;
    const week = "日一二三四五六"[date.getDay()];
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日 · 周${week}`;
  }

  function money(value) {
    const number = Number(value) || 0;
    const fixed = Math.abs(number).toFixed(2);
    const parts = fixed.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  }

  function sum(items) {
    return items.reduce((total, item) => total + (Number(item.amount) || 0), 0);
  }

  function unique(values) {
    const seen = [];
    values.forEach((value) => {
      const text = String(value || "").trim();
      if (text && seen.indexOf(text) < 0) seen.push(text);
    });
    return seen;
  }

  function setText(id, text) {
    document.getElementById(id).textContent = text;
  }

  function setError(message) {
    const el = document.getElementById("ledger-error");
    el.textContent = message || "";
    el.hidden = !message;
  }
})();
