(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const COLLAPSED_INGREDIENTS = 4;   // 折叠时最多显示几行食材
  const COLLAPSED_STEPS = 3;         // 折叠时最多显示几步做法

  const state = {
    recipes: [],
    keyword: "",
    category: "",
    expanded: new Set(),   // 展开了全文的菜谱 id
    editing: "",           // 正在编辑的 id，空 = 新增
    pendingDelete: ""      // 正在确认删除的 id
  };

  Nav.boot("recipes", async () => {
    bind();
    await load();
    applyHash(true);
  });

  function bind() {
    $("recipe-add").addEventListener("click", () => openEditor(""));
    $("recipe-cancel").addEventListener("click", () => $("recipe-dialog").close());
    $("recipe-form").addEventListener("submit", save);
    $("recipe-del-cancel").addEventListener("click", () => $("recipe-del-dialog").close());
    $("recipe-del-form").addEventListener("submit", confirmDelete);

    const search = $("recipe-search");
    search.addEventListener("input", () => {
      state.keyword = search.value.trim().toLowerCase();
      renderList();
      renderCount();
    });

    $("recipe-categories").addEventListener("click", (event) => {
      const chip = event.target.closest("[data-category]");
      if (!chip) return;
      state.category = chip.dataset.category;
      renderCategories();
      renderList();
      renderCount();
    });

    $("recipe-list").addEventListener("click", (event) => {
      const edit = event.target.closest("[data-edit]");
      if (edit) {
        openEditor(edit.dataset.edit);
        return;
      }
      const remove = event.target.closest("[data-remove]");
      if (remove) {
        openDelete(remove.dataset.remove);
        return;
      }
      const toggle = event.target.closest("[data-toggle]");
      if (toggle) {
        toggleOne(toggle.dataset.toggle);
        return;
      }
      const empty = event.target.closest("[data-clear-filter]");
      if (empty) {
        state.keyword = "";
        state.category = "";
        $("recipe-search").value = "";
        renderCategories();
        renderList();
        renderCount();
      }
    });

    // 从别处跳进来（recipes.html#<id>）时定位到那一条
    window.addEventListener("hashchange", () => applyHash(false));
  }

  async function load() {
    state.recipes = await Workbench.loadRecipes();
    renderCategories();
    renderList();
    renderCount();
    fillCategoryOptions();
  }

  /* ===== 数据视图 ===== */

  function active() {
    return Workbench.activeItems(state.recipes);
  }

  // 关键词匹配菜名/分类/食材/步骤，再按分类筛选，最后按最近更新排序
  function visible() {
    const keyword = state.keyword;
    return active()
      .filter((item) => {
        if (state.category && item.category !== state.category) return false;
        if (!keyword) return true;
        const haystack = [item.name, item.category].concat(item.ingredients, item.steps)
          .join(" ").toLowerCase();
        return haystack.indexOf(keyword) >= 0;
      })
      .sort((a, b) => {
        const left = String(b.updatedAt || b.createdAt || "");
        const right = String(a.updatedAt || a.createdAt || "");
        return left.localeCompare(right) || a.name.localeCompare(b.name, "zh");
      });
  }

  // 分类标签由已有数据动态生成，只列真正用到的
  function categoryList() {
    const counts = new Map();
    active().forEach((item) => {
      const name = item.category || "";
      counts.set(name, (counts.get(name) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"));
  }

  function renderCategories() {
    const box = $("recipe-categories");
    box.innerHTML = "";
    const list = categoryList();
    if (list.length === 0) return;   // 一条都没有时不显示分类行

    const total = active().length;
    box.append(categoryChip("", "全部", total, state.category === ""));
    list.forEach(([name, count]) => {
      if (!name) return;
      box.append(categoryChip(name, name, count, state.category === name));
    });
  }

  function categoryChip(value, label, count, on) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (on ? " on" : "");
    chip.dataset.category = value;
    chip.setAttribute("aria-pressed", on ? "true" : "false");
    chip.textContent = label + "（" + count + "）";
    return chip;
  }

  function fillCategoryOptions() {
    const box = $("recipe-category-options");
    box.innerHTML = "";
    categoryList().forEach(([name]) => {
      if (!name) return;
      const option = document.createElement("option");
      option.value = name;
      box.append(option);
    });
  }

  function renderCount() {
    const total = active().length;
    const shown = visible().length;
    if (total === 0) {
      $("recipe-count").textContent = "";
      return;
    }
    const categories = categoryList().filter(([name]) => name).length;
    const parts = ["共 " + total + " 道菜"];
    if (categories) parts.push("分类 " + categories + " 个");
    if (shown !== total) parts.push("当前显示 " + shown + " 道");
    $("recipe-count").textContent = parts.join(" · ");
  }

  /* ===== 列表 ===== */

  function renderList() {
    const box = $("recipe-list");
    box.innerHTML = "";
    const rows = visible();

    if (active().length === 0) {
      box.append(emptyState("还没有记录菜谱。把常做的菜记下来，下次不用再想。", "新增菜谱", () => openEditor("")));
      return;
    }
    if (rows.length === 0) {
      box.append(emptyState("没有匹配的菜谱，换个关键词或切回全部。", "清空筛选", null, true));
      return;
    }
    rows.forEach((item) => box.append(card(item)));
  }

  function emptyState(text, actionLabel, action, clearFilter) {
    const wrap = document.createElement("div");
    wrap.className = "card recipe-empty";
    const line = document.createElement("p");
    line.className = "empty";
    line.textContent = text;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn" + (clearFilter ? "" : " primary");
    button.textContent = actionLabel;
    if (clearFilter) {
      button.dataset.clearFilter = "1";
    } else {
      button.addEventListener("click", action);
    }
    wrap.append(line, button);
    return wrap;
  }

  function card(item) {
    const expanded = state.expanded.has(item.id);

    const el = document.createElement("article");
    el.className = "card recipe-card";
    el.dataset.id = item.id;

    const head = document.createElement("div");
    head.className = "recipe-card-head";
    const title = document.createElement("h2");
    title.className = "recipe-name";
    title.textContent = item.name || "未命名";
    head.append(title);
    if (item.category) {
      const pill = document.createElement("span");
      pill.className = "recipe-pill";
      pill.textContent = item.category;
      head.append(pill);
    }
    const actions = document.createElement("span");
    actions.className = "recipe-actions";
    actions.append(actionButton("编辑", { edit: item.id }), actionButton("删除", { remove: item.id }, true));
    head.append(actions);

    const body = document.createElement("div");
    body.className = "recipe-body";
    body.append(ingredientBlock(item, expanded), stepBlock(item, expanded));

    const foot = document.createElement("div");
    foot.className = "recipe-card-foot";
    const hiddenCount = Math.max(0, item.ingredients.length - COLLAPSED_INGREDIENTS)
      + Math.max(0, item.steps.length - COLLAPSED_STEPS);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "linkish";
    toggle.dataset.toggle = item.id;
    if (item.ingredients.length <= COLLAPSED_INGREDIENTS && item.steps.length <= COLLAPSED_STEPS) {
      toggle.textContent = "展开";
      toggle.hidden = true;      // 内容本来就短，不需要展开按钮
    } else {
      toggle.textContent = expanded ? "收起" : "展开全部（还有 " + hiddenCount + " 行）";
    }
    foot.append(toggle);
    if (item.updatedAt || item.createdAt) {
      const stamp = document.createElement("span");
      stamp.className = "muted recipe-stamp";
      stamp.textContent = "更新于 " + Workbench.formatShortDate(item.updatedAt || item.createdAt);
      foot.append(stamp);
    }

    el.append(head, body, foot);

    // 点卡片空白处也能展开/收起（点按钮时不触发）
    el.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      toggleOne(item.id);
    });
    return el;
  }

  function actionButton(label, dataset, danger) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "linkish" + (danger ? " danger" : "");
    button.textContent = label;
    Object.keys(dataset).forEach((key) => { button.dataset[key] = dataset[key]; });
    return button;
  }

  function ingredientBlock(item, expanded) {
    const block = document.createElement("div");
    block.className = "recipe-block";
    const title = document.createElement("h3");
    title.className = "recipe-block-title";
    title.textContent = "食材";
    block.append(title);
    if (item.ingredients.length === 0) {
      block.append(mutedLine("没有记录食材"));
      return block;
    }
    const list = document.createElement("ul");
    list.className = "recipe-ingredients";
    const shown = expanded ? item.ingredients : item.ingredients.slice(0, COLLAPSED_INGREDIENTS);
    shown.forEach((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      list.append(li);
    });
    block.append(list);
    if (!expanded && item.ingredients.length > shown.length) {
      block.append(moreLine(item.ingredients.length - shown.length + " 样食材已折叠"));
    }
    return block;
  }

  function stepBlock(item, expanded) {
    const block = document.createElement("div");
    block.className = "recipe-block";
    const title = document.createElement("h3");
    title.className = "recipe-block-title";
    title.textContent = "做法";
    block.append(title);
    if (item.steps.length === 0) {
      block.append(mutedLine("没有记录步骤"));
      return block;
    }
    const list = document.createElement("ol");
    list.className = "recipe-steps";
    const shown = expanded ? item.steps : item.steps.slice(0, COLLAPSED_STEPS);
    shown.forEach((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      list.append(li);
    });
    block.append(list);
    if (!expanded && item.steps.length > shown.length) {
      block.append(moreLine(item.steps.length - shown.length + " 步已折叠"));
    }
    return block;
  }

  function mutedLine(text) {
    const p = document.createElement("p");
    p.className = "muted recipe-none";
    p.textContent = text;
    return p;
  }

  function moreLine(text) {
    const p = document.createElement("p");
    p.className = "muted recipe-more";
    p.textContent = "…还有 " + text;
    return p;
  }

  function toggleOne(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    const card = document.querySelector('.recipe-card[data-id="' + cssEscape(id) + '"]');
    const keepTop = card ? card.getBoundingClientRect().top : 0;
    renderList();
    // 展开/收起后让这张卡留在原来的位置，避免长列表里"跳走"
    const next = document.querySelector('.recipe-card[data-id="' + cssEscape(id) + '"]');
    if (next && card) {
      const delta = next.getBoundingClientRect().top - keepTop;
      if (Math.abs(delta) > 1) window.scrollBy(0, delta);
    }
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, "\\$&");
  }

  /* ===== 新增 / 编辑 ===== */

  function openEditor(id) {
    state.editing = id || "";
    const item = id ? state.recipes.find((entry) => entry.id === id) : null;
    $("recipe-dialog-title").textContent = item ? "编辑菜谱" : "新增菜谱";
    $("recipe-name").value = item ? item.name : "";
    $("recipe-category").value = item ? item.category : (state.category || "");
    $("recipe-ingredients").value = item ? item.ingredients.join("\n") : "";
    $("recipe-steps").value = item ? item.steps.join("\n") : "";
    setError("");
    fillCategoryOptions();
    $("recipe-dialog").showModal();
    $("recipe-name").focus();
  }

  async function save(event) {
    event.preventDefault();
    const name = $("recipe-name").value.trim();
    if (!name) return setError("菜名不能为空");

    const list = state.recipes.slice();
    const ingredients = splitLines($("recipe-ingredients").value);
    const steps = splitLines($("recipe-steps").value);
    const now = new Date().toISOString();
    const existing = state.editing
      ? list.findIndex((item) => item.id === state.editing)
      : -1;

    if (existing >= 0) {
      const item = list[existing];
      item.name = name;
      item.category = $("recipe-category").value.trim();
      item.ingredients = ingredients;
      item.steps = steps;
      item.updatedAt = now;
    } else {
      list.push({
        id: Workbench.uid(),
        name,
        category: $("recipe-category").value.trim(),
        ingredients,
        steps,
        createdAt: now,
        updatedAt: now,
        deletedAt: ""
      });
    }

    $("recipe-save").disabled = true;
    try {
      await Workbench.saveRecipes(list);
    } catch (err) {
      setError(err && err.message ? err.message : "保存失败");
      return;
    } finally {
      $("recipe-save").disabled = false;
    }
    $("recipe-dialog").close();
    state.expanded.add(list[existing >= 0 ? existing : list.length - 1].id);
    await load();
    Nav.toast(existing >= 0 ? "已保存修改" : "已新增「" + name + "」");
  }

  // 一行一项：去空行、去首尾空白
  function splitLines(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function setError(message) {
    const el = $("recipe-error");
    el.textContent = message || "";
    el.hidden = !message;
  }

  /* ===== 删除（软删除 + 撤销）===== */

  function openDelete(id) {
    const item = state.recipes.find((entry) => entry.id === id);
    if (!item) return;
    state.pendingDelete = id;
    $("recipe-del-text").textContent = "「" + (item.name || "未命名")
      + "」会移到回收站，之后可以恢复。";
    $("recipe-del-dialog").showModal();
  }

  async function confirmDelete(event) {
    event.preventDefault();
    const id = state.pendingDelete;
    state.pendingDelete = "";
    $("recipe-del-dialog").close();
    if (!id) return;
    const list = state.recipes.slice();
    const item = list.find((entry) => entry.id === id);
    if (!item) return;
    item.deletedAt = new Date().toISOString();
    item.updatedAt = item.deletedAt;
    await Workbench.saveRecipes(list);
    state.expanded.delete(id);
    await load();
    Nav.toast("已删除「" + (item.name || "未命名") + "」", {
      label: "撤销",
      onSelect: () => restore(id)
    });
  }

  async function restore(id) {
    const list = state.recipes.slice();
    const item = list.find((entry) => entry.id === id);
    if (!item) return;
    item.deletedAt = "";
    item.updatedAt = new Date().toISOString();
    await Workbench.saveRecipes(list);
    await load();
    Nav.toast("已恢复「" + (item.name || "未命名") + "」");
  }

  /* ===== 定位（recipes.html#<id>）===== */

  function applyHash(initial) {
    const id = decodeURIComponent((location.hash || "").replace(/^#/, ""));
    if (!id) return;
    const item = state.recipes.find((entry) => entry.id === id);
    if (!item || Workbench.isDeleted(item)) return;

    // 目标可能被当前筛选挡住，先清掉筛选再定位
    if (state.keyword || state.category) {
      state.keyword = "";
      state.category = "";
      $("recipe-search").value = "";
      renderCategories();
      renderList();
      renderCount();
    }
    if (!state.expanded.has(id)) {
      state.expanded.add(id);
      renderList();
    }
    const card = document.querySelector('.recipe-card[data-id="' + cssEscape(id) + '"]');
    if (!card) return;
    card.scrollIntoView({ block: initial ? "start" : "center" });
    card.classList.add("is-focus");
    setTimeout(() => card.classList.remove("is-focus"), 2000);
  }
})();
