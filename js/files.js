(function () {
  /* 收藏：拖进来的文件 / 文件夹直接落进数据文件夹，索引写在 files.json。
     本体放 files/<相对路径>（重名自动加「 (2)」后缀），截图放 screenshot/。
     没有现成的系统路径可用（浏览器不给数据文件夹的盘符），所以「打开」走的是
     浏览器预览 + 另存到本机，而不是调本机程序。 */

  const MAX_BYTES = 200 * 1024 * 1024;   // 单个文件上限
  const THUMB_LIMIT = 60;                // 最多做这么多张缩略图，免得一次读爆内存

  const state = {
    items: [],
    kind: "all",
    keyword: "",
    thumbs: {},      // id -> objectURL
    viewing: null
  };

  Nav.boot("files", async () => {
    state.items = await Workbench.loadFiles();
    bind();
    render();
    // 收藏清单在别处被改（另一台设备同步过来、或别的标签页）就重新读一遍
    Workbench.onChange(["files.json"], async () => {
      state.items = await Workbench.loadFiles();
      render();
    });
  });

  /* ===== 交互 ===== */

  function bind() {
    document.getElementById("files-pick").addEventListener("click", () => {
      document.getElementById("files-input").click();
    });
    document.getElementById("files-pick-dir").addEventListener("click", () => {
      document.getElementById("files-input-dir").click();
    });

    document.getElementById("files-input").addEventListener("change", (event) => {
      const files = sliceFiles(event.target.files);
      event.target.value = "";
      saveFiles(files.map((file) => ({ file, rel: file.name })));
    });
    document.getElementById("files-input-dir").addEventListener("change", (event) => {
      const files = sliceFiles(event.target.files);
      event.target.value = "";
      saveFiles(files.map((file) => ({ file, rel: file.webkitRelativePath || file.name })));
    });

    document.getElementById("files-search").addEventListener("input", (event) => {
      state.keyword = event.target.value.trim().toLowerCase();
      render();
    });
    document.getElementById("files-kinds").addEventListener("click", (event) => {
      const button = event.target.closest("[data-kind]");
      if (!button) return;
      state.kind = button.dataset.kind;
      Array.prototype.forEach.call(document.querySelectorAll("#files-kinds .seg-btn"), (item) => {
        item.classList.toggle("on", item === button);
      });
      render();
    });

    bindDrop();

    document.getElementById("files-view-close").addEventListener("click", () => {
      document.getElementById("files-view-dialog").close();
    });
    document.getElementById("files-view-download").addEventListener("click", () => {
      if (state.viewing) download(state.viewing);
    });

    window.addEventListener("workbench-files", async () => {
      state.items = await Workbench.loadFiles();
      render();
    });
  }

  // 整页都能接文件，不用非得对准那一小块
  function bindDrop() {
    const zone = document.getElementById("files-drop");
    let depth = 0;
    const stop = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      stop(event);
      depth += 1;
      zone.classList.add("is-over");
    });
    window.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      stop(event);
    });
    window.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return;
      stop(event);
      depth = Math.max(0, depth - 1);
      if (!depth) zone.classList.remove("is-over");
    });
    window.addEventListener("drop", async (event) => {
      if (!hasFiles(event)) return;
      stop(event);
      depth = 0;
      zone.classList.remove("is-over");
      const payload = await collect(event.dataTransfer);
      await saveFiles(payload);
    });
  }

  function hasFiles(event) {
    const types = event.dataTransfer ? event.dataTransfer.types : null;
    return !!types && Array.prototype.indexOf.call(types, "Files") >= 0;
  }

  /* ===== 收集与保存 ===== */

  async function collect(transfer) {
    const out = [];
    const items = transfer && transfer.items ? Array.prototype.slice.call(transfer.items) : [];
    const entries = items
      .map((item) => (item.kind === "file" && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (entries.length) {
      for (const entry of entries) await walkEntry(entry, "", out);
      return out;
    }
    // 没有 webkitGetAsEntry 的浏览器：退回普通文件列表
    sliceFiles(transfer && transfer.files).forEach((file) => out.push({ file, rel: file.name }));
    return out;
  }

  // readEntries 一次最多给 100 条，要反复读到空为止（整个文件夹才不会只进来一半）
  function walkEntry(entry, prefix, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((file) => {
          out.push({ file, rel: prefix + entry.name });
          resolve();
        }, () => resolve());
        return;
      }
      const reader = entry.createReader();
      const parts = [];
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (!batch.length) {
            for (const child of parts) await walkEntry(child, prefix + entry.name + "/", out);
            resolve();
            return;
          }
          parts.push.apply(parts, batch);
          readBatch();
        }, () => resolve());
      };
      readBatch();
    });
  }

  async function saveFiles(payload) {
    const all = payload || [];
    const usable = all.filter((item) => item.file && item.file.size <= MAX_BYTES && !isHidden(item.rel));
    if (!usable.length) {
      Nav.toast(all.length ? `跳过了 ${all.length} 个：隐藏文件或超过 ${MAX_BYTES / 1024 / 1024}MB` : "没有可保存的文件");
      return;
    }

    const list = (await Workbench.loadFiles()).slice();
    const addedIds = [];
    // 已经占用的路径（含软删除的条目：它们的本体还在磁盘上，不能被覆盖）
    const used = new Set(list.map((entry) => entry.path));
    for (const item of usable) {
      const id = Workbench.uid();
      const rel = sanitize(item.rel);
      const path = uniquePath(used, rel);
      try {
        await Workbench.writeFile(path, item.file);
      } catch (err) {
        Nav.toast("写入失败：" + ((err && err.message) || rel));
        continue;
      }
      used.add(path);
      list.push({
        id,
        name: baseName(rel),
        path,
        size: item.file.size,
        type: item.file.type || "",
        kind: "file",
        project: "",
        note: "",
        addedAt: new Date().toISOString(),
        deletedAt: ""
      });
      addedIds.push(id);
    }
    if (!addedIds.length) return;

    await Workbench.saveFiles(list);
    state.items = await Workbench.loadFiles();
    render();

    const skipped = all.length - addedIds.length;
    Nav.toast(`已收藏 ${addedIds.length} 个文件` + (skipped ? `，跳过 ${skipped} 个` : ""), {
      label: "撤销",
      onSelect: async () => {
        const current = await Workbench.loadFiles();
        for (const id of addedIds) {
          const target = current.find((item) => item.id === id);
          if (target) await removeBlob(target);
        }
        const keep = current.filter((item) => addedIds.indexOf(item.id) < 0);
        await Workbench.saveFiles(keep);
        state.items = keep;
        render();
      }
    });
  }

  /* ===== 渲染 ===== */

  function render() {
    const live = Workbench.activeItems(state.items)
      .slice()
      .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
    const box = document.getElementById("files-list");
    box.innerHTML = "";

    const total = live.length;
    const screenshots = live.filter((item) => item.kind === "screenshot").length;
    document.getElementById("files-summary").textContent = total
      ? `共 ${total} 个（其中截图 ${screenshots} 个）`
      : "还没有收藏。拖文件进来，或者在别处按 Alt+A 截图。";

    const keyword = state.keyword;
    const items = live
      .filter((item) => state.kind === "all" || item.kind === state.kind)
      .filter((item) => !keyword || (item.name + " " + item.note).toLowerCase().includes(keyword));

    if (!items.length) {
      box.append(empty(total ? "没有匹配的收藏。" : "拖文件到页面上试试。"));
      return;
    }
    items.forEach((item) => box.append(card(item)));
  }

  function card(item) {
    const el = document.createElement("article");
    el.className = "card files-card";

    const thumb = document.createElement("div");
    thumb.className = "files-thumb";
    if (isImage(item)) {
      const img = document.createElement("img");
      img.alt = item.name;
      thumb.append(img);
      fillThumb(item, img);
    } else {
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("class", "ico");
      const ref = document.createElementNS("http://www.w3.org/2000/svg", "use");
      ref.setAttribute("href", item.kind === "screenshot" ? "#i-upload" : "#i-resources");
      icon.append(ref);
      thumb.append(icon);
    }

    const body = document.createElement("div");
    body.className = "files-card-body";
    const name = document.createElement("strong");
    name.textContent = item.name;
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = [sizeText(item.size), dateText(item.addedAt), item.kind === "screenshot" ? "截图" : ""]
      .filter(Boolean).join(" · ");
    body.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "files-card-actions";
    actions.append(
      action("查看", () => view(item)),
      action("另存…", () => download(item)),
      action("删除", () => remove(item), true)
    );

    el.append(thumb, body, actions);
    return el;
  }

  function action(label, handler, danger) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "linkish" + (danger ? " danger" : "");
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  async function fillThumb(item, img) {
    if (state.thumbs[item.id]) {
      img.src = state.thumbs[item.id];
      return;
    }
    if (Object.keys(state.thumbs).length >= THUMB_LIMIT) return;
    try {
      const blob = await Workbench.readFile(item.path);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      state.thumbs[item.id] = url;
      img.src = url;
    } catch (err) {
      // 读不到就只显示名字，不影响其它卡
    }
  }

  /* ===== 查看 / 另存 / 删除 ===== */

  async function view(item) {
    state.viewing = item;
    const dialog = document.getElementById("files-view-dialog");
    document.getElementById("files-view-title").textContent = item.name;
    document.getElementById("files-view-meta").textContent =
      [sizeText(item.size), item.type || "未知类型", dateText(item.addedAt)].join(" · ");
    const body = document.getElementById("files-view-body");
    body.innerHTML = "";
    body.textContent = "读取中…";
    dialog.showModal();

    try {
      const blob = await Workbench.readFile(item.path);
      if (!blob) {
        body.textContent = "这个文件已经不在了。";
        return;
      }
      body.innerHTML = "";
      if (isImage(item)) {
        const img = document.createElement("img");
        img.alt = item.name;
        img.src = URL.createObjectURL(blob);
        body.append(img);
      } else if (isText(item)) {
        const pre = document.createElement("pre");
        pre.textContent = await blob.text();
        body.append(pre);
      } else {
        body.textContent = "这个类型没法在页面里预览，用下面的「另存到本机…」。";
      }
    } catch (err) {
      body.textContent = "读取失败：" + ((err && err.message) || "未知错误");
    }
  }

  async function download(item) {
    try {
      const blob = await Workbench.readFile(item.path);
      if (!blob) {
        Nav.toast("这个文件已经不在了");
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = item.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      Nav.toast("另存失败：" + ((err && err.message) || "未知错误"));
    }
  }

  async function remove(item) {
    const ok = await Nav.ask({
      title: "删除这条收藏",
      text: `${item.name}\n\n会同时删掉数据文件夹里的文件本体，删了就找不回来了。`,
      okText: "删除",
      cancelText: "取消",
      danger: true
    });
    if (!ok) return;

    const list = (await Workbench.loadFiles()).slice();
    const index = list.findIndex((entry) => entry.id === item.id);
    if (index < 0) return;
    const backup = list[index];
    list.splice(index, 1);
    await Workbench.saveFiles(list);

    let blobError = "";
    try {
      await removeBlob(item);
    } catch (err) {
      blobError = (err && err.message) || "文件本体没删掉";
    }
    if (state.thumbs[item.id]) {
      URL.revokeObjectURL(state.thumbs[item.id]);
      delete state.thumbs[item.id];
    }
    state.items = list;
    render();
    Nav.toast(blobError ? "索引已删，但" + blobError : "已删除", {
      label: "撤销",
      onSelect: async () => {
        const current = await Workbench.loadFiles();
        if (current.some((entry) => entry.id === backup.id)) return;
        current.push(backup);
        await Workbench.saveFiles(current);
        state.items = current;
        render();
        Nav.toast("已恢复索引；文件本体如果已经被删掉，需要重新拖一次");
      }
    });
  }

  function removeBlob(item) {
    return Workbench.removeFile(item.path);
  }

  /* ===== 小工具 ===== */

  function sliceFiles(list) {
    return Array.prototype.slice.call(list || []);
  }

  function isHidden(rel) {
    return String(rel || "").split("/").some((part) => part.charAt(0) === ".");
  }

  // 不再给每个文件建一个 id 目录：直接放在 files/ 下，重名就按系统习惯补后缀
  function uniquePath(used, rel) {
    const base = "files/" + rel;
    if (!used.has(base)) return base;
    const cut = rel.lastIndexOf("/");
    const dir = cut >= 0 ? rel.slice(0, cut + 1) : "";
    const name = cut >= 0 ? rel.slice(cut + 1) : rel;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let n = 2;
    let candidate = base;
    do {
      candidate = "files/" + dir + stem + " (" + n + ")" + ext;
      n += 1;
    } while (used.has(candidate));
    return candidate;
  }

  function sanitize(rel) {
    const parts = String(rel || "")
      .split(/[\\/]/)
      .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim())
      .filter((part) => part && part !== "." && part !== "..");
    return parts.join("/") || "未命名";
  }

  function baseName(rel) {
    const parts = String(rel || "").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(rel || "未命名");
  }

  function isImage(item) {
    if (String(item.type || "").indexOf("image/") === 0) return true;
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(item.name || "");
  }

  function isText(item) {
    if (String(item.type || "").indexOf("text/") === 0) return true;
    return /\.(txt|md|json|js|css|html?|csv|log|ini|yml|yaml|xml)$/i.test(item.name || "");
  }

  function sizeText(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
    if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + " MB";
    return (value / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function dateText(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function empty(text) {
    const el = document.createElement("div");
    el.className = "empty card files-empty";
    el.textContent = text;
    return el;
  }
})();
