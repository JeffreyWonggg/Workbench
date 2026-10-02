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

  /* ===== 上传进度 =====
     用 XHR 而不是 fetch：fetch 没有上传进度事件（浏览器不给请求体的进度回调），
     只有 XHR 的 upload.onprogress 能拿到逐块字节数。 */

  // 单个文件上传，onProgress 收到的是这个文件已发出的字节数
  function putFile(name, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/lan/put?name=" + encodeURIComponent(name));
      xhr.upload.onprogress = (event) => onProgress(event.loaded || 0);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          // 很小的文件可能一个进度事件都不来，补报一次，免得进度条永远差一截
          onProgress(file.size || 0);
          resolve();
          return;
        }
        reject(new Error(xhr.responseText || ("发送失败（" + xhr.status + "）")));
      };
      xhr.onerror = () => reject(new Error("连接中断"));
      xhr.send(file);
    });
  }

  // 速度采样：两个采样点间隔太近就沿用上一次的值（否则每个进度事件都算一次会乱跳），
  // 够一个窗口了再算瞬时速度，并用 0.6/0.4 的权重平滑一下
  const SPEED_WINDOW_MS = 700;

  function speedSampler() {
    let lastAt = 0;
    let lastBytes = 0;
    let smooth = 0;
    return function sample(now, bytes) {
      if (!lastAt) {
        lastAt = now;
        lastBytes = bytes;
        return 0;
      }
      const elapsed = now - lastAt;
      if (elapsed < SPEED_WINDOW_MS) return smooth;
      const instant = (bytes - lastBytes) * 1000 / elapsed;   // 字节/秒
      lastAt = now;
      lastBytes = bytes;
      smooth = smooth > 0 ? smooth * 0.6 + instant * 0.4 : instant;
      return smooth;
    };
  }

  function formatSpeed(bytesPerSecond) {
    return bytesPerSecond > 0 ? formatSize(bytesPerSecond) + "/s" : "";
  }

  // 剩余时间只给个大概，所以进位到秒/分/小时
  function formatDuration(seconds) {
    const sec = Math.max(1, Math.round(seconds));
    if (sec < 60) return sec + " 秒";
    const min = Math.floor(sec / 60);
    if (min < 60) return min + " 分 " + (sec % 60) + " 秒";
    return Math.floor(min / 60) + " 小时 " + (min % 60) + " 分";
  }

  // 进度条 + 一行说明：正在传哪个 / 百分比 / 已传-总量 / 速度 / 预计剩余。
  // 整批一起算（不是每个文件一条），一次拖一堆文件时也能看出总体到哪了。
  function progressReporter(box, total) {
    box.innerHTML = "";
    const bar = document.createElement("div");
    bar.className = "lan-bar";
    const fill = document.createElement("i");
    bar.append(fill);
    const text = document.createElement("div");
    text.className = "lan-progress-text";
    box.append(bar, text);

    const sample = speedSampler();
    let finishedBytes = 0;   // 已传完的文件累计
    let currentBytes = 0;    // 当前文件已传
    let label = "";
    let speed = 0;

    function paint() {
      const sent = Math.min(finishedBytes + currentBytes, total);
      const percent = total > 0 ? Math.min(100, Math.round(sent * 100 / total)) : 100;
      fill.style.width = percent + "%";
      const parts = [];
      if (label) parts.push(label);
      parts.push(percent + "%");
      parts.push(formatSize(sent) + " / " + formatSize(total));
      if (speed > 0) {
        parts.push(formatSpeed(speed));
        const rest = (total - sent) / speed;
        if (rest > 0 && rest < 24 * 3600) parts.push("还剩约 " + formatDuration(rest));
      }
      text.textContent = parts.join(" · ");
    }

    return {
      start(name, index, count) {
        label = "正在发送 " + name + (count > 1 ? `（${index}/${count}）` : "");
        paint();
      },
      bytes(loaded) {
        currentBytes = loaded;
        speed = sample(Date.now(), Math.min(finishedBytes + currentBytes, total));
        paint();
      },
      doneFile() {
        finishedBytes += currentBytes;
        currentBytes = 0;
        paint();
      },
      failFile() {
        // 这一份没传成，它已发的字节不算进总进度；速度读数留着，下次采样自然修正
        currentBytes = 0;
        paint();
      },
      finish(summary) {
        box.innerHTML = "";
        box.textContent = summary;
      }
    };
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

    const totalBytes = visible.reduce((sum, item) => sum + (item.file.size || 0), 0);
    const reporter = progressReporter(progress, totalBytes);
    let done = 0;
    let failed = 0;
    let firstError = "";
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      const name = joinRel(state.path, item.rel);
      reporter.start(name, i + 1, visible.length);
      try {
        await putFile(name, item.file, (loaded) => reporter.bytes(loaded));
        reporter.doneFile();
        done += 1;
      } catch (err) {
        // 单个失败不中止整批：文件夹上传常有零星坏名字，把其余的传完再汇总
        reporter.failFile();
        failed += 1;
        if (!firstError) firstError = err && err.message ? err.message : "未知错误";
      }
    }

    const summary = visible.length > 1 ? `已发送 ${done} 个文件` : "发送完成";
    const notes = [];
    if (failed) notes.push(`${failed} 个失败（${firstError}）`);
    if (skipped) notes.push(`跳过 ${skipped} 个隐藏项`);
    reporter.finish(summary + (notes.length ? " · " + notes.join("，") : ""));
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
