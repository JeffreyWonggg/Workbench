(function () {
  const BASE = "http://127.0.0.1:47321/";
  const HOST = BASE + "update-version-ini";
  const PUBLISH = BASE + "publish";
  const CONFIG = BASE + "config";
  const PICK = BASE + "pick-file";
  const DISPLAY_LIMIT = 60;
  const BROWSE_HINT = "打开 Windows 文件对话框选择，选完自动回填；也可以直接粘贴完整路径";

  let projects = [];
  let dirty = false;
  let configInfo = null;
  // 发布流水记在 meta.json 的 git.releases（代码页打标签时写入）。
  // 这个页面不强制要求数据文件夹，读不到就当没有，不影响发布本身。
  let releases = [];
  // 从代码页带着 ?section= 跳过来时，用来展开并定位到对应项目
  let wantedSection = "";
  // 默认折叠；这里只记「被手动展开过」的项目，重新渲染（甚至重新读盘）后仍保持展开
  const expanded = new Set();

  // 用节名做键，这样保存后重新读盘也不会丢状态；还没填节名的新项目用对象本身当键
  function cardKey(project) {
    return project.section ? "s:" + project.section : project;
  }

  function copyCountText(project) {
    const count = (project.copies || []).length;
    return count > 0 ? count + " 个复制项" : "没有复制项";
  }

  Nav.boot("version", async () => {
    document.getElementById("version-add").addEventListener("click", () => {
      const created = blankProject();
      projects.push(created);
      // 新建的项目是要马上填内容的，自动展开
      expanded.add(cardKey(created));
      dirty = true;
      render();
    });
    document.getElementById("version-save").addEventListener("click", save);
    document.getElementById("version-preview").addEventListener("click", () => runPublish("", true));
    document.getElementById("version-publish").addEventListener("click", () => runPublish("", false));
    document.getElementById("publish-close").addEventListener("click", () => {
      const dialog = document.getElementById("publish-dialog");
      if (dialog.open) dialog.close();
    });

    document.getElementById("config-edit").addEventListener("click", openConfigDialog);
    document.getElementById("config-cancel").addEventListener("click", closeConfigDialog);
    document.getElementById("config-form").addEventListener("submit", saveConfig);
    document.getElementById("config-browse").addEventListener("click", pickFile);
    document.getElementById("config-browse-inline").addEventListener("click", browseInPage);
    document.getElementById("config-open-folder").addEventListener("click", openIniFolder);

    window.addEventListener("beforeunload", (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
    await loadConfig();
    wantedSection = (new URLSearchParams(location.search).get("section") || "").trim();
    await load();
  }, { optionalFolder: true });

  async function loadConfig() {
    try {
      const response = await fetch(CONFIG, { cache: "no-store" });
      if (!response.ok) throw new Error("config failed");
      configInfo = await response.json();
    } catch (err) {
      configInfo = null;
    }
  }

  function blankProject() {
    return { section: "", name: "", mimsConfigPath: "", copies: [{ source: "", target: "" }] };
  }

  async function load() {
    try {
      const response = await fetch(HOST, { cache: "no-store" });
      if (!response.ok) throw new Error("load failed");
      const data = await response.json();
      projects = Array.isArray(data.projects) ? data.projects : [];
      dirty = false;
      loadReleases();
      render();
      focusWanted();
    } catch (err) {
      Nav.toast("没有读到配置。请先双击「打开工作台」再试");
    }
  }

  function loadReleases() {
    try {
      releases = Workbench.gitConfig().releases || [];
    } catch (err) {
      releases = [];
    }
  }

  // 从代码页跳过来（?section=项目名/节名）时展开并高亮对应项目
  function focusWanted() {
    const wanted = wantedSection;
    wantedSection = "";
    if (!wanted) return;
    const target = wanted.toLowerCase();
    const project = projects.find((item) => (item.section || "").trim().toLowerCase() === target)
      || projects.find((item) => (item.name || "").trim().toLowerCase() === target);
    if (!project) {
      Nav.toast("「" + wanted + "」在项目列表里没有对应项，已列出全部");
      return;
    }
    expanded.add(cardKey(project));
    render();
    const index = projects.indexOf(project);
    const card = document.querySelectorAll("#version-list .version-card")[index];
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    card.classList.add("is-focus");
    setTimeout(() => card.classList.remove("is-focus"), 2000);
  }

  /* ===== 与「代码」页的联动 ===== */

  // 版本页的节名 / 名称 与代码页仓库绑定的项目名对上，就认为是一条线上的
  function releasesFor(project) {
    const names = [(project.section || "").trim().toLowerCase(), (project.name || "").trim().toLowerCase()]
      .filter(Boolean);
    if (!names.length) return [];
    return releases.filter((item) => names.indexOf(String(item.project || "").trim().toLowerCase()) >= 0);
  }

  function releaseSummary(project) {
    const list = releasesFor(project);
    if (!list.length) return "";
    const first = list[0];
    return (first.tag || "") + (first.at ? " · " + formatWhenShort(first.at) : "");
  }

  function formatWhenShort(iso) {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    const diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 3600) return Math.max(1, Math.floor(diff / 60)) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + " 天前";
    return (date.getMonth() + 1) + "月" + date.getDate() + "日";
  }

  function renderPathLine() {
    const pathEl = document.getElementById("version-ini-path");
    const warn = document.getElementById("version-ini-missing");
    const openBtn = document.getElementById("config-open-folder");
    if (!configInfo) {
      pathEl.textContent = "没有连上本地服务。请先双击「打开工作台」再试";
      warn.hidden = true;
      openBtn.hidden = true;
      syncPublishButtons(false);
      return;
    }
    pathEl.textContent = configInfo.configured ? configInfo.iniPath : "（还没有指定）";
    if (!configInfo.configured) {
      warn.textContent = "点右边「更改…」选择文件";
      warn.hidden = false;
    } else if (!configInfo.iniExists) {
      warn.textContent = "文件还不存在，保存时会创建";
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
    openBtn.hidden = !(configInfo.configured && configInfo.iniExists);
    syncPublishButtons(false);
  }

  /* ===== 配置文件位置 ===== */

  function setConfigError(message) {
    const el = document.getElementById("config-error");
    el.textContent = message || "";
    el.hidden = !message;
  }

  function openConfigDialog() {
    if (!configInfo) {
      Nav.toast("没有连上本地服务。请先双击「打开工作台」再试");
      return;
    }
    const values = configInfo.values || {};
    document.getElementById("config-ini").value = values.updateVersionIni || "";
    setConfigError("");
    document.getElementById("config-dialog").showModal();
    document.getElementById("config-ini").focus();
  }

  function closeConfigDialog() {
    const dialog = document.getElementById("config-dialog");
    if (dialog.open) dialog.close();
  }

  /* ===== 选择配置文件 ===== */

  // 首选：由本地服务弹出 Windows 原生文件对话框，选完把绝对路径回传
  async function pickFile() {
    const button = document.getElementById("config-browse");
    const hint = document.getElementById("config-browse-hint");
    const current = document.getElementById("config-ini").value.trim();
    button.disabled = true;
    button.textContent = "等待选择…";
    hint.textContent = "已打开 Windows 文件对话框，请在那里选择文件";
    try {
      const response = await fetch(PICK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: current })
      });
      if (!response.ok) throw new Error("pick failed");
      const data = await response.json();
      if (!data.ok) {
        Nav.toast(data.error || "没有打开文件对话框");
      } else if (!data.cancelled && data.path) {
        document.getElementById("config-ini").value = data.path;
      }
    } catch (err) {
      Nav.toast("没有连上本地服务。请先双击「打开工作台」再试");
    } finally {
      button.disabled = false;
      button.textContent = "浏览…";
      hint.textContent = BROWSE_HINT;
    }
  }

  // 备用：原生对话框弹不出来时，改用公共的页面内选择器（与「代码」页共用一份实现）
  async function browseInPage() {
    const current = document.getElementById("config-ini").value.trim();
    const dir = current.replace(/[\\/][^\\/]*$/, "");
    const usable = /^[A-Za-z]:[\\/]/.test(dir) || dir.indexOf("\\\\") === 0;
    const picked = await Nav.pickPath({
      mode: "file",
      extensions: [".ini"],
      start: usable ? dir : "",
      title: "选择 UpdateVersion.ini",
      hint: "点 .ini 文件即可选中；也可以把完整路径粘贴到输入框再点「用这个路径」。"
    });
    if (!picked) return;
    document.getElementById("config-ini").value = picked;
    document.getElementById("config-ini").focus();
  }

  async function postConfig(payload, okText) {
    try {
      const response = await fetch(CONFIG, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const reason = await response.text();
        throw new Error(reason || "保存失败");
      }
      configInfo = await response.json();
      closeConfigDialog();
      renderPathLine();
      Nav.toast(okText);
      await load();
    } catch (err) {
      setConfigError(err && err.message ? err.message : "保存失败");
    }
  }

  // 这个界面只管 UpdateVersion.ini。两个 exe 路径若在配置文件里手写过，
  // 这里原样带回去，避免保存时把它们清空。
  function configPayload(iniValue) {
    const values = (configInfo && configInfo.values) || {};
    return {
      updateVersionIni: iniValue,
      updateVersionExe: values.updateVersionExe || "",
      templateToolExe: values.templateToolExe || ""
    };
  }

  function saveConfig(event) {
    event.preventDefault();
    postConfig(configPayload(document.getElementById("config-ini").value.trim()), "已更新配置文件位置");
  }

  async function openIniFolder() {
    if (!configInfo || !configInfo.iniPath) return;
    const dir = configInfo.iniPath.replace(/[\\/][^\\/]*$/, "");
    if (!dir) return;
    try {
      const response = await fetch(BASE + "open", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: dir
      });
      if (!response.ok) throw new Error("open failed");
    } catch (err) {
      Nav.toast("没有打开。请先双击「打开工作台」再试");
    }
  }

  function render() {
    renderPathLine();
    const list = document.getElementById("version-list");
    list.replaceChildren();
    if (!configInfo || !configInfo.configured) {
      const empty = document.createElement("div");
      empty.className = "empty card";
      empty.textContent = "还没有指定 UpdateVersion.ini 的位置。点右上角「更改…」选择文件。";
      list.append(empty);
      return;
    }
    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "empty card";
      empty.textContent = "还没有项目。";
      list.append(empty);
      return;
    }
    projects.forEach((project, index) => list.append(projectCard(project, index)));
  }

  function projectCard(project, index) {
    let key = cardKey(project);
    const card = document.createElement("details");
    card.className = "card version-card";
    card.open = expanded.has(key);
    card.addEventListener("toggle", () => {
      if (card.open) expanded.add(key);
      else expanded.delete(key);
    });

    const head = document.createElement("summary");
    const titleBox = document.createElement("div");
    titleBox.className = "version-card-head";
    const title = document.createElement("h2");
    title.textContent = project.name || project.section || "新项目";
    const sectionTag = document.createElement("span");
    sectionTag.className = "version-card-section";
    sectionTag.textContent = project.name && project.section ? project.section : "";
    const countTag = document.createElement("span");
    countTag.className = "version-card-count";
    countTag.textContent = copyCountText(project);
    // 最近发的版本（来自「代码」页打标签时记的流水）
    const releaseTag = document.createElement("span");
    releaseTag.className = "version-card-release";
    releaseTag.textContent = releaseSummary(project);
    releaseTag.hidden = !releaseTag.textContent;
    titleBox.append(Nav.icon("chevron", "version-chevron"), title, sectionTag, countTag, releaseTag);

    const actions = document.createElement("div");
    actions.className = "version-card-actions";
    actions.append(
      plainButton("预览", () => runPublish(project.section, true)),
      plainButton("发布", () => runPublish(project.section, false))
    );

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn danger";
    remove.title = "删除项目";
    remove.setAttribute("aria-label", "删除项目");
    remove.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-trash"></use></svg>';
    remove.addEventListener("click", () => {
      projects.splice(index, 1);
      dirty = true;
      render();
    });
    actions.append(remove);
    // summary 里的按钮不要连带触发折叠
    actions.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    head.append(titleBox, actions);

    const fields = document.createElement("div");
    fields.className = "version-fields";
    fields.append(
      ...labeled("节名", textInput(project.section, (value) => {
        project.section = value;
        dirty = true;
        title.textContent = project.name || value || "新项目";
        sectionTag.textContent = project.name ? value : "";
        // 节名变了，展开状态跟着搬到新键上
        const nextKey = cardKey(project);
        if (nextKey !== key) {
          if (expanded.has(key)) expanded.add(nextKey);
          expanded.delete(key);
          key = nextKey;
        }
      })),
      ...labeled("名称", textInput(project.name, (value) => {
        project.name = value;
        dirty = true;
        title.textContent = value || project.section || "新项目";
        sectionTag.textContent = value ? project.section : "";
      })),
      ...labeled("Mims 配置", textInput(project.mimsConfigPath || "", (value) => { project.mimsConfigPath = value; dirty = true; }))
    );

    const table = document.createElement("table");
    table.className = "version-copies";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["源文件", "目标", ""].forEach((label) => {
      const cell = document.createElement("th");
      cell.textContent = label;
      headRow.append(cell);
    });
    thead.append(headRow);
    const tbody = document.createElement("tbody");
    (project.copies || []).forEach((copy, copyIndex) => tbody.append(copyRow(project, copy, copyIndex)));
    table.append(thead, tbody);

    const addCopy = document.createElement("button");
    addCopy.type = "button";
    addCopy.className = "btn";
    addCopy.textContent = "添加复制项";
    addCopy.addEventListener("click", () => {
      project.copies.push({ source: "", target: "" });
      dirty = true;
      render();
    });

    // 发布记录 + 直连代码页：两页各自独立，但这里给出明确的路口
    const releaseBox = document.createElement("div");
    releaseBox.className = "version-release";
    const list = releasesFor(project);
    const releaseText = document.createElement("span");
    releaseText.textContent = list.length
      ? "最近发布：" + list.slice(0, 3).map((item) => item.tag + (item.commit ? " " + item.commit : "")).join("、")
      : "还没有发布记录。在「代码」页打标签时会自动记一条。";
    const codeLink = document.createElement("a");
    codeLink.className = "linkish";
    codeLink.textContent = "去代码页";
    codeLink.href = "code.html?project=" + encodeURIComponent((project.name || project.section || "").trim());
    releaseBox.append(releaseText, codeLink);

    const body = document.createElement("div");
    body.className = "version-card-body";
    body.append(releaseBox, fields, table, addCopy);
    card.append(head, body);
    return card;
  }

  function plainButton(label, onclick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.textContent = label;
    button.addEventListener("click", onclick);
    return button;
  }

  function labeled(label, input) {
    const name = document.createElement("span");
    name.textContent = label;
    return [name, input];
  }

  function textInput(value, onInput) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value || "";
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  function copyRow(project, copy, copyIndex) {
    const row = document.createElement("tr");
    const source = document.createElement("td");
    const target = document.createElement("td");
    const action = document.createElement("td");
    source.append(textInput(copy.source, (value) => { copy.source = value; dirty = true; }));
    target.append(textInput(copy.target, (value) => { copy.target = value; dirty = true; }));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn danger";
    remove.title = "删除复制项";
    remove.setAttribute("aria-label", "删除复制项");
    remove.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-trash"></use></svg>';
    remove.addEventListener("click", () => {
      project.copies.splice(copyIndex, 1);
      dirty = true;
      render();
    });
    action.append(remove);
    row.append(source, target, action);
    return row;
  }

  function collectError() {
    const seen = new Set();
    for (const project of projects) {
      const section = (project.section || "").trim();
      if (!section || /[\[\]=\r\n]/.test(section)) return "节名不能为空，也不能包含方括号或等号";
      if (seen.has(section)) return "节名重复：" + section;
      seen.add(section);
      const copies = (project.copies || []).map((copy) => ({
        source: (copy.source || "").trim(),
        target: (copy.target || "").trim()
      })).filter((copy) => copy.source || copy.target);
      if (!copies.length) return (project.name || section) + " 还没有复制项";
      if (copies.some((copy) => !copy.source || !copy.target)) return (project.name || section) + " 有未填完的源文件或目标";
    }
    return "";
  }

  async function save() {
    if (!projects.length) {
      Nav.toast("没有项目，没有写入文件");
      return false;
    }
    const error = collectError();
    if (error) {
      Nav.toast(error);
      return false;
    }
    const button = document.getElementById("version-save");
    button.disabled = true;
    try {
      const response = await fetch(HOST, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects })
      });
      if (!response.ok) throw new Error("save failed");
      dirty = false;
      Nav.toast("已保存");
      await load();
      return true;
    } catch (err) {
      Nav.toast("没有保存。请先双击「打开工作台」再试");
      return false;
    } finally {
      button.disabled = false;
    }
  }

  /* ===== 发布（内置，不再调用外部 exe） ===== */

  async function runPublish(section, dryRun) {
    const target = (section || "").trim();
    if (section !== "" && !target) {
      Nav.toast("先填节名并保存，再发布这一项");
      return;
    }
    // 发布读的是磁盘上的 ini，有未保存的改动先落盘
    if (dirty) {
      if (!(await Nav.ask({
        title: "有未保存的修改",
        text: "发布用的是磁盘上的配置。先保存再发布？",
        okText: "保存并发布"
      }))) return;
      if (!(await save())) return;
    }
    setPublishBusy(true);
    try {
      const payload = { dryRun: !!dryRun };
      if (target) payload.section = target;
      const response = await fetch(PUBLISH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error("publish failed");
      showReport(await response.json(), dryRun);
    } catch (err) {
      Nav.toast("没有连上本地服务。请先双击「打开工作台」再试");
    } finally {
      setPublishBusy(false);
    }
  }

  function syncPublishButtons(busy) {
    const ready = !!(configInfo && configInfo.configured);
    ["version-preview", "version-publish"].forEach((id) => {
      const button = document.getElementById(id);
      if (button) button.disabled = !!busy || !ready;
    });
  }

  function setPublishBusy(busy) {
    syncPublishButtons(busy);
  }

  function showReport(result, dryRun) {
    const dialog = document.getElementById("publish-dialog");
    document.getElementById("publish-title").textContent = dryRun ? "发布预览" : "发布结果";

    const summary = document.getElementById("publish-summary");
    const report = document.getElementById("publish-report");
    report.replaceChildren();

    if (!result.ok) {
      summary.textContent = result.error || "发布失败";
      dialog.showModal();
      return;
    }

    const totals = result.totals || {};
    if (result.aborted) {
      document.getElementById("publish-title").textContent = "发布已中断";
      summary.textContent = "已更新 " + (totals.updated || 0) + " 个文件 · 已是最新 " + (totals.skipped || 0) + " 个";

      const banner = document.createElement("div");
      banner.className = "publish-abort";
      const reason = document.createElement("strong");
      reason.textContent = "已中断：" + (result.error || "遇到错误");
      const where = document.createElement("span");
      where.textContent = (result.abortAt ? "位置：" + result.abortAt + "。" : "")
        + "中断前的改动已经生效（不会回滚），后面的复制项和项目都没有执行。";
      banner.append(reason, where);
      report.append(banner);
    } else {
      summary.textContent = [
        (dryRun ? "需要更新 " : "已更新 ") + (totals.updated || 0) + " 个文件",
        "已是最新 " + (totals.skipped || 0) + " 个",
        "失败 " + (totals.failed || 0) + " 个"
      ].join(" · ");
    }

    (result.projects || []).forEach((project) => report.append(projectBlock(project, dryRun)));

    if (result.truncated) {
      const more = document.createElement("div");
      more.className = "publish-more";
      more.textContent = "更新列表过长，只列出了前 200 项。";
      report.append(more);
    }
    if (!dryRun) appendTagHint(report, result);
    dialog.showModal();
  }

  // 发布完成只是半步：另一半是给仓库打标签。这里把人送到代码页。
  function appendTagHint(report, result) {
    const sections = (result.projects || []).map((item) => item.section).filter(Boolean);
    const hint = document.createElement("div");
    hint.className = "publish-tag-hint";
    const text = document.createElement("span");
    text.textContent = "发布完成。要留版本标记的话，去「代码」页给仓库打个标签，会自动记进发布流水。";
    const link = document.createElement("a");
    link.className = "btn";
    link.textContent = "去代码页";
    link.href = sections.length === 1
      ? "code.html?project=" + encodeURIComponent(sections[0])
      : "code.html";
    hint.append(text, link);
    report.append(hint);
  }

  function projectBlock(project, dryRun) {
    const box = document.createElement("div");
    box.className = "publish-project";

    const head = document.createElement("div");
    head.className = "publish-project-head";
    const title = document.createElement("strong");
    title.textContent = project.name ? project.name + " · " + project.section : project.section;
    const failed = (project.items || []).some((item) => item.status === "error") || !!project.error;
    const tag = document.createElement("span");
    tag.className = "publish-tag " + (failed ? "bad" : (project.changed ? "warn" : "ok"));
    tag.textContent = failed ? "有失败" : (project.changed ? (dryRun ? "需更新" : "已更新") : "已最新");
    head.append(title, tag);
    box.append(head);

    const items = project.items || [];
    items.slice(0, DISPLAY_LIMIT).forEach((item) => {
      const line = document.createElement("div");
      line.className = "publish-line";
      const status = document.createElement("span");
      status.className = "publish-status " + item.status;
      status.textContent = item.status === "copy" ? (dryRun ? "待复制" : "已复制") : (item.status === "skip" ? "跳过" : "失败");
      const text = document.createElement("span");
      text.className = "publish-detail";
      text.textContent = item.error
        ? item.source + " → " + item.target + "：" + item.error
        : item.detail;
      line.append(status, text);
      box.append(line);
      if (!item.error) {
        const path = document.createElement("div");
        path.className = "publish-path";
        path.textContent = item.source + "  →  " + item.target;
        box.append(path);
      }
    });

    if (items.length > DISPLAY_LIMIT) {
      const more = document.createElement("div");
      more.className = "publish-more";
      more.textContent = "还有 " + (items.length - DISPLAY_LIMIT) + " 项未列出";
      box.append(more);
    }

    if (project.oldVersion) {
      const line = document.createElement("div");
      line.className = "publish-line";
      const status = document.createElement("span");
      status.className = "publish-status copy";
      status.textContent = "版本号";
      const text = document.createElement("span");
      text.className = "publish-detail";
      text.textContent = project.oldVersion + " → " + project.newVersion + (dryRun ? "（预览）" : "");
      line.append(status, text);
      box.append(line);
    }
    if (project.error) {
      const line = document.createElement("div");
      line.className = "publish-line";
      const status = document.createElement("span");
      status.className = "publish-status error";
      status.textContent = "失败";
      const text = document.createElement("span");
      text.className = "publish-detail";
      text.textContent = project.error;
      line.append(status, text);
      box.append(line);
    }
    if (project.note) {
      const note = document.createElement("div");
      note.className = "publish-more";
      note.textContent = project.note;
      box.append(note);
    }
    return box;
  }
})();
