(function () {
  const DB_NAME = "otdr-sn";
  const DB_VERSION = 1;
  let exact = new Map();
  let fuzzy = [];
  let catalogDb = null;
  let catalogRows = [];
  let editingCatalogId = null;
  let catalogPnFilter = "";
  let catalogProjectFilter = "";
  let sqlPromise = null;
  let fileHandle = null;

  Nav.boot("sn", async () => {
    document.getElementById("sn-pick").addEventListener("click", syncDatabase);
    document.getElementById("sn-form").addEventListener("submit", (event) => {
      event.preventDefault();
      search(document.getElementById("sn-input").value);
    });
    document.getElementById("catalog-add").addEventListener("click", () => openCatalogEditor(null));
    document.getElementById("catalog-cancel").addEventListener("click", closeCatalogEditor);
    document.getElementById("catalog-form").addEventListener("submit", saveCatalogEditor);
    document.getElementById("catalog-filter-pn").addEventListener("change", (event) => {
      catalogPnFilter = event.target.value;
      renderCatalog();
    });
    document.getElementById("catalog-filter-project").addEventListener("change", (event) => {
      catalogProjectFilter = event.target.value;
      renderCatalog();
    });
    window.addEventListener("workbench-projects", () => {
      const select = document.getElementById("catalog-project");
      if (select) fillCatalogProjects(select, select.value);
    });
    await restore();
    await openCatalog();
  }, { optionalFolder: true });

  function dirname(fullPath) {
    const text = String(fullPath || "").replace(/[\\/]+$/, "");
    const index = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
    return index >= 0 ? text.slice(0, index) : text;
  }

  function openIndexDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        if (!db.objectStoreNames.contains("rows")) db.createObjectStore("rows", { autoIncrement: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function useMemory(rows) {
    exact = new Map();
    fuzzy = rows;
    rows.forEach((row) => {
      const key = String(row.sn || "");
      if (!exact.has(key)) exact.set(key, []);
      exact.get(key).push(row);
    });
  }

  async function restore() {
    const db = await openIndexDb();
    const metaTx = db.transaction("meta");
    const metaRequest = metaTx.objectStore("meta").get("current");
    const fileRequest = metaTx.objectStore("meta").get("file");
    const rowsRequest = db.transaction("rows").objectStore("rows").getAll();
    const meta = await requestToPromise(metaRequest);
    fileHandle = await requestToPromise(fileRequest);
    const rows = await requestToPromise(rowsRequest);
    db.close();
    useMemory(Array.isArray(rows) ? rows : []);
    paintStatus(meta);
    if (!fuzzy.length && fileHandle && fileHandle.queryPermission) {
      const perm = await fileHandle.queryPermission({ mode: "read" });
      if (perm === "granted") {
        await importFile(await fileHandle.getFile());
      } else {
        document.getElementById("sn-status").textContent = "已记住数据库文件。点「更新数据库」并允许访问后即可查询。";
      }
    }
  }

  async function syncDatabase() {
    const status = document.getElementById("sn-status");
    status.textContent = "正在对比服务器和本地数据库的修改时间…";
    let info;
    try {
      const response = await fetch("http://127.0.0.1:47321/sync-db", { method: "POST" });
      info = await response.json();
      if (!response.ok && (!info || info.status !== "error")) throw new Error("sync failed");
    } catch (err) {
      status.textContent = "没有连上本地服务。请先双击「打开工作台」。";
      Nav.toast("没有连上本地服务");
      return;
    }
    if (info.status === "error") {
      status.textContent = info.message || "更新数据库失败";
      Nav.toast("更新数据库失败");
      return;
    }
    if (info.status === "unavailable" && !info.local) {
      status.textContent = "服务器上的数据库读不到，本地也没有副本。";
      Nav.toast("数据库不可用");
      return;
    }
    if (info.status === "same" && fuzzy.length) {
      status.textContent = "修改时间相同，未更新" + timeNote(info) + " · 已载入 " + fuzzy.length + " 条";
      Nav.toast("修改时间相同，未更新");
      return;
    }
    if (info.status === "copied") status.textContent = "正在读取刚复制的数据库…";
    else if (info.status === "unavailable") status.textContent = "服务器暂时读不到，改用本地数据库…";
    else status.textContent = "正在读取本地数据库…";
    try {
      const response = await fetch("http://127.0.0.1:47321/otdr_index.db", { cache: "no-store" });
      if (!response.ok) throw new Error("read failed");
      const file = new File([await response.blob()], "otdr_index.db", { type: "application/octet-stream" });
      await importFile(file);
      const line = document.getElementById("sn-status");
      if (info.status === "copied") line.textContent += " · 已从服务器更新" + timeNote(info);
      else if (info.status === "unavailable") line.textContent += " · 服务器暂时读不到";
      else line.textContent += timeNote(info);
    } catch (err) {
      status.textContent = "本地数据库没有读成。";
      Nav.toast("读取失败");
    }
  }

  function timeNote(info) {
    if (!info || !info.nasTime) return "";
    return " · " + info.nasTime;
  }

  function paintStatus(meta) {
    const status = document.getElementById("sn-status");
    if (!fuzzy.length) {
      status.textContent = "还没有读取数据库。点「选择数据库」后会按修改时间决定要不要从服务器复制。";
      return;
    }
    const name = meta && meta.name ? meta.name : "已保存的索引";
    const when = meta && meta.importedAt ? meta.importedAt.replace("T", " ").slice(0, 19) : "";
    status.textContent = `已载入 ${fuzzy.length} 条 · ${name}${when ? " · " + when : ""}`;
  }

  function loadSql() {
    if (!sqlPromise) {
      sqlPromise = initSqlJs({ locateFile: () => "js/vendor/sql-wasm.wasm" });
    }
    return sqlPromise;
  }

  async function importFile(file) {
    const status = document.getElementById("sn-status");
    status.textContent = "正在读取数据库…";
    try {
      const SQL = await loadSql();
      const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
      let result;
      try {
        result = db.exec(
          "SELECT DISTINCT pn, sn, full_path FROM file_index WHERE rule_name = 'SN_Log.txt' ORDER BY sn"
        );
      } finally {
        db.close();
      }
      const table = result && result[0];
      const rows = [];
      if (table) {
        const pnIndex = table.columns.indexOf("pn");
        const snIndex = table.columns.indexOf("sn");
        const pathIndex = table.columns.indexOf("full_path");
        table.values.forEach((value) => {
          if (!value[pathIndex] || !value[snIndex]) return;
          rows.push({
            pn: value[pnIndex] == null ? "" : String(value[pnIndex]),
            sn: String(value[snIndex]),
            folder: dirname(value[pathIndex])
          });
        });
      }
      const meta = { name: file.name, importedAt: new Date().toISOString(), count: rows.length };
      await saveIndex(meta, rows);
      useMemory(rows);
      paintStatus(meta);
      Nav.toast(rows.length ? "索引已保存" : "库里没有 SN_Log 记录");
    } catch (err) {
      status.textContent = "数据库没有读成。请确认这是 OTDR 索引库。";
      Nav.toast(err && err.message ? err.message : "读取失败");
    }
  }

  async function saveIndex(meta, rows) {
    const db = await openIndexDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["meta", "rows"], "readwrite");
      tx.objectStore("meta").put(meta, "current");
      const store = tx.objectStore("rows");
      store.clear();
      rows.forEach((row) => store.add(row));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }

  function search(raw) {
    const text = String(raw || "").trim();
    if (!text) return;
    if (!fuzzy.length && !catalogRows.length) {
      Nav.toast("请先更新数据库，或在自建目录里添加记录");
      return;
    }
    const exactMatches = catalogHits(text, true).concat((exact.get(text) || []).map(indexHit));
    if (exactMatches.length) {
      showResults(exactMatches);
      openFolder(exactMatches[0].folder);
      return;
    }
    const needle = text.toLowerCase();
    const matches = catalogHits(text, false);
    for (let i = 0; i < fuzzy.length && matches.length < 20; i += 1) {
      if (String(fuzzy[i].sn).toLowerCase().indexOf(needle) >= 0) matches.push(indexHit(fuzzy[i]));
    }
    if (!matches.length) {
      showResults([]);
      Nav.toast("未找到这个序列号");
      return;
    }
    showResults(matches.slice(0, 20));
    if (matches.length === 1) openFolder(matches[0].folder);
  }

  function indexHit(row) {
    return { sn: row.sn, pn: row.pn, project: "", folder: row.folder, source: "索引" };
  }

  function catalogHits(text, exactOnly) {
    const needle = text.toLowerCase();
    return catalogRows.filter((row) => {
      const sn = String(row.sn || "");
      return exactOnly ? sn.toLowerCase() === text.toLowerCase() : sn.toLowerCase().indexOf(needle) >= 0;
    }).map((row) => ({
      sn: row.sn,
      pn: row.pn,
      project: row.project,
      folder: row.path,
      source: "自建"
    }));
  }

  function showResults(rows) {
    const card = document.getElementById("sn-results");
    const body = document.getElementById("sn-body");
    body.innerHTML = "";
    if (!rows.length) {
      card.hidden = true;
      return;
    }
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      [row.sn, row.pn, row.project, row.folder, row.source].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value || "—";
        tr.append(cell);
      });
      const action = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "linkish";
      button.textContent = "打开";
      button.addEventListener("click", () => openFolder(row.folder));
      action.append(button);
      tr.append(action);
      body.append(tr);
    });
    card.hidden = false;
  }

  async function openFolder(folder) {
    if (!folder) return;
    try {
      const response = await fetch("http://127.0.0.1:47321/open", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: folder
      });
      if (!response.ok) throw new Error("open failed");
    } catch (err) {
      Nav.toast("没有打开。请先双击「打开工作台」再试");
    }
  }

  async function openCatalog() {
    const status = document.getElementById("catalog-status");
    try {
      const SQL = await loadSql();
      let bytes = null;
      const response = await fetch("http://127.0.0.1:47321/catalog.db", { cache: "no-store" });
      if (response.ok) bytes = new Uint8Array(await response.arrayBuffer());
      catalogDb = bytes && bytes.length ? new SQL.Database(bytes) : new SQL.Database();
      const changed = ensureCatalogSchema();
      readCatalogRows();
      if (!bytes || changed) await persistCatalog();
      renderCatalog();
    } catch (err) {
      status.textContent = "自建目录没有打开。请先双击「打开工作台」。";
    }
  }

  function ensureCatalogSchema() {
    catalogDb.run(
      "CREATE TABLE IF NOT EXISTS catalog (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, sn TEXT NOT NULL, pn TEXT NOT NULL DEFAULT '', " +
      "project TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '')"
    );
    const existing = catalogDb.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'catalog_sn'");
    if (existing && existing.length) return false;
    catalogDb.run("DELETE FROM catalog WHERE id NOT IN (SELECT MAX(id) FROM catalog GROUP BY sn COLLATE NOCASE)");
    catalogDb.run("CREATE UNIQUE INDEX catalog_sn ON catalog(sn COLLATE NOCASE)");
    return true;
  }

  function readCatalogRows() {
    catalogRows = [];
    const result = catalogDb.exec("SELECT id, sn, pn, project, path FROM catalog ORDER BY sn COLLATE NOCASE, id");
    const table = result && result[0];
    if (!table) return;
    const idIndex = table.columns.indexOf("id");
    const snIndex = table.columns.indexOf("sn");
    const pnIndex = table.columns.indexOf("pn");
    const projectIndex = table.columns.indexOf("project");
    const pathIndex = table.columns.indexOf("path");
    table.values.forEach((value) => {
      catalogRows.push({
        id: value[idIndex],
        sn: value[snIndex] == null ? "" : String(value[snIndex]),
        pn: value[pnIndex] == null ? "" : String(value[pnIndex]),
        project: value[projectIndex] == null ? "" : String(value[projectIndex]),
        path: value[pathIndex] == null ? "" : String(value[pathIndex])
      });
    });
  }

  async function persistCatalog() {
    const bytes = catalogDb.export();
    const response = await fetch("http://127.0.0.1:47321/catalog/save", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes
    });
    if (!response.ok) throw new Error((await response.text()) || "保存失败");
  }

  function renderCatalog() {
    const body = document.getElementById("catalog-body");
    const empty = document.getElementById("catalog-empty");
    const status = document.getElementById("catalog-status");
    const filters = document.getElementById("catalog-filters");
    catalogPnFilter = fillCatalogFilter(
      document.getElementById("catalog-filter-pn"),
      catalogRows.map((row) => row.pn),
      catalogPnFilter,
      "全部 PN"
    );
    catalogProjectFilter = fillCatalogFilter(
      document.getElementById("catalog-filter-project"),
      catalogRows.map((row) => row.project),
      catalogProjectFilter,
      "全部项目"
    );
    const shown = catalogRows.filter((row) => {
      if (catalogPnFilter && row.pn !== catalogPnFilter) return false;
      if (catalogProjectFilter && row.project !== catalogProjectFilter) return false;
      return true;
    });
    body.innerHTML = "";
    shown.forEach((row) => {
      const tr = document.createElement("tr");
      [row.sn, row.pn, row.project, row.path].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value || "—";
        tr.append(cell);
      });
      const actions = document.createElement("td");
      actions.className = "resource-actions";
      actions.append(catalogAction("打开", () => openFolder(row.path)));
      actions.append(catalogAction("编辑", () => openCatalogEditor(row)));
      actions.append(catalogAction("删除", () => deleteCatalogRow(row)));
      tr.append(actions);
      body.append(tr);
    });
    filters.hidden = catalogRows.length === 0;
    empty.hidden = shown.length > 0;
    empty.textContent = catalogRows.length ? "没有符合筛选的记录。" : "还没有自建记录。";
    document.getElementById("catalog-wrap").hidden = shown.length === 0;
    if (!catalogRows.length) status.textContent = "存在本机的 catalog.db，和索引库分开。";
    else if (shown.length === catalogRows.length) status.textContent = "共 " + catalogRows.length + " 条，每个 SN 只保留一条。";
    else status.textContent = "显示 " + shown.length + " / " + catalogRows.length + " 条。";
  }

  function fillCatalogFilter(select, values, current, allLabel) {
    const names = [];
    const seen = new Set();
    values.forEach((value) => {
      const name = String(value || "").trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    });
    names.sort((a, b) => a.localeCompare(b, "zh"));
    select.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = allLabel;
    select.append(all);
    names.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.append(option);
    });
    select.value = names.indexOf(current) >= 0 ? current : "";
    return select.value;
  }

  function catalogAction(label, onclick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "linkish";
    button.textContent = label;
    button.addEventListener("click", onclick);
    return button;
  }

  function fillCatalogProjects(select, selected) {
    Nav.fillProjects(select, selected || "");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "（不选）";
    select.insertBefore(blank, select.firstChild);
    select.value = selected || "";
  }

  function openCatalogEditor(row) {
    editingCatalogId = row ? row.id : null;
    document.getElementById("catalog-dialog-title").textContent = row ? "编辑记录" : "添加记录";
    document.getElementById("catalog-sn").value = row ? row.sn : "";
    document.getElementById("catalog-pn").value = row ? row.pn : "";
    document.getElementById("catalog-path").value = row ? row.path : "";
    fillCatalogProjects(document.getElementById("catalog-project"), row ? row.project : "");
    document.getElementById("catalog-dialog").showModal();
    document.getElementById("catalog-sn").focus();
  }

  function closeCatalogEditor() {
    const dialog = document.getElementById("catalog-dialog");
    if (dialog.open) dialog.close();
    editingCatalogId = null;
  }

  async function saveCatalogEditor(event) {
    event.preventDefault();
    if (!catalogDb) {
      Nav.toast("自建目录还没打开");
      return;
    }
    const sn = document.getElementById("catalog-sn").value.trim();
    const pn = document.getElementById("catalog-pn").value.trim();
    const project = document.getElementById("catalog-project").value;
    const path = document.getElementById("catalog-path").value.trim();
    if (!sn || !path) return;
    const duplicate = catalogRows.some((row) => {
      return row.sn.toLowerCase() === sn.toLowerCase() && row.id !== editingCatalogId;
    });
    if (duplicate) {
      Nav.toast("这个 SN 已经有了");
      return;
    }
    try {
      if (editingCatalogId == null) {
        catalogDb.run("INSERT INTO catalog (sn, pn, project, path) VALUES (?, ?, ?, ?)", [sn, pn, project, path]);
      } else {
        catalogDb.run("UPDATE catalog SET sn = ?, pn = ?, project = ?, path = ? WHERE id = ?", [
          sn, pn, project, path, editingCatalogId
        ]);
      }
      await persistCatalog();
      readCatalogRows();
      renderCatalog();
      closeCatalogEditor();
      Nav.toast("已保存到 catalog.db");
    } catch (err) {
      Nav.toast(err && err.message ? err.message : "保存失败");
    }
  }

  async function deleteCatalogRow(row) {
    if (!catalogDb) return;
    if (!(await Nav.ask({
      title: "删除记录",
      text: "删除 SN「" + row.sn + "」这条自建记录？",
      okText: "删除",
      danger: true
    }))) return;
    try {
      catalogDb.run("DELETE FROM catalog WHERE id = ?", [row.id]);
      await persistCatalog();
      readCatalogRows();
      renderCatalog();
      Nav.toast("已删除");
    } catch (err) {
      Nav.toast(err && err.message ? err.message : "删除失败");
    }
  }
})();
