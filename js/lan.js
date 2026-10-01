(function () {
  const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
  // 本机打开时才显示「访问地址 + 二维码」；手机端访问时自动隐藏
  const isLocal = LOOPBACK.indexOf(location.hostname) >= 0;

  // 当前所在的子目录（相对 lan/ 根，用 / 分隔）
  const state = { path: "", dirs: [], files: [] };

  Nav.boot("lan", async () => {
    if (!isLocal) {
      const access = document.getElementById("lan-access");
      if (access) access.hidden = true;
    }
    bind();
    if (isLocal) await loadInfo();
    await loadList();
  }, { optionalFolder: true });

  function bind() {
    document.getElementById("lan-refresh").addEventListener("click", async () => {
      await loadList();
      Nav.toast("已刷新");
    });

    const input = document.getElementById("lan-input");
    document.getElementById("lan-pick").addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      upload(Array.prototype.slice.call(input.files).map((file) => ({ file: file, rel: file.name })));
      input.value = "";
    });

    // 选文件夹：浏览器会给出每个文件的 webkitRelativePath（含文件夹名），原样存下来
    const dirInput = document.getElementById("lan-dir-input");
    document.getElementById("lan-dir").addEventListener("click", () => dirInput.click());
    dirInput.addEventListener("change", () => {
      const list = Array.prototype.slice.call(dirInput.files).map((file) => ({
        file: file,
        rel: file.webkitRelativePath || file.name
      }));
      upload(list);
      dirInput.value = "";
    });

    bindDrop();

    // 面包屑在文件列表之外，单独挂一个监听
    document.getElementById("lan-crumbs").addEventListener("click", (event) => {
      const crumb = event.target.closest("[data-crumb]");
      if (!crumb) return;
      state.path = crumb.dataset.crumb || "";
      loadList();
    });

    document.getElementById("lan-files").addEventListener("click", (event) => {
      const openDir = event.target.closest("[data-dir]");
      if (openDir) {
        state.path = joinRel(state.path, openDir.dataset.dir);
        loadList();
        return;
      }
      const breadcrumb = event.target.closest("[data-crumb]");
      if (breadcrumb) {
        state.path = breadcrumb.dataset.crumb;
        loadList();
        return;
      }
      const remove = event.target.closest("[data-remove]");
      if (remove) removeItem(remove.dataset.remove, remove.dataset.kind);
    });
  }

  function bindDrop() {
    const drop = document.getElementById("lan-drop");
    ["dragenter", "dragover"].forEach((type) => {
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add("over");
      });
    });
    ["dragleave", "dragend"].forEach((type) => {
      drop.addEventListener(type, () => drop.classList.remove("over"));
    });
    drop.addEventListener("drop", async (event) => {
      event.preventDefault();
      drop.classList.remove("over");
      const transfer = event.dataTransfer;
      if (!transfer) return;
      // 拖进来的是文件夹时要用 Entry 接口递归展开，files 里只会有一个目录项
      const items = Array.prototype.slice.call(transfer.items || []);
      if (items.length && items[0].webkitGetAsEntry) {
        const collected = await collectEntries(items);
        await upload(collected);
        return;
      }
      await upload(Array.prototype.slice.call(transfer.files || []).map((file) => ({ file: file, rel: file.name })));
    });
  }

  // 递归展开拖进来的目录（readEntries 一次最多 100 条，要反复读直到空）
  async function collectEntries(items) {
    const found = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
      if (entry) await walkEntry(entry, "", found);
    }
    return found;
  }

  function walkEntry(entry, prefix, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file(
          (file) => { out.push({ file: file, rel: prefix + file.name }); resolve(); },
          () => resolve()
        );
        return;
      }
      if (!entry.isDirectory) return resolve();
      const reader = entry.createReader();
      const next = () => {
        reader.readEntries(async (batch) => {
          if (!batch || !batch.length) return resolve();
          for (let i = 0; i < batch.length; i++) {
            await walkEntry(batch[i], prefix + entry.name + "/", out);
          }
          next();
        }, () => resolve());
      };
      next();
    });
  }

  // 任何一层以 "." 开头的文件/文件夹（.git、.gitignore 等）都算隐藏项：
  // 服务端拒收这类名字（防路径穿越的守卫），传了也只会得到 bad name
  function hasHiddenPart(rel) {
    return String(rel || "").split(/[\\/]/).some((part) => part.charCodeAt(0) === 46);
  }

  async function upload(list) {
    const progress = document.getElementById("lan-progress");
    if (!list.length) return;
    const visible = list.filter((item) => !hasHiddenPart(item.rel));
    const skipped = list.length - visible.length;
    if (!visible.length) {
      progress.textContent = skipped
        ? `没有可发送的文件：${skipped} 项是隐藏文件或位于隐藏文件夹（如 .git），已跳过`
        : "没有可发送的文件";
      return;
    }

    let done = 0;
    let failed = 0;
    let firstError = "";
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      const name = joinRel(state.path, item.rel);
      const step = visible.length > 1 ? `（${i + 1}/${visible.length}）` : "";
      progress.textContent = `正在发送 ${name}${step} · ${formatSize(item.file.size)}`;
      try {
        const response = await fetch("/lan/put?name=" + encodeURIComponent(name), {
          method: "POST",
          body: item.file
        });
        if (!response.ok) throw new Error((await response.text()) || "发送失败");
        done += 1;
      } catch (err) {
        // 单个失败不中止整批：文件夹上传常有零星坏名字，把其余的传完再汇总
        failed += 1;
        if (!firstError) firstError = err && err.message ? err.message : "未知错误";
      }
    }

    const summary = visible.length > 1 ? `已发送 ${done} 个文件` : "发送完成";
    const notes = [];
    if (failed) notes.push(`${failed} 个失败（${firstError}）`);
    if (skipped) notes.push(`跳过 ${skipped} 个隐藏项`);
    progress.textContent = summary + (notes.length ? " · " + notes.join("，") : "");
    if (failed) {
      Nav.toast(`发送失败 ${failed} 个` + (skipped ? `，跳过 ${skipped} 个隐藏项` : ""));
    } else {
      Nav.toast(list.length > 1 || skipped ? `已收到 ${done} 个文件` + (skipped ? `（跳过 ${skipped} 个隐藏项）` : "") : "已收到文件");
    }
    await loadList();
  }

  // 相对路径拼接：把当前目录和文件在文件夹里的相对路径合成一条
  function joinRel(base, rel) {
    const prefix = String(base || "").split(/[\\/]/).filter(Boolean);
    const parts = String(rel || "").split(/[\\/]/).filter(Boolean);
    return prefix.concat(parts).join("/");
  }

  async function loadInfo() {
    const box = document.getElementById("lan-urls");
    const qrBox = document.getElementById("lan-qr");
    let data;
    try {
      data = await (await fetch("/lan/info", { cache: "no-store" })).json();
    } catch (err) {
      box.textContent = "读取局域网地址失败。";
      qrBox.hidden = true;
      return;
    }
    const urls = data.urls || [];
    box.innerHTML = "";
    if (!urls.length) {
      if (data.scope === "local") {
        // 服务只绑到了 127.0.0.1。原因以服务端记下的为准：多数是缺 URL 保留，
        // 也可能是端口被别的程序占了——一律写成"缺 URL 保留"会把人带偏。
        const reason = data.bindError
          ? "（" + data.bindError + "）"
          : "（一般是缺少 47321 端口的监听授权 / URL 保留）";
        box.textContent = "局域网访问未开启：服务目前只能在本机（127.0.0.1）打开" + reason + "。"
          + "双击「启用局域网访问.bat」会自动弹一次 UAC，把 URL 保留和防火墙规则写好并重启服务；"
          + "本机使用不受影响。";
      } else {
        box.textContent = "没有检测到局域网地址，请确认已连上 WiFi 或网线。";
      }
      qrBox.hidden = true;
      return;
    }
    urls.forEach((url) => {
      const row = document.createElement("div");
      row.className = "lan-url";
      const code = document.createElement("code");
      code.textContent = url;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "btn";
      copy.textContent = "复制";
      copy.addEventListener("click", () => copyText(url));
      row.append(code, copy);
      box.append(row);
    });
    renderQr(qrBox, urls[0]);
  }

  function renderQr(box, text) {
    box.innerHTML = "";
    if (typeof qrcode !== "function") return;
    try {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
    } catch (err) {
      box.hidden = true;
    }
  }

  async function loadList() {
    const box = document.getElementById("lan-files");
    const count = document.getElementById("lan-count");
    const crumbs = document.getElementById("lan-crumbs");
    let data;
    try {
      const query = state.path ? "?path=" + encodeURIComponent(state.path) : "";
      data = await (await fetch("/lan/list" + query, { cache: "no-store" })).json();
    } catch (err) {
      box.innerHTML = "";
      box.append(empty("读取失败，请确认主机程序在运行。"));
      count.textContent = "";
      return;
    }
    if (data.error) {
      box.innerHTML = "";
      box.append(empty(data.error));
      state.path = "";
      renderCrumbs(crumbs);
      return;
    }
    state.dirs = data.dirs || [];
    state.files = data.files || [];
    renderCrumbs(crumbs);

    const total = state.dirs.length + state.files.length;
    count.textContent = total
      ? (state.dirs.length ? state.dirs.length + " 个文件夹 · " : "") + state.files.length + " 个文件"
      : "";

    box.innerHTML = "";
    if (!total) {
      box.append(empty(state.path ? "这个文件夹是空的。" : "还没有文件。把文件或文件夹拖到上面，或点「选择文件夹」。"));
      return;
    }
    state.dirs.forEach((dir) => box.append(dirRow(dir)));
    state.files.forEach((file) => box.append(fileRow(file)));
  }

  function renderCrumbs(box) {
    if (!box) return;
    box.innerHTML = "";
    const parts = String(state.path || "").split(/[\\/]/).filter(Boolean);
    const root = crumb("全部文件", "");
    box.append(root);
    let walked = "";
    parts.forEach((part) => {
      walked = walked ? walked + "/" + part : part;
      box.append(document.createTextNode(" / "), crumb(part, walked));
    });
  }

  function crumb(label, path) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "linkish";
    button.textContent = label;
    button.dataset.crumb = path;
    return button;
  }

  function dirRow(dir) {
    const row = document.createElement("div");
    row.className = "lan-file lan-dir";

    const icon = document.createElement("span");
    icon.className = "lan-file-icon";
    icon.textContent = "📁";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "linkish lan-file-name";
    open.textContent = dir.name;
    open.dataset.dir = dir.name;
    open.title = "进入 " + dir.name;

    const meta = document.createElement("span");
    meta.className = "lan-file-meta";
    meta.textContent = "文件夹 · " + dir.mtime;

    const actions = document.createElement("span");
    actions.className = "lan-file-actions";
    const zip = document.createElement("a");
    zip.className = "btn";
    zip.textContent = "打包下载";
    zip.href = "/lan/get?folder=" + encodeURIComponent(joinRel(state.path, dir.name));
    zip.setAttribute("download", dir.name + ".zip");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn danger";
    remove.textContent = "删除";
    remove.dataset.remove = joinRel(state.path, dir.name);
    remove.dataset.kind = "folder";
    actions.append(zip, remove);

    row.append(icon, open, meta, actions);
    return row;
  }

  function fileRow(file) {
    const row = document.createElement("div");
    row.className = "lan-file";
    const name = document.createElement("span");
    name.className = "lan-file-name";
    name.textContent = file.name;
    const meta = document.createElement("span");
    meta.className = "lan-file-meta";
    meta.textContent = formatSize(file.size) + " · " + file.mtime;
    const actions = document.createElement("span");
    actions.className = "lan-file-actions";
    const download = document.createElement("a");
    download.className = "btn";
    download.textContent = "下载";
    download.href = "/lan/get?name=" + encodeURIComponent(file.name) +
      (state.path ? "&path=" + encodeURIComponent(state.path) : "");
    download.setAttribute("download", file.name);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn danger";
    remove.textContent = "删除";
    remove.dataset.remove = joinRel(state.path, file.name);
    remove.dataset.kind = "file";
    actions.append(download, remove);
    row.append(name, meta, actions);
    return row;
  }

  async function removeItem(name, kind) {
    const folder = kind === "folder";
    if (!(await Nav.ask({
      title: folder ? "删除文件夹" : "删除文件",
      text: folder
        ? "「" + name + "」及里面的全部内容都会被删除。"
        : "「" + name + "」会被删除。",
      okText: "删除",
      danger: true
    }))) return;
    try {
      const query = "?name=" + encodeURIComponent(name) + "&type=" + encodeURIComponent(kind || "file");
      const response = await fetch("/lan/delete" + query, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
    } catch (err) {
      Nav.toast("删除失败");
      return;
    }
    Nav.toast("已删除");
    await loadList();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => Nav.toast("已复制"),
        () => Nav.toast("复制失败，请手动选择")
      );
    } else {
      Nav.toast("请手动复制");
    }
  }

  function formatSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
    if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + " MB";
    return (value / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function empty(text) {
    const el = document.createElement("div");
    el.className = "empty";
    el.textContent = text;
    return el;
  }
})();
