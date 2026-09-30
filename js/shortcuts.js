(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const HOST = "http://127.0.0.1:47321";

  let editing = "";   // 正在编辑的 id，空 = 新增

  Nav.boot("shortcuts", async () => {
    bind();
    render();
  });

  // 清单存在 meta.json 的 shortcuts 字段里，由 model.js 归一化
  function list() {
    return (Workbench.meta && Workbench.meta.shortcuts) || [];
  }

  function bind() {
    $("shortcut-add").addEventListener("click", () => openEditor(""));
    $("shortcut-cancel").addEventListener("click", () => $("shortcut-dialog").close());
    $("shortcut-form").addEventListener("submit", save);
    $("shortcut-pick-dir").addEventListener("click", () => pick("dir"));
    $("shortcut-pick-file").addEventListener("click", () => pick("file"));

    $("shortcut-list").addEventListener("click", (event) => {
      const edit = event.target.closest("[data-edit]");
      if (edit) {
        openEditor(edit.dataset.edit);
        return;
      }
      const remove = event.target.closest("[data-remove]");
      if (remove) {
        removeShortcut(remove.dataset.remove);
        return;
      }
      const copy = event.target.closest("[data-copy]");
      if (copy) {
        copyPath(copy.dataset.copy);
        return;
      }
      const open = event.target.closest("[data-open]");
      if (open) openPath(open.dataset.open);
    });
  }

  /* ===== 列表 ===== */

  function render() {
    const box = $("shortcut-list");
    box.innerHTML = "";
    const items = list();
    $("shortcut-count").textContent = items.length ? "共 " + items.length + " 个" : "";
    if (items.length === 0) {
      box.append(emptyState());
      return;
    }
    items.forEach((item) => box.append(tile(item)));
  }

  function emptyState() {
    const wrap = document.createElement("div");
    wrap.className = "card shortcut-empty";
    const line = document.createElement("p");
    line.className = "empty";
    line.textContent = "还没有快捷方式。把常用的工程目录、日志目录、文档或网址放进来，点一下就打开。";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn primary";
    button.textContent = "新增快捷方式";
    button.addEventListener("click", () => openEditor(""));
    wrap.append(line, button);
    return wrap;
  }

  function tile(item) {
    const el = document.createElement("article");
    el.className = "card shortcut-tile";
    el.dataset.open = item.path;
    el.title = item.path;

    const head = document.createElement("div");
    head.className = "shortcut-head";
    const title = document.createElement("h2");
    title.className = "shortcut-name";
    title.textContent = item.label;
    const actions = document.createElement("span");
    actions.className = "shortcut-actions";
    actions.append(
      actionButton("打开", { open: item.path }),
      actionButton("复制", { copy: item.path }),
      actionButton("编辑", { edit: item.id }),
      actionButton("删除", { remove: item.id }, true)
    );
    head.append(title, actions);

    const path = document.createElement("p");
    path.className = "muted shortcut-path mono";
    path.textContent = item.path;

    el.append(head, path);
    if (item.note) {
      const note = document.createElement("p");
      note.className = "muted shortcut-note";
      note.textContent = item.note;
      el.append(note);
    }
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

  /* ===== 打开 / 复制 ===== */

  async function openPath(value) {
    const path = String(value || "").trim();
    if (!path) return;
    if (/^https?:\/\//i.test(path)) {
      window.open(path, "_blank", "noopener");
      return;
    }
    if (typeof Nav.isLocal === "function" && !Nav.isLocal()) {
      Nav.toast("打开本机文件需要在电脑上打开工作台");
      return;
    }
    try {
      const response = await fetch(HOST + "/open", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: path
      });
      if (!response.ok) throw new Error("open failed");
    } catch (err) {
      Nav.toast("没有打开。请先双击「打开工作台」，并确认路径存在");
    }
  }

  async function copyPath(value) {
    try {
      await navigator.clipboard.writeText(String(value || ""));
      Nav.toast("路径已复制");
    } catch (err) {
      Nav.toast("浏览器不允许写剪贴板，请手动选中复制");
    }
  }

  /* ===== 新增 / 编辑 ===== */

  function openEditor(id) {
    editing = id || "";
    const item = id ? list().find((entry) => entry.id === id) : null;
    $("shortcut-dialog-title").textContent = item ? "编辑快捷方式" : "新增快捷方式";
    $("shortcut-label").value = item ? item.label : "";
    $("shortcut-path").value = item ? item.path : "";
    $("shortcut-note").value = item ? item.note : "";
    setError("");
    $("shortcut-dialog").showModal();
    $("shortcut-path").focus();
  }

  async function pick(mode) {
    if (typeof Nav.pickPath !== "function") {
      setError("这个版本没有目录选择器，请直接粘贴路径");
      return;
    }
    const path = await Nav.pickPath({
      mode,
      title: mode === "file" ? "选择文件" : "选择文件夹",
      start: $("shortcut-path").value.trim()
    });
    if (!path) return;
    $("shortcut-path").value = path;
    if (!$("shortcut-label").value.trim()) {
      const parts = String(path).replace(/[\\/]+$/, "").split(/[\\/]/);
      $("shortcut-label").value = parts[parts.length - 1] || path;
    }
    setError("");
  }

  async function save(event) {
    event.preventDefault();
    const path = $("shortcut-path").value.trim();
    if (!path) {
      setError("路径不能为空");
      return;
    }
    if (!/^https?:\/\//i.test(path) && !/^[a-zA-Z]:[\\/]/.test(path) && !/^\\\\/.test(path)) {
      setError("本机路径要写完整，例如 D:\\Tool 或 \\\\服务器\\共享");
      return;
    }

    const items = list().slice();
    const entry = {
      id: editing || Workbench.uid(),
      label: $("shortcut-label").value.trim(),
      path,
      note: $("shortcut-note").value.trim()
    };
    const index = editing ? items.findIndex((item) => item.id === editing) : -1;
    if (index >= 0) items[index] = Object.assign({}, items[index], entry);
    else items.push(entry);
    Workbench.meta.shortcuts = Workbench.normalizeShortcuts(items);

    $("shortcut-save").disabled = true;
    try {
      await Workbench.saveMeta();
    } catch (err) {
      setError(err && err.message ? err.message : "保存失败");
      return;
    } finally {
      $("shortcut-save").disabled = false;
    }
    $("shortcut-dialog").close();
    render();
    Nav.toast(index >= 0 ? "已保存修改" : "已新增「" + (entry.label || entry.path) + "」");
  }

  async function removeShortcut(id) {
    const items = list();
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    const ok = await Nav.ask({
      title: "删除快捷方式",
      text: "「" + item.label + "」会从这个列表里移除（只删这个入口，不会动文件本身）。",
      okText: "删除",
      danger: true
    });
    if (!ok) return;

    Workbench.meta.shortcuts = Workbench.normalizeShortcuts(items.filter((entry) => entry.id !== id));
    try {
      await Workbench.saveMeta();
    } catch (err) {
      Nav.toast(err && err.message ? err.message : "删除失败");
      return;
    }
    render();
    Nav.toast("已删除「" + item.label + "」");
  }

  function setError(message) {
    const el = $("shortcut-error");
    el.textContent = message || "";
    el.hidden = !message;
  }
})();
