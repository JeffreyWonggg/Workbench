(function (root) {
  const DEFAULT_PROJECTS = ["DR23", "DC26", "MR25", "M120", "DC24", "DD2J", "GFF", "OTDR共享平台", "其他"];
  // 首页「工具」菜单的默认为空：清单存在 meta.json 的 tools 字段里，在界面上自己加
  const DEFAULT_TOOLS = [];

  // git 页的默认配置：roots 是代码根目录，repos 是「仓库 → 项目」的绑定表
  const DEFAULT_GIT = { roots: [], repos: [] };


  const STATES = [
    { id: "DOING", label: "进行中" },
    { id: "NO START", label: "未开始" },
    { id: "HOLD", label: "暂停" },
    { id: "DONE", label: "已完成" }
  ];

  function uid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return { year: d.getUTCFullYear(), week };
  }

  function weekMonday(year, week) {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Dow = jan4.getUTCDay() || 7;
    const monday = new Date(jan4);
    monday.setUTCDate(jan4.getUTCDate() - jan4Dow + 1 + (week - 1) * 7);
    return monday;
  }

  function addUtcDays(date, days) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  function formatUtcMonthDay(date) {
    return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  }

  function todayIso(date) {
    const d = date || new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function dateFromIso(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function formatShortDate(iso) {
    const date = dateFromIso(iso);
    if (!date) return "";
    return `${date.getMonth() + 1}.${date.getDate()}`;
  }

  function inIsoWeek(iso, year, week) {
    const date = dateFromIso(iso);
    if (!date) return false;
    const info = isoWeek(date);
    return info.year === year && info.week === week;
  }

  function shiftWeek(year, week, delta) {
    const monday = addUtcDays(weekMonday(year, week), delta * 7);
    return isoWeek(new Date(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[ch]));
  }

  function inlineMarkdown(value) {
    return String(value)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
        const raw = href.replace(/&amp;/g, "&");
        if (!/^(https?:|mailto:)/i.test(raw)) return label;
        return `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`;
      });
  }

  function renderMarkdown(src) {
    const escaped = escapeHtml(String(src || "").replace(/\r\n/g, "\n"));
    const fences = [];
    let text = escaped.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
      const token = `%%FENCE${fences.length}%%`;
      fences.push(`<pre class="md-pre"><code>${code.replace(/\n$/, "")}</code></pre>`);
      return token;
    });
    text = text.replace(/`([^`\n]+)`/g, "<code class=\"md-inline\">$1</code>");
    const lines = text.split("\n");
    let html = "";
    let i = 0;
    const fenceIndex = (line) => {
      const match = /^%%FENCE(\d+)%%$/.exec(line.trim());
      return match ? Number(match[1]) : -1;
    };
    const isList = (line) => /^(-|\*)\s+/.test(line) || /^\d+\.\s+/.test(line) || /^\d+、/.test(line);

    while (i < lines.length) {
      const trimmed = lines[i].trim();
      if (!trimmed) {
        i += 1;
        continue;
      }
      const fence = fenceIndex(trimmed);
      if (fence >= 0) {
        html += fences[fence];
        i += 1;
        continue;
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
      if (heading) {
        const level = heading[1].length;
        html += `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`;
        i += 1;
        continue;
      }
      if (isList(trimmed)) {
        const ordered = !/^(-|\*)\s+/.test(trimmed);
        const items = [];
        while (i < lines.length && isList(lines[i].trim())) {
          const lead = /^[ \t]*/.exec(lines[i])[0];
          let columns = 0;
          for (let k = 0; k < lead.length; k += 1) columns += lead[k] === "\t" ? 4 : 1;
          items.push({
            columns,
            text: lines[i].trim().replace(/^(-|\*|\d+\.)\s+/, "").replace(/^\d+、/, "")
          });
          i += 1;
        }
        const tag = ordered ? "ol" : "ul";
        html += `<${tag}>${items.map((item) => {
          const style = item.columns ? ` style="margin-left:${item.columns}ch"` : "";
          return `<li${style}>${inlineMarkdown(item.text)}</li>`;
        }).join("")}</${tag}>`;
        continue;
      }
      if (/^\|.+\|$/.test(trimmed) && i + 1 < lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(lines[i + 1].trim())) {
        const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
        const header = splitRow(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        html += `<table class="md-table"><thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${
          rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")
        }</tbody></table>`;
        continue;
      }
      if (trimmed.startsWith("&gt;")) {
        const quote = [];
        while (i < lines.length && lines[i].trim().startsWith("&gt;")) {
          quote.push(lines[i].trim().replace(/^&gt; ?/, ""));
          i += 1;
        }
        html += `<blockquote><p>${inlineMarkdown(quote.join("<br>"))}</p></blockquote>`;
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && fenceIndex(lines[i]) < 0 && !/^(#{1,4})\s+/.test(lines[i].trim()) && !isList(lines[i].trim()) && !lines[i].trim().startsWith("&gt;")) {
        // 只去掉行尾空白。行首缩进要留在正文里，否则预览被裁平，点进行才看得到。
        para.push(lines[i].replace(/[ \t]+$/g, ""));
        i += 1;
      }
      html += `<p>${inlineMarkdown(para.join("<br>"))}</p>`;
    }
    return html;
  }

  function formatHours(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "0";
    // 保留一位小数且不带多余零：3 -> "3"、3.5 -> "3.5"
    return String(Math.round(num * 10) / 10);
  }

  function reportToMarkdown(report) {
    const lines = [`# ${report.week}周`];
    (report.sections || []).forEach((section) => {
      if (!section.project) return;
      lines.push(`### ${section.project}（${formatHours(section.hours)}h）`);
      (section.items || []).map((item) => String(item).trim()).filter(Boolean).forEach((item, index) => {
        lines.push(`${index + 1}、${item}`);
      });
    });
    return lines.join("\n");
  }

  function stateLabel(id) {
    const found = STATES.find((state) => state.id === id);
    return found ? found.label : id;
  }

  // 工具清单容错：丢掉没有可执行路径的条目，并补齐 id / label
  function normalizeTools(list) {
    // 显式给空数组表示「用户不想留任何工具」，此时不回退到默认值
    const source = Array.isArray(list) ? list : DEFAULT_TOOLS;
    const seen = Object.create(null);
    const tools = [];
    source.forEach((item, index) => {
      const exe = String((item && item.exe) || "").trim();
      if (!exe) return;
      let id = String((item && item.id) || "").trim() || "tool-" + (index + 1);
      while (seen[id]) id += "-2";
      seen[id] = true;
      tools.push({
        id,
        label: String((item && item.label) || "").trim() || exe.split(/[\\/]/).pop() || "未命名工具",
        exe,
        args: String((item && item.args) || "").trim(),
        cwd: String((item && item.cwd) || "").trim()
      });
    });
    return tools;
  }

  // git 配置容错：去掉空路径与重复项，仓库名缺省取目录名
  function normalizeGit(git) {
    const source = git && typeof git === "object" ? git : {};
    const roots = [];
    const seenRoot = Object.create(null);
    (Array.isArray(source.roots) ? source.roots : []).forEach((item) => {
      const path = String(item || "").trim().replace(/[\\/]+$/, "");
      if (!path || seenRoot[path.toLowerCase()]) return;
      seenRoot[path.toLowerCase()] = true;
      roots.push(path);
    });

    const repos = [];
    const seenRepo = Object.create(null);
    (Array.isArray(source.repos) ? source.repos : []).forEach((item) => {
      const path = String((item && item.path) || "").trim().replace(/[\\/]+$/, "");
      if (!path || seenRepo[path.toLowerCase()]) return;
      seenRepo[path.toLowerCase()] = true;
      repos.push({
        path,
        name: String((item && item.name) || "").trim() || path.split(/[\\/]/).pop() || path,
        project: String((item && item.project) || "").trim()
      });
    });

    // 发布流水：代码页打标签时记一条，版本页据此显示「这个项目最近发的版本」
    const releases = [];
    (Array.isArray(source.releases) ? source.releases : []).forEach((item) => {
      const tag = String((item && item.tag) || "").trim();
      if (!tag) return;
      releases.push({
        id: String((item && item.id) || "").trim() || tag,
        project: String((item && item.project) || "").trim(),
        repo: String((item && item.repo) || "").trim(),
        tag,
        commit: String((item && item.commit) || "").trim(),
        at: String((item && item.at) || "")
      });
    });

    return { roots, repos, releases: releases.slice(0, 100) };
  }

  // 软件号：从加密资料库迁出后存在明文的 software.json，字段名沿用 softwareId 便于迁移
  function normalizeSoftware(list) {
    if (!Array.isArray(list)) return [];
    return list.map((item, index) => ({
      id: String((item && item.id) || "").trim() || "sw-" + (index + 1),
      name: String((item && item.name) || "").trim(),
      softwareId: String((item && item.softwareId) || "").trim(),
      project: String((item && item.project) || "").trim(),
      notes: String((item && item.notes) || "").trim(),
      deletedAt: String((item && item.deletedAt) || ""),
      updatedAt: String((item && item.updatedAt) || "")
    }));
  }

  function todoWeekIso(todo) {
    if (todo.state === "DONE" && todo.doneAt) return todo.doneAt;
    return todo.date || todo.updatedAt || "";
  }

  const VAULT_SESSION_KEY = "wb-vault-records";

  // 资料库解锁后把明文暂存在 sessionStorage：同一个标签页内其它页面（项目主页、命令面板）
  // 可以只读展示，关掉标签页即清空。写入只发生在资料库页面。
  function vaultLibrarySession(vault) {
    const library = vault && vault.library && typeof vault.library === "object" ? vault.library : {};
    const raw = library.assignments && typeof library.assignments === "object" ? library.assignments : {};
    const assignments = {};
    Object.keys(raw).forEach((path) => {
      const project = String(raw[path] || "").trim();
      const clean = String(path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (clean && project) assignments[clean] = project;
    });
    return {
      root: String(library.root || ""),
      assignments
    };
  }

  function readVaultSession() {
    try {
      const raw = root.sessionStorage.getItem(VAULT_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.records)) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function writeVaultSession(vault) {
    try {
      root.sessionStorage.setItem(VAULT_SESSION_KEY, JSON.stringify({
        version: 1,
        records: Array.isArray(vault.records) ? vault.records : [],
        library: vaultLibrarySession(vault),
        updatedAt: vault.updatedAt || new Date().toISOString()
      }));
    } catch (err) {
      // 隐私模式下 sessionStorage 可能不可用，忽略即可
    }
  }

  function clearVaultSession() {
    try { root.sessionStorage.removeItem(VAULT_SESSION_KEY); } catch (err) {}
  }

  // 软删除：带 deletedAt 的条目在各页面隐藏，只在回收站里出现
  function isDeleted(item) {
    return !!(item && item.deletedAt);
  }

  function activeItems(items) {
    return Array.isArray(items) ? items.filter((item) => !isDeleted(item)) : [];
  }

  function deletedItems(items) {
    return Array.isArray(items) ? items.filter((item) => isDeleted(item)) : [];
  }

  const Workbench = {
    dir: null,
    meta: null,
    status: null,
    DEFAULT_PROJECTS,
    DEFAULT_TOOLS,
    DEFAULT_GIT,
    STATES,
    normalizeTools,
    normalizeGit,
    normalizeSoftware,
    isDeleted,
    activeItems,
    deletedItems,
    readVaultSession,
    writeVaultSession,
    clearVaultSession,
    uid,
    isoWeek,
    weekMonday,
    addUtcDays,
    formatUtcMonthDay,
    todayIso,
    dateFromIso,
    formatShortDate,
    inIsoWeek,
    shiftWeek,
    escapeHtml,
    renderMarkdown,
    formatHours,
    reportToMarkdown,
    stateLabel,
    todoWeekIso,

    async open() {
      const status = { ok: false, needsPick: false, needsPermission: false, unsupported: false, folderName: "", error: "" };
      this.status = status;
      if (typeof root.showDirectoryPicker !== "function") {
        status.unsupported = true;
        return status;
      }
      let handle = null;
      try {
        handle = await Storage.loadHandle();
      } catch (err) {
        handle = null;
      }
      if (!handle) {
        status.needsPick = true;
        return status;
      }
      let perm = "prompt";
      try {
        perm = await handle.queryPermission({ mode: "readwrite" });
      } catch (err) {
        status.unsupported = true;
        return status;
      }
      if (perm !== "granted") {
        status.needsPermission = true;
        status.folderName = handle.name || "";
        return status;
      }
      this.dir = handle;
      try {
        this.meta = await this.ensureMeta();
      } catch (err) {
        status.error = err && err.message ? err.message : "数据打不开";
        return status;
      }
      status.ok = true;
      status.folderName = handle.name || "";
      return status;
    },

    async pickDirectory() {
      const handle = await root.showDirectoryPicker({ mode: "readwrite", id: "workbench-data" });
      await Storage.saveHandle(handle);
      this.dir = handle;
      this.meta = await this.ensureMeta();
      return handle;
    },

    async requestAccess() {
      const handle = await Storage.loadHandle();
      if (!handle) throw new Error("还没有选择文件夹");
      const perm = await handle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") throw new Error("没有获得读写权限");
      this.dir = handle;
      this.meta = await this.ensureMeta();
      return handle;
    },

    async readJson(path, fallback) {
      const text = await Storage.readText(this.dir, path);
      if (text == null || text.trim() === "") {
        await this.writeJson(path, fallback);
        return structuredClone(fallback);
      }
      return JSON.parse(text);
    },

    async writeJson(path, data) {
      await Storage.writeText(this.dir, path, JSON.stringify(data, null, 2) + "\n");
    },

    async removeFile(path) {
      await Storage.removeFile(this.dir, path);
    },

    async loadVaultEnvelope() {
      const text = await Storage.readText(this.dir, "vault.json");
      if (text == null || text.trim() === "") return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error("vault.json 无法读取：" + err.message);
      }
    },

    async loadVaultBackup() {
      const text = await Storage.readText(this.dir, "vault.backup.json");
      if (text == null || text.trim() === "") return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error("vault.backup.json 无法读取：" + err.message);
      }
    },

    async saveVaultEnvelope(envelope) {
      const current = await Storage.readText(this.dir, "vault.json");
      if (current != null && current.trim() !== "") {
        await Storage.writeText(this.dir, "vault.backup.json", current.endsWith("\n") ? current : current + "\n");
      }
      await this.writeJson("vault.json", envelope);
    },

    async restoreVaultBackup() {
      const backup = await this.loadVaultBackup();
      if (!backup) throw new Error("没有可恢复的资料库备份");
      await this.writeJson("vault.json", backup);
      return backup;
    },

    async ensureMeta() {
      const fallback = { projects: DEFAULT_PROJECTS.slice(), lastWeek: null, tools: DEFAULT_TOOLS.slice() };
      let meta;
      try {
        meta = await this.readJson("meta.json", fallback);
      } catch (err) {
        throw new Error("meta.json 无法读取：" + err.message);
      }
      if (!Array.isArray(meta.projects) || meta.projects.length === 0) meta.projects = DEFAULT_PROJECTS.slice();
      meta.tools = Array.isArray(meta.tools) ? normalizeTools(meta.tools) : normalizeTools(DEFAULT_TOOLS);
      meta.git = meta.git ? normalizeGit(meta.git) : normalizeGit(DEFAULT_GIT);
      this.meta = meta;
      return meta;
    },

    async saveMeta() {
      await this.writeJson("meta.json", this.meta);
    },

    gitConfig() {
      return normalizeGit(this.meta ? this.meta.git : DEFAULT_GIT);
    },

    // 只覆盖显式传进来的字段：调用方常常只想改 roots / repos，
    // 不能让发布流水被顺手清掉。
    async saveGitConfig(git) {
      if (!this.meta) await this.ensureMeta();
      const current = normalizeGit(this.meta.git);
      const next = normalizeGit(git);
      const source = git && typeof git === "object" ? git : {};
      this.meta.git = {
        roots: Array.isArray(source.roots) ? next.roots : current.roots,
        repos: Array.isArray(source.repos) ? next.repos : current.repos,
        releases: Array.isArray(source.releases) ? next.releases : current.releases
      };
      await this.saveMeta();
      return this.meta.git;
    },

    // 记一条发布流水（打标签时调用），最新的排在最前，最多留 100 条
    async addRelease(entry) {
      const config = this.gitConfig();
      const record = Object.assign({ id: uid(), at: new Date().toISOString() }, entry || {});
      config.releases = [record].concat(config.releases).slice(0, 100);
      await this.saveGitConfig({ roots: config.roots, repos: config.repos, releases: config.releases });
      return record;
    },

    projects(selected) {
      const names = (this.meta && this.meta.projects ? this.meta.projects : DEFAULT_PROJECTS).slice();
      if (selected && !names.includes(selected)) names.push(selected);
      return names;
    },

    async loadTodos() {
      const todos = await this.readJson("todos.json", []);
      return Array.isArray(todos) ? todos : [];
    },

    async saveTodos(todos) {
      await this.writeJson("todos.json", todos);
      root.dispatchEvent(new CustomEvent("workbench-todos"));
    },

    async loadSoftware() {
      const list = await this.readJson("software.json", []);
      return normalizeSoftware(list);
    },

    async saveSoftware(list) {
      await this.writeJson("software.json", normalizeSoftware(list));
      root.dispatchEvent(new CustomEvent("workbench-software"));
    },

    async loadReports() {
      const reports = await this.readJson("reports.json", []);
      return Array.isArray(reports) ? reports : [];
    },

    async saveReports(reports) {
      await this.writeJson("reports.json", reports);
    },

    async getReport(year, week) {
      const reports = await this.loadReports();
      return reports.find((report) => report.year === year && report.week === week) || null;
    },

    async saveReport(report) {
      const reports = await this.loadReports();
      const index = reports.findIndex((item) => item.year === report.year && item.week === report.week);
      if (index >= 0) reports[index] = report;
      else reports.push(report);
      reports.sort((a, b) => a.year - b.year || a.week - b.week);
      await this.saveReports(reports);
      this.meta.lastWeek = { year: report.year, week: report.week };
      await this.saveMeta();
    },

    async loadNoteIndex() {
      const text = await Storage.readText(this.dir, "notes.json");
      if (text != null && text.trim() !== "") {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
      }
      const legacy = await Storage.readText(this.dir, "notes/index.json");
      if (legacy != null && legacy.trim() !== "") {
        const parsed = JSON.parse(legacy);
        const index = Array.isArray(parsed) ? parsed : [];
        await this.writeJson("notes.json", index);
        return index;
      }
      await this.writeJson("notes.json", []);
      return [];
    },

    async saveNoteIndex(index) {
      await this.writeJson("notes.json", index);
    },

    async readNoteBody(id) {
      const text = await Storage.readText(this.dir, `notes/${id}.md`);
      return text == null ? "" : text;
    },

    async writeNote(note, body) {
      const index = await this.loadNoteIndex();
      const next = Object.assign({}, note, { updatedAt: new Date().toISOString() });
      const pos = index.findIndex((item) => item.id === next.id);
      if (pos >= 0) index[pos] = next;
      else index.unshift(next);
      index.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      await this.saveNoteIndex(index.map((item) => ({
        id: item.id,
        title: item.title,
        kind: item.kind,
        project: item.project,
        pinned: !!item.pinned,
        deletedAt: item.deletedAt || "",
        updatedAt: item.updatedAt
      })));
      await Storage.writeText(this.dir, `notes/${next.id}.md`, body == null ? "" : String(body));
      return next;
    },

    async deleteNote(id) {
      const index = await this.loadNoteIndex();
      await this.saveNoteIndex(index.filter((item) => item.id !== id));
      await Storage.removeFile(this.dir, `notes/${id}.md`);
    }
  };

  root.Workbench = Workbench;
})(typeof window !== "undefined" ? window : globalThis);
