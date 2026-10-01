(function () {
  let notes = [];
  let currentId = null;
  let saveTimer = 0;
  let dirty = false;
  let blocks = [];
  let active = -1;
  let insertAnchor = -1;
  let selectedTable = -1;
  let pointerDown = false;
  let downTarget = null;
  let undoStack = [];
  let redoStack = [];
  const bodyCache = new Map();
  const bodyPending = new Map();
  const PAGE = 50;
  let matched = [];
  let renderLimit = PAGE;
  let scanSeq = 0;
  let scanDone = 0;
  let scanTotal = 0;

  Nav.boot("notes", async () => {
    notes = await Workbench.loadNoteIndex();
    bind();
    renderList();
    const requested = new URLSearchParams(location.search).get("id");
    if (requested && notes.some((note) => note.id === requested && !Workbench.isDeleted(note))) await openNote(requested);
    window.addEventListener("workbench-projects", () => {
      const select = document.getElementById("note-project");
      if (select && currentId) Nav.fillProjects(select, select.value);
      renderList();
    });
    // 别处改了笔记索引就重新读。正在打字（dirty）时不打断——
    // 编辑器里的内容还没存，这时候换掉会让人以为白写了。
    Workbench.onChange(["notes.json"], async () => {
      if (dirty) return;
      notes = await Workbench.loadNoteIndex();
      renderList();
    });
  });

  function bind() {
    document.getElementById("note-search").addEventListener("input", renderList);
    document.getElementById("new-note").addEventListener("click", createNote);
    document.getElementById("note-title").addEventListener("input", markDirty);
    document.getElementById("note-project").addEventListener("change", markDirty);
    document.getElementById("note-pin").addEventListener("change", markDirty);
    mountTablePicker();
    document.getElementById("delete-note").addEventListener("click", removeCurrent);
    document.getElementById("editor-form").addEventListener("submit", (event) => {
      event.preventDefault();
      flush();
    });
    document.getElementById("note-live").addEventListener("mousedown", onLiveMousedown, true);
    document.addEventListener("mouseup", onLiveMouseup);
    document.addEventListener("keydown", onSelectionKeydown, true);
    document.addEventListener("keydown", onUndoKey, true);
    const liveEl = document.getElementById("note-live");
    liveEl.addEventListener("beforeinput", selectionInsert);
    liveEl.addEventListener("copy", onLiveCopy);
    liveEl.addEventListener("cut", onLiveCopy);
    liveEl.addEventListener("paste", onLivePaste);
    liveEl.addEventListener("drop", (event) => {
      if (liveEl.hasAttribute("contenteditable")) event.preventDefault();
    });
    liveEl.addEventListener("compositionend", () => {
      if (!liveEl.hasAttribute("contenteditable")) return;
      setSelecting(false);
      paint({});
    });
    document.getElementById("note-live").addEventListener("focusout", (event) => {
      const live = event.currentTarget;
      if (event.relatedTarget && live.contains(event.relatedTarget)) return;
      if (!event.relatedTarget || !live.contains(event.relatedTarget)) {
        setTimeout(() => {
          if (!live.contains(document.activeElement)) setSelecting(false);
        }, 0);
      }
      if (active < 0) return;
      setTimeout(() => {
        if (live.contains(document.activeElement)) return;
        active = -1;
        blocks = parseBlocks(compose());
        syncSource();
        paint({});
      }, 0);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }

  function queryText() {
    return document.getElementById("note-search").value.trim().toLowerCase();
  }

  async function readBody(note) {
    if (bodyCache.has(note.id)) return;
    let inflight = bodyPending.get(note.id);
    if (!inflight) {
      inflight = (async () => {
        let text = "";
        try {
          text = String((await Workbench.readNoteBody(note.id)) || "");
        } catch (err) {
          text = "";
        }
        // 读取期间若已被保存流程写入最新正文，就别用旧内容覆盖
        if (!bodyCache.has(note.id)) bodyCache.set(note.id, text.toLowerCase());
        bodyPending.delete(note.id);
      })();
      bodyPending.set(note.id, inflight);
    }
    await inflight;
  }

  // 只在输入查询时逐批读取正文；新查询会取消上一轮扫描
  async function scanBodies(q, candidates) {
    const seq = ++scanSeq;
    scanDone = 0;
    scanTotal = candidates.length;
    setCount();
    const BATCH = 25;
    let painted = matched.length;
    for (let i = 0; i < candidates.length; i += BATCH) {
      if (seq !== scanSeq) return;
      const batch = candidates.slice(i, i + BATCH);
      await Promise.all(batch.map(readBody));
      if (seq !== scanSeq) return;
      batch.forEach((note) => {
        const body = bodyCache.get(note.id);
        if (body && body.includes(q)) matched.push(note);
      });
      scanDone = Math.min(i + BATCH, candidates.length);
      if (matched.length !== painted) {
        painted = matched.length;
        paintRows(q);
      } else {
        setCount();
      }
    }
    scanDone = scanTotal;
    setCount();
  }

  // 命中正文时截取一小段上下文
  function bodySnippet(id, q) {
    const text = bodyCache.get(id);
    if (!text) return "";
    const at = text.indexOf(q);
    if (at < 0) return "";
    const start = Math.max(0, at - 18);
    const end = Math.min(text.length, at + q.length + 34);
    return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
  }

  function snippetNode(text, q) {
    const wrap = document.createElement("span");
    wrap.className = "note-snippet";
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) {
      wrap.textContent = text;
      return wrap;
    }
    if (at > 0) wrap.append(document.createTextNode(text.slice(0, at)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(at, at + q.length);
    wrap.append(mark);
    wrap.append(document.createTextNode(text.slice(at + q.length)));
    return wrap;
  }

  function updateActive() {
    const list = document.getElementById("note-list");
    if (!list) return;
    list.querySelectorAll(".note-row").forEach((row) => {
      row.classList.toggle("on", row.dataset.id === currentId);
    });
  }

  function renderList() {
    const q = queryText();
    renderLimit = PAGE;
    const live = notes.filter((note) => !Workbench.isDeleted(note));
    if (!q) {
      scanSeq++;
      scanDone = 0;
      scanTotal = 0;
      matched = live;
      paintRows(q);
      return;
    }
    // 标题命中立即可得；正文交给 scanBodies 逐批补齐
    const byTitle = [];
    const rest = [];
    live.forEach((note) => {
      if (String(note.title || "").toLowerCase().includes(q)) byTitle.push(note);
      else rest.push(note);
    });
    matched = byTitle;
    paintRows(q);
    scanBodies(q, rest);
  }

  function setCount() {
    const count = document.getElementById("note-count");
    if (!count) return;
    if (!queryText()) {
      count.textContent = matched.length ? matched.length + " 篇" : "";
      return;
    }
    const suffix = scanDone < scanTotal ? " · 搜索中 " + scanDone + "/" + scanTotal : "";
    count.textContent = (matched.length ? matched.length + " 篇" : "无结果") + suffix;
  }

  function paintRows(q) {
    const list = document.getElementById("note-list");
    const prevScroll = list.scrollTop;
    list.innerHTML = "";
    setCount();
    if (!matched.length) {
      list.append(emptyRow(q ? "没有匹配的笔记。" : "没有笔记。"));
      list.scrollTop = prevScroll;
      return;
    }
    const shown = q ? matched.slice(0, renderLimit) : matched;
    const pinned = shown.filter((note) => note.pinned);
    const rest = shown.filter((note) => !note.pinned);
    if (pinned.length) {
      list.append(label("置顶"));
      pinned.forEach((note) => list.append(rowButton(note, q)));
    }
    const groups = new Map();
    rest.forEach((note) => {
      const key = note.project || "其他";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(note);
    });
    const order = Workbench.meta.projects.filter((name) => groups.has(name));
    groups.forEach((_, name) => {
      if (!order.includes(name)) order.push(name);
    });
    order.forEach((name) => {
      list.append(label(name));
      groups.get(name).forEach((note) => list.append(rowButton(note, q)));
    });
    if (q && matched.length > shown.length) {
      list.append(moreButton(matched.length - shown.length));
    }
    list.scrollTop = prevScroll;
  }

  function moreButton(rest) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-more";
    button.textContent = "显示更多（还有 " + rest + " 篇）";
    button.addEventListener("click", () => {
      renderLimit += PAGE;
      paintRows(queryText());
    });
    return button;
  }

  function emptyRow(text) {
    const el = document.createElement("div");
    el.className = "empty";
    el.textContent = text;
    return el;
  }

  function label(text) {
    const el = document.createElement("div");
    el.className = "group-label";
    el.textContent = text;
    return el;
  }

  function rowButton(note, q) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-row" + (note.id === currentId ? " on" : "");
    button.dataset.id = note.id;
    const titleText = note.title || "未命名";
    const title = document.createElement("strong");
    title.textContent = titleText;
    const meta = document.createElement("span");
    meta.className = "muted";
    const bits = [note.project || "未分类", Workbench.formatShortDate(note.updatedAt)];
    meta.textContent = bits.filter(Boolean).join(" · ");
    button.append(title, meta);
    // 标题未命中但正文命中：附一行上下文
    if (q && !titleText.toLowerCase().includes(q)) {
      const snippet = bodySnippet(note.id, q);
      if (snippet) button.append(snippetNode(snippet, q));
    }
    button.addEventListener("click", () => openNote(note.id));
    return button;
  }

  async function openNote(id) {
    await saveCurrent();
    const note = notes.find((item) => item.id === id);
    if (!note) return;
    currentId = id;
    document.getElementById("editor-empty").hidden = true;
    document.getElementById("editor-form").hidden = false;
    document.getElementById("note-title").value = note.title || "";
    Nav.fillProjects(document.getElementById("note-project"), note.project || Workbench.meta.projects[0]);
    document.getElementById("note-pin").checked = !!note.pinned;
    loadSource(await Workbench.readNoteBody(id));
    document.getElementById("save-state").textContent = "已保存";
    dirty = false;
    updateActive();
  }

  function loadSource(text) {
    const source = String(text || "").replace(/\r\n/g, "\n");
    document.getElementById("note-body").value = source;
    blocks = parseBlocks(source);
    active = -1;
    insertAnchor = Math.max(blocks.length - 1, 0);
    undoStack = [];
    redoStack = [];
    paint({});
  }

  function captureFocus() {
    const area = document.activeElement;
    if (area && area.tagName === "TEXTAREA" && area.closest && area.closest("#note-live")) {
      return { kind: "text", offset: blockOffset(Number(area.dataset.index)) + area.selectionStart };
    }
    const cell = area && area.closest && area.closest("#note-live th, #note-live td");
    if (cell) {
      const block = cell.closest(".live-block");
      return {
        kind: "table",
        index: Number(block.dataset.index),
        row: Number(cell.dataset.row),
        col: Number(cell.dataset.col)
      };
    }
    return { kind: "text", offset: blockOffset(Math.max(active, 0)) };
  }

  function saveUndoPoint() {
    const source = compose();
    const last = undoStack[undoStack.length - 1];
    if (last && last.source === source) return;
    undoStack.push({ source: source, focus: captureFocus() });
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
  }

  function restoreHistory(entry) {
    blocks = parseBlocks(entry.source);
    active = -1;
    syncSource();
    markDirty();
    const focus = entry.focus;
    if (focus && focus.kind === "table" && blocks[focus.index] && blocks[focus.index].type === "table") {
      remember(focus.index);
      paint({ table: { block: focus.index, row: focus.row, col: focus.col } });
      return;
    }
    enterAt(focus && focus.kind === "text" ? focus.offset : 0);
  }

  function undoEdit() {
    const entry = undoStack.pop();
    if (!entry) return;
    redoStack.push({ source: compose(), focus: captureFocus() });
    restoreHistory(entry);
  }

  function redoEdit() {
    const entry = redoStack.pop();
    if (!entry) return;
    undoStack.push({ source: compose(), focus: captureFocus() });
    restoreHistory(entry);
  }

  function onUndoKey(event) {
    if (event.isComposing) return;
    const live = document.getElementById("note-live");
    if (!live || !event.target || !live.contains(event.target)) return;
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || event.altKey) return;
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      undoEdit();
    } else if (key === "y" || (key === "z" && event.shiftKey)) {
      event.preventDefault();
      redoEdit();
    }
  }

  function watchUndo(target) {
    target.addEventListener("beforeinput", (event) => {
      if (event.isComposing || event.inputType === "insertCompositionText" || event.inputType === "deleteCompositionText") return;
      saveUndoPoint();
    });
    target.addEventListener("compositionstart", saveUndoPoint);
  }

  function remember(index) {
    if (index >= 0) insertAnchor = index;
  }

  function isTableSeparator(line) {
    return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(String(line || "").trim());
  }

  function isTableRow(line) {
    return /^\|.+\|$/.test(String(line || "").trim());
  }

  function parseBlocks(src) {
    const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
    const next = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].startsWith("```")) {
        let end = i + 1;
        while (end < lines.length && !lines[end].startsWith("```")) end += 1;
        if (end < lines.length) {
          next.push({ type: "code", text: lines.slice(i, end + 1).join("\n") });
          i = end + 1;
          continue;
        }
      }
      if (isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        let end = i + 2;
        while (end < lines.length && isTableRow(lines[end])) end += 1;
        next.push({ type: "table", text: lines.slice(i, end).join("\n") });
        i = end;
        continue;
      }
      next.push({ type: "text", text: lines[i] });
      i += 1;
    }
    if (!next.length) next.push({ type: "text", text: "" });
    return next;
  }

  function compose() {
    return blocks.map((block) => block.text).join("\n");
  }

  function syncSource() {
    document.getElementById("note-body").value = compose();
  }

  function blockLineStart(index) {
    let line = 0;
    for (let i = 0; i < index; i += 1) line += blocks[i].text.split("\n").length;
    return line;
  }

  function lineCount() {
    return blocks.reduce((sum, block) => sum + block.text.split("\n").length, 0);
  }

  function locate(line, offset) {
    let cursor = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      const parts = blocks[i].text.split("\n");
      if (line < cursor + parts.length) {
        const inner = line - cursor;
        if (blocks[i].type === "table") return { index: i, type: "table", inner };
        let pos = 0;
        for (let k = 0; k < inner; k += 1) pos += parts[k].length + 1;
        pos += Math.min(Math.max(offset, 0), parts[inner].length);
        return { index: i, type: blocks[i].type, pos };
      }
      cursor += parts.length;
    }
    const last = blocks.length - 1;
    return { index: last, type: blocks[last].type, pos: blocks[last].text.length, inner: 0 };
  }

  function reparseLocate(line, offset) {
    blocks = parseBlocks(compose());
    syncSource();
    return locate(line, offset);
  }

  function paint(focus) {
    const live = document.getElementById("note-live");
    setSelecting(false);
    if (!blocks.length) blocks.push({ type: "text", text: "" });
    live.innerHTML = "";
    blocks.forEach((block, index) => live.append(renderBlock(block, index)));
    if (focus && focus.table) {
      const cell = cellAt(focus.table.block, focus.table.row, focus.table.col);
      if (cell) {
        if (focus.select) selectContents(cell);
        else placeCaret(cell, false);
      }
      return;
    }
    if (focus && focus.caret != null && active >= 0) {
      const area = live.querySelector('textarea[data-index="' + active + '"]');
      if (area) {
        area.focus();
        const pos = Math.min(focus.caret, area.value.length);
        area.setSelectionRange(pos, pos);
        autosize(area);
      }
    }
  }

  function renderBlock(block, index) {
    if (block.type === "table") return renderTable(block, index);
    if (index === active) return renderSource(block, index);
    const view = document.createElement("div");
    view.className = "live-block live-rendered";
    view.dataset.index = String(index);
    view.dataset.line = String(blockLineStart(index));
    const html = Workbench.renderMarkdown(block.text);
    if (!html) view.classList.add("live-empty");
    else view.innerHTML = html;
    return view;
  }

  function onLiveMousedown(event) {
    if (event.button !== 0) return;
    clearTableSelection();
    const inCell = event.target.closest("th, td");
    if (event.target.closest("textarea") || inCell || event.target.closest("a")) {
      setSelecting(false);
      if (inCell) deactivateInPlace();
      return;
    }
    pointerDown = true;
    downTarget = event.target;
    deactivateInPlace();
    setSelecting(true);
  }

  // Edge 会在普通文字上弹出选中菜单并抢走键盘，可编辑区域不弹，所以拖选期间把正文临时设为可编辑
  function setSelecting(on) {
    const live = document.getElementById("note-live");
    if (on) {
      live.setAttribute("contenteditable", "true");
      live.spellcheck = false;
    } else if (live.hasAttribute("contenteditable")) {
      live.removeAttribute("contenteditable");
    }
  }

  function selectionInsert(event) {
    if (!document.getElementById("note-live").hasAttribute("contenteditable")) return;
    if (event.target.closest && event.target.closest("textarea")) return;
    event.preventDefault();
    const range = liveSelection();
    const type = event.inputType || "";
    let text = "";
    if (type === "insertText" || type === "insertReplacementText") text = event.data || "";
    else if (type === "insertParagraph" || type === "insertLineBreak") text = "\n";
    else if (type === "insertFromPaste" || type === "insertFromDrop") {
      text = event.dataTransfer ? event.dataTransfer.getData("text/plain") : "";
    }
    if (range) {
      setSelecting(false);
      replaceRange(range.start, range.end, text);
      return;
    }
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    const info = pointInfo(selection.anchorNode, selection.anchorOffset);
    if (!info) return;
    setSelecting(false);
    const span = pointSpan(info);
    if (text) replaceRange(span[0], span[0], text);
    else enterAt(span[0]);
  }

  function onLiveCopy(event) {
    const range = liveSelection();
    if (!range || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", compose().slice(range.start, range.end));
    if (event.type === "cut") {
      setSelecting(false);
      replaceRange(range.start, range.end, "");
    }
  }

  function onLivePaste(event) {
    const range = liveSelection();
    if (!range || !event.clipboardData) return;
    event.preventDefault();
    setSelecting(false);
    replaceRange(range.start, range.end, event.clipboardData.getData("text/plain"));
  }

  function onLiveMouseup(event) {
    if (!pointerDown) return;
    pointerDown = false;
    const target = downTarget;
    downTarget = null;
    const selection = window.getSelection();
    if (selection && selection.rangeCount && !selection.isCollapsed) return;
    setSelecting(false);
    if (!target || target.closest("th, td") || target.closest("a")) return;
    const live = document.getElementById("note-live");
    const view = target.closest("#note-live > .live-block");
    if (!view) {
      if (target === live) appendLine();
      return;
    }
    const index = Number(view.dataset.index);
    let pos = blocks[index] ? blocks[index].text.length : 0;
    const caret = document.caretRangeFromPoint ? document.caretRangeFromPoint(event.clientX, event.clientY) : null;
    if (caret) {
      const info = pointInfo(caret.startContainer, caret.startOffset);
      if (info && info.index === index && info.pos != null) pos = info.pos;
    }
    enterAt(blockOffset(index) + pos);
  }

  function appendLine() {
    blocks = parseBlocks(compose());
    const last = blocks[blocks.length - 1];
    if (!last || last.type !== "text" || last.text) blocks.push({ type: "text", text: "" });
    syncSource();
    active = blocks.length - 1;
    remember(active);
    paint({ caret: 0 });
  }

  function deactivateInPlace() {
    if (active < 0) return;
    const index = active;
    active = -1;
    const area = document.querySelector('#note-live textarea[data-index="' + index + '"]');
    if (area && blocks[index]) area.replaceWith(renderBlock(blocks[index], index));
  }

  function blockOffset(index) {
    let offset = 0;
    for (let i = 0; i < index; i += 1) offset += blocks[i].text.length + 1;
    return offset;
  }

  function enterAt(abs) {
    const source = compose();
    blocks = parseBlocks(source);
    syncSource();
    const clamped = Math.max(0, Math.min(abs, source.length));
    const before = source.slice(0, clamped);
    const line = (before.match(/\n/g) || []).length;
    const col = clamped - (before.lastIndexOf("\n") + 1);
    showLocated(locate(line, col), "start");
  }

  function renderedToSource(block, offset) {
    if (block.type === "code") {
      const first = block.text.indexOf("\n") + 1;
      return Math.min(first + offset, block.text.length);
    }
    // 行首空白已经画在预览里，不能再算进被藏起来的标记长度，否则一点击光标就会多跳一截。
    const marker = /^\s*(?:#{1,4}\s+|[-*]\s+|\d+\.\s+|\d+、|>\s?)/.exec(block.text);
    const prefix = marker ? marker[0].length : 0;
    return Math.min(prefix + offset, block.text.length);
  }

  function pointInfo(node, offset) {
    const live = document.getElementById("note-live");
    if (node === live) {
      const child = live.childNodes[offset];
      if (child && child.dataset) return { index: Number(child.dataset.index), pos: 0 };
      const last = blocks.length - 1;
      return { index: last, pos: blocks[last] ? blocks[last].text.length : 0 };
    }
    const element = node.nodeType === 1 ? node : node.parentNode;
    const view = element && element.closest ? element.closest("#note-live > .live-block, #note-live > textarea") : null;
    if (!view || !live.contains(view)) return null;
    const index = Number(view.dataset.index);
    const block = blocks[index];
    if (!block) return null;
    if (view.tagName === "TEXTAREA" || block.type === "table") return { index, whole: true };
    const range = document.createRange();
    range.selectNodeContents(view);
    range.setEnd(node, offset);
    return { index, pos: renderedToSource(block, range.toString().length) };
  }

  function pointSpan(info) {
    const start = blockOffset(info.index);
    if (info.whole) return [start, start + blocks[info.index].text.length];
    return [start + info.pos, start + info.pos];
  }

  function liveSelection() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) return null;
    const focused = document.activeElement;
    if (focused && focused.tagName === "TEXTAREA" && focused.closest("#note-live")) return null;
    const live = document.getElementById("note-live");
    if (!live.contains(selection.anchorNode) || !live.contains(selection.focusNode)) return null;
    const anchorCell = selection.anchorNode.parentElement && selection.anchorNode.parentElement.closest("th, td");
    const focusCell = selection.focusNode.parentElement && selection.focusNode.parentElement.closest("th, td");
    if (anchorCell && anchorCell === focusCell) return null;
    const first = pointInfo(selection.anchorNode, selection.anchorOffset);
    const second = pointInfo(selection.focusNode, selection.focusOffset);
    if (!first || !second) return null;
    const a = pointSpan(first);
    const b = pointSpan(second);
    return { start: Math.min(a[0], b[0]), end: Math.max(a[1], b[1]) };
  }

  function onSelectionKeydown(event) {
    if (event.isComposing) return;
    const range = liveSelection();
    if (!range) return;
    const cut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x";
    const typed = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key !== "Backspace" && event.key !== "Delete" && event.key !== "Enter" && !cut && !typed) return;
    event.preventDefault();
    if (cut && navigator.clipboard) {
      navigator.clipboard.writeText(compose().slice(range.start, range.end)).catch(() => {});
    }
    const text = typed ? event.key : event.key === "Enter" ? "\n" : "";
    replaceRange(range.start, range.end, text);
  }

  function replaceRange(start, end, text) {
    saveUndoPoint();
    const source = compose();
    window.getSelection().removeAllRanges();
    blocks = parseBlocks(source.slice(0, start) + text + source.slice(end));
    syncSource();
    markDirty();
    enterAt(start + text.length);
  }

  function selectTable(index) {
    clearTableSelection();
    const view = document.querySelector('#note-live .live-block[data-index="' + index + '"]');
    if (!view) return;
    selectedTable = index;
    view.classList.add("is-selected");
    Nav.toast("再按一次退格删除表格");
  }

  function clearTableSelection() {
    if (selectedTable < 0) return;
    const view = document.querySelector('#note-live .live-block[data-index="' + selectedTable + '"]');
    if (view) view.classList.remove("is-selected");
    selectedTable = -1;
  }

  function deleteTable(index) {
    selectedTable = -1;
    const source = compose();
    let start = blockOffset(index);
    let end = start + blocks[index].text.length;
    if (source[end] === "\n") end += 1;
    else if (start > 0) start -= 1;
    replaceRange(start, end, "");
  }

  function caretAtCellStart(cell) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return range.toString().length === 0;
  }

  function renderSource(block, index) {
    const area = document.createElement("textarea");
    area.className = block.type === "code" ? "live-code" : "";
    area.dataset.index = String(index);
    area.rows = 1;
    area.value = block.text;
    area.spellcheck = false;
    if (blocks.length === 1 && !block.text) area.placeholder = "开始写…";
    watchUndo(area);
    area.addEventListener("input", () => {
      blocks[index].text = area.value;
      syncSource();
      markDirty();
      autosize(area);
      maybeShowLangDropdown(area, index);
    });
    area.addEventListener("scroll", hideLangDropdown);
    area.addEventListener("blur", hideLangDropdown);
    area.addEventListener("keydown", onAreaKeydown);
    area.addEventListener("paste", onAreaPaste);
    requestAnimationFrame(() => autosize(area));
    return area;
  }

  function autosize(area) {
    area.style.height = "auto";
    area.style.height = area.scrollHeight + "px";
  }

  function lineBounds(area) {
    const pos = area.selectionStart;
    const value = area.value;
    const start = value.lastIndexOf("\n", pos - 1) + 1;
    const next = value.indexOf("\n", pos);
    return { first: start === 0, last: next === -1 };
  }

  function onAreaKeydown(event) {
    if (event.isComposing) return;
    if (event.key === "Escape" && langDropdownOpen) {
      hideLangDropdown();
      event.preventDefault();
      return;
    }
    const area = event.currentTarget;
    const index = Number(area.dataset.index);
    if (selectedTable >= 0) {
      if ((event.key === "Backspace" || event.key === "Delete") && selectedTable === index - 1) {
        event.preventDefault();
        deleteTable(index - 1);
        return;
      }
      clearTableSelection();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (langDropdownOpen) hideLangDropdown();
      // 普通文本块里以 ``` 起头的那一行回车：自动补出结尾的 ``` 围栏，光标落在中间空行
      if (blocks[index].type !== "code") {
        const fence = fenceOnLine(area);
        if (fence) {
          event.preventDefault();
          insertFence(area, index, fence);
          return;
        }
      }
      event.preventDefault();
      splitLine(area);
      return;
    }
    const bounds = lineBounds(area);
    if (event.key === "Backspace" && area.selectionStart === 0 && area.selectionEnd === 0 && bounds.first) {
      event.preventDefault();
      mergeBackward(area);
      return;
    }
    if (event.key === "ArrowUp" && bounds.first && index > 0) {
      event.preventDefault();
      focusAtLine(blockLineStart(index) - 1, "end");
      return;
    }
    if (event.key === "ArrowDown" && bounds.last) {
      const next = blockLineStart(index) + area.value.split("\n").length;
      if (next < lineCount()) {
        event.preventDefault();
        focusAtLine(next, "start");
      }
    }
  }

  function fenceOnLine(area) {
    const pos = area.selectionStart;
    const value = area.value;
    const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
    let lineEnd = value.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = value.length;
    const line = value.slice(lineStart, lineEnd);
    const m = /^\s*(`{3,})([^\n\x60]*)\s*$/.exec(line);
    return m ? m[1] : null;
  }

  function insertFence(area, index, fence) {
    saveUndoPoint();
    const caret = area.selectionStart;
    const value = area.value;
    const left = value.slice(0, caret);
    const right = value.slice(caret);
    const inserted = "\n\n" + fence + "\n";
    blocks[index].text = left + inserted + right;
    const caretLine = blockLineStart(index) + (left.match(/\n/g) || []).length + 1;
    const located = reparseLocate(caretLine, 0);
    showLocated(located, "start");
    markDirty();
  }

  const LANGUAGES = [
    { label: "纯文本", value: "" },
    { label: "C", value: "c" },
    { label: "C++", value: "cpp" },
    { label: "C#", value: "csharp" },
    { label: "Python", value: "python" },
    { label: "JavaScript", value: "javascript" },
    { label: "TypeScript", value: "typescript" },
    { label: "Java", value: "java" },
    { label: "Go", value: "go" },
    { label: "Rust", value: "rust" },
    { label: "SQL", value: "sql" },
    { label: "Bash / Shell", value: "bash" },
    { label: "JSON", value: "json" },
    { label: "YAML", value: "yaml" },
    { label: "XML / HTML", value: "xml" },
    { label: "CSS", value: "css" },
    { label: "Markdown", value: "markdown" },
    { label: "Kotlin", value: "kotlin" },
    { label: "Swift", value: "swift" },
    { label: "PHP", value: "php" },
    { label: "Ruby", value: "ruby" },
    { label: "Dart", value: "dart" },
    { label: "Lua", value: "lua" },
    { label: "Scala", value: "scala" }
  ];

  let langDropdown = null;
  let langCtx = null;
  let langDropdownOpen = false;

  // 点下拉外部时关闭（捕获阶段，避免和列表项点击冲突）
  document.addEventListener("mousedown", (event) => {
    if (langDropdownOpen && langDropdown && !langDropdown.contains(event.target)) hideLangDropdown();
  }, true);

  function ensureLangDropdown() {
    if (langDropdown) return langDropdown;
    langDropdown = document.createElement("div");
    langDropdown.id = "lang-dropdown";
    langDropdown.className = "lang-dropdown";
    langDropdown.hidden = true;
    const ul = document.createElement("ul");
    LANGUAGES.forEach((lang) => {
      const li = document.createElement("li");
      li.dataset.value = lang.value;
      const name = document.createElement("span");
      name.className = "lang-name";
      name.textContent = lang.label;
      li.append(name);
      if (lang.value) {
        const sub = document.createElement("span");
        sub.className = "lang-sub";
        sub.textContent = lang.value;
        li.append(sub);
      }
      ul.append(li);
    });
    langDropdown.append(ul);
    // 在浮层内按下不抢走 textarea 焦点，保证点击能落到 li 上
    langDropdown.addEventListener("mousedown", (event) => event.preventDefault());
    langDropdown.addEventListener("click", (event) => {
      const li = event.target.closest("li");
      if (!li || !langCtx) return;
      applyLang(li.dataset.value);
    });
    document.body.append(langDropdown);
    return langDropdown;
  }

  function hideLangDropdown() {
    if (langDropdown) langDropdown.hidden = true;
    langDropdownOpen = false;
    langCtx = null;
  }

  // 估算 textarea 中光标坐标（镜像 div）：用于把语言下拉定位到 ``` 行下方
  function getCaretCoordinates(el, position) {
    const div = document.createElement("div");
    const style = div.style;
    const computed = getComputedStyle(el);
    const props = ["boxSizing", "width", "height", "overflowX", "overflowY",
      "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "lineHeight",
      "fontFamily", "textAlign", "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize"];
    props.forEach((p) => { style[p] = computed[p]; });
    style.position = "absolute";
    style.visibility = "hidden";
    style.whiteSpace = "pre-wrap";
    style.wordWrap = "break-word";
    style.top = "0";
    style.left = "0";
    div.textContent = el.value.substring(0, position);
    const span = document.createElement("span");
    span.textContent = el.value.substring(position) || ".";
    div.appendChild(span);
    document.body.appendChild(div);
    const coordinates = {
      top: span.offsetTop,
      left: span.offsetLeft,
      height: parseInt(computed.lineHeight, 10) || (parseInt(computed.fontSize, 10) * 1.4)
    };
    document.body.removeChild(div);
    return coordinates;
  }

  // 当前行是「``` 起头且还没填语言」的围栏起始行时，弹出语言下拉
  function maybeShowLangDropdown(area, index) {
    if (blocks[index].type === "code") { hideLangDropdown(); return; }
    const pos = area.selectionStart;
    const value = area.value;
    const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
    let lineEnd = value.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = value.length;
    const line = value.slice(lineStart, lineEnd);
    const m = /^(\s*)(`{3,})\s*([^\n\x60]*)$/.exec(line);
    if (!m || m[3] !== "") { hideLangDropdown(); return; }
    showLangDropdown(area, index, m[1], m[2]);
  }

  function showLangDropdown(area, index, indent, fence) {
    const drop = ensureLangDropdown();
    langCtx = { area, index, indent, fence };
    const c = getCaretCoordinates(area, area.selectionStart);
    const rect = area.getBoundingClientRect();
    drop.style.position = "fixed";
    drop.style.left = (rect.left + c.left - area.scrollLeft) + "px";
    drop.style.top = (rect.top + c.top - area.scrollTop + c.height + 2) + "px";
    drop.hidden = false;
    langDropdownOpen = true;
  }

  // 选中语言：写回 ``` 后的语言名，并补出闭合围栏，光标落在中间空行
  function applyLang(lang) {
    if (!langCtx) return;
    const { area, index, indent, fence } = langCtx;
    const pos = area.selectionStart;
    const value = area.value;
    const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
    let lineEnd = value.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = value.length;
    const newLine = indent + fence + (lang ? " " + lang : "");
    const newValue = value.slice(0, lineStart) + newLine + value.slice(lineEnd);
    area.value = newValue;
    const newCaret = lineStart + newLine.length;
    area.setSelectionRange(newCaret, newCaret);
    hideLangDropdown();
    insertFence(area, index, fence);
  }

  function splitLine(area) {
    saveUndoPoint();
    const index = Number(area.dataset.index);
    const caret = area.selectionStart;
    const left = area.value.slice(0, caret);
    const right = area.value.slice(caret);
    const caretLine = blockLineStart(index) + (left.match(/\n/g) || []).length + 1;
    blocks[index].text = left + "\n" + right;
    const located = reparseLocate(caretLine, 0);
    showLocated(located, "start");
    markDirty();
  }

  function mergeBackward(area) {
    const index = Number(area.dataset.index);
    if (index <= 0) return;
    const current = area.value;
    const prev = blocks[index - 1];
    if (prev.type === "table") {
      selectTable(index - 1);
      return;
    }
    saveUndoPoint();
    if (prev.type !== "text") {
      if (!current) {
        blocks.splice(index, 1);
        syncSource();
      }
      active = index - 1;
      remember(active);
      paint({ caret: blocks[index - 1].text.length });
      markDirty();
      return;
    }
    const line = blockLineStart(index - 1);
    const offset = prev.text.length;
    prev.text += current;
    blocks.splice(index, 1);
    const located = reparseLocate(line, offset);
    showLocated(located, "start");
    markDirty();
  }

  function showLocated(located, edge) {
    if (located.type === "table") {
      const parsed = parseTable(blocks[located.index].text);
      let row = 0;
      if (located.inner >= 2) row = Math.min(located.inner - 1, parsed.rows.length);
      else row = edge === "end" ? parsed.rows.length : 0;
      const col = edge === "end" ? Math.max(parsed.header.length - 1, 0) : 0;
      active = -1;
      remember(located.index);
      paint({ table: { block: located.index, row, col } });
      return;
    }
    active = located.index;
    remember(active);
    paint({ caret: located.pos });
  }

  function focusAtLine(line, edge) {
    if (line < 0 || line >= lineCount()) return;
    showLocated(reparseLocate(line, edge === "end" ? 100000 : 0), edge);
  }

  function onAreaPaste(event) {
    const text = event.clipboardData && event.clipboardData.getData("text/plain");
    if (!text || text.indexOf("\n") < 0) return;
    event.preventDefault();
    const area = event.currentTarget;
    const index = Number(area.dataset.index);
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const merged = area.value.slice(0, start) + text + area.value.slice(end);
    const caretLine = blockLineStart(index) + (area.value.slice(0, start).match(/\n/g) || []).length + (text.match(/\n/g) || []).length;
    const tail = text.split("\n").pop().length;
    blocks[index].text = merged;
    const located = reparseLocate(caretLine, tail);
    showLocated(located, "start");
    markDirty();
  }

  function parseTable(text) {
    const lines = String(text || "").split("\n").filter((line) => line.trim());
    const split = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (!lines.length) return { header: ["列1"], rows: [[""]] };
    const header = split(lines[0]);
    const rows = lines.slice(1).filter((line) => !isTableSeparator(line)).map((line) => {
      const cells = split(line);
      while (cells.length < header.length) cells.push("");
      return cells.slice(0, header.length);
    });
    return { header, rows };
  }

  function serializeTable(header, rows) {
    const cols = Math.max(header.length, 1);
    const line = (cells) => {
      const copy = [];
      for (let i = 0; i < cols; i += 1) copy.push(String(cells[i] || "").replace(/\|/g, "").trim());
      return "| " + copy.join(" | ") + " |";
    };
    const body = [line(header), "| " + Array(cols).fill("---").join(" | ") + " |"];
    rows.forEach((row) => body.push(line(row)));
    return body.join("\n");
  }

  function renderTable(block, index) {
    const wrap = document.createElement("div");
    wrap.className = "live-block";
    wrap.dataset.index = String(index);
    wrap.dataset.line = String(blockLineStart(index));
    const parsed = parseTable(block.text);
    const table = document.createElement("table");
    table.className = "md-table live-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    parsed.header.forEach((text, col) => headRow.append(makeCell("th", text, index, 0, col)));
    thead.append(headRow);
    const tbody = document.createElement("tbody");
    parsed.rows.forEach((row, rowIndex) => {
      const tr = document.createElement("tr");
      for (let col = 0; col < parsed.header.length; col += 1) {
        tr.append(makeCell("td", row[col] || "", index, rowIndex + 1, col));
      }
      tbody.append(tr);
    });
    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  function makeCell(tag, text, blockIndex, row, col) {
    const cell = document.createElement(tag);
    cell.contentEditable = "plaintext-only";
    cell.textContent = text;
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    watchUndo(cell);
    cell.addEventListener("input", () => {
      const table = cell.closest("table");
      blocks[blockIndex].text = readTable(table);
      syncSource();
      markDirty();
    });
    cell.addEventListener("focus", () => {
      if (active < 0) return;
      const line = Number(cell.closest(".live-block").dataset.line);
      blocks = parseBlocks(compose());
      syncSource();
      const located = locate(line, 0);
      active = -1;
      remember(located.index);
      paint({ table: { block: located.index, row, col } });
    });
    cell.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (selectedTable >= 0) {
        if (selectedTable === blockIndex && (event.key === "Backspace" || event.key === "Delete")) {
          event.preventDefault();
          deleteTable(blockIndex);
          return;
        }
        clearTableSelection();
      }
      if (event.key === "Backspace" && caretAtCellStart(cell)) {
        event.preventDefault();
        if (row === 0 && col === 0) {
          selectTable(blockIndex);
        } else {
          const cols = Math.max(parseTable(blocks[blockIndex].text).header.length, 1);
          const prevRow = col > 0 ? row : row - 1;
          const prevCol = col > 0 ? col - 1 : cols - 1;
          const target = cellAt(blockIndex, prevRow, prevCol);
          if (target) placeCaret(target, false);
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        moveTable(blockIndex, row, col, 1, 0);
      } else if (event.key === "Tab") {
        event.preventDefault();
        moveTable(blockIndex, row, col, 0, event.shiftKey ? -1 : 1);
      } else if (event.key === "ArrowUp" && row === 0) {
        event.preventDefault();
        if (blockIndex > 0) focusAtLine(blockLineStart(blockIndex) - 1, "end");
      } else if (event.key === "ArrowDown") {
        const parsed = parseTable(blocks[blockIndex].text);
        if (row >= parsed.rows.length && blockIndex < blocks.length - 1) {
          event.preventDefault();
          focusAtLine(blockLineStart(blockIndex) + blocks[blockIndex].text.split("\n").length, "start");
        } else if (row < parsed.rows.length) {
          event.preventDefault();
          moveTable(blockIndex, row, col, 1, 0);
        }
      }
    });
    return cell;
  }

  function readTable(table) {
    const header = Array.from(table.tHead.rows[0].cells).map((cell) => cell.textContent);
    const rows = Array.from(table.tBodies[0].rows).map((tr) => Array.from(tr.cells).map((cell) => cell.textContent));
    return serializeTable(header, rows);
  }

  function moveTable(blockIndex, row, col, dRow, dCol) {
    const parsed = parseTable(blocks[blockIndex].text);
    const cols = Math.max(parsed.header.length, 1);
    let nextRow = row + dRow;
    let nextCol = col + dCol;
    if (dCol > 0 && nextCol >= cols) {
      nextCol = 0;
      nextRow += 1;
    }
    if (dCol < 0 && nextCol < 0) {
      nextCol = cols - 1;
      nextRow -= 1;
    }
    const total = 1 + parsed.rows.length;
    if (nextRow >= total) {
      saveUndoPoint();
      parsed.rows.push(Array(cols).fill(""));
      blocks[blockIndex].text = serializeTable(parsed.header, parsed.rows);
      syncSource();
      markDirty();
      active = -1;
      remember(blockIndex);
      paint({ table: { block: blockIndex, row: nextRow, col: nextCol } });
      return;
    }
    if (nextRow < 0) {
      if (blockIndex > 0) focusAtLine(blockLineStart(blockIndex) - 1, "end");
      return;
    }
    const cell = cellAt(blockIndex, nextRow, nextCol);
    if (cell) placeCaret(cell, false);
  }

  function cellAt(blockIndex, row, col) {
    const table = document.querySelector('#note-live .live-block[data-index="' + blockIndex + '"] table');
    if (!table) return null;
    const gridRow = row === 0 ? table.tHead.rows[0] : table.tBodies[0].rows[row - 1];
    if (!gridRow) return null;
    return gridRow.cells[col] || null;
  }

  function placeCaret(cell, selectAll) {
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    if (!selectAll) range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function selectContents(cell) {
    placeCaret(cell, true);
  }

  function mountTablePicker() {
    const grid = document.getElementById("table-grid");
    const columns = 8;
    const rows = 6;
    for (let row = 1; row <= rows; row += 1) {
      for (let column = 1; column <= columns; column += 1) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "table-cell";
        cell.dataset.column = String(column);
        cell.dataset.row = String(row);
        cell.addEventListener("mouseenter", () => highlightTable(column, row));
        cell.addEventListener("focus", () => highlightTable(column, row));
        cell.addEventListener("click", () => {
          insertTable(column, row);
          closeTablePicker();
        });
        grid.append(cell);
      }
    }
    document.getElementById("note-table").addEventListener("click", () => {
      const picker = document.getElementById("table-picker");
      if (picker.hidden) {
        picker.hidden = false;
        document.getElementById("note-table").setAttribute("aria-expanded", "true");
        highlightTable(3, 3);
      } else {
        closeTablePicker();
      }
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".table-insert")) closeTablePicker();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeTablePicker();
    });
  }

  function highlightTable(columns, rows) {
    document.querySelectorAll(".table-cell").forEach((cell) => {
      const on = Number(cell.dataset.column) <= columns && Number(cell.dataset.row) <= rows;
      cell.classList.toggle("on", on);
    });
    document.getElementById("table-size").textContent = columns + " 列 × " + rows + " 行";
  }

  function closeTablePicker() {
    const picker = document.getElementById("table-picker");
    if (!picker || picker.hidden) return;
    picker.hidden = true;
    document.getElementById("note-table").setAttribute("aria-expanded", "false");
  }

  function insertTable(columns, rows) {
    saveUndoPoint();
    const headers = [];
    for (let column = 1; column <= columns; column += 1) headers.push("列" + column);
    const body = [];
    for (let row = 1; row < rows; row += 1) body.push(Array(columns).fill(""));
    const text = serializeTable(headers, body);
    if (!blocks.length) blocks.push({ type: "text", text: "" });
    let index = active >= 0 ? active : insertAnchor;
    if (index < 0 || index >= blocks.length) index = blocks.length - 1;
    let tableIndex = index;
    if (blocks[index] && blocks[index].type === "text" && !blocks[index].text) {
      blocks.splice(index, 1, { type: "table", text });
    } else {
      tableIndex = index + 1;
      blocks.splice(tableIndex, 0, { type: "table", text });
    }
    if (!blocks[tableIndex + 1]) blocks.splice(tableIndex + 1, 0, { type: "text", text: "" });
    active = -1;
    remember(tableIndex);
    syncSource();
    paint({ table: { block: tableIndex, row: 0, col: 0 }, select: true });
    markDirty();
  }

  // 写盘失败不能就这么算了：以前失败后没人再排定时器，界面会永远停在「正在保存…」，
  // 而改动其实还在编辑器里、从此不再尝试。这里按几档退避重试，都失败才放弃并明说。
  const SAVE_RETRY_MS = [800, 3000, 8000, 20000];
  let saveFailures = 0;

  function setSaveState(text) {
    const node = document.getElementById("save-state");
    if (node) node.textContent = text;
  }

  // 定时触发的那次不该往外抛（冒出去只会弹一条 toast，问题依旧），失败由 scheduleRetry 记账
  async function flushQuietly() {
    try {
      await flush();
    } catch (err) {
      /* 重试已经排好了 */
    }
  }

  function scheduleRetry() {
    saveFailures += 1;
    if (saveFailures > SAVE_RETRY_MS.length) {
      setSaveState("保存失败");
      Nav.toast("笔记没能写进数据文件夹，改动还在编辑器里，检查下文件夹权限后重试");
      return;
    }
    const wait = SAVE_RETRY_MS[saveFailures - 1];
    setSaveState("保存失败，" + Math.round(wait / 1000) + " 秒后重试");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushQuietly, wait);
  }

  function markDirty() {
    dirty = true;
    saveFailures = 0;   // 又有新改动，退避从头算
    setSaveState("正在保存…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushQuietly, 500);
  }

  // 只保存当前笔记，不重建列表。切换笔记时走这里，避免列表滚动位置归零、以及
  // 因 updatedAt 重排序把上一条顶到最上面造成的视觉跳动。
  async function saveCurrent() {
    clearTimeout(saveTimer);
    if (!dirty || !currentId) return false;
    syncSource();
    const existing = notes.find((item) => item.id === currentId);
    if (!existing) return false;
    dirty = false;
    const title = document.getElementById("note-title").value.trim() || "未命名";
    const body = document.getElementById("note-body").value;
    const project = document.getElementById("note-project").value;
    const pinned = document.getElementById("note-pin").checked;
    let next;
    try {
      next = await Workbench.writeNote({
        id: existing.id,
        title,
        kind: existing.kind || "note",
        project,
        pinned,
        updatedAt: existing.updatedAt
      }, body);
    } catch (err) {
      dirty = true;
      throw err;
    }
    Object.assign(existing, next);
    bodyCache.set(currentId, String(body || "").toLowerCase());
    document.getElementById("save-state").textContent = "已保存";
    notes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return true;
  }

  async function flush() {
    try {
      const saved = await saveCurrent();
      if (saved) renderList();
      saveFailures = 0;
      return saved;
    } catch (err) {
      scheduleRetry();
      throw err;   // 直接 await flush() 的地方（比如新建笔记）仍要知道这一趟没存上
    }
  }

  async function createNote() {
    await flush();
    const note = await Workbench.writeNote({
      id: Workbench.uid(),
      title: "未命名",
      kind: "note",
      project: Workbench.meta.projects[0],
      pinned: false
    }, "");
    notes.unshift(note);
    bodyCache.set(note.id, "");
    await openNote(note.id);
    const listEl = document.getElementById("note-list");
    if (listEl) listEl.scrollTop = 0;
    document.getElementById("note-title").focus();
    document.getElementById("note-title").select();
  }

  // 删除先进回收站：只标记索引，正文 .md 保留，可撤销 / 可恢复
  async function removeCurrent() {
    if (!currentId) return;
    const note = notes.find((item) => item.id === currentId);
    if (!note) return;
    dirty = false;
    clearTimeout(saveTimer);
    const previous = String(note.deletedAt || "");
    note.deletedAt = new Date().toISOString();
    note.updatedAt = note.deletedAt;
    await Workbench.saveNoteIndex(notes);
    bodyCache.delete(currentId);
    closeEditor();
    renderList();
    Nav.toast(`「${note.title || "未命名"}」已移入回收站`, {
      label: "撤销",
      onSelect: async () => {
        note.deletedAt = previous;
        note.updatedAt = new Date().toISOString();
        await Workbench.saveNoteIndex(notes);
        renderList();
        Nav.toast("已恢复");
      }
    });
  }

  function closeEditor() {
    currentId = null;
    blocks = [];
    active = -1;
    document.getElementById("editor-form").hidden = true;
    document.getElementById("editor-empty").hidden = false;
    document.getElementById("note-body").value = "";
    document.getElementById("note-live").innerHTML = "";
  }
})();
