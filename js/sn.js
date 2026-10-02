(function () {
  const HOST = "http://127.0.0.1:47321";
  let scanTimer = 0;

  Nav.boot("sn", async () => {
    document.getElementById("sn-form").addEventListener("submit", (event) => {
      event.preventDefault();
      search(document.getElementById("sn-input").value);
    });
    document.getElementById("scan-run").addEventListener("click", startScan);
    document.getElementById("scan-root-add").addEventListener("click", addRoot);
    document.getElementById("scan-root-browse").addEventListener("click", browseRoot);
    document.getElementById("scan-root-input").addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      addRoot();
    });
    // 换了 Spec 要先把 PN 下拉重填（只列这个规格下的 PN），再刷新明细
    document.getElementById("scan-filter-spec").addEventListener("change", onSpecChange);
    document.getElementById("scan-filter-pn").addEventListener("change", onFilterChange);
    await loadScanRoots();
    // 一进来就把上次扫到的结果显示出来——服务没重启的话索引还在内存里，
    // 快照也在盘上，不该只有点过「更新路径」才看得见
    await loadStats();
  }, { optionalFolder: true });

  /* 产品目录只有一条来源：服务端扫盘出来的索引。
     以前要先把 26MB 的索引库整个下载到浏览器解析一遍，再另外维护一份自建目录；
     现在都由服务端按 根目录\spec\PN\SN 三级扫出来，索引常驻服务端内存，
     这里只负责配置根目录、触发扫描、以及查询。 */

  async function search(raw) {
    const text = String(raw || "").trim();
    if (!text) return;
    const status = document.getElementById("sn-status");
    status.textContent = "正在查…";
    let rows = [];
    try {
      const response = await fetch(HOST + "/catalog/find?sn=" + encodeURIComponent(text), { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        if (data && data.found) rows = [{ sn: data.sn, pn: data.pn, spec: data.spec, folder: data.path }];
      }
    } catch (err) {
      status.textContent = "查不到。请先双击「打开工作台」。";
      return;
    }
    if (!rows.length) rows = await searchFuzzy(text);
    // 只有一条就直接打开，跟以前敲完回车就跳过去的手感一致
    if (rows.length === 1) openFolder(rows[0].folder);
    status.textContent = rows.length ? "" : "没有找到这个序列号。";
    showResults(rows);
  }

  // 精确没中退一步：按 SN 或 PN 模糊匹配（服务端全表扫一次，几万条也就几毫秒）
  async function searchFuzzy(text) {
    try {
      const response = await fetch(HOST + "/catalog/search?q=" + encodeURIComponent(text), { cache: "no-store" });
      if (!response.ok) return [];
      const data = await response.json();
      return (data.items || []).map((item) => ({
        sn: item.sn,
        pn: item.pn,
        spec: item.spec,
        folder: item.path
      }));
    } catch (err) {
      return [];
    }
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
      [row.sn, row.pn, row.spec, row.folder].forEach((value) => {
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
      const response = await fetch(HOST + "/open", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: folder
      });
      if (!response.ok) throw new Error("open failed");
    } catch (err) {
      Nav.toast("没有打开。请先双击「打开工作台」再试");
    }
  }

  // 根目录：逐条添加（粘贴 UNC 路径，或点「浏览…」选文件夹），增删后即时保存
  let roots = [];

  async function loadScanRoots() {
    try {
      const response = await fetch(HOST + "/catalog/roots", { cache: "no-store" });
      if (!response.ok) throw new Error("读取失败");
      const data = await response.json();
      roots = data.roots || [];
      renderRoots();
      paintScanStatus(roots);
    } catch (err) {
      roots = [];
      renderRoots();
      document.getElementById("scan-status").textContent = "根目录读不到。请先双击「打开工作台」。";
    }
  }

  function renderRoots() {
    const box = document.getElementById("scan-root-list");
    box.innerHTML = "";
    if (!roots.length) {
      const empty = document.createElement("p");
      empty.className = "sub";
      empty.textContent = "还没有根目录。";
      box.append(empty);
      return;
    }
    roots.forEach((root, index) => {
      const row = document.createElement("div");
      row.className = "scan-root-item";
      const path = document.createElement("span");
      path.className = "scan-root-path";
      path.textContent = root;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "linkish";
      remove.textContent = "删除";
      remove.addEventListener("click", () => {
        roots.splice(index, 1);
        renderRoots();
        saveScanRoots();
      });
      row.append(path, remove);
      box.append(row);
    });
  }

  async function saveScanRoots() {
    paintScanStatus(roots);
    try {
      const response = await fetch(HOST + "/catalog/roots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roots: roots })
      });
      if (!response.ok) throw new Error((await response.text()) || "保存失败");
    } catch (err) {
      Nav.toast("根目录没保存上：" + err.message);
    }
  }

  function addRoot() {
    const input = document.getElementById("scan-root-input");
    const value = input.value.trim();
    if (!value) return;
    if (roots.indexOf(value) >= 0) {
      Nav.toast("这个根目录已经在列表里了");
      return;
    }
    roots.push(value);
    input.value = "";
    renderRoots();
    saveScanRoots();
  }

  // 弹系统的文件夹选择框（服务端 mode=dir），网络共享也能一路点进去
  async function browseRoot() {
    try {
      const response = await fetch(HOST + "/pick-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "dir", title: "选择产品数据根目录" })
      });
      if (!response.ok) throw new Error("打开失败");
      const data = await response.json();
      if (!data || data.cancelled || !data.path) return;
      document.getElementById("scan-root-input").value = data.path;
      addRoot();   // 选完直接加进去，省一步点「添加」
    } catch (err) {
      Nav.toast("没能打开选择框。请先双击「打开工作台」。");
    }
  }

  async function startScan() {
    const button = document.getElementById("scan-run");
    const status = document.getElementById("scan-status");
    try {
      const response = await fetch(HOST + "/catalog/scan", { method: "POST" });
      if (!response.ok) throw new Error("启动失败");
    } catch (err) {
      status.textContent = "没能启动扫描。请先双击「打开工作台」。";
      return;
    }
    button.disabled = true;
    status.textContent = "正在扫描…";
    pollScan();
  }

  // 几万个目录要扫几十秒，这里轮询进度，扫完把条数和出错的根目录报出来
  async function pollScan() {
    let data = null;
    try {
      const response = await fetch(HOST + "/catalog/status", { cache: "no-store" });
      if (response.ok) data = await response.json();
    } catch (err) {
      data = null;
    }
    const button = document.getElementById("scan-run");
    const status = document.getElementById("scan-status");
    if (!data) {
      button.disabled = false;
      status.textContent = "扫描状态读不到。";
      return;
    }
    if (data.running) {
      status.textContent = "正在扫描…已扫到 " + data.scanned + " 个";
      scanTimer = setTimeout(pollScan, 1000);
      return;
    }
    button.disabled = false;
    clearTimeout(scanTimer);
    const errors = data.errors || [];
    status.textContent = "已扫到 " + data.total + " 个 SN"
      + (errors.length ? "，" + errors.length + " 个根目录出错" : "");
    if (errors.length) Nav.toast(errors[0]);
    await loadStats();
  }

  function paintScanStatus(roots) {
    if (!roots || !roots.length) {
      document.getElementById("scan-status").textContent = "还没有配置根目录。填好上面再点「更新路径」。";
      return;
    }
    document.getElementById("scan-status").textContent = "已配 " + roots.length + " 个根目录，还没扫描。";
  }

  /* ===== 扫盘结果的可视化 =====
     索引几万条，不可能全塞进页面（那等于把刚挪走的 26MB 索引库又请回来）。
     所以分三层：概览和分布在服务端聚合好、只传数字过来；明细才按需分页拉。 */

  let detail = { spec: "", pn: "", offset: 0, limit: 100, total: 0 };

  async function loadStats() {
    const box = document.getElementById("scan-overview");
    try {
      const response = await fetch(HOST + "/catalog/stats", { cache: "no-store" });
      if (!response.ok) throw new Error("读取失败");
      renderStats(await response.json());
      box.hidden = false;
    } catch (err) {
      box.hidden = true;
    }
  }

  function renderStats(data) {
    const stats = document.getElementById("scan-stats");
    stats.innerHTML = "";
    [["SN", data.total], ["Spec", data.specCount], ["PN", data.pnCount]].forEach((pair) => {
      const cell = document.createElement("div");
      cell.className = "scan-stat";
      const value = document.createElement("b");
      value.textContent = pair[1];
      const label = document.createElement("span");
      label.textContent = pair[0];
      cell.append(value, label);
      stats.append(cell);
    });

    // 每个根目录各扫到多少：0 个的要显眼，多半是路径填错了
    const roots = document.getElementById("scan-roots-stat");
    roots.innerHTML = "";
    (data.roots || []).forEach((item) => {
      const row = document.createElement("div");
      row.className = "scan-root-row" + (item.count === 0 ? " is-empty" : "");
      const path = document.createElement("span");
      path.className = "scan-root-path";
      path.textContent = item.root;
      const count = document.createElement("b");
      count.textContent = item.count + " 个";
      row.append(path, count);
      roots.append(row);
    });

    // 出错要说出来：快照没读出来、哪些根目录扫不了
    const problems = (data.errors || []).slice();
    if (data.loadError) problems.unshift(data.loadError);
    const warn = document.getElementById("scan-warn");
    warn.textContent = problems.join("；");
    warn.hidden = problems.length === 0;

    fillSpecFilter(data.specs || []);
  }

  // Spec 下拉：全部 + 每个规格（带 SN 条数）
  function fillSpecFilter(specs) {
    const select = document.getElementById("scan-filter-spec");
    const keep = select.value;
    select.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "全部";
    select.append(all);
    specs.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.spec;
      option.textContent = item.spec + "（" + item.snCount + "）";
      select.append(option);
    });
    select.value = keep && specs.some((item) => item.spec === keep) ? keep : "";
    document.getElementById("scan-filter").hidden = specs.length === 0;
    fillPnFilter(select.value, true);
  }

  // PN 下拉只列当前 Spec 下的；Spec 选「全部」时列出所有 PN
  async function fillPnFilter(spec, refreshDetail) {
    const select = document.getElementById("scan-filter-pn");
    const keep = select.value;
    select.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "全部";
    select.append(all);
    try {
      const response = await fetch(
        HOST + "/catalog/list?spec=" + encodeURIComponent(spec || "") + "&level=pn", { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        (data.items || []).forEach((item) => {
          const option = document.createElement("option");
          option.value = item.pn;
          option.textContent = item.pn + "（" + item.count + "）";
          select.append(option);
        });
      }
    } catch (err) {
      /* 拉不到就只剩「全部」，明细照旧能列 */
    }
    const stillThere = Array.prototype.some.call(select.options, (option) => option.value === keep);
    select.value = keep && stillThere ? keep : "";
    if (refreshDetail) onFilterChange();
  }

  async function onSpecChange() {
    await fillPnFilter(document.getElementById("scan-filter-spec").value, false);
    onFilterChange();
  }

  function onFilterChange() {
    detail.spec = document.getElementById("scan-filter-spec").value;
    detail.pn = document.getElementById("scan-filter-pn").value;
    detail.offset = 0;
    loadDetail();
  }

  async function loadDetail() {
    const box = document.getElementById("scan-detail");
    const body = document.getElementById("scan-detail-body");
    try {
      const query = "?spec=" + encodeURIComponent(detail.spec)
        + "&pn=" + encodeURIComponent(detail.pn)
        + "&offset=" + detail.offset + "&limit=" + detail.limit;
      const response = await fetch(HOST + "/catalog/list" + query, { cache: "no-store" });
      if (!response.ok) throw new Error("读取失败");
      const data = await response.json();
      detail.total = data.total || 0;
      const scope = detail.pn || detail.spec || "全部";
      document.getElementById("scan-detail-title").textContent = scope + " 共 " + detail.total + " 个";
      body.innerHTML = "";
      (data.items || []).forEach((item) => {
        const tr = document.createElement("tr");
        [item.sn, item.pn, item.spec, item.path].forEach((value) => {
          const cell = document.createElement("td");
          cell.textContent = value || "—";
          tr.append(cell);
        });
        const action = document.createElement("td");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "linkish";
        button.textContent = "打开";
        button.addEventListener("click", () => openFolder(item.path));
        action.append(button);
        tr.append(action);
        body.append(tr);
      });
      renderPager();
      box.hidden = false;
    } catch (err) {
      Nav.toast("明细没读出来");
    }
  }

  function renderPager() {
    const pager = document.getElementById("scan-detail-pager");
    pager.innerHTML = "";
    if (!detail.total) return;
    const from = detail.offset + 1;
    const to = Math.min(detail.offset + detail.limit, detail.total);
    const label = document.createElement("span");
    label.textContent = from + "–" + to + " / " + detail.total;
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "linkish";
    prev.textContent = "上一页";
    prev.disabled = detail.offset <= 0;
    prev.addEventListener("click", () => {
      detail.offset = Math.max(0, detail.offset - detail.limit);
      loadDetail();
    });
    const next = document.createElement("button");
    next.type = "button";
    next.className = "linkish";
    next.textContent = "下一页";
    next.disabled = detail.offset + detail.limit >= detail.total;
    next.addEventListener("click", () => {
      detail.offset += detail.limit;
      loadDetail();
    });
    pager.append(label, prev, next);
  }
})();
