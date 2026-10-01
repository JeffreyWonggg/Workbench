/* 记谱页面逻辑：歌曲列表 / 编辑 / 谱面显示 / 转调 / 推荐调 / 试听 / 导出。
   数据落地：charts.json（歌曲）+ chart-settings.json（擅长和弦、音量等偏好）。 */
(function () {
  "use strict";

  const Core = window.ChartCore;
  const Text = window.ChartText;
  const Suggest = window.ChartSuggest;
  const Audio = window.ChartAudio;
  const $ = (id) => document.getElementById(id);

  const SONGS_FILE = "charts.json";
  const SETTINGS_FILE = "chart-settings.json";
  const SETTINGS_DEFAULT = { favorites: [], weight: 0, volume: 80 };
  const NO_KEY = "未标调";   // 没填调的歌曲在筛选条里的分组名

  const state = {
    songs: [],
    settings: Object.assign({}, SETTINGS_DEFAULT),
    keyword: "",
    keyFilter: "",
    editing: "",        // 正在编辑的歌曲 id，空 = 新增
    viewing: "",        // 正在查看的歌曲 id
    transposing: "",    // 正在转调的歌曲 id
    pendingDelete: "",
    undo: null,         // 删除后的快照，供「撤销」放回原位
    suggestTimer: 0
  };

  Nav.boot("chart", async () => {
    bind();
    await load();
    applyHash(true);
    // 记谱已纳入云同步：别处（另一台设备、另一个标签页）改了歌就重新读一遍。
    // 正在编辑时不打断，编辑器的内容还没存。
    Workbench.onChange(["charts.json", "chart-settings.json"], async () => {
      if (state.editing) return;
      await load();
    });
  });

  /* ===== 数据 ===== */

  function normalizeSong(item, index) {
    const capo = Number(item && item.capo);
    return {
      id: String((item && item.id) || "").trim() || "chart-" + (index + 1),
      title: String((item && item.title) || "").trim(),
      key: String((item && item.key) || "").trim(),
      capo: Number.isFinite(capo) ? Math.min(12, Math.max(0, Math.round(capo))) : 0,
      content: String((item && item.content) || ""),
      createdAt: String((item && item.createdAt) || ""),
      updatedAt: String((item && item.updatedAt) || ""),
      deletedAt: String((item && item.deletedAt) || "")
    };
  }

  function normalizeSettings(raw) {
    const options = raw && typeof raw === "object" ? raw : {};
    const toList = (value) => (Array.isArray(value) ? value : [])
      .map((name) => String(name == null ? "" : name).trim()).filter((name) => name.length > 0);
    const weight = Number(options.weight);
    const volume = Number(options.volume);
    return {
      favorites: toList(options.favorites),
      weight: Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0,
      volume: Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : 80
    };
  }

  async function load() {
    const list = await Workbench.readJson(SONGS_FILE, []);
    state.songs = (Array.isArray(list) ? list : []).map(normalizeSong);
    state.settings = normalizeSettings(await Workbench.readJson(SETTINGS_FILE, SETTINGS_DEFAULT));
    Audio.setVolume(state.settings.volume / 100);
    $("chart-volume").value = String(state.settings.volume);
    renderKeyChips();
    renderList();
    renderCount();
  }

  async function saveSongs(list) {
    state.songs = list.map(normalizeSong);
    await Workbench.writeJson(SONGS_FILE, state.songs);
  }

  async function saveSettings(patch) {
    state.settings = normalizeSettings(Object.assign({}, state.settings, patch));
    await Workbench.writeJson(SETTINGS_FILE, state.settings);
    Audio.setVolume(state.settings.volume / 100);
  }

  function songById(id) { return state.songs.find((item) => item.id === id) || null; }
  // 不做回收站，deletedAt 只用来兼容别处写进来的旧数据（标了就不再显示）
  function activeSongs() { return state.songs.filter((item) => !item.deletedAt); }

  /* ===== 列表 ===== */

  function visible() {
    const keyword = state.keyword;
    const rows = activeSongs().filter((item) => {
      if (state.keyFilter === NO_KEY) {
        if (item.key) return false;
      } else if (state.keyFilter && item.key !== state.keyFilter) {
        return false;
      }
      if (!keyword) return true;
      return [item.title, item.key, item.content].join(" ").toLowerCase().indexOf(keyword) >= 0;
    });
    // 固定按最近更新排在前，同一天的再按歌名
    return rows.sort((a, b) => {
      const left = String(b.updatedAt || b.createdAt || "");
      const right = String(a.updatedAt || a.createdAt || "");
      return left.localeCompare(right) || (a.title || "").localeCompare(b.title || "", "zh");
    });
  }

  function renderKeyChips() {
    const box = $("chart-keys");
    box.innerHTML = "";
    const counts = new Map();
    activeSongs().forEach((item) => {
      const name = item.key || NO_KEY;
      counts.set(name, (counts.get(name) || 0) + 1);
    });
    if (counts.size === 0) return;
    // 「全部调」= keyFilter 置空；chip 的第 5 个参数是点击回调，不能漏
    box.append(chip("", "全部调", activeSongs().length, state.keyFilter === "",
      () => pickKey("")));
    Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
      .forEach(([name, count]) => {
        box.append(chip(name, name, count, state.keyFilter === name, () => pickKey(name)));
      });
  }

  function pickKey(name) {
    state.keyFilter = state.keyFilter === name ? "" : name;
    renderKeyChips();
    renderList();
    renderCount();
  }

  function chip(value, label, count, on, action) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "chip" + (on ? " on" : "");
    el.dataset.value = value;
    el.setAttribute("aria-pressed", on ? "true" : "false");
    el.textContent = label + "（" + count + "）";
    if (action) el.addEventListener("click", action);
    return el;
  }

  function renderCount() {
    const alive = activeSongs().length;
    const shown = visible().length;
    const parts = ["共 " + alive + " 首"];
    const keys = new Set(activeSongs().map((item) => item.key || NO_KEY));
    if (alive > 0) parts.push("调 " + keys.size + " 个");
    if (shown !== alive) parts.push("当前显示 " + shown + " 首");
    $("chart-count").textContent = parts.join(" · ");
  }

  function renderList() {
    const box = $("chart-list");
    box.innerHTML = "";
    const rows = visible();
    if (rows.length === 0) {
      box.append(emptyState(activeSongs().length === 0
        ? "还没有歌曲。粘一份谱子进来，或者从新增开始记。"
        : "没有匹配的歌曲，换个关键词或切回全部。"));
      return;
    }
    rows.forEach((item) => box.append(card(item)));
  }

  function emptyState(text) {
    const wrap = document.createElement("div");
    wrap.className = "card";
    const line = document.createElement("p");
    line.className = "empty";
    line.textContent = text;
    wrap.append(line);
    if (activeSongs().length === 0) {
      const actions = document.createElement("div");
      actions.className = "chart-empty-actions";
      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn primary";
      add.textContent = "新增歌曲";
      add.addEventListener("click", () => openEditor(""));
      actions.append(add);
      wrap.append(actions);
    }
    return wrap;
  }

  function card(item) {
    const el = document.createElement("article");
    el.className = "card chart-card";
    el.dataset.id = item.id;

    const head = document.createElement("div");
    head.className = "chart-card-head";
    const title = document.createElement("h2");
    title.textContent = item.title || "未命名";
    head.append(title);
    if (item.key) {
      const pill = document.createElement("span");
      pill.className = "chart-pill";
      pill.textContent = item.key;
      head.append(pill);
    }
    if (item.capo > 0) {
      const pill = document.createElement("span");
      pill.className = "chart-pill capo";
      pill.textContent = "变调夹 " + item.capo;
      head.append(pill);
    }
    const actions = document.createElement("span");
    actions.className = "chart-card-actions";
    actions.append(actionButton("查看", { view: item.id }), actionButton("编辑", { edit: item.id }),
      actionButton("转调", { transpose: item.id }), actionButton("删除", { remove: item.id }, true));
    head.append(actions);

    const excerpt = document.createElement("pre");
    excerpt.className = "chart-excerpt";
    excerpt.textContent = excerptOf(item);

    const foot = document.createElement("div");
    foot.className = "chart-card-foot";
    const chords = Text.parse(item.content).chords.length;
    foot.append(muted("和弦 " + chords + " 个"));
    const stamp = item.updatedAt || item.createdAt;
    if (stamp) foot.append(muted("更新于 " + Workbench.formatShortDate(stamp)));

    el.append(head, excerpt, foot);
    return el;
  }

  function excerptOf(item) {
    const lines = Text.format(item.content).split("\n")
      .filter((line) => line.trim().length > 0).slice(0, 5);
    return lines.length > 0 ? lines.join("\n") : "（空谱面）";
  }

  function muted(text) {
    const span = document.createElement("span");
    span.className = "muted";
    span.textContent = text;
    return span;
  }

  function actionButton(label, dataset, danger) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "linkish" + (danger ? " danger" : "");
    button.textContent = label;
    Object.keys(dataset).forEach((key) => { button.dataset[key] = dataset[key]; });
    return button;
  }

  /* ===== 事件绑定 ===== */

  function bind() {
    $("chart-add").addEventListener("click", () => openEditor(""));
    $("chart-favorites").addEventListener("click", openFavorites);

    const search = $("chart-search");
    search.addEventListener("input", () => {
      state.keyword = search.value.trim().toLowerCase();
      renderList();
      renderCount();
    });

    $("chart-list").addEventListener("click", (event) => {
      const hit = event.target.closest("[data-view],[data-edit],[data-transpose],[data-remove]");
      if (!hit) return;
      const data = hit.dataset;
      if (data.view) return openViewer(data.view);
      if (data.edit) return openEditor(data.edit);
      if (data.transpose) return openTranspose(data.transpose);
      if (data.remove) return openDelete(data.remove);
    });

    bindEditor();
    bindViewer();
    bindTranspose();
    bindFavorites();
    bindDelete();

    window.addEventListener("hashchange", () => applyHash(false));
  }

  /* ===== 删除（不做回收站，只留一次「撤销」）===== */

  function bindDelete() {
    $("chart-del-cancel").addEventListener("click", () => $("chart-del-dialog").close());
    $("chart-del-form").addEventListener("submit", (event) => {
      event.preventDefault();
      $("chart-del-dialog").close();
      return confirmDelete();
    });
  }

  function openDelete(id) {
    const item = songById(id);
    if (!item) return;
    state.pendingDelete = id;
    $("chart-del-title").textContent = "删除歌曲";
    $("chart-del-text").textContent = "「" + (item.title || "未命名") + "」会被删掉，删完还能在提示里撤销一次。";
    $("chart-del-ok").textContent = "删除";
    $("chart-del-dialog").showModal();
  }

  async function confirmDelete() {
    const id = state.pendingDelete;
    state.pendingDelete = "";
    const index = state.songs.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const item = state.songs[index];
    state.undo = { item: item, index: index };
    await saveSongs(state.songs.filter((entry) => entry.id !== id));
    renderKeyChips();
    renderList();
    renderCount();
    Nav.toast("已删除「" + (item.title || "未命名") + "」", { label: "撤销", onSelect: undoDelete });
  }

  // 撤销把歌放回原来的位置，避免列表顺序被搅乱
  async function undoDelete() {
    const snapshot = state.undo;
    state.undo = null;
    if (!snapshot || songById(snapshot.item.id)) return;
    const list = state.songs.slice();
    list.splice(Math.min(snapshot.index, list.length), 0, snapshot.item);
    await saveSongs(list);
    renderKeyChips();
    renderList();
    renderCount();
    Nav.toast("已恢复「" + (snapshot.item.title || "未命名") + "」");
  }

  /* ===== 定位（chart.html#<id>）===== */

  function applyHash(initial) {
    const id = decodeURIComponent((location.hash || "").replace(/^#/, ""));
    if (!id) return;
    const item = songById(id);
    if (!item || item.deletedAt) return;
    if (state.keyword || state.keyFilter) {
      state.keyword = "";
      state.keyFilter = "";
      $("chart-search").value = "";
      renderKeyChips();
      renderList();
      renderCount();
    }
    const card = document.querySelector('.chart-card[data-id="' + id.replace(/["\\]/g, "\\$&") + '"]');
    if (!card) return;
    card.scrollIntoView({ block: initial ? "start" : "center" });
    card.classList.add("is-focus");
    setTimeout(() => card.classList.remove("is-focus"), 2000);
  }

  /* ===== 编辑器 ===== */

  function bindEditor() {
    const keySelect = $("chart-key");
    Core.KEYS.forEach((key) => {
      const option = document.createElement("option");
      option.value = key.name;
      option.textContent = key.name;
      keySelect.append(option);
    });
    $("chart-cancel").addEventListener("click", () => $("chart-editor").close());
    $("chart-form").addEventListener("submit", saveSong);
    $("chart-paste").addEventListener("click", () => {
      const area = $("chart-content");
      const next = Text.inlineConvert(Text.clean(area.value));
      if (next === area.value) return Nav.toast("没有可清洗的内容");
      area.value = next;
      refreshEditor();
      Nav.toast("已清洗并合并内联和弦");
    });
    $("chart-format").addEventListener("click", () => {
      const area = $("chart-content");
      area.value = Text.format(area.value);
      refreshEditor();
      Nav.toast("已按列对齐");
    });
    $("chart-recommend").addEventListener("click", () => {
      const best = bestKey($("chart-content").value, currentEditorKey());
      keySelect.value = best.name;
      renderChordPanel();
      Nav.toast("推荐调：" + best.name + "（黑键 " + best.blackKeyCount + " 处）");
    });
    $("chart-volume").addEventListener("input", (event) => {
      saveSettings({ volume: Number(event.target.value) });
    });
    $("chart-chords").addEventListener("click", (event) => {
      const hit = event.target.closest("[data-chord]");
      if (!hit) return;
      const name = hit.dataset.chord;
      if (event.shiftKey) return Audio.playChord(name, "block", 1.0);
      return insertChord(name);
    });
    keySelect.addEventListener("change", () => {
      renderChordPanel();
      refreshEditor();
    });

    const area = $("chart-content");
    area.addEventListener("input", () => {
      refreshEditor();
      window.clearTimeout(state.suggestTimer);
      state.suggestTimer = window.setTimeout(updateSuggest, 120);
    });
    area.addEventListener("click", () => updateSuggest());
    area.addEventListener("blur", () => window.setTimeout(hideSuggest, 150));
    area.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideSuggest();
      if (event.key === "Tab" && !$("chart-suggest").hidden) {
        const first = $("chart-suggest").querySelector("[data-chord]");
        if (first) {
          event.preventDefault();
          insertChord(first.dataset.chord);
        }
      }
    });
    $("chart-suggest").addEventListener("mousedown", (event) => {
      const hit = event.target.closest("[data-chord]");
      if (!hit) return;
      event.preventDefault();   // 别让 textarea 先失焦
      insertChord(hit.dataset.chord);
    });
  }

  function currentEditorKey() {
    return Core.findKey($("chart-key").value) || Core.KEYS[0];
  }

  function openEditor(id) {
    state.editing = id || "";
    const item = id ? songById(id) : null;
    $("chart-editor-title").textContent = item ? "编辑歌曲" : "新增歌曲";
    $("chart-title").value = item ? item.title : "";
    $("chart-key").value = (item && Core.findKey(item.key) ? item.key : Core.KEYS[0].name);
    $("chart-capo").value = String(item ? item.capo : 0);
    $("chart-content").value = item ? item.content : "";
    setError("");
    hideSuggest();
    renderChordPanel();
    refreshEditor();
    $("chart-editor").showModal();
    $("chart-title").focus();
  }

  function setError(message) {
    const el = $("chart-error");
    el.textContent = message || "";
    el.hidden = !message;
  }

  function refreshEditor() {
    renderChordPanelHint();
    renderSheet($("chart-preview"), $("chart-content").value);
  }

  function renderChordPanel() {
    const key = currentEditorKey();
    const box = $("chart-chords");
    box.innerHTML = "";
    const names = [];
    const seen = new Set();
    const push = (name) => {
      const low = name.toLowerCase();
      if (seen.has(low)) return;
      seen.add(low);
      names.push(name);
    };
    state.settings.favorites.forEach((name) => {
      if (Core.isValidChord(name)) push(name);
    });
    for (let degree = 1; degree <= 7; degree++) {
      push(Core.chordName(Suggest.chordFromDegree(key, degree), key.useSharps));
    }
    (key.major ? [1, 2, 5, 6] : [1, 4, 5]).forEach((degree) => {
      const quality = key.major
        ? (degree === 1 ? 6 : degree === 5 ? 8 : 7)
        : (degree === 5 ? 8 : 7);
      push(Core.chordName(Core.makeChord(Suggest.degreeToNote(key, degree), quality, null), key.useSharps));
    });
    names.forEach((name) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "chip";
      el.dataset.chord = name;
      el.title = "点击插入，按住 Shift 点击试听";
      el.textContent = name;
      box.append(el);
    });
  }

  function renderChordPanelHint() {
    const key = currentEditorKey();
    const favorites = state.settings.favorites.filter((name) => Core.isValidChord(name)).length;
    $("chart-chord-hint").textContent = key.name + " 调内和弦 · 擅长 " + favorites + " 个";
  }

  /* 光标处的和弦前缀 → 补全候选 */
  function updateSuggest() {
    const area = $("chart-content");
    const box = $("chart-suggest");
    const before = area.value.slice(0, area.selectionStart);
    const match = /([A-G][#b]?[A-Za-z0-9#°+]*)$/.exec(before);
    if (!match || match[1].length < 1) return hideSuggest();
    const key = currentEditorKey();
    const used = Text.parse(area.value).chords.map((chord) => Core.chordName(chord, key.useSharps));
    const names = Suggest.suggest(used, key, {
      prefix: match[1],
      current: match[1],
      favorites: state.settings.favorites,
      count: 6
    });
    if (names.length === 0) return hideSuggest();
    box.hidden = false;
    box.innerHTML = "";
    names.forEach((name) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "chip";
      el.dataset.chord = name;
      el.textContent = name;
      box.append(el);
    });
  }

  function hideSuggest() { $("chart-suggest").hidden = true; }

  // 用候选补全时替换掉已经打了一半的那个和弦
  function insertChord(name) {
    const area = $("chart-content");
    const end = area.selectionStart;
    const before = area.value.slice(0, end);
    const match = /([A-G][#b]?[A-Za-z0-9#°+]*)$/.exec(before);
    const start = match && !$("chart-suggest").hidden ? end - match[1].length : end;
    area.value = area.value.slice(0, start) + name + area.value.slice(end);
    const caret = start + name.length;
    area.setSelectionRange(caret, caret);
    area.focus();
    hideSuggest();
    refreshEditor();
  }

  async function saveSong(event) {
    event.preventDefault();
    const title = $("chart-title").value.trim();
    if (!title) return setError("歌名不能为空");
    const list = state.songs.slice();
    const now = new Date().toISOString();
    const index = state.editing ? list.findIndex((item) => item.id === state.editing) : -1;
    const patch = {
      title: title,
      key: $("chart-key").value,
      capo: Number($("chart-capo").value) || 0,
      content: $("chart-content").value
    };
    if (index >= 0) {
      Object.assign(list[index], patch, { updatedAt: now });
    } else {
      list.push(Object.assign({
        id: Workbench.uid(), createdAt: now, updatedAt: now, deletedAt: ""
      }, patch));
    }
    $("chart-save").disabled = true;
    try {
      await saveSongs(list);
    } catch (err) {
      setError(err && err.message ? err.message : "保存失败");
      return;
    } finally {
      $("chart-save").disabled = false;
    }
    $("chart-editor").close();
    renderKeyChips();
    renderList();
    renderCount();
    Nav.toast(index >= 0 ? "已保存修改" : "已新增「" + title + "」");
  }

  /* ===== 谱面显示（列对齐 + 点和弦试听）===== */

  function renderSheet(box, content) {
    box.innerHTML = "";
    const lines = Text.normalizedLines(content);
    if (lines.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "（空谱面）";
      box.append(empty);
      return;
    }
    lines.forEach((line) => {
      if (line.sectionTitle) {
        const section = document.createElement("div");
        section.className = "chart-section";
        section.textContent = line.sectionTitle;
        box.append(section);
        return;
      }
      if (line.chordRow.trim()) {
        const row = document.createElement("div");
        row.className = "chart-line";
        const spans = line.spans.slice().sort((a, b) => a.start - b.start);
        let cursor = 0;
        spans.forEach((span) => {
          if (span.start > cursor) row.append(document.createTextNode(line.chordRow.slice(cursor, span.start)));
          const el = document.createElement("span");
          el.className = "chart-chord";
          el.dataset.chord = span.name;
          el.title = "试听 " + span.name;
          el.textContent = line.chordRow.substr(span.start, span.length).trim() || span.name;
          row.append(el);
          cursor = span.start + span.length;
        });
        if (cursor < line.chordRow.length) row.append(document.createTextNode(line.chordRow.slice(cursor)));
        box.append(row);
      }
      if (line.lyricRow.trim()) {
        const row = document.createElement("div");
        row.className = "chart-line";
        row.textContent = line.lyricRow;
        box.append(row);
      }
      if (!line.chordRow.trim() && !line.lyricRow.trim()) {
        const blank = document.createElement("div");
        blank.className = "chart-blank";
        box.append(blank);
      }
    });
  }

  document.addEventListener("click", (event) => {
    const hit = event.target.closest(".chart-chord");
    if (!hit) return;
    if (!Audio.playChord(hit.dataset.chord, "block", 1.0)) return;
    hit.classList.add("is-playing");
    setTimeout(() => hit.classList.remove("is-playing"), 400);
  });

  /* ===== 查看 ===== */

  function bindViewer() {
    $("chart-view-close").addEventListener("click", () => $("chart-view").close());
    $("chart-view-copy").addEventListener("click", () => {
      const item = songById(state.viewing);
      if (item) copyChart(item);
    });
    $("chart-view-print").addEventListener("click", () => {
      const item = songById(state.viewing);
      if (item) printChart(item);
    });
  }

  function openViewer(id) {
    const item = songById(id);
    if (!item) return;
    state.viewing = id;
    $("chart-view-title").textContent = item.title || "未命名";
    const parts = [];
    if (item.key) parts.push("调 " + item.key);
    if (item.capo > 0) parts.push("变调夹 " + item.capo);
    parts.push("和弦 " + Text.parse(item.content).chords.length + " 个");
    if (item.updatedAt) parts.push("更新于 " + Workbench.formatShortDate(item.updatedAt));
    $("chart-view-meta").textContent = parts.join(" · ");
    renderSheet($("chart-sheet"), item.content);
    $("chart-view").showModal();
  }

  /* ===== 导出 ===== */

  function chartTextOf(item) {
    const head = ["# " + (item.title || "未命名")];
    if (item.key) head.push("# 调：" + item.key);
    if (item.capo > 0) head.push("# 变调夹：" + item.capo);
    return head.join("\n") + "\n\n" + Text.format(item.content) + "\n";
  }

  function downloadTxt(item) {
    const blob = new Blob([chartTextOf(item)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = (item.title || "chord-chart") + ".txt";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    Nav.toast("已导出 TXT");
  }

  async function copyChart(item) {
    try {
      await navigator.clipboard.writeText(chartTextOf(item));
      Nav.toast("谱面已复制");
    } catch (err) {
      Nav.toast("复制失败，改用导出 TXT");
      downloadTxt(item);
    }
  }

  function printChart(item) {
    const win = window.open("", "_blank");
    if (!win) return Nav.toast("浏览器拦了打印窗口");
    const title = Workbench.escapeHtml(item.title || "未命名");
    win.document.write("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">"
      + "<title>" + title + "</title><style>"
      + "body{font-family:\"Microsoft YaHei\",sans-serif;margin:24px;}"
      + "h1{font-size:18px;margin:0 0 4px;}"
      + "p.meta{color:#666;font-size:12px;margin:0 0 16px;}"
      + "pre{font-family:Consolas,\"Cascadia Mono\",monospace;font-size:13px;line-height:1.5;}"
      + "</style></head><body><h1>" + title + "</h1><p class=\"meta\">"
      + Workbench.escapeHtml([item.key ? "调 " + item.key : "", item.capo > 0 ? "变调夹 " + item.capo : ""]
        .filter(Boolean).join(" · "))
      + "</p><pre>" + Workbench.escapeHtml(Text.format(item.content)) + "</pre></body></html>");
    win.document.close();
    win.focus();
    win.print();
  }

  /* ===== 转调 ===== */

  function bindTranspose() {
    const select = $("chart-transpose-key");
    Core.KEYS.forEach((key) => {
      const option = document.createElement("option");
      option.value = key.name;
      option.textContent = key.name;
      select.append(option);
    });
    $("chart-transpose-cancel").addEventListener("click", () => $("chart-transpose").close());
    $("chart-transpose-form").addEventListener("submit", (event) => {
      event.preventDefault();
      applyTranspose(false);
    });
    $("chart-transpose-saveas").addEventListener("click", () => applyTranspose(true));
    select.addEventListener("change", renderTransposeInfo);
  }

  function openTranspose(id) {
    const item = songById(id);
    if (!item) return;
    state.transposing = id;
    const from = Core.findKey(item.key) || Core.KEYS[0];
    $("chart-transpose-key").value = from.name;
    $("chart-transpose-sub").textContent = "「" + (item.title || "未命名") + "」当前 "
      + (item.key || "未标调") + (item.capo > 0 ? "，变调夹 " + item.capo : "");
    renderTransposeInfo();
    $("chart-transpose").showModal();
  }

  function transposeContext() {
    const item = songById(state.transposing);
    if (!item) return null;
    const from = Core.findKey(item.key) || Core.KEYS[0];
    const to = Core.findKey($("chart-transpose-key").value) || from;
    const chords = Text.parse(item.content).chords;
    return { item: item, from: from, to: to, chords: chords, steps: Core.semitonesBetween(from, to) };
  }

  function renderTransposeInfo() {
    const context = transposeContext();
    if (!context) return;
    $("chart-transpose-steps").value = (context.steps > 0 ? "+" : "") + context.steps + " 半音";
    const box = $("chart-transpose-recommend");
    box.innerHTML = "";
    const favorites = state.settings.favorites.map((name) => name);
    Suggest.recommendKeys(context.chords, context.from, {
      favorites: favorites, weight: state.settings.weight
    }).slice(0, 8).forEach((item) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "chip" + (item.name === context.to.name ? " on" : "");
      el.dataset.key = item.name;
      el.append(document.createTextNode(item.name));
      const note = document.createElement("small");
      note.textContent = "黑键 " + item.blackKeyCount
        + (favorites.length > 0 ? " · 覆盖 " + Math.round(item.coverage * 100) + "%" : "");
      el.append(note);
      el.addEventListener("click", () => {
        $("chart-transpose-key").value = item.name;
        renderTransposeInfo();
      });
      box.append(el);
    });
  }

  async function applyTranspose(asNew) {
    const context = transposeContext();
    if (!context) return;
    const content = Text.transposeChart(context.item.content, context.steps, context.to);
    const list = state.songs.slice();
    const now = new Date().toISOString();
    if (asNew) {
      list.push({
        id: Workbench.uid(),
        title: (context.item.title || "未命名") + "（" + context.to.name + "）",
        key: context.to.name,
        capo: context.item.capo,
        content: content,
        createdAt: now,
        updatedAt: now,
        deletedAt: ""
      });
    } else {
      const target = list.find((entry) => entry.id === context.item.id);
      target.content = content;
      target.key = context.to.name;
      target.updatedAt = now;
    }
    await saveSongs(list);
    $("chart-transpose").close();
    renderKeyChips();
    renderList();
    renderCount();
    if (!asNew && state.viewing === context.item.id) openViewer(context.item.id);
    Nav.toast(asNew
      ? "已另存为 " + context.to.name + " 调"
      : "已转为 " + context.to.name + " 调（" + (context.steps > 0 ? "+" : "") + context.steps + " 半音）");
  }

  // 编辑器「推荐调」：直接取打分最优的那个调
  function bestKey(content, fromKey) {
    const chords = Text.parse(content).chords;
    return Suggest.recommendKeys(chords, fromKey, {
      favorites: state.settings.favorites,
      weight: state.settings.weight
    })[0];
  }

  /* ===== 擅长和弦 ===== */

  function bindFavorites() {
    $("chart-favorites-cancel").addEventListener("click", () => $("chart-favorites-dialog").close());
    $("chart-favorites-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const raw = $("chart-favorites-text").value;
      const all = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      const bad = all.filter((name) => !Core.isValidChord(name));
      const good = all.filter((name) => Core.isValidChord(name));
      await saveSettings({
        favorites: good,
        weight: Number($("chart-favorites-weight").value) / 100
      });
      $("chart-favorites-dialog").close();
      renderChordPanel();
      Nav.toast(bad.length > 0
        ? "已保存 " + good.length + " 个，忽略无法识别的 " + bad.length + " 个"
        : "已保存 " + good.length + " 个擅长和弦");
    });
  }

  function openFavorites() {
    $("chart-favorites-text").value = state.settings.favorites.join("\n");
    $("chart-favorites-weight").value = String(Math.round(state.settings.weight * 100));
    $("chart-favorites-dialog").showModal();
    $("chart-favorites-text").focus();
  }
})();
