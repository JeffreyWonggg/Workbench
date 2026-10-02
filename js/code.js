(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const TABS = ["changes", "log", "branches", "tags", "software"];

  const state = {
    repos: [],
    status: new Map(),
    current: "",
    tab: "changes",
    pendingTab: "",
    pendingSoftware: "",
    selected: new Set(),
    log: { skip: 0, limit: 15, items: [], hasMore: false },
    software: [],
    softwareSearch: "",
    showDeleted: false,
    editing: "",
    busy: false,
    projectFilter: "",
    changesPage: 1
  };

  // 改动列表每页条数（和历史列表保持一致）
  const CHANGE_PAGE_SIZE = 15;

  // 危险操作的确认文案：写清楚会发生什么
  const OP_META = {
    fetch: { label: "获取远端更新", command: "git fetch --all --prune" },
    pull: { label: "拉取远端更新", command: "git pull --ff-only" },
    push: { label: "推送当前分支", command: "git push" },
    "push-upstream": { label: "首次推送（顺带建立上游跟踪）", command: "git push --set-upstream origin HEAD" },
    "push-force": { label: "强制推送", command: "git push --force-with-lease", danger: true },
    "stage-all": { label: "暂存全部改动", command: "git add -A" },
    "stage-paths": { label: "暂存所选文件", command: "git add -- <文件>" },
    "unstage-all": { label: "取消全部暂存", command: "git reset HEAD --" },
    "unstage-paths": { label: "取消所选暂存", command: "git reset HEAD -- <文件>" },
    discard: { label: "放弃所选文件的改动", command: "git checkout -- <文件>", danger: true },
    commit: { label: "提交已暂存的改动", command: "git commit -F <说明文件>" },
    "commit-amend": { label: "用当前暂存内容改写上一条提交", command: "git commit --amend -F <说明文件>", danger: true },
    "commit-amend-keep": { label: "用当前暂存内容改写上一条提交（保留原说明）", command: "git commit --amend --no-edit", danger: true },
    checkout: { label: "切换分支", command: "git checkout <分支>" },
    "branch-new": { label: "新建并切换分支", command: "git checkout -b <分支>" },
    "branch-delete": { label: "删除本地分支", command: "git branch -d <分支>", danger: true },
    "tag-create": { label: "新建标签", command: "git tag -a <标签> -F <说明文件>" },
    "tag-delete": { label: "删除标签", command: "git tag -d <标签>", danger: true },
    "tag-push": { label: "推送标签到远端", command: "git push origin <标签>" },
    "reset-hard": { label: "硬回滚", command: "git reset --hard <提交>", danger: true },
    revert: { label: "反向提交", command: "git revert --no-edit <提交>" },
    stash: { label: "搁置当前改动", command: "git stash push --include-untracked" },
    "stash-pop": { label: "取回最近一次搁置", command: "git stash pop" }
  };

  Nav.boot("code", async () => {
    bind();
    await loadConfig();
    applyDeepLink();
    await refreshStatus(false);
    if (!state.current) {
      const first = visibleRepos()[0] || state.repos[0];
      if (first) selectRepo(first.path);
    }
    await renderSoftware();
    applyPendingSoftware();
    syncNotice();
  });

  // 支持从版本页 / 项目主页跳进来：?repo=<仓库路径> 或 ?project=<项目名>
  function applyDeepLink() {
    const params = new URLSearchParams(location.search);
    const repo = (params.get("repo") || "").trim();
    const project = (params.get("project") || "").trim();
    const tab = (params.get("tab") || "").trim();
    if (TABS.indexOf(tab) >= 0) state.pendingTab = tab;
    state.pendingSoftware = (params.get("software") || "").trim();
    if (project) state.projectFilter = project;
    if (!repo) return;
    const hit = state.repos.find((item) => item.path.toLowerCase() === repo.toLowerCase());
    if (!hit) {
      Nav.toast("没有找到仓库 " + repo);
      return;
    }
    state.current = hit.path;
    // 已经指定了具体仓库，就不必再按项目筛一层
    if (state.projectFilter && hit.project === state.projectFilter) state.projectFilter = "";
  }

  // 项目页点某条软件号进来：打开软件号页签，并直接弹出这条的编辑框（里面有删除）
  function applyPendingSoftware() {
    if (state.pendingSoftware) {
      showTab("software");
      const item = state.software.find((entry) => entry.id === state.pendingSoftware && !Workbench.isDeleted(entry));
      if (item) openSoftware(item.id);
      return;
    }
    if (state.pendingTab) showTab(state.pendingTab);
  }

  function visibleRepos() {
    if (!state.projectFilter) return state.repos;
    const filtered = state.repos.filter((repo) => repo.project === state.projectFilter);
    return filtered.length ? filtered : state.repos;
  }

  // 悬停提示：把"点下去会执行什么命令"写在按钮上（用原生 title，零依赖）。
  // 固定动作按 OP_META 取命令；带参数的动作在创建按钮时传入具体命令。
  function commandHint(op) {
    const meta = OP_META[op] || {};
    return meta.command ? "将执行：" + meta.command : "";
  }

  // 页面上固定按钮 → 动作 的对应表
  const STATIC_HINTS = {
    "repo-fetch": "fetch",
    "repo-pull": "pull",
    "stage-all": "stage-all",
    "stage-selected": "stage-paths",
    "unstage-selected": "unstage-paths",
    "discard-selected": "discard",
    "commit": "commit",
    "commit-amend": "commit-amend",
    "stash": "stash",
    "stash-pop": "stash-pop",
    "create-branch": "branch-new",
    "create-tag": "tag-create"
  };

  function applyStaticHints() {
    Object.keys(STATIC_HINTS).forEach((id) => {
      const el = $(id);
      if (!el) return;
      const hint = commandHint(STATIC_HINTS[id]);
      if (hint) el.title = hint;
    });
  }

  function bind() {
    $("code-refresh").addEventListener("click", () => refreshAll(true));
    $("code-scan").addEventListener("click", scanRepos);
    $("code-roots").addEventListener("click", openRoots);
    $("repo-search").addEventListener("input", renderRepos);
    $("repo-project").addEventListener("change", bindProject);

    $("code-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-tab]");
      if (!button) return;
      showTab(button.dataset.tab);
    });

    $("select-all").addEventListener("change", () => {
      const status = currentStatus();
      state.selected.clear();
      if ($("select-all").checked && status) {
        (status.files || []).forEach((file) => state.selected.add(file.path));
      }
      renderChanges();
    });

    $("stage-selected").addEventListener("click", () => runPathsOp("stage-paths", "已暂存所选文件"));
    $("unstage-selected").addEventListener("click", () => runPathsOp("unstage-paths", "已取消暂存"));
    $("stage-all").addEventListener("click", () => runOp("stage-all", {}, { done: "已暂存全部改动" }));
    $("discard-selected").addEventListener("click", () => {
      if (!state.selected.size) return Nav.toast("先勾选要放弃的文件");
      runPathsOp("discard", "已放弃改动", {
        title: "放弃改动",
        text: "选中的 " + state.selected.size + " 个文件会回到上一次提交的状态，未提交的修改会丢失且无法找回。",
        danger: true
      });
    });
    $("commit").addEventListener("click", () => doCommit(false));
    $("commit-amend").addEventListener("click", () => doCommit(true));
    $("stash").addEventListener("click", () => runOp("stash", {}, { done: "已搁置改动" }));
    $("stash-pop").addEventListener("click", () => runOp("stash-pop", {}, { done: "已取回搁置" }));

    $("log-more").addEventListener("click", () => loadLog(false));

    $("repo-remote").addEventListener("click", openRemote);
    $("remote-cancel").addEventListener("click", () => $("remote-dialog").close());
    $("remote-form").addEventListener("submit", saveRemote);

    $("repo-fetch").addEventListener("click", () => runOp("fetch", {}, { done: "已获取远端更新" }));
    $("repo-pull").addEventListener("click", () => runOp("pull", {}, { done: "已拉取" }));
    // 首次推送要顺带建立上游（git push 在无上游时会直接拒绝）
    $("repo-push").addEventListener("click", () => {
      const status = currentStatus();
      // 一个提交都没有时，git 会说 "src refspec HEAD does not match any"，
      // 那句话对不上用户的直觉（他只是想推送），所以在这里先拦住并说清楚
      if (status && status.empty) {
        Nav.toast("仓库还没有任何提交，先把文件暂存并提交，再推送", {
          label: "去暂存",
          onSelect: () => showTab("changes")
        });
        return null;
      }
      const first = !status || !status.upstream;
      if (first) {
        return runOp("push-upstream", {}, {
          done: "已首次推送，并建立了上游跟踪",
          confirm: true,
          title: "首次推送",
          text: "这条分支还没有上游跟踪，会用「git push --set-upstream origin HEAD」把它推到 origin 并建立跟踪。",
          danger: false
        });
      }
      return runOp("push", {}, { done: "已推送" });
    });
    $("repo-push").addEventListener("contextmenu", (event) => {
      // 右键走强制推送，少一个按钮但不缺能力；危险操作必须二次确认
      event.preventDefault();
      runOp("push-force", {}, {
        done: "已强制推送",
        confirm: true,
        title: "强制推送",
        text: "会用本地分支覆盖远端（--force-with-lease：远端有别人新提交时仍会被拒绝）。",
        danger: true
      });
    });

    $("create-branch").addEventListener("click", () => {
      const name = $("new-branch").value.trim();
      if (!name) return Nav.toast("先填分支名");
      runOp("branch-new", { name }, { done: "已切到 " + name });
      $("new-branch").value = "";
    });
    $("create-tag").addEventListener("click", async () => {
      const name = $("new-tag").value.trim();
      if (!name) return Nav.toast("先填标签名");
      const message = $("new-tag-message").value.trim() || name;
      const result = await runOp("tag-create", { name, message }, { done: "已打标签 " + name });
      if (!result || !result.ok) return;
      $("new-tag").value = "";
      $("new-tag-message").value = "";
      await recordRelease(name);
    });

    $("diff-close").addEventListener("click", () => {
      $("diff-view").hidden = true;
    });

    $("software-search").addEventListener("input", () => {
      state.softwareSearch = $("software-search").value.trim().toLowerCase();
      renderSoftwareList();
    });
    $("software-add").addEventListener("click", () => openSoftware(""));
    $("software-deleted").addEventListener("click", () => {
      state.showDeleted = !state.showDeleted;
      renderSoftwareList();
    });
    $("software-form").addEventListener("submit", saveSoftware);
    $("software-cancel").addEventListener("click", () => $("software-dialog").close());
    $("software-delete").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      deleteSoftware();
    });

    $("roots-close").addEventListener("click", () => $("roots-dialog").close());
    $("root-add").addEventListener("click", addRoot);
    $("root-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-root]");
      if (button) removeRoot(button.dataset.removeRoot);
    });

    $("confirm-cancel").addEventListener("click", () => $("confirm-dialog").close());

    applyStaticHints();
  }

  /* ===== 仓库与状态 ===== */

  async function loadConfig() {
    const config = Workbench.gitConfig();
    state.repos = config.repos.slice();
    if (config.roots.length === 0) {
      // 第一次用：先让用户选目录
      return;
    }
    if (state.repos.length === 0) {
      await scanRepos(true);
    }
  }

  // quiet 为真时扫描失败不打扰用户（首次进入自动扫描用）
  async function scanRepos(quiet) {
    const config = Workbench.gitConfig();
    if (config.roots.length === 0 && !quiet) {
      Nav.toast("先设置代码目录");
      openRoots();
      return;
    }
    if (config.roots.length === 0) return;
    setBusy(true);
    const result = await GitApi.scan();
    setBusy(false);
    if (!result || !result.ok) {
      notice("扫描失败：" + GitApi.errorText(result));
      return;
    }
    const found = new Map((result.repos || []).map((item) => [String(item.path).toLowerCase(), item]));

    // 之前只增不删：本地删掉的仓库会永远留在列表里显示"无法读取"。
    // 对扫描没找到的登记仓库，逐个确认目录是否真的没了才移出；
    // 目录还在的（比如被扫描规则跳过）保留不动，绝不误删。
    let removed = 0;
    const bindings = new Map();
    if (!result.truncated) {
      const missing = state.repos.filter((repo) => !found.has(repo.path.toLowerCase()));
      for (const repo of missing) {
        if (!(await directoryMissing(repo.path))) continue;
        if (repo.project) bindings.set(repo.path.toLowerCase(), repo.project);
        state.repos = state.repos.filter((item) => item !== repo);
        removed += 1;
      }
    }

    const known = new Map(state.repos.map((repo) => [repo.path.toLowerCase(), repo]));
    let added = 0;
    found.forEach((item, key) => {
      if (known.has(key)) return;
      known.set(key, { path: item.path, name: item.name, project: bindings.get(key) || "" });
      added += 1;
    });
    state.repos = Array.from(known.values()).sort((a, b) => a.name.localeCompare(b.name, "zh"));
    await Workbench.saveGitConfig({ roots: config.roots, repos: state.repos });
    const parts = [];
    if (removed > 0) parts.push("清理了 " + removed + " 个已删除的仓库");
    if (added > 0) parts.push("发现 " + added + " 个新仓库");
    if (parts.length) notice(parts.join("，") + "，共 " + state.repos.length + " 个。");
    else if (result.truncated) notice("仓库太多，只取了前 200 个，没有做清理。");
    else if (!quiet) Nav.toast("没有变化");
    if (state.current && !state.repos.some((repo) => repo.path === state.current)) state.current = "";
    await refreshStatus(true);
  }

  // 目录真没了才返回 true。请求失败（服务没开、返回异常）一律按"还在"处理，宁可留着不误删。
  async function directoryMissing(path) {
    try {
      const response = await fetch("/fs/list?path=" + encodeURIComponent(path), { cache: "no-store" });
      if (!response.ok) return false;
      const data = await response.json();
      return !!data.error && String(data.error).indexOf("目录不存在") >= 0;
    } catch (err) {
      return false;
    }
  }

  async function refreshAll(force) {
    GitApi.invalidate();
    await refreshStatus(!!force);
    await reloadTab(true);
  }

  async function refreshStatus(force) {
    const paths = state.repos.map((repo) => repo.path);
    const map = new Map();
    if (paths.length === 0) {
      state.status = map;
      renderRepos();
      renderRepoHead();
      return;
    }
    const data = await GitApi.status(paths, { force: !!force });
    if (data && data.ok) {
      (data.repos || []).forEach((item) => map.set(String(item.path).toLowerCase(), item));
      (data.failed || []).forEach((item) => {
        map.set(String(item.path).toLowerCase(), {
          path: item.path,
          name: repoName(item.path),
          error: item.error,
          branch: "",
          files: [],
          staged: 0,
          unstaged: 0,
          ahead: 0,
          behind: 0,
          clean: true,
          last: null
        });
      });
    } else {
      notice("读取仓库状态失败：" + GitApi.errorText(data));
    }
    state.status = map;
    renderRepos();
    renderRepoHead();
    if (state.tab === "changes") renderChanges();
  }

  function repoName(path) {
    const parts = String(path).split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(path);
  }

  function currentStatus() {
    return state.current ? state.status.get(state.current.toLowerCase()) || null : null;
  }

  function renderRepos() {
    const list = $("repo-list");
    const keyword = $("repo-search").value.trim().toLowerCase();
    const pool = visibleRepos();
    const rows = pool.filter((repo) => {
      if (!keyword) return true;
      return repo.name.toLowerCase().includes(keyword) || repo.path.toLowerCase().includes(keyword);
    });
    list.innerHTML = "";
    renderRepoFilter(pool);
    $("repo-empty").hidden = state.repos.length > 0;

    rows.forEach((repo) => {
      const status = state.status.get(repo.path.toLowerCase());
      const row = document.createElement("button");
      row.type = "button";
      row.className = "repo-row" + (repo.path === state.current ? " on" : "");
      row.dataset.path = repo.path;

      const top = document.createElement("span");
      top.className = "repo-row-top";
      const name = document.createElement("strong");
      name.textContent = repo.name;
      top.append(name);
      if (status && !status.error) {
        const branch = document.createElement("span");
        branch.className = "repo-branch";
        branch.textContent = status.branch || "无提交";
        top.append(branch);
      }
      row.append(top);

      const meta = document.createElement("span");
      meta.className = "repo-row-meta";
      const dirty = status && !status.error ? (status.staged + status.unstaged) : 0;
      if (status && status.error) {
        meta.append(badge("无法读取", "warn"));
      } else if (status) {
        if (dirty > 0) meta.append(badge(dirty + " 处改动", "warn"));
        else meta.append(badge("干净", ""));
        if (status.ahead) meta.append(badge("↑" + status.ahead, ""));
        if (status.behind) meta.append(badge("↓" + status.behind, ""));
        if (status.last) {
          const time = document.createElement("span");
          time.className = "repo-time";
          time.textContent = relTime(status.last.at);
          meta.append(time);
        }
      } else {
        const time = document.createElement("span");
        time.className = "repo-time";
        time.textContent = "未加载";
        meta.append(time);
      }
      row.append(meta);

      if (repo.project) {
        const project = document.createElement("span");
        project.className = "repo-project";
        project.textContent = repo.project;
        row.append(project);
      }

      row.addEventListener("click", () => selectRepo(repo.path));
      list.append(row);
    });
  }

  // 深链带来的项目筛选：给一个看得见的出口
  function renderRepoFilter(pool) {
    const box = $("repo-filter");
    if (!box) return;
    box.innerHTML = "";
    if (!state.projectFilter) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const chip = document.createElement("span");
    chip.className = "repo-filter-chip";
    chip.textContent = "只看 " + state.projectFilter + " · " + pool.length + " 个";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "linkish";
    clear.textContent = "显示全部";
    clear.addEventListener("click", () => {
      state.projectFilter = "";
      renderRepos();
    });
    box.append(chip, clear);
  }

  function badge(text, tone) {
    const el = document.createElement("span");
    el.className = "repo-badge" + (tone ? " " + tone : "");
    el.textContent = text;
    return el;
  }

  function renderRepoHead() {
    const repo = state.repos.find((item) => item.path === state.current);
    const status = currentStatus();
    $("repo-name").textContent = repo ? repo.name : "未选择仓库";

    if (!repo) {
      $("repo-meta").textContent = state.repos.length ? "从左侧选一个仓库" : "还没有仓库";
    } else if (!status) {
      $("repo-meta").textContent = repo.path;
    } else if (status.error) {
      $("repo-meta").textContent = status.error;
    } else {
      const parts = [repo.path, status.branch ? "分支 " + status.branch : "（无提交）"];
      if (status.upstream) parts.push("跟踪 " + status.upstream);
      if (status.ahead) parts.push("领先 " + status.ahead);
      if (status.behind) parts.push("落后 " + status.behind);
      $("repo-meta").textContent = parts.join(" · ");
    }

    fillProjectSelect($("repo-project"), repo ? repo.project : "", "未绑定");

    // 直达「更新软件版本」的对应项目（按你的要求：这两个按钮不给悬停提示）
    const release = $("repo-release");
    if (release) {
      const section = repo ? (repo.project || repo.name) : "";
      release.hidden = !repo;
      release.href = "version.html?section=" + encodeURIComponent(section);
    }

    // 远端：没设置时按钮更醒目一点（同样不给悬停提示）
    const remote = $("repo-remote");
    if (remote) {
      const url = status && status.remoteUrl ? status.remoteUrl : "";
      remote.textContent = url ? "远端" : "设置远端";
      remote.classList.toggle("primary", !url && !!repo);
      remote.disabled = state.busy || !repo;
    }

    // 推送按钮的实际命令取决于有没有上游：首次推送要顺带建立上游
    const push = $("repo-push");
    if (push) {
      const first = !status || !status.upstream;
      push.title = first
        ? "将执行：git push --set-upstream origin HEAD（首次推送，顺带建立上游跟踪）"
        : "将执行：git push";
    }

    const disabled = state.busy || !repo;
    ["repo-fetch", "repo-pull", "repo-push"].forEach((id) => { $(id).disabled = disabled; });
  }

  /* ===== 远端 ===== */

  function openRemote() {
    const status = currentStatus();
    const url = status && status.remoteUrl ? status.remoteUrl : "";
    $("remote-url").value = url;
    setError("remote-error", "");
    $("remote-current").textContent = url
      ? "当前 origin：" + url + "（保存会替换为上面的地址）"
      : "当前还没有设置 origin。";
    $("remote-dialog").showModal();
    $("remote-url").focus();
  }

  async function saveRemote(event) {
    event.preventDefault();
    const url = $("remote-url").value.trim();
    if (!url) return setError("remote-error", "先填远端地址");
    const looksRemote = /^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/i.test(url)
      || /^[a-z]:[\\/]/i.test(url)                       // 本机路径：D:\repo.git
      || url.indexOf("\\\\") === 0;                      // 网络共享：\\server\share\repo.git
    if (!looksRemote) {
      return setError("remote-error", "填仓库地址（http(s)://、ssh://、git://、git@主机:路径），或本机/共享路径（如 D:\\repo.git）");
    }
    if (/["'\t\n\r]/.test(url)) return setError("remote-error", "地址里不能有引号或换行");

    $("remote-save").disabled = true;
    setBusy(true);
    const result = await GitApi.exec(state.current, "remote-set", { url });
    setBusy(false);
    $("remote-save").disabled = false;
    if (!result || !result.ok) {
      setError("remote-error", GitApi.errorText(result));
      return;
    }
    $("remote-dialog").close();
    Nav.toast("远端已" + (result.action === "add" ? "设置" : "更新") + "：" + url);
    await refreshAll(true);
  }

  function selectRepo(path) {
    if (state.current === path) return;
    state.current = path;
    state.selected.clear();
    state.changesPage = 1;
    state.log = { skip: 0, limit: 15, items: [], hasMore: false };
    $("diff-view").hidden = true;
    renderRepos();
    renderRepoHead();
    reloadTab(true);
  }

  function showTab(tab) {
    if (TABS.indexOf(tab) < 0) return;
    state.tab = tab;
    $("code-tabs").querySelectorAll("[data-tab]").forEach((button) => {
      const on = button.dataset.tab === tab;
      button.classList.toggle("on", on);
      button.setAttribute("aria-selected", on ? "true" : "false");
    });
    TABS.forEach((name) => { $("panel-" + name).hidden = name !== tab; });
    reloadTab(false);
  }

  async function reloadTab() {
    // 软件号不依赖当前仓库，列表在进入页面时已经画好，这里不要重读，
    // 否则深链刚打开编辑框时一次迟到的读取会把刚删掉的条目又画回来
    if (state.tab === "software") return;
    if (!state.current) {
      renderNoRepo();
      return;
    }
    if (state.tab === "changes") {
      renderChanges();
      return;
    }
    if (state.tab === "log") {
      await loadLog(true);
      return;
    }
    if (state.tab === "branches") {
      await loadBranches();
      return;
    }
    if (state.tab === "tags") {
      await loadTags();
    }
  }

  // 没选仓库时，各页签给一句明确的指引，而不是留一片空白
  function renderNoRepo() {
    if (state.tab === "changes") {
      renderChanges();
      return;
    }
    const message = state.repos.length
      ? "从左侧选一个仓库"
      : "还没有仓库。先点「代码目录」选一个目录，再点「扫描仓库」。";
    if (state.tab === "log") {
      $("commit-list").innerHTML = "";
      $("commit-list").append(emptyRow(message));
      $("log-more").hidden = true;
      return;
    }
    if (state.tab === "branches") {
      $("branch-local").innerHTML = "";
      $("branch-remote").innerHTML = "";
      $("branch-local").append(emptyRow(message));
      return;
    }
    if (state.tab === "tags") {
      $("tag-list").innerHTML = "";
      $("tag-list").append(emptyRow(message));
    }
  }

  // 项目下拉：所有页面都用同一份项目表，这里额外给一个「未绑定 / 未指定」的空选项
  function fillProjectSelect(select, value, emptyLabel) {
    const projects = Workbench.projects(value);
    const current = value || "";
    select.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = emptyLabel;
    select.append(empty);
    projects.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.append(option);
    });
    select.value = projects.includes(current) ? current : "";
  }

  /* ===== 改动 ===== */

  function renderChanges() {
    const list = $("change-list");
    const status = currentStatus();
    list.innerHTML = "";

    if (!status) {
      list.append(emptyRow(state.repos.length ? "从左侧选一个仓库" : "还没有仓库"));
      $("changes-count").textContent = "";
      return;
    }
    if (status.error) {
      list.append(emptyRow(status.error));
      $("changes-count").textContent = "";
      return;
    }
    if (status.empty && (status.files || []).length === 0) {
      list.append(emptyRow("这个仓库还没有任何提交"));
      $("changes-count").textContent = "";
      return;
    }
    if (!status.files.length) {
      list.append(emptyRow("工作区干净，没有未提交的改动"));
      $("changes-count").textContent = "";
      return;
    }

    // 已暂存的排在前面，未暂存接上；整体分页，每页固定条数（不再无限往下长）
    const entries = [];
    status.files.filter((file) => file.staged).forEach((file) => entries.push({ group: "staged", file }));
    status.files.filter((file) => file.unstaged).forEach((file) => entries.push({ group: "unstaged", file }));

    const pages = Math.max(1, Math.ceil(entries.length / CHANGE_PAGE_SIZE));
    if (state.changesPage > pages) state.changesPage = pages;
    if (state.changesPage < 1) state.changesPage = 1;
    const start = (state.changesPage - 1) * CHANGE_PAGE_SIZE;
    const titles = { staged: "已暂存", unstaged: "未暂存" };
    const totals = { staged: status.staged, unstaged: status.unstaged };
    let lastGroup = "";
    entries.slice(start, start + CHANGE_PAGE_SIZE).forEach(({ group, file }) => {
      if (group !== lastGroup) {
        lastGroup = group;
        const head = document.createElement("h3");
        head.className = "sub-head";
        head.textContent = titles[group] + "（" + totals[group] + "）";
        list.append(head);
      }
      list.append(changeRow(file, group));
    });
    if (pages > 1) list.append(changePager(entries.length, state.changesPage, pages));

    $("changes-count").textContent = status.staged + " 已暂存 · " + status.unstaged + " 未暂存";
    $("select-all").checked = state.selected.size > 0 &&
      state.selected.size === status.files.filter((file) => file.unstaged || file.staged).length;
  }

  // 分页条：挂在列表底部（和列表同一个方框，不额外占版面）
  function changePager(total, page, pages) {
    const box = document.createElement("div");
    box.className = "list-pager";

    const info = document.createElement("span");
    info.className = "muted";
    info.textContent = "共 " + total + " 个文件 · 第 " + page + "/" + pages + " 页";

    const spacer = document.createElement("span");
    spacer.className = "dialog-spacer";

    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "btn";
    prev.textContent = "上一页";
    prev.disabled = page <= 1;
    prev.title = "上一页（不会执行任何 git 命令）";
    prev.addEventListener("click", () => goChangePage(page - 1));

    const next = document.createElement("button");
    next.type = "button";
    next.className = "btn";
    next.textContent = "下一页";
    next.disabled = page >= pages;
    next.title = "下一页（不会执行任何 git 命令）";
    next.addEventListener("click", () => goChangePage(page + 1));

    box.append(info, spacer, prev, next);
    return box;
  }

  function goChangePage(page) {
    if (page === state.changesPage) return;
    state.changesPage = page;
    renderChanges();
  }

  function changeRow(file, group) {
    const row = document.createElement("div");
    row.className = "change-row";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = state.selected.has(file.path);
    check.addEventListener("change", () => {
      if (check.checked) state.selected.add(file.path);
      else state.selected.delete(file.path);
      renderChanges();
    });

    const status = changeStatus(file, group);
    const code = document.createElement("span");
    code.className = "change-status " + status.cls;
    code.textContent = status.label;
    code.title = statusText(file);

    const path = document.createElement("span");
    path.className = "change-path mono";
    if (file.orig) {
      const from = document.createElement("span");
      from.className = "muted";
      from.textContent = file.orig + " → ";
      path.append(from);
    }
    path.append(document.createTextNode(file.path));
    path.title = file.path;

    const actions = document.createElement("span");
    actions.className = "change-actions";
    const view = document.createElement("button");
    view.type = "button";
    view.className = "linkish";
    view.textContent = "差异";
    view.title = "查看差异（只读，不会改动任何文件）";
    view.addEventListener("click", () => showFileDiff(file, group));
    actions.append(view);

    if (group === "unstaged") {
      const discard = document.createElement("button");
      discard.type = "button";
      discard.className = "linkish";
      discard.textContent = "放弃";
      discard.title = "将执行：git checkout -- " + file.path;
      discard.addEventListener("click", () => {
        state.selected.clear();
        state.selected.add(file.path);
        runPathsOp("discard", "已放弃改动", {
          title: "放弃改动",
          text: "「" + file.path + "」会回到上一次提交的状态，未提交的修改会丢失。",
          danger: true
        });
      });
      actions.append(discard);
    }

    row.append(check, code, path, actions);
    return row;
  }

  // git 的两位状态码（M / A / ?? …）对不上号，列表里改成一眼能懂的英文单词
  const CHANGE_STATUS = {
    M: { label: "Modified", cls: "is-mod" },
    A: { label: "Added", cls: "is-new" },
    D: { label: "Deleted", cls: "is-del" },
    R: { label: "Renamed", cls: "is-rename" },
    C: { label: "Copied", cls: "is-rename" },
    U: { label: "Conflict", cls: "is-conflict" },
    T: { label: "Type change", cls: "is-mod" },
    "?": { label: "Untracked", cls: "is-new" }
  };

  // 已暂存的行看暂存区那一列，未暂存的行看工作区那一列
  function changeStatus(file, group) {
    if (file.untracked) return CHANGE_STATUS["?"];
    const letter = group === "staged" ? file.index : file.worktree;
    return CHANGE_STATUS[letter] || { label: "Changed", cls: "is-mod" };
  }

  function statusText(file) {
    if (file.untracked) return "新文件（未跟踪）";
    const map = {
      M: "已修改", A: "新增", D: "删除", R: "重命名", C: "复制", U: "冲突", T: "类型变化", "?": "未跟踪"
    };
    const index = map[file.index] || file.index;
    const worktree = map[file.worktree] || file.worktree;
    return "暂存区：" + index + " · 工作区：" + worktree;
  }

  function emptyRow(text) {
    const el = document.createElement("p");
    el.className = "empty";
    el.textContent = text;
    return el;
  }

  async function showFileDiff(file, group) {
    const scope = group === "staged" ? "staged" : "worktree";
    const result = await GitApi.diff(state.current, { scope, path: file.path });
    const title = file.path + " · " + (group === "staged" ? "已暂存" : "工作区");
    if (!result || !result.ok) {
      renderDiff(GitApi.errorText(result), title);
      return;
    }
    renderDiff(result.stdout || "（这个文件没有可显示的差异。未跟踪文件要先暂存一次才会出现在差异里。）", title);
  }

  function renderDiff(text, title) {
    $("diff-view").hidden = false;
    $("diff-title").textContent = title || "";
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    const limit = Math.min(lines.length, 6000);
    let html = "";
    for (let i = 0; i < limit; i++) {
      const line = lines[i];
      let cls = "d-ctx";
      if (/^(@@|\+\+\+|---)/.test(line)) cls = "d-hunk";
      else if (/^(diff --git|index |new file|deleted file|similarity|rename )/.test(line)) cls = "d-meta";
      else if (line.startsWith("+")) cls = "d-add";
      else if (line.startsWith("-")) cls = "d-del";
      html += '<span class="d-line ' + cls + '">' + (Workbench.escapeHtml(line) || "&nbsp;") + "</span>";
    }
    if (lines.length > limit) html += '<span class="d-line d-meta">… 差异过长，只显示前 ' + limit + " 行</span>";
    $("diff-body").innerHTML = html || '<span class="d-line d-ctx">没有差异</span>';
  }

  // 提交说明留空不拦着：不少改动没什么好写的，统一记为 N/A，别让人卡在这一步
  const DEFAULT_COMMIT_MESSAGE = "N/A";

  async function doCommit(amend) {
    const typed = $("commit-message").value.trim();
    const status = currentStatus();
    if (status && !amend && status.staged === 0) {
      return Nav.toast("暂存区是空的，先暂存要提交的文件");
    }
    // 「修改上一条」留空是另一回事：照写 N/A 会把上一条的真实说明抹掉，
    // 所以空说明时走 --no-edit，只把暂存区的内容并进去，原来的消息不动。
    const keepMessage = amend && !typed;
    const op = keepMessage ? "commit-amend-keep" : (amend ? "commit-amend" : "commit");
    const result = await runOp(op, keepMessage ? {} : { message: typed || DEFAULT_COMMIT_MESSAGE }, {
      done: amend ? "已改写上一条提交" : "提交成功",
      confirm: amend,
      title: "改写上一条提交",
      text: "会用当前暂存区的内容替换上一条提交（提交号会变），已经推送过的分支不建议这么做。",
      danger: true
    });
    if (result && result.ok) $("commit-message").value = "";
  }

  async function runPathsOp(op, done, confirmOptions) {
    const paths = Array.from(state.selected);
    if (!paths.length) return Nav.toast("先在列表里勾选文件");
    const meta = OP_META[op] || {};
    return runOp(op, { paths }, Object.assign({
      done,
      confirm: !!confirmOptions,
      title: meta.label,
      text: "将作用在这 " + paths.length + " 个文件上：\n" + paths.slice(0, 12).join("\n") + (paths.length > 12 ? "\n…" : ""),
      danger: !!meta.danger
    }, confirmOptions || {}));
  }

  /* ===== 历史 ===== */

  async function loadLog(reset) {
    if (!state.current) return;
    if (reset) {
      state.log.skip = 0;
      state.log.items = [];
    }
    const result = await GitApi.log(state.current, { limit: state.log.limit, skip: state.log.skip });
    if (!result || !result.ok) {
      $("commit-list").innerHTML = "";
      $("commit-list").append(emptyRow(GitApi.errorText(result)));
      $("log-more").hidden = true;
      return;
    }
    state.log.items = state.log.items.concat(result.commits || []);
    state.log.skip += (result.commits || []).length;
    state.log.hasMore = !!result.hasMore;
    renderLog();
  }

  function renderLog() {
    const list = $("commit-list");
    list.innerHTML = "";
    if (!state.log.items.length) {
      list.append(emptyRow("还没有提交记录"));
      $("log-more").hidden = true;
      return;
    }
    state.log.items.forEach((commit) => {
      const row = document.createElement("div");
      row.className = "commit-row";

      const head = document.createElement("button");
      head.type = "button";
      head.className = "commit-head";
      const hash = document.createElement("span");
      hash.className = "commit-hash mono";
      hash.textContent = commit.hash;
      const subject = document.createElement("span");
      subject.className = "commit-subject";
      subject.textContent = commit.subject;
      const meta = document.createElement("span");
      meta.className = "commit-meta";
      meta.textContent = commit.author + " · " + relTime(commit.at);
      head.append(hash, subject, meta);
      head.addEventListener("click", () => showCommitDiff(commit));

      // 回滚相关动作挂在每条提交上：反向提交是安全的，硬回滚要二次确认
      const actions = document.createElement("span");
      actions.className = "commit-actions";
      actions.append(
        textAction("反向提交", () => runOp("revert", { ref: commit.hash }, {
          done: "已反向提交 " + commit.hash,
          confirm: true,
          title: "反向提交",
          text: "生成一条新提交来撤销 " + commit.hash + "「" + commit.subject + "」。历史保留，还可以再撤销它。",
          danger: false
        }), false, "git revert --no-edit " + commit.hash),
        textAction("回滚到此", () => runOp("reset-hard", { ref: commit.hash }, {
          done: "已回滚到 " + commit.hash,
          confirm: true,
          title: "硬回滚到此提交",
          text: "工作区与暂存区都会重置到 " + commit.hash + "「" + commit.subject
            + "」，未提交的改动会丢失。之后的提交仍在 reflog 里，但界面上看不到了。",
          danger: true
        }), false, "git reset --hard " + commit.hash)
      );

      row.append(head, actions);
      list.append(row);
    });
    $("log-more").hidden = !state.log.hasMore;
  }

  async function showCommitDiff(commit) {
    const result = await GitApi.diff(state.current, { scope: "commit", ref: commit.hash });
    renderDiff(result && result.ok ? result.stdout : GitApi.errorText(result), commit.hash + " · " + commit.subject);
  }

  /* ===== 分支 / 标签 ===== */

  async function loadBranches() {
    const local = $("branch-local");
    const remote = $("branch-remote");
    local.innerHTML = "";
    remote.innerHTML = "";
    const result = await GitApi.branches(state.current);
    if (!result || !result.ok) {
      local.append(emptyRow(GitApi.errorText(result)));
      return;
    }
    if (!(result.local || []).length) local.append(emptyRow("没有本地分支"));
    (result.local || []).forEach((branch) => {
      const row = plainRow(branch.name, (branch.subject || "") + " · " + relTime(branch.at), branch.name === result.current);
      row.actions.append(
        textAction("切换", () => runOp("checkout", { ref: branch.name }, { done: "已切到 " + branch.name }),
          branch.name === result.current, "git checkout " + branch.name),
        textAction("删除", () => runOp("branch-delete", { name: branch.name }, {
          done: "已删除分支 " + branch.name,
          confirm: true,
          title: "删除分支",
          text: "删除本地分支「" + branch.name + "」，没合并的提交会被 git 拒绝删除。",
          danger: true
        }), branch.name === result.current, "git branch -d " + branch.name)
      );
      local.append(row.el);
    });

    if (!(result.remote || []).length) remote.append(emptyRow("没有远程分支（可能还没配远端）"));
    (result.remote || []).forEach((branch) => {
      const row = plainRow(branch.name, relTime(branch.at), false);
      row.actions.append(textAction("检出到新分支", () => {
        $("new-branch").value = branch.name.replace(/^[^/]+\//, "");
        Nav.toast("已填入分支名，确认后点「新建并切换」");
      }, false, "先填入分支名，确认后执行 git checkout -b <分支名>"));
      remote.append(row.el);
    });
  }

  async function loadTags() {
    const list = $("tag-list");
    list.innerHTML = "";
    renderReleases();
    const result = await GitApi.tags(state.current);
    if (!result || !result.ok) {
      list.append(emptyRow(GitApi.errorText(result)));
      return;
    }
    if (!(result.tags || []).length) list.append(emptyRow("还没有标签"));
    (result.tags || []).forEach((tag) => {
      const row = plainRow(tag.name, (tag.subject || "") + " · " + relTime(tag.at), false);
      row.actions.append(
        textAction("推送", () => runOp("tag-push", { name: tag.name }, {
          done: "已推送标签 " + tag.name,
          confirm: true,
          title: "推送标签",
          text: "把标签「" + tag.name + "」推到 origin。",
          danger: false
        }), false, "git push origin " + tag.name),
        textAction("检出", () => runOp("checkout", { ref: tag.name }, { done: "已切到标签 " + tag.name }),
          false, "git checkout " + tag.name),
        textAction("删除", () => runOp("tag-delete", { name: tag.name }, {
          done: "已删除标签 " + tag.name,
          confirm: true,
          title: "删除标签",
          text: "删除本地标签「" + tag.name + "」，远端同名标签不影响。",
          danger: true
        }), false, "git tag -d " + tag.name)
      );
      list.append(row.el);
    });
  }

  /* ===== 发布流水 =====
     打标签就当一次发布，记在 meta.json 的 git.releases 里。
     「更新软件版本」页读同一份数据，在那个项目的卡片上显示最近发的版本。 */

  async function recordRelease(tag) {
    const repo = state.repos.find((item) => item.path === state.current);
    const status = currentStatus();
    try {
      await Workbench.addRelease({
        tag,
        project: repo ? repo.project : "",
        repo: state.current,
        commit: status && status.last ? String(status.last.hash || "").slice(0, 8) : ""
      });
      renderReleases();
      const section = repo ? (repo.project || repo.name) : "";
      Nav.toast(repo && repo.project ? "已记入发布流水：" + repo.project : "已记入发布流水", {
        label: "去版本页",
        onSelect: () => { location.href = "version.html?section=" + encodeURIComponent(section); }
      });
    } catch (err) {
      // 流水只是锦上添花，记录失败不该打断打标签
    }
  }

  function renderReleases() {
    const box = $("release-list");
    if (!box || !state.current) return;
    box.innerHTML = "";
    const repo = state.repos.find((item) => item.path === state.current);
    const key = state.current.toLowerCase();
    const list = Workbench.gitConfig().releases.filter((item) => {
      if (String(item.repo || "").toLowerCase() === key) return true;
      return !!(repo && repo.project && item.project === repo.project);
    });
    if (!list.length) {
      box.append(emptyRow("还没有发布流水。打标签时会自动记一条。"));
      return;
    }
    list.slice(0, 10).forEach((item) => {
      const meta = [item.project && "项目 " + item.project, item.commit, formatWhen(item.at)]
        .filter(Boolean).join(" · ");
      box.append(plainRow(item.tag, meta, false).el);
    });
  }

  // 时间：同一天只显示时刻，跨天显示日期
  function formatWhen(iso) {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    const time = String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return time;
    return (date.getMonth() + 1) + "月" + date.getDate() + "日 " + time;
  }

  function plainRow(title, subtitle, current) {
    const el = document.createElement("div");
    el.className = "plain-row" + (current ? " on" : "");
    const main = document.createElement("div");
    main.className = "plain-main";
    const strong = document.createElement("strong");
    strong.textContent = title;
    main.append(strong);
    if (subtitle) {
      const sub = document.createElement("span");
      sub.className = "muted";
      sub.textContent = subtitle;
      main.append(sub);
    }
    const actions = document.createElement("div");
    actions.className = "plain-actions";
    el.append(main, actions);
    return { el, actions };
  }

  // hint：鼠标悬停时的说明。动态行里的动作带着实际参数（如 "git checkout main"），
  // 比 OP_META 的占位写法更准确；不是命令的说明（纯提示文字）原样显示。
  function textAction(label, onclick, disabled, hint) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "linkish";
    button.textContent = label;
    button.disabled = !!disabled;
    if (hint) button.title = /^git\s/.test(hint) ? "将执行：" + hint : hint;
    button.addEventListener("click", onclick);
    return button;
  }

  /* ===== 软件号 ===== */

  async function renderSoftware() {
    state.software = await Workbench.loadSoftware();
    renderSoftwareList();
  }

  function renderSoftwareList() {
    const list = $("software-list");
    list.innerHTML = "";
    const keyword = state.softwareSearch;
    const all = state.software;
    const deletedCount = all.filter((item) => Workbench.isDeleted(item)).length;

    const toggle = $("software-deleted");
    toggle.hidden = deletedCount === 0;
    toggle.textContent = state.showDeleted ? "隐藏已删除" : "显示已删除（" + deletedCount + "）";

    const rows = all.filter((item) => {
      if (!state.showDeleted && Workbench.isDeleted(item)) return false;
      if (!keyword) return true;
      return [item.name, item.softwareId, item.project, item.notes]
        .filter(Boolean).join(" ").toLowerCase().includes(keyword);
    });

    if (!rows.length) {
      list.append(emptyRow(all.length ? "没有匹配的软件号" : "还没有软件号。原来在加密资料库里的「软件号」会迁到这里。"));
      return;
    }

    rows.forEach((item) => {
      const row = plainRow(item.name || "（未命名）", [item.softwareId, item.project, item.notes].filter(Boolean).join(" · "), false);
      const value = document.createElement("code");
      value.className = "mono software-value";
      value.textContent = item.softwareId || "—";
      row.el.querySelector(".plain-main").append(value);

      if (Workbench.isDeleted(item)) {
        row.el.classList.add("is-deleted");
        row.actions.append(textAction("恢复", async () => {
          const target = state.software.find((entry) => entry.id === item.id);
          if (!target) return;
          target.deletedAt = "";
          target.updatedAt = new Date().toISOString();
          await Workbench.saveSoftware(state.software);
          renderSoftwareList();
          Nav.toast("已恢复");
        }, false, "从回收站恢复这条软件号"));
      } else {
        row.actions.append(
          textAction("复制", () => copyText(item.softwareId || item.name, "已复制软件号"),
            false, "复制软件号到剪贴板（不会改动任何数据）"),
          textAction("编辑", () => openSoftware(item.id), false, "修改这条软件号"),
          textAction("删除", () => softDeleteSoftware(item), false, "移到回收站（可以在回收站里还原）")
        );
      }
      list.append(row.el);
    });
  }

  function copyText(text, done) {
    if (!text) return Nav.toast("没有可复制的内容");
    const write = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error("浏览器不支持"));
    write.then(() => Nav.toast(done)).catch(() => Nav.toast("复制失败，请手动选中复制"));
  }

  function openSoftware(id) {
    state.editing = id || "";
    const item = id ? state.software.find((entry) => entry.id === id) : null;
    $("software-title").textContent = item ? "编辑软件号" : "新增软件号";
    $("software-name").value = item ? item.name : "";
    $("software-id").value = item ? item.softwareId : "";
    $("software-notes").value = item ? item.notes : "";
    $("software-delete").hidden = !item;
    setError("software-error", "");
    fillProjectSelect($("software-project"), item ? item.project : "", "未指定");
    $("software-dialog").showModal();
    $("software-name").focus();
  }

  async function saveSoftware(event) {
    event.preventDefault();
    const name = $("software-name").value.trim();
    if (!name) return setError("software-error", "名称不能为空");
    const now = new Date().toISOString();
    const payload = {
      name,
      softwareId: $("software-id").value.trim(),
      project: $("software-project").value,
      notes: $("software-notes").value.trim()
    };
    if (state.editing) {
      const target = state.software.find((entry) => entry.id === state.editing);
      if (target) Object.assign(target, payload, { updatedAt: now });
    } else {
      state.software.push(Object.assign({ id: Workbench.uid(), deletedAt: "", updatedAt: now }, payload));
    }
    await Workbench.saveSoftware(state.software);
    $("software-dialog").close();
    await renderSoftware();
    Nav.toast(state.editing ? "已保存" : "已新增");
  }

  async function deleteSoftware() {
    if (!state.editing) return;
    const item = state.software.find((entry) => entry.id === state.editing);
    if (item) await softDeleteSoftware(item);
    $("software-dialog").close();
  }

  async function softDeleteSoftware(item) {
    const previous = item.deletedAt || "";
    item.deletedAt = new Date().toISOString();
    item.updatedAt = item.deletedAt;
    await Workbench.saveSoftware(state.software);
    renderSoftwareList();
    Nav.toast("「" + (item.name || "未命名") + "」已移入回收站", {
      label: "撤销",
      onSelect: async () => {
        item.deletedAt = previous;
        item.updatedAt = new Date().toISOString();
        await Workbench.saveSoftware(state.software);
        renderSoftwareList();
        Nav.toast("已恢复");
      }
    });
  }

  /* ===== 项目绑定 ===== */

  async function bindProject() {
    const repo = state.repos.find((item) => item.path === state.current);
    if (!repo) return;
    repo.project = $("repo-project").value;
    const config = Workbench.gitConfig();
    await Workbench.saveGitConfig({ roots: config.roots, repos: state.repos });
    renderRepos();
    Nav.toast(repo.project ? "已绑定到 " + repo.project : "已取消绑定");
  }

  /* ===== 执行动作 ===== */

  async function runOp(op, fields, options) {
    const opts = options || {};
    if (!state.current) return null;
    const meta = OP_META[op] || {};
    if (opts.confirm) {
      const ok = await askConfirm({
        title: opts.title || meta.label || "确认操作",
        text: opts.text || "",
        command: meta.command || ("git " + op),
        danger: opts.danger === true
      });
      if (!ok) return null;
    }
    setBusy(true);
    // 点击后立刻在输出面板占一条"执行中"，结果回来再填内容。
    // 之前要等命令跑完才有任何反应，而 fetch/pull/push 动辄几十秒。
    const command = meta.command || ("git " + op);
    const entry = beginOutput(command);
    const startedAt = Date.now();
    let result = null;
    try {
      result = await GitApi.exec(state.current, op, fields);
    } catch (err) {
      result = { ok: false, stderr: err && err.message ? err.message : "执行失败" };
    }
    endOutput(entry, result, startedAt);
    GitApi.invalidate();
    await refreshStatus(true);
    await reloadTab(true);
    setBusy(false);
    if (result && result.ok) {
      if (opts.done) Nav.toast(opts.done);
    } else {
      const reason = GitApi.errorText(result);
      // 首次推送最常见的两个坑：没有远端、没有任何提交。都给能点的入口，别让人去猜。
      if (/No configured push destination|no upstream branch|No such remote|does not appear to be a git repository|Could not read from remote repository/i.test(reason)) {
        Nav.toast("还没有远端地址，点这里设置", { label: "设置远端", onSelect: openRemote });
      } else if (/src refspec .* does not match any|does not have any commits/i.test(reason)) {
        Nav.toast("仓库还没有任何提交，先暂存并提交再推送", {
          label: "去暂存",
          onSelect: () => showTab("changes")
        });
      } else {
        Nav.toast("失败：" + reason);
      }
    }
    return result;
  }

  function setBusy(busy) {
    state.busy = busy;
    const repoOps = ["stage-selected", "unstage-selected", "stage-all", "discard-selected",
      "commit", "commit-amend", "stash", "stash-pop", "create-branch", "create-tag",
      "repo-fetch", "repo-pull", "repo-push", "repo-remote"];
    const scan = $("code-scan");
    if (scan) scan.disabled = busy;
    repoOps.forEach((id) => {
      const el = $(id);
      if (el) el.disabled = busy || !state.current;
    });
    document.body.classList.toggle("is-busy", busy);
  }

  function askConfirm(options) {
    return new Promise((resolve) => {
      $("confirm-title").textContent = options.title || "确认操作";
      $("confirm-text").textContent = options.text || "";
      $("confirm-command").textContent = options.command || "";
      const ok = $("confirm-ok");
      ok.className = options.danger ? "btn danger" : "btn primary";
      const dialog = $("confirm-dialog");
      const finish = (value) => {
        ok.removeEventListener("click", onOk);
        dialog.removeEventListener("close", onClose);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onOk = () => finish(true);
      const onClose = () => finish(false);
      ok.addEventListener("click", onOk);
      dialog.addEventListener("close", onClose);
      dialog.showModal();
    });
  }

  /* ===== 输出面板 =====
     两段式：开始执行就先插一条"执行中…"（并展开面板），结束后再把它改成结果。
     这样慢命令（fetch/pull/push）一按下就有反馈，不用干等。 */

  function beginOutput(command) {
    const body = $("output-body");
    const entry = document.createElement("div");
    entry.className = "output-entry running";

    const head = document.createElement("div");
    head.className = "output-head";
    const label = document.createElement("span");
    label.className = "mono";
    label.textContent = new Date().toLocaleTimeString() + "  " + command;
    const state = document.createElement("span");
    state.className = "output-state";
    state.textContent = "执行中…";
    head.append(label, state);
    entry.append(head);

    const text = document.createElement("pre");
    text.className = "mono muted";
    text.textContent = "正在执行，等待 git 返回…";
    entry.append(text);

    body.prepend(entry);
    while (body.children.length > 30) body.removeChild(body.lastChild);
    // 展开面板并更新折叠状态下的提示行：点下去立刻有反馈
    $("output-hint").textContent = "执行中 · " + command;
    $("code-output").open = true;
    return entry;
  }

  function endOutput(entry, result, startedAt) {
    if (!entry) return;
    const ok = !!(result && result.ok);
    const state = entry.querySelector(".output-state");
    const text = entry.querySelector("pre");
    entry.classList.remove("running");
    entry.classList.toggle("bad", !ok);
    if (text) text.classList.remove("muted");

    const seconds = startedAt ? (Date.now() - startedAt) / 1000 : 0;
    if (state) {
      // 太快的操作不显示耗时，免得"0.0s"这种噪声
      state.textContent = (ok ? "成功" : "失败") + (seconds >= 0.3 ? " · " + seconds.toFixed(1) + "s" : "");
    }
    const merged = [result && result.stdout ? result.stdout.trim() : "", result && result.stderr ? result.stderr.trim() : ""]
      .filter(Boolean).join("\n");
    if (text) text.textContent = merged || "（没有输出）";

    const label = entry.querySelector(".output-head .mono");
    $("output-hint").textContent = (ok ? "上次成功" : "上次失败") + " · "
      + (label ? label.textContent.replace(/^\S+\s+/, "") : "");
    // 只有失败才自动展开；成功时不再强制折叠，展开/折叠交给你
    if (!ok) $("code-output").open = true;
  }

  function notice(message) {
    const el = $("code-notice");
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = message;
  }

  function syncNotice() {
    const config = Workbench.gitConfig();
    const total = state.repos.length;
    const dirty = state.repos.filter((repo) => {
      const status = state.status.get(repo.path.toLowerCase());
      return status && !status.error && status.staged + status.unstaged > 0;
    }).length;
    $("code-summary").textContent = total
      ? total + " 个仓库" + (dirty ? " · " + dirty + " 个有改动" : "")
      : "代码";
    if (config.roots.length === 0) {
      notice("还没有设置代码根目录。点右上角「代码目录」选一个目录（例如 D:\\Git Repository），再点「扫描仓库」。");
    } else if (!state.repos.length) {
      notice("代码目录是 " + config.roots.join("、") + "，但还没发现仓库。点「扫描仓库」试试。");
    } else {
      notice("");
    }
  }

  /* ===== 代码目录 ===== */

  function openRoots() {
    $("roots-error").hidden = true;
    renderRootList();
    $("roots-dialog").showModal();
  }

  function renderRootList() {
    const list = $("root-list");
    list.innerHTML = "";
    const roots = Workbench.gitConfig().roots;
    if (!roots.length) {
      list.append(emptyRow("还没有代码根目录"));
      return;
    }
    roots.forEach((path) => {
      const row = plainRow(path, "", false);
      row.actions.append(textAction("移除", () => removeRoot(path),
        false, "从代码根目录列表里移除（只改登记，不会删除磁盘上的目录）"));
      list.append(row.el);
    });
  }

  // 目录选择交给公共选择器（与「更新软件版本」页共用一份实现）
  async function addRoot() {
    const current = Workbench.gitConfig();
    const picked = await Nav.pickPath({
      mode: "dir",
      start: current.roots[0] || "",
      title: "选择代码根目录",
      confirmLabel: "加为代码根目录"
    });
    if (!picked) return;

    const config = Workbench.gitConfig();
    const path = picked.trim().replace(/[\\/]+$/, "");
    if (!path) return setError("roots-error", "没有选到目录");
    if (config.roots.some((item) => item.toLowerCase() === path.toLowerCase())) {
      return setError("roots-error", "这个目录已经在列表里了");
    }
    config.roots.push(path);
    await Workbench.saveGitConfig(config);
    setError("roots-error", "");
    renderRootList();
    await scanRepos();
    syncNotice();
  }

  async function removeRoot(path) {
    const config = Workbench.gitConfig();
    config.roots = config.roots.filter((item) => item !== path);
    // 一起清掉这个根目录下的仓库登记，避免列表里留下已经管不到的项
    const prefix = path.replace(/[\\/]+$/, "") + "\\";
    config.repos = state.repos.filter((repo) => repo.path.toLowerCase().indexOf(prefix.toLowerCase()) !== 0);
    await Workbench.saveGitConfig(config);
    state.repos = config.repos.slice();
    if (state.current && !state.repos.some((repo) => repo.path === state.current)) state.current = "";
    renderRootList();
    await refreshStatus(true);
    syncNotice();
  }

  function setError(id, message) {
    const el = $(id);
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }

  function relTime(epochSeconds) {
    const at = Number(epochSeconds);
    if (!at) return "";
    const diff = Math.max(0, Math.floor(Date.now() / 1000 - at));
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + " 天前";
    return new Date(at * 1000).toLocaleDateString();
  }
})();
