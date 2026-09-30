(function () {
  "use strict";

  const TYPES = {
    credential: { label: "账号", value: "username", valueLabel: "账号" },
    path: { label: "路径", value: "path", valueLabel: "路径或网址" },
    host: { label: "主机", value: "host", valueLabel: "IP 或主机名" }
  };

  // 「软件号」已经改由代码页的明文 software.json 管理。这里留一份历史定义，
  // 只用于把加密库里的老记录认出来并迁走，不再允许新建。
  const LEGACY_TYPES = {
    software: { label: "软件号", value: "softwareId", valueLabel: "软件号" }
  };

  function typeInfo(type) {
    return TYPES[type] || LEGACY_TYPES[type] || null;
  }

  function isLegacySoftware(record) {
    return !!(record && record.type === "software");
  }

  const LOCK_IDLE_MS = 15 * 60 * 1000;
  const LEGACY_FILE = "resources.json";
  const REMEMBER_KEY = "wb-vault-remember";

  let vault = null;          // 解密后的明文 { version, records, updatedAt }
  let vaultKey = null;       // CryptoKey
  let vaultSettings = null;  // { iterations, salt }
  let envelope = null;       // 磁盘上的密文信封
  let legacyCount = 0;       // 首次启用时可导入的明文条数
  let filter = "all";
  let projectFilter = "全部";
  let editingId = null;
  let saveQueue = Promise.resolve();
  let idleTimer = null;
  let libraryPath = "";
  let libraryEntries = [];
  let libraryTruncated = false;
  let pendingLibraryPath = "";
  let libraryFocus = "";
  const revealed = new Set();

  Nav.boot("resources", async () => {
    const params = new URLSearchParams(location.search);
    const wantedProject = params.get("project");
    if (wantedProject && Workbench.meta.projects.includes(wantedProject)) projectFilter = wantedProject;
    if (params.get("view") === "file" || params.get("path")) filter = "file";
    pendingLibraryPath = String(params.get("path") || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    bind();
    window.addEventListener("workbench-projects", () => {
      if (projectFilter !== "全部" && !Workbench.meta.projects.includes(projectFilter)) projectFilter = "全部";
      if (!vault) return;
      renderTypes();
      renderTable();
    });
    await openVault();
  });

  function bind() {
    document.getElementById("resource-search").addEventListener("input", renderTable);
    document.getElementById("resource-add").addEventListener("click", () => openEditor());
    document.getElementById("resource-type").addEventListener("change", syncEditorFields);
    document.getElementById("resource-form").addEventListener("submit", saveEditor);
    document.getElementById("resource-cancel").addEventListener("click", closeEditor);
    document.getElementById("resource-delete").addEventListener("click", deleteEditor);
    document.getElementById("library-pick").addEventListener("click", pickLibraryFolder);
    document.getElementById("library-refresh").addEventListener("click", () => loadLibrary(libraryPath));
    document.getElementById("library-open-root").addEventListener("click", () => openLibraryItem(libraryPath));
    document.getElementById("library-crumbs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-library-path]");
      if (button) {
        libraryFocus = "";
        loadLibrary(button.dataset.libraryPath || "");
      }
    });

    const migrateGo = document.getElementById("software-migrate-go");
    if (migrateGo) migrateGo.addEventListener("click", migrateAllSoftware);

    document.getElementById("vault-lock").addEventListener("click", () => lock("已锁定"));
    document.getElementById("vault-security").addEventListener("click", openSecurity);
    document.getElementById("vault-security-close").addEventListener("click", closeSecurity);
    document.getElementById("vault-export").addEventListener("click", exportPlain);
    document.getElementById("vault-password-form").addEventListener("submit", changePassword);
    document.getElementById("vault-unlock-form").addEventListener("submit", onUnlock);
    document.getElementById("vault-setup-form").addEventListener("submit", onSetup);
    document.getElementById("vault-reset").addEventListener("click", onReset);
    document.getElementById("vault-forget-remember").addEventListener("click", onForgetRemembered);

    ["pointerdown", "keydown"].forEach((type) => {
      document.addEventListener(type, () => {
        if (vault) startIdleTimer();
      }, true);
    });
  }

  /* ================= 加密资料库 ================= */

  async function openVault() {
    try {
      envelope = await Workbench.loadVaultEnvelope();
    } catch (err) {
      envelope = null;
      Nav.toast(err && err.message ? err.message : "vault.json 读取失败");
    }
    if (envelope) {
      try {
        VaultCrypto.validateEnvelope(envelope);
      } catch (err) {
        showGate("unlock");
        setError("vault-unlock-error", err.message + "（可在「忘记主密码」里重置）");
        return;
      }
      // 这台电脑记住过主密码就直接进，不再问
      const remembered = readRemembered();
      if (remembered) {
        showGate("auto");
        try {
          const result = await VaultCrypto.unlock(remembered, envelope);
          applyVault(result.key, result.settings, result.data, true);
          return;
        } catch (err) {
          // 密码改过或 vault.json 换过：清掉记忆，退回到手输
          clearRemembered();
        }
      }
      showGate("unlock");
      document.getElementById("vault-unlock-password").focus();
      return;
    }
    // 还没有 vault.json：首次启用，顺便统计可导入的明文资料
    legacyCount = await countLegacy();
    const hint = legacyCount > 0
      ? `当前有 ${legacyCount} 条明文资料（${LEGACY_FILE}）。设置主密码后会被加密写入 vault.json，原明文文件将被删除，且无法用其它方式找回——请务必记住主密码。`
      : "设置一个主密码，资料会用 AES-GCM 加密后写入 vault.json。密码只在本机内存中使用，不会保存到磁盘。";
    document.getElementById("vault-setup-hint").textContent = hint;
    document.getElementById("vault-setup-title").textContent = legacyCount > 0 ? "把现有资料加密" : "启用加密资料库";
    showGate("setup");
    document.getElementById("vault-setup-password").focus();
  }

  function showGate(mode) {
    document.getElementById("vault-gate").hidden = false;
    document.getElementById("vault-app").hidden = true;
    document.getElementById("vault-head-actions").hidden = true;
    document.getElementById("vault-auto-box").hidden = mode !== "auto";
    document.getElementById("vault-unlock-form").hidden = mode !== "unlock";
    document.getElementById("vault-setup-form").hidden = mode !== "setup";
    setError("vault-unlock-error", "");
    setError("vault-setup-error", "");
  }

  function showApp() {
    document.getElementById("vault-gate").hidden = true;
    document.getElementById("vault-auto-box").hidden = true;
    document.getElementById("vault-app").hidden = false;
    document.getElementById("vault-head-actions").hidden = false;
  }

  async function onUnlock(event) {
    event.preventDefault();
    const input = document.getElementById("vault-unlock-password");
    const password = input.value;
    if (!password) return;
    setError("vault-unlock-error", "");
    const button = event.target.querySelector("button[type=submit]");
    button.disabled = true;
    const remember = document.getElementById("vault-remember").checked;
    try {
      const result = await VaultCrypto.unlock(password, envelope);
      input.value = "";
      if (remember) writeRemembered(password);
      else clearRemembered();
      applyVault(result.key, result.settings, result.data, remember);
      Nav.toast(remember ? "已解锁，这台电脑下次自动进入" : "已解锁");
    } catch (err) {
      setError("vault-unlock-error", err && err.message ? err.message : "解锁失败");
      input.select();
    } finally {
      button.disabled = false;
    }
  }

  async function onSetup(event) {
    event.preventDefault();
    const first = document.getElementById("vault-setup-password").value;
    const second = document.getElementById("vault-setup-password2").value;
    setError("vault-setup-error", "");
    if (first.length < 6) {
      setError("vault-setup-error", "主密码至少 6 位");
      return;
    }
    if (first !== second) {
      setError("vault-setup-error", "两次输入不一致");
      return;
    }
    const remember = document.getElementById("vault-remember-setup").checked;
    const button = event.target.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const payload = await buildInitialVault();
      const created = await VaultCrypto.create(first, payload);
      await Workbench.saveVaultEnvelope(created.envelope);
      envelope = created.envelope;
      document.getElementById("vault-setup-password").value = "";
      document.getElementById("vault-setup-password2").value = "";
      if (remember) writeRemembered(first);
      else clearRemembered();
      if (legacyCount > 0) {
        await Workbench.removeFile(LEGACY_FILE);
        legacyCount = 0;
      }
      applyVault(created.key, created.settings, payload, remember);
      Nav.toast(remember ? "资料库已加密，这台电脑下次自动进入" : "资料库已加密");
    } catch (err) {
      setError("vault-setup-error", err && err.message ? err.message : "创建失败");
    } finally {
      button.disabled = false;
    }
  }

  async function buildInitialVault() {
    const data = emptyVault();
    if (legacyCount > 0) {
      try {
        const legacy = await Workbench.readJson(LEGACY_FILE, emptyVault());
        data.records = normalizeVault(legacy).records;
      } catch (err) {
        data.records = [];
      }
    }
    return data;
  }

  async function countLegacy() {
    try {
      const text = await Storage.readText(Workbench.dir, LEGACY_FILE);
      if (!text || !text.trim()) return 0;
      const parsed = JSON.parse(text);
      return normalizeVault(parsed).records.length;
    } catch (err) {
      return 0;
    }
  }

  function applyVault(key, settings, data, remembered) {
    vaultKey = key;
    vaultSettings = settings;
    vault = normalizeVault(data);
    revealed.clear();
    Workbench.writeVaultSession(vault);
    renderTypes();
    if (filter === "file") showFiles();
    else renderTable();
    syncSoftwareMigration();
    showApp();
    // 本机已经记住密码，自动锁定就没意义了（刷新一下又回来）
    if (remembered) stopIdleTimer();
    else startIdleTimer();
  }

  function lock(message) {
    vault = null;
    vaultKey = null;
    vaultSettings = null;
    revealed.clear();
    libraryPath = "";
    libraryEntries = [];
    Workbench.clearVaultSession();
    stopIdleTimer();
    if (envelope) {
      showGate("unlock");
      const input = document.getElementById("vault-unlock-password");
      input.value = "";
      input.focus();
    } else {
      showGate("setup");
    }
    if (message) Nav.toast(message);
  }

  function startIdleTimer() {
    stopIdleTimer();
    idleTimer = setTimeout(() => lock("闲置过久，资料库已自动锁定"), LOCK_IDLE_MS);
  }

  function stopIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  async function onReset() {
    const warning = "重置会删除 vault.json 里已加密的资料，且不可恢复。\n\n确定要继续吗？";
    if (!confirm(warning)) return;
    try {
      await Workbench.removeFile("vault.json");
      await Workbench.removeFile("vault.backup.json");
      envelope = null;
      vault = null;
      vaultKey = null;
      vaultSettings = null;
      clearRemembered();
      Workbench.clearVaultSession();
      legacyCount = await countLegacy();
      showGate("setup");
      Nav.toast("已重置，请设置新的主密码");
      document.getElementById("vault-setup-password").focus();
    } catch (err) {
      Nav.toast(err && err.message ? err.message : "重置失败");
    }
  }

  function openSecurity() {
    document.getElementById("vault-password-form").reset();
    setError("vault-password-error", "");
    syncRememberButton();
    document.getElementById("vault-security-dialog").showModal();
    document.getElementById("vault-old-password").focus();
  }

  function closeSecurity() {
    const dialog = document.getElementById("vault-security-dialog");
    if (dialog.open) dialog.close();
  }

  async function changePassword(event) {
    event.preventDefault();
    const current = document.getElementById("vault-old-password").value;
    const next = document.getElementById("vault-password-next").value;
    const again = document.getElementById("vault-password-next2").value;
    setError("vault-password-error", "");
    if (next.length < 6) {
      setError("vault-password-error", "新主密码至少 6 位");
      return;
    }
    if (next !== again) {
      setError("vault-password-error", "两次输入不一致");
      return;
    }
    try {
      // 用旧密码验证一次，避免记错密码后把资料锁死
      await VaultCrypto.unlock(current, envelope);
    } catch (err) {
      setError("vault-password-error", "当前主密码不正确");
      return;
    }
    try {
      const created = await VaultCrypto.create(next, vault);
      await Workbench.saveVaultEnvelope(created.envelope);
      envelope = created.envelope;
      vaultKey = created.key;
      vaultSettings = created.settings;
      // 之前记住的是旧密码，跟着换掉，否则下次自动解锁会失败
      if (readRemembered()) writeRemembered(next);
      closeSecurity();
      Nav.toast("主密码已修改");
    } catch (err) {
      setError("vault-password-error", err && err.message ? err.message : "修改失败");
    }
  }

  function exportPlain() {
    if (!vault) return;
    if (!confirm("导出的 JSON 是明文，里面包含所有密码。确定导出吗？")) return;
    const blob = new Blob([JSON.stringify(vault, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `resources-plain-${Workbench.todayIso()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    Nav.toast("已导出明文，请妥善保管");
  }

  function setError(id, message) {
    const el = document.getElementById(id);
    el.textContent = message || "";
    el.hidden = !message;
  }

  /* 本机记忆：把主密码存在浏览器 localStorage 里，只影响这台电脑的这个浏览器。
     数据文件夹里的 vault.json 仍然是密文，拷到别的电脑一样要输密码。 */

  function readRemembered() {
    try {
      const raw = localStorage.getItem(REMEMBER_KEY);
      if (!raw) return "";
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed.password === "string" ? parsed.password : "";
    } catch (err) {
      return "";
    }
  }

  function writeRemembered(password) {
    try {
      localStorage.setItem(REMEMBER_KEY, JSON.stringify({
        password: String(password || ""),
        savedAt: new Date().toISOString()
      }));
      return true;
    } catch (err) {
      Nav.toast("浏览器不允许保存，这次不会自动解锁");
      return false;
    }
  }

  function clearRemembered() {
    try { localStorage.removeItem(REMEMBER_KEY); } catch (err) {}
  }

  function syncRememberButton() {
    const button = document.getElementById("vault-forget-remember");
    if (!button) return;
    const saved = readRemembered();
    button.disabled = !saved;
    button.title = saved
      ? "清除后，下次打开资料库需要重新输入主密码"
      : "这台电脑还没有记住主密码";
  }

  function onForgetRemembered() {
    if (!readRemembered()) {
      Nav.toast("这台电脑没有记住主密码");
      return;
    }
    clearRemembered();
    syncRememberButton();
    Nav.toast("已清除，下次打开需要输入主密码");
  }

  /* ================= 数据 ================= */

  function emptyVault() {
    return {
      version: 1,
      records: [],
      library: { root: "", assignments: {} },
      updatedAt: new Date().toISOString()
    };
  }

  function normalizeVault(data) {
    const result = data && typeof data === "object" ? data : emptyVault();
    result.version = 1;
    if (!Array.isArray(result.records)) result.records = [];
    result.records = result.records
      .filter((item) => item && typeInfo(item.type))
      .map((item) => ({
        id: String(item.id || Workbench.uid()),
        type: item.type,
        name: String(item.name || ""),
        username: String(item.username || ""),
        secret: String(item.secret || ""),
        path: String(item.path || ""),
        host: String(item.host || ""),
        softwareId: String(item.softwareId || ""),
        project: String(item.project || ""),
        notes: String(item.notes || ""),
        deletedAt: String(item.deletedAt || ""),
        updatedAt: String(item.updatedAt || "")
      }));
    const library = result.library && typeof result.library === "object" ? result.library : {};
    const rawAssignments = library.assignments && typeof library.assignments === "object"
      ? library.assignments
      : {};
    const assignments = {};
    Object.keys(rawAssignments).forEach((path) => {
      const cleanPath = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (cleanPath) assignments[cleanPath] = String(rawAssignments[path] || "");
    });
    result.library = {
      root: String(library.root || ""),
      assignments
    };
    return result;
  }

  function liveRecords() {
    return vault ? vault.records.filter((record) => !record.deletedAt) : [];
  }

  function trashedRecords() {
    return vault ? vault.records.filter((record) => record.deletedAt) : [];
  }

  /* ================= 文件管理 ================= */

  async function pickLibraryFolder() {
    if (!vault) return;
    try {
      const response = await fetch("http://127.0.0.1:47321/pick-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "dir",
          path: vault.library.root || "",
          title: "选择资料库要管理的文件夹"
        })
      });
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || "选择文件夹失败");
      if (result.cancelled || !result.path) return;
      const changed = result.path !== vault.library.root;
      vault.library.root = result.path;
      libraryPath = "";
      libraryEntries = [];
      if (changed) vault.library.assignments = {};
      await persist();
      await loadLibrary("");
      Nav.toast("文件夹已指定");
    } catch (err) {
      Nav.toast(err && err.message ? err.message : "无法选择文件夹，请确认本地服务已启动");
    }
  }

  async function loadLibrary(path) {
    if (!vault || !vault.library.root) {
      libraryPath = "";
      libraryEntries = [];
      libraryTruncated = false;
      renderTable();
      return;
    }
    const empty = document.getElementById("resource-empty");
    empty.hidden = false;
    empty.textContent = "正在读取文件夹…";
    try {
      const response = await fetch("http://127.0.0.1:47321/library/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: vault.library.root, path: path || "" })
      });
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json();
      if (result.error) throw new Error(result.error);
      libraryPath = String(result.path || "");
      libraryEntries = Array.isArray(result.entries) ? result.entries : [];
      libraryTruncated = !!result.truncated;
      renderTable();
    } catch (err) {
      libraryEntries = [];
      libraryTruncated = false;
      renderTable();
      const empty = document.getElementById("resource-empty");
      empty.hidden = false;
      empty.textContent = err && err.message ? err.message : "文件夹读取失败";
      document.getElementById("library-table-wrap").hidden = true;
    }
  }

  function visibleLibraryEntries() {
    const query = document.getElementById("resource-search").value.trim().toLowerCase();
    return libraryEntries.filter((entry) => {
      const project = vault.library.assignments[entry.path] || "";
      if (projectFilter !== "全部" && project !== projectFilter) return false;
      if (query && !String(entry.name || "").toLowerCase().includes(query)) return false;
      return true;
    });
  }

  function renderLibrary() {
    const configured = !!(vault && vault.library && vault.library.root);
    const root = document.getElementById("library-root");
    const bar = document.getElementById("library-bar");
    const table = document.getElementById("library-table-wrap");
    const body = document.getElementById("library-body");
    const empty = document.getElementById("resource-empty");
    const crumbs = document.getElementById("library-crumbs");
    document.getElementById("library-open-root").hidden = !configured;
    document.getElementById("library-refresh").hidden = !configured;
    root.textContent = configured ? vault.library.root : "";
    bar.hidden = !configured;
    body.innerHTML = "";
    crumbs.innerHTML = "";

    if (configured) {
      appendLibraryCrumb(crumbs, "根目录", "");
      let built = "";
      libraryPath.split("/").filter(Boolean).forEach((part) => {
        const slash = document.createElement("span");
        slash.textContent = "/";
        crumbs.append(slash);
        built = built ? built + "/" + part : part;
        appendLibraryCrumb(crumbs, part, built);
      });
    }

    const rows = configured ? visibleLibraryEntries() : [];
    rows.forEach((entry) => body.append(renderLibraryRow(entry)));
    table.hidden = rows.length === 0;
    const focused = body.querySelector(".library-focus");
    if (focused && focused.scrollIntoView) focused.scrollIntoView({ block: "nearest" });
    empty.hidden = rows.length > 0 && !libraryTruncated;
    if (!configured) {
      empty.hidden = false;
      empty.textContent = "还没有指定文件夹。点右上角「选择文件夹」。";
    } else if (libraryEntries.length === 0) {
      empty.textContent = "这个文件夹是空的。";
    } else if (rows.length === 0) {
      empty.textContent = "没有匹配的文件。";
    } else if (libraryTruncated) {
      empty.hidden = false;
      empty.textContent = "当前文件夹项目过多，只显示前 1,000 项。";
    }
  }

  function appendLibraryCrumb(root, label, path) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.libraryPath = path;
    button.textContent = label;
    root.append(button);
  }

  function renderLibraryRow(entry) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const name = document.createElement("button");
    name.type = "button";
    name.className = "library-name";
    name.textContent = (entry.kind === "dir" ? "📁 " : "📄 ") + String(entry.name || "");
    if (libraryFocus && entry.path === libraryFocus) row.classList.add("library-focus");
    name.addEventListener("click", () => {
      libraryFocus = "";
      if (entry.kind === "dir") loadLibrary(entry.path);
      else openLibraryItem(entry.path);
    });
    nameCell.append(name);

    const kind = document.createElement("td");
    kind.className = "library-kind";
    kind.textContent = entry.kind === "dir" ? "文件夹" : fileType(entry.name);
    const size = document.createElement("td");
    size.className = "muted";
    size.textContent = entry.kind === "dir" ? "—" : formatFileSize(Number(entry.size) || 0);
    const time = document.createElement("td");
    time.className = "muted";
    time.textContent = entry.mtime || "—";

    const projectCell = document.createElement("td");
    const project = document.createElement("select");
    project.className = "library-project";
    fillProjectOptions(project, vault.library.assignments[entry.path] || "");
    project.addEventListener("change", async () => {
      if (project.value) vault.library.assignments[entry.path] = project.value;
      else delete vault.library.assignments[entry.path];
      try {
        await persist();
        Nav.toast("项目归属已保存");
      } catch (err) {
        Nav.toast(err && err.message ? err.message : "保存失败");
      }
    });
    projectCell.append(project);

    const actions = document.createElement("td");
    actions.className = "resource-actions";
    if (entry.kind === "dir") {
      actions.append(actionButton("打开", () => openLibraryItem(entry.path)));
    } else {
      actions.append(actionButton("打开", () => openLibraryItem(entry.path)));
      actions.append(actionButton("定位", () => openLibraryItem(entry.path, "select")));
    }
    row.append(nameCell, kind, size, time, projectCell, actions);
    return row;
  }

  function fileType(name) {
    const match = /\.([^.]*)$/.exec(String(name || ""));
    return match && match[1] ? match[1].toUpperCase() + " 文件" : "文件";
  }

  function formatFileSize(size) {
    if (size < 1024) return size + " B";
    if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10240 ? 1 : 0) + " KB";
    if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(size < 10485760 ? 1 : 0) + " MB";
    return (size / 1024 / 1024 / 1024).toFixed(1) + " GB";
  }

  async function openLibraryItem(path, mode) {
    if (!vault || !vault.library.root) return;
    try {
      const response = await fetch("http://127.0.0.1:47321/library/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: vault.library.root, path: path || "", mode: mode || "" })
      });
      if (!response.ok) throw new Error(await response.text());
    } catch (err) {
      Nav.toast(err && err.message ? err.message : "无法在资源管理器中打开");
    }
  }

  function renderProjects() {
    const root = document.getElementById("resource-projects");
    root.innerHTML = "";
    ["全部"].concat(Workbench.meta.projects).forEach((name) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip" + (projectFilter === name ? " on" : "");
      button.textContent = name;
      button.addEventListener("click", () => {
        projectFilter = name;
        renderProjects();
        renderTable();
      });
      root.append(button);
    });
  }

  function renderTypes() {
    renderProjects();
    const root = document.getElementById("resource-types");
    root.innerHTML = "";
    const entries = [["all", "全部"]]
      .concat(Object.entries(TYPES).map(([id, type]) => [id, type.label]))
      .concat([["file", "文件"], ["trash", "回收站"]])
      .filter(([id]) => id !== "trash" || trashedRecords().length > 0);
    entries.forEach(([id, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip" + (filter === id ? " on" : "");
      button.textContent = id === "trash" ? `${label} ${trashedRecords().length}` : label;
      button.addEventListener("click", () => {
        filter = id;
        renderTypes();
        if (id === "file") showFiles();
        else renderTable();
      });
      root.append(button);
    });
  }

  function visibleRecords() {
    if (!vault) return [];
    const query = document.getElementById("resource-search").value.trim().toLowerCase();
    const pool = filter === "trash" ? trashedRecords() : liveRecords();
    return pool.filter((record) => {
      if (filter !== "all" && filter !== "trash" && record.type !== filter) return false;
      if (projectFilter !== "全部" && record.project !== projectFilter) return false;
      if (!query) return true;
      return Object.keys(record).some((field) => {
        if (field === "secret") return false;
        return String(record[field] || "").toLowerCase().includes(query);
      });
    }).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, "zh-CN"));
  }

  function parentLibraryPath(path) {
    const clean = String(path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const slash = clean.lastIndexOf("/");
    return slash >= 0 ? clean.slice(0, slash) : "";
  }

  function showFiles() {
    if (vault && vault.library.root) {
      if (pendingLibraryPath) {
        libraryFocus = pendingLibraryPath;
        const target = pendingLibraryPath;
        pendingLibraryPath = "";
        loadLibrary(parentLibraryPath(target));
        return;
      }
      loadLibrary(libraryPath);
    } else renderTable();
  }

  function setLibraryChrome(files) {
    const configured = !!(vault && vault.library && vault.library.root);
    document.getElementById("resource-add").hidden = files || filter === "trash";
    document.getElementById("library-pick").hidden = !files;
    document.getElementById("library-refresh").hidden = !files || !configured;
    document.getElementById("library-open-root").hidden = !files || !configured;
    document.getElementById("resource-table-wrap").hidden = files;
    document.getElementById("library-table-wrap").hidden = !files;
    document.getElementById("library-bar").hidden = !files;
    document.getElementById("resource-search").placeholder = files ? "搜索文件" : "搜索资料";
  }

  function renderTable() {
    if (!vault) return;
    if (filter === "file") {
      setLibraryChrome(true);
      renderLibrary();
      return;
    }
    setLibraryChrome(false);
    const head = document.getElementById("resource-head");
    const body = document.getElementById("resource-body");
    head.innerHTML = "";
    body.innerHTML = "";
    const columns = filter === "all" || filter === "trash"
      ? [["type", "类型"], ["name", "名称"], ["summary", "内容"], ["project", "项目"], ["notes", "备注"]]
      : typeColumns(filter);
    const headerRow = document.createElement("tr");
    columns.forEach(([, label]) => {
      const th = document.createElement("th");
      th.textContent = label;
      headerRow.append(th);
    });
    const actionHead = document.createElement("th");
    actionHead.textContent = filter === "trash" ? "回收站" : "操作";
    headerRow.append(actionHead);
    head.append(headerRow);

    const records = visibleRecords();
    records.forEach((record) => body.append(renderRow(record, columns)));
    const empty = document.getElementById("resource-empty");
    empty.hidden = records.length > 0;
    empty.textContent = filter === "trash"
      ? "回收站是空的。"
      : (vault.records.length === 0 ? "还没有资料。点右上角「新建资料」。" : "没有匹配的资料。");
    document.getElementById("resource-table-wrap").hidden = records.length === 0;
  }

  function typeColumns(type) {
    if (type === "credential") {
      return [["name", "名称"], ["username", "账号"], ["secret", "密码"], ["project", "项目"], ["notes", "备注"]];
    }
    const config = typeInfo(type);
    if (!config) return [["name", "名称"], ["project", "项目"], ["notes", "备注"]];
    return [["name", "名称"], [config.value, config.valueLabel], ["project", "项目"], ["notes", "备注"]];
  }

  function renderRow(record, columns) {
    const row = document.createElement("tr");
    columns.forEach(([field]) => {
      const cell = document.createElement("td");
      renderCell(cell, record, field);
      row.append(cell);
    });
    const actions = document.createElement("td");
    actions.className = "resource-actions";
    if (record.deletedAt) {
      actions.append(actionButton("恢复", () => restoreRecord(record.id)));
      actions.append(actionButton("彻底删除", () => purgeRecord(record.id)));
    } else if (isLegacySoftware(record)) {
      actions.append(actionButton("迁到代码页", () => migrateOne(record)));
      actions.append(actionButton("彻底删除", () => purgeRecord(record.id)));
    } else {
      actions.append(actionButton("编辑", () => openEditor(record)));
    }
    row.append(actions);
    return row;
  }

  function renderCell(cell, record, field) {
    if (field === "type") {
      const info = typeInfo(record.type);
      cell.textContent = info ? info.label : record.type;
      return;
    }
    if (field === "summary") {
      const config = typeInfo(record.type);
      if (!config) {
        cell.textContent = "—";
        return;
      }
      const value = record[config.value] || "";
      if (record.type === "path") {
        appendPathValue(cell, value);
        return;
      }
      appendCopyValue(cell, value, value);
      return;
    }
    if (field === "secret") {
      const shown = revealed.has(record.id);
      const value = record.secret || "";
      const text = value ? (shown ? value : "••••••••") : "—";
      const span = document.createElement("span");
      span.className = "secret-value";
      span.textContent = text;
      cell.append(span);
      if (value) {
        cell.append(actionButton(shown ? "隐藏" : "显示", () => toggleSecret(record.id)));
        cell.append(actionButton("复制", () => copyValue(value, true)));
      }
      return;
    }
    const value = String(record[field] || "");
    if (field === "path") {
      appendPathValue(cell, value);
      return;
    }
    if ((field === "username" || field === "host" || field === "softwareId") && value) {
      appendCopyValue(cell, value, value);
      return;
    }
    cell.textContent = value || "—";
  }

  function appendCopyValue(cell, label, value) {
    const span = document.createElement("span");
    span.className = "resource-value";
    span.textContent = label || "—";
    cell.append(span);
    if (value) cell.append(actionButton("复制", () => copyValue(value, false)));
  }

  function appendPathValue(cell, value) {
    const text = String(value || "").trim();
    if (!text) {
      cell.textContent = "—";
      return;
    }
    const link = document.createElement("a");
    link.className = "resource-path-link";
    link.href = /^https?:\/\//i.test(text) ? text : "#";
    link.textContent = text;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openPath(text);
    });
    cell.append(link);
    cell.append(actionButton("复制", () => copyValue(text, false)));
  }

  async function openPath(value) {
    const text = String(value || "").trim();
    if (/^https?:\/\//i.test(text)) {
      window.open(text, "_blank", "noopener");
      return;
    }
    try {
      const response = await fetch("http://127.0.0.1:47321/open", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: text
      });
      if (!response.ok) throw new Error("open failed");
    } catch (err) {
      Nav.toast("没有打开。请先双击「打开工作台」再试");
    }
  }

  function actionButton(label, onclick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "linkish";
    button.textContent = label;
    button.addEventListener("click", onclick);
    return button;
  }

  function toggleSecret(id) {
    if (revealed.has(id)) revealed.delete(id);
    else {
      revealed.add(id);
      setTimeout(() => {
        revealed.delete(id);
        if (vault) renderTable();
      }, 15000);
    }
    renderTable();
  }

  async function copyValue(value, secret) {
    try {
      await navigator.clipboard.writeText(value);
      Nav.toast(secret ? "密码已复制，30 秒后尝试清除" : "已复制");
      if (secret) setTimeout(() => clearClipboard(value), 30000);
    } catch (err) {
      Nav.toast("浏览器不允许访问剪贴板");
    }
  }

  async function clearClipboard(expected) {
    try {
      const current = await navigator.clipboard.readText();
      if (current === expected) await navigator.clipboard.writeText("");
    } catch (err) {
      // 浏览器可能允许写入但不允许读取；此时不能安全地覆盖用户的新剪贴板内容。
    }
  }

  /* ================= 编辑 ================= */

  function fillProjectOptions(select, selected) {
    select.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "（不归属项目）";
    select.append(blank);
    Workbench.projects(selected).forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.append(option);
    });
    select.value = selected || "";
    if (select.value !== (selected || "")) select.value = "";
  }

  function openEditor(record) {
    editingId = record ? record.id : null;
    const dialog = document.getElementById("resource-dialog");
    document.getElementById("resource-dialog-title").textContent = record ? "编辑资料" : "新建资料";
    document.getElementById("resource-delete").hidden = !record;
    document.getElementById("resource-type").value = record ? record.type : (filter === "all" || filter === "trash" ? "credential" : filter);
    document.getElementById("resource-name").value = record ? record.name : "";
    document.getElementById("resource-username").value = record ? record.username : "";
    document.getElementById("resource-secret").value = record ? record.secret : "";
    document.getElementById("resource-path").value = record ? record.path : "";
    document.getElementById("resource-host").value = record ? record.host : "";
    document.getElementById("resource-software").value = record ? record.softwareId : "";
    document.getElementById("resource-notes").value = record ? record.notes : "";
    const preset = !record && projectFilter !== "全部" ? projectFilter : "";
    fillProjectOptions(document.getElementById("resource-project"), record ? record.project : preset);
    syncEditorFields();
    dialog.showModal();
    document.getElementById("resource-name").focus();
  }

  function syncEditorFields() {
    const type = document.getElementById("resource-type").value;
    document.querySelectorAll(".resource-field").forEach((field) => {
      field.hidden = !field.dataset.types.split(" ").includes(type);
    });
  }

  function closeEditor() {
    const dialog = document.getElementById("resource-dialog");
    if (dialog.open) dialog.close();
    editingId = null;
  }

  async function saveEditor(event) {
    event.preventDefault();
    if (!vault) return;
    const type = document.getElementById("resource-type").value;
    const now = new Date().toISOString();
    const record = {
      id: editingId || Workbench.uid(),
      type,
      name: document.getElementById("resource-name").value.trim(),
      username: type === "credential" ? document.getElementById("resource-username").value.trim() : "",
      secret: type === "credential" ? document.getElementById("resource-secret").value : "",
      path: type === "path" ? document.getElementById("resource-path").value.trim() : "",
      host: type === "host" ? document.getElementById("resource-host").value.trim() : "",
      softwareId: type === "software" ? document.getElementById("resource-software").value.trim() : "",
      project: document.getElementById("resource-project").value,
      notes: document.getElementById("resource-notes").value.trim(),
      deletedAt: "",
      updatedAt: now
    };
    const index = vault.records.findIndex((item) => item.id === record.id);
    const previous = index >= 0 ? vault.records[index] : null;
    if (previous) record.deletedAt = String(previous.deletedAt || "");
    if (index >= 0) vault.records[index] = record;
    else vault.records.push(record);
    try {
      await persist();
      closeEditor();
      renderTypes();
      renderTable();
      Nav.toast("资料已保存");
    } catch (err) {
      Nav.toast(err && err.message ? err.message : "保存失败");
    }
  }

  async function deleteEditor() {
    const record = vault && vault.records.find((item) => item.id === editingId);
    if (!record) return;
    closeEditor();
    await softDelete(record);
  }

  // 删除先入回收站，1 分钟内可撤销
  async function softDelete(record) {
    const backup = Object.assign({}, record);
    record.deletedAt = new Date().toISOString();
    try {
      await persist();
      renderTypes();
      renderTable();
      Nav.toast(`「${record.name || "未命名"}」已移入回收站`, {
        label: "撤销",
        onSelect: async () => {
          const target = vault && vault.records.find((item) => item.id === backup.id);
          if (!target) return;
          target.deletedAt = "";
          target.updatedAt = new Date().toISOString();
          await persist();
          renderTypes();
          renderTable();
          Nav.toast("已恢复");
        }
      });
    } catch (err) {
      record.deletedAt = "";
      Nav.toast(err && err.message ? err.message : "删除失败");
    }
  }

  async function restoreRecord(id) {
    const record = vault && vault.records.find((item) => item.id === id);
    if (!record) return;
    record.deletedAt = "";
    record.updatedAt = new Date().toISOString();
    try {
      await persist();
      renderTypes();
      renderTable();
      Nav.toast("已恢复");
    } catch (err) {
      Nav.toast(err && err.message ? err.message : "恢复失败");
    }
  }

  async function purgeRecord(id) {
    const record = vault && vault.records.find((item) => item.id === id);
    if (!record) return;
    if (!confirm(`彻底删除「${record.name || "未命名"}」？不可恢复。`)) return;
    vault.records = vault.records.filter((item) => item.id !== id);
    try {
      await persist();
      renderTypes();
      renderTable();
      Nav.toast("已彻底删除");
    } catch (err) {
      Nav.toast(err && err.message ? err.message : "删除失败");
    }
  }

  /* ===== 软件号迁出 =====
     软件号原来存在加密库里的一个类型，现在改由代码页的明文 software.json 管理。
     解密后（这时才有明文）统计还剩多少条，给一个明确的迁出入口。 */

  function legacySoftwareRecords() {
    return vault ? vault.records.filter(isLegacySoftware) : [];
  }

  function syncSoftwareMigration() {
    const bar = document.getElementById("software-migrate");
    if (!bar) return;
    const records = legacySoftwareRecords();
    const text = document.getElementById("software-migrate-text");
    bar.hidden = records.length === 0;
    if (records.length === 0 || !text) return;
    text.textContent = "加密资料库里还有 " + records.length
      + " 条「软件号」。它们已经改由「代码」页管理，迁出后会写成明文的 software.json（不再受主密码保护）。";
  }

  // 迁出：合并进 software.json，再从加密库移除。persist() 会顺带刷新 vault.backup.json 作为回滚点。
  async function migrateSoftware(records) {
    if (!records.length) return 0;
    const existing = await Workbench.loadSoftware();
    const known = new Set(existing.map((item) => item.id));
    records.forEach((record) => {
      if (known.has(record.id)) return;
      existing.push({
        id: record.id,
        name: record.name || "",
        softwareId: record.softwareId || "",
        project: record.project || "",
        notes: record.notes || "",
        deletedAt: record.deletedAt || "",
        updatedAt: record.updatedAt || new Date().toISOString()
      });
    });
    await Workbench.saveSoftware(existing);
    const ids = new Set(records.map((record) => record.id));
    vault.records = vault.records.filter((record) => !ids.has(record.id));
    await persist();
    renderTypes();
    renderTable();
    syncSoftwareMigration();
    return records.length;
  }

  async function migrateOne(record) {
    try {
      const count = await migrateSoftware([record]);
      if (count) Nav.toast("「" + (record.name || "未命名") + "」已迁到代码页");
    } catch (err) {
      Nav.toast(err && err.message ? err.message : "迁出失败");
    }
  }

  async function migrateAllSoftware() {
    const records = legacySoftwareRecords();
    if (!records.length) return;
    if (!confirm("把 " + records.length + " 条「软件号」迁到代码页？\n\n"
      + "迁出后它们会写成明文的 software.json，不再受主密码保护。原加密库会同步移除这些条目，"
      + "但 vault.backup.json 里仍留有一份可回滚的备份。")) return;
    try {
      const count = await migrateSoftware(records);
      Nav.toast("已迁出 " + count + " 条，去「代码」页的软件号页签查看");
    } catch (err) {
      Nav.toast(err && err.message ? err.message : "迁出失败");
    }
  }

  function persist() {
    if (!vault || !vaultKey || !vaultSettings) {
      return Promise.reject(new Error("资料库未解锁"));
    }
    vault.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(vault);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const next = await VaultCrypto.encrypt(vaultKey, vaultSettings, snapshot);
      await Workbench.saveVaultEnvelope(next);
      envelope = next;
      Workbench.writeVaultSession(snapshot);
    });
    return saveQueue;
  }
})();
