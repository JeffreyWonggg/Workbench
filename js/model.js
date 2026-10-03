(function (root) {
  const DEFAULT_PROJECTS = ["DR23", "DC26", "MR25", "M120", "DC24", "DD2J", "GFF", "OTDR共享平台", "其他"];
  // 首页「工具」菜单的默认为空：清单存在 meta.json 的 tools 字段里，在界面上自己加
  const DEFAULT_TOOLS = [];

  // git 页的默认配置：roots 是代码根目录，repos 是「仓库 → 项目」的绑定表
  const DEFAULT_GIT = { roots: [], repos: [] };

  // 菜谱示例：只在「一条菜谱都没有」时灌一次，方便打开页面就能看到效果。
  // 之后即使把菜谱删光或清空回收站，也不会再自动补回来（由 meta.json 的 recipesSeeded 标记控制）。
  const DEFAULT_RECIPES = [
    {
      id: "rcp-sample-tomato-egg",
      name: "番茄炒蛋",
      category: "家常菜",
      ingredients: ["番茄 2 个", "鸡蛋 3 个", "小葱 1 根", "盐 少许", "白糖 1 小勺", "食用油 适量"],
      steps: [
        "鸡蛋打散，加一小撮盐搅匀；番茄去蒂切块，小葱切末。",
        "热锅倒油，油温五成热下蛋液，凝固定型后盛出。",
        "锅内留底油，下番茄中火炒出汁水，加白糖和盐调味。",
        "倒回炒蛋翻匀，让蛋块裹上汤汁，撒葱花出锅。"
      ]
    },
    {
      id: "rcp-sample-pepper-pork",
      name: "青椒肉丝",
      category: "家常菜",
      ingredients: ["猪里脊 200 克", "青椒 2 个", "生抽 1 勺", "淀粉 1 小勺", "盐 少许", "食用油 适量"],
      steps: [
        "里脊切细丝，加生抽和淀粉抓匀，腌 10 分钟。",
        "青椒去籽切丝。",
        "热锅倒油，下肉丝快速滑散至变色，盛出备用。",
        "下青椒丝炒至断生，回锅肉丝，加盐炒匀即可。"
      ]
    },
    {
      id: "rcp-sample-garlic-lettuce",
      name: "蒜蓉生菜",
      category: "素菜",
      ingredients: ["生菜 1 颗", "大蒜 3 瓣", "生抽 1 勺", "蚝油 半勺", "食用油 适量"],
      steps: [
        "生菜洗净掰散，大蒜切末。",
        "水烧开加少许盐和油，生菜焯 15 秒后捞出沥干。",
        "热锅倒油爆香蒜末，加生抽和蚝油调成味汁。",
        "把味汁浇在生菜上拌匀即可。"
      ]
    },
    {
      id: "rcp-sample-tomato-egg-soup",
      name: "西红柿鸡蛋汤",
      category: "汤",
      ingredients: ["西红柿 1 个", "鸡蛋 1 个", "小葱 1 根", "盐 少许", "香油 几滴"],
      steps: [
        "西红柿切小块，鸡蛋打散，小葱切末。",
        "锅中加两碗水烧开，下西红柿煮 3 分钟。",
        "转小火，沿锅边缓缓淋入蛋液，形成蛋花。",
        "加盐调味，滴香油、撒葱花即可。"
      ]
    },
    {
      id: "rcp-sample-fried-rice",
      name: "蛋炒饭",
      category: "主食",
      ingredients: ["隔夜米饭 2 碗", "鸡蛋 2 个", "火腿 1 小块", "小葱 1 根", "生抽 1 勺", "盐 少许"],
      steps: [
        "鸡蛋打散，火腿切小丁，小葱切末。",
        "热锅倒油，炒散鸡蛋后盛出。",
        "下火腿丁略炒，倒入米饭压散炒匀。",
        "加回鸡蛋，淋生抽、撒盐炒香，撒葱花出锅。"
      ]
    },
    {
      id: "rcp-sample-steamed-egg",
      name: "蒸水蛋",
      category: "早餐",
      ingredients: ["鸡蛋 2 个", "温水 蛋液的 1.5 倍", "盐 少许", "生抽 几滴", "香油 几滴"],
      steps: [
        "鸡蛋打散，加盐和约 1.5 倍温水搅匀。",
        "过筛滤去浮沫，倒入碗中盖上保鲜膜。",
        "上汽后中火蒸 10 分钟，关火再焖 2 分钟。",
        "淋上生抽和香油即可。"
      ]
    }
  ];

  // 「快捷方式」页：清单存在 meta.json 的 shortcuts 字段里（和「工具」菜单同一套思路）。
  // path 既可以是本机文件/文件夹（交给系统默认程序打开），也可以是 http(s) 网址。
  const DEFAULT_SHORTCUTS = [];

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

  function normalizeLang(lang) {
    if (!lang) return "";
    const key = String(lang).toLowerCase().replace(/[^a-z0-9+#]/g, "");
    const map = {
      "c++": "cpp", "c#": "csharp", "cs": "csharp", "c": "c",
      "py": "python", "python": "python",
      "js": "javascript", "javascript": "javascript",
      "ts": "typescript", "typescript": "typescript",
      "sh": "bash", "bash": "bash", "shell": "bash", "zsh": "bash",
      "go": "go", "rust": "rust", "rs": "rust", "java": "java",
      "json": "json", "xml": "xml", "html": "xml", "css": "css",
      "yaml": "yaml", "yml": "yaml", "md": "markdown", "markdown": "markdown",
      "sql": "sql", "kotlin": "kotlin", "kt": "kotlin", "swift": "swift",
      "php": "php", "ruby": "ruby", "rb": "ruby", "dart": "dart",
      "scala": "scala", "lua": "lua", "toml": "toml", "ini": "ini", "r": "r"
    };
    return map[key] || key;
  }

  function highlightCode(code, lang) {
    if (window.hljs) {
      try {
        const clean = code.replace(/\n+$/, "");
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(clean, { language: lang, ignoreIllegals: true }).value;
        }
        return hljs.highlightAuto(clean).value;
      } catch (e) { /* 退化到纯文本 */ }
    }
    return escapeHtml(code);
  }

  function renderMarkdown(src) {
    const raw = String(src || "").replace(/\r\n/g, "\n");
    const fences = [];
    // 先用原始文本抽围栏：保留语言名与原文，避免先 escape 导致 hljs 二次转义。
    // 结束围栏要求独占一行且与开头反引号数量一致（\1）。
    let text = raw.replace(/(`{3,})([^\n]*)\n([\s\S]*?)\n\s*\1(?=\n|$)/g,
      (m, fence, info, code) => {
        const lang = normalizeLang((info.trim().split(/\s+/)[0] || ""));
        const codeHtml = highlightCode(code, lang);
        const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
        fences.push(`<pre class="md-pre"${langAttr}><code>${codeHtml}</code></pre>`);
        return `%%FENCE${fences.length - 1}%%`;
      });
    const escaped = escapeHtml(text);
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
    const title = (report.endDate && report.spanDays)
      ? (() => {
          const end = new Date(report.endDate + "T00:00:00Z");
          const start = Workbench.addUtcDays(end, -(report.spanDays - 1));
          return `${Workbench.formatUtcMonthDay(start)} – ${Workbench.formatUtcMonthDay(end)}（${report.spanDays} 天）`;
        })()
      : `${report.week}周`;
    const lines = [`# ${title}`];
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

  // 快捷方式容错：丢掉没填路径的条目，补齐 id / 名称（缺省用路径最后一段）
  function normalizeShortcuts(list) {
    // 显式给空数组表示「用户不想留任何快捷方式」，此时不回退到默认值
    const source = Array.isArray(list) ? list : DEFAULT_SHORTCUTS;
    const seen = Object.create(null);
    const shortcuts = [];
    source.forEach((item, index) => {
      const path = String((item && item.path) || "").trim();
      if (!path) return;
      let id = String((item && item.id) || "").trim() || "sc-" + (index + 1);
      while (seen[id]) id += "-2";
      seen[id] = true;
      shortcuts.push({
        id,
        label: String((item && item.label) || "").trim()
          || path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()
          || "未命名",
        path,
        note: String((item && item.note) || "").trim()
      });
    });
    return shortcuts;
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

  // 数组字段容错：只保留去空白后的非空字符串。也兼容手写数据时把一个字段
  // 写成多行文本的情况（按行切开），免得手改坏一次页面就崩。
  function toLineArray(value) {
    const source = Array.isArray(value) ? value : String(value == null ? "" : value).split(/\r?\n/);
    return source
      .map((item) => String(item == null ? "" : item).trim())
      .filter((item) => item.length > 0);
  }

  // 菜谱：明文 recipes.json。食材与步骤存成字符串数组（编辑器里一行一项），
  // 这样展示时能逐条渲染，将来要加"合并购物清单"之类也不必迁移数据。
  function normalizeRecipes(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((item) => item && typeof item === "object")
      .map((item, index) => ({
        id: String(item.id || "").trim() || "rcp-" + (index + 1),
        name: String(item.name || "").trim(),
        category: String(item.category || "").trim(),
        ingredients: toLineArray(item.ingredients),
        steps: toLineArray(item.steps),
        createdAt: String(item.createdAt || ""),
        updatedAt: String(item.updatedAt || ""),
        deletedAt: String(item.deletedAt || "")
      }));
  }

  // 记账：明文 ledger.json。金额统一存正数，收/支由 kind 决定——
  // 手改数据时把 -50 写成 50 也只会变成一笔支出，不会把月度合计算反。
  function normalizeLedgers(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((item) => item && typeof item === "object")
      .map((item, index) => {
        const amount = Number(item.amount);
        return {
          id: String(item.id || "").trim() || "led-" + (index + 1),
          date: String(item.date || "").trim() || todayIso(),
          kind: item.kind === "income" ? "income" : "expense",
          amount: Number.isFinite(amount) ? Math.abs(amount) : 0,
          category: String(item.category || "").trim(),
          project: String(item.project || "").trim(),
          note: String(item.note || "").trim(),
          createdAt: String(item.createdAt || ""),
          updatedAt: String(item.updatedAt || ""),
          deletedAt: String(item.deletedAt || "")
        };
      });
  }

  // 收藏：明文 files.json。只存索引，文件本体落在 files/ 与 screenshot/ 目录里。
  // 没有 path 的条目是坏的（读不回本体），直接丢掉。
  function normalizeFiles(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((item) => item && typeof item === "object")
      .map((item, index) => ({
        id: String(item.id || "").trim() || "file-" + (index + 1),
        name: String(item.name || "").trim() || "未命名",
        path: String(item.path || "").trim(),
        size: Number(item.size) || 0,
        type: String(item.type || "").trim(),
        kind: item.kind === "screenshot" ? "screenshot" : "file",
        project: String(item.project || "").trim(),
        note: String(item.note || "").trim(),
        addedAt: String(item.addedAt || ""),
        deletedAt: String(item.deletedAt || "")
      }))
      .filter((item) => item.path);
  }

  // 示例菜谱带上时间戳：越靠前的越新，列表按「最近更新」排下来正好是录入顺序
  function defaultRecipes() {
    const base = Date.now();
    return DEFAULT_RECIPES.map((item, index) => {
      const stamp = new Date(base - index * 60000).toISOString();
      return Object.assign({}, item, { createdAt: stamp, updatedAt: stamp, deletedAt: "" });
    });
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

  // 别的标签页改了同一个数据文件夹时，本页也得知道。同源 BroadcastChannel 最合适：
  // 不用轮询，也不像 storage 事件那样只在 localStorage 上触发。老浏览器没有就退化成本页内通知。
  const channel = (function () {
    try {
      if (typeof root.BroadcastChannel === "function") return new root.BroadcastChannel("workbench");
    } catch (err) { /* 不支持就算了，只是别的标签页看不到实时更新 */ }
    return null;
  })();

  // 上次读到的原文。写之前跟磁盘比对，不一致说明别处改过（另一个标签页、或云同步拉回来的）
  const knownText = Object.create(null);

  // 落地层广播变更：同步模块监听 workbench-write，自己决定什么时候推、推哪些。
  // 页面代码不需要知道同步的存在，同步失败也不该影响本地读写。
  function notifyChange(kind, path) {
    root.dispatchEvent(new CustomEvent("workbench-write", { detail: { kind: kind, path: path } }));
    // 页面听的是 workbench-change：别的标签页发来的变更也走这个事件，页面只认这一个
    root.dispatchEvent(new CustomEvent("workbench-change", { detail: { kind: kind, path: path } }));
    if (channel) {
      try {
        channel.postMessage({ kind: kind, path: path, at: Date.now() });
      } catch (err) { /* 广播不通不影响本机读写 */ }
    }
  }

  if (channel) {
    channel.onmessage = (event) => {
      const data = event.data;
      if (!data || !data.path) return;
      // 只转成页面用的事件：同步模块听的是 workbench-write，
      // 别让它以为本机又有了待推的改动（那边只是别人已经写下去的东西）
      root.dispatchEvent(new CustomEvent("workbench-change", {
        detail: { kind: data.kind, path: data.path, outside: true }
      }));
    };
  }

  // 页面注册自己关心的数据文件：本机一改就回调。第二个参数表示「是别的标签页改的」
  function onChange(paths, handler) {
    const wanted = Array.isArray(paths) ? paths : [paths];
    root.addEventListener("workbench-change", (event) => {
      const detail = event.detail || {};
      if (detail.path && wanted.indexOf(detail.path) >= 0) handler(detail.path, !!detail.outside);
    });
  }

  // 数组且元素带 id 时的合并：以磁盘为底，本地较新的条目压上去，两边独有的都留着。
  // 判不出新旧（没有 updatedAt）时以本地为准——本地这份是用户刚做的操作，不能默默丢掉。
  function mergeById(local, disk) {
    if (!Array.isArray(local) || !Array.isArray(disk)) return null;
    const keyed = (list) => list.every((item) => item && typeof item === "object" && item.id);
    if (!keyed(local) || !keyed(disk)) return null;
    const map = new Map();
    disk.forEach((item) => map.set(item.id, item));
    local.forEach((item) => {
      const other = map.get(item.id);
      if (!other) {
        map.set(item.id, item);
        return;
      }
      const mine = String(item.updatedAt || "");
      const theirs = String(other.updatedAt || "");
      if (!mine || !theirs || mine > theirs) map.set(item.id, item);
    });
    return Array.from(map.values());
  }

  // 写之前先看一眼磁盘：和上次读到的不一样说明别处改过，先并起来再写。
  // 否则这一写会把别人的改动整份抹掉——每个标签页各持一份内存快照时必现。
  async function mergeExternal(fs, path, data) {
    const base = knownText[path];
    if (base === undefined) return data;   // 这一路没读过，无从比对
    let disk = null;
    try {
      disk = await fs.readText(path);
    } catch (err) {
      return data;
    }
    if (disk == null || disk === base) return data;   // 没被改过，照原样写
    let parsed = null;
    try {
      parsed = JSON.parse(disk);
    } catch (err) {
      return data;   // 磁盘上这份是坏的，以我写的为准，顺手把它修好
    }
    const merged = mergeById(data, parsed);
    return merged === null ? data : merged;
  }

  function deletedItems(items) {
    return Array.isArray(items) ? items.filter((item) => isDeleted(item)) : [];
  }

  const Workbench = {
    dir: null,   // 本地文件夹句柄；IndexedDB 后端时为 null
    fs: null,    // 落地后端，接口见 Storage.createLocal / createIndexed
    meta: null,
    status: null,
    DEFAULT_PROJECTS,
    DEFAULT_TOOLS,
    DEFAULT_GIT,
    DEFAULT_SHORTCUTS,
    STATES,
    normalizeTools,
    normalizeShortcuts,
    onChange,
    normalizeGit,
    normalizeSoftware,
    normalizeRecipes,
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
      const status = { ok: false, needsPick: false, needsPermission: false, unsupported: false, backend: "", folderName: "", error: "" };
      this.status = status;
      if (!Storage.hasDirectoryPicker()) {
        // 没有文件夹可用（手机浏览器、非安全上下文）：落到 IndexedDB 后端。
        // 这里判的是"这个环境能不能真的用文件夹"，不是"浏览器有没有这个 API"——
        // 手机上 showDirectoryPicker 也调得起来，早先只判 API 存在，手机就会停在
        // "去选个文件夹"那一步，fs 一直是空的，云同步第一次读本地文件就空指针崩掉。
        // 这里仍然不算 ok，放不放行由云同步决定——配好了并能连上才让页面继续。
        status.unsupported = true;
        status.backend = "indexed";
        this.fs = Storage.createIndexed();
        // 每个页面一上来就取 Workbench.meta.projects，这里不读的话整页都是
        // "Cannot read properties of null (reading 'projects')"。
        // 只读不写：本机落一份默认 meta.json，同步会把它算成"本机改过"推上云，
        // 把别的设备上的项目清单盖掉；留空的话云端那份会被正常拉下来，
        // applyMeta() 再把它补回 this.meta。
        try {
          this.meta = await this.ensureMeta({ readOnly: true });
        } catch (err) {
          status.error = err && err.message ? err.message : "数据打不开";
        }
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
      this.fs = Storage.createLocal(handle);
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
      this.fs = Storage.createLocal(handle);
      this.meta = await this.ensureMeta();
      return handle;
    },

    async requestAccess() {
      const handle = await Storage.loadHandle();
      if (!handle) throw new Error("还没有选择文件夹");
      const perm = await handle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") throw new Error("没有获得读写权限");
      this.dir = handle;
      this.fs = Storage.createLocal(handle);
      this.meta = await this.ensureMeta();
      return handle;
    },

    // 底层读写收口：外部（资料库迁移旧文件、同步模块）走这两个方法，
    // 不要再去碰 Storage 和后端的 handle。
    async readText(path) {
      return this.fs.readText(path);
    },

    async writeText(path, text) {
      await this.fs.writeText(path, text);
      notifyChange("write", path);
    },

    async readJson(path, fallback) {
      const text = await this.fs.readText(path);
      if (text == null || text.trim() === "") {
        await this.writeJson(path, fallback);
        return structuredClone(fallback);
      }
      // 记住读到时的样子：写之前拿它跟磁盘比对，就能判断有没有被别处改过
      knownText[path] = text;
      try {
        return JSON.parse(text);
      } catch (err) {
        // 坏文件以前会一路冒到页面初始化，留下一片空白和一句看不懂的报错
        throw new Error(path + " 读不出来：" + err.message
          + "。可能被手工改坏了，或者上一次没写完。改回正确的 JSON，或用备份覆盖它。");
      }
    },

    async writeJson(path, data) {
      const merged = await mergeExternal(this.fs, path, data);
      const text = JSON.stringify(merged, null, 2) + "\n";
      await this.fs.writeText(path, text);
      knownText[path] = text;
      notifyChange("write", path);
    },

    async removeFile(path) {
      await this.fs.removeFile(path);
      notifyChange("remove", path);
    },

    async loadVaultEnvelope() {
      const text = await this.fs.readText("vault.json");
      if (text == null || text.trim() === "") return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error("vault.json 无法读取：" + err.message);
      }
    },

    async loadVaultBackup() {
      const text = await this.fs.readText("vault.backup.json");
      if (text == null || text.trim() === "") return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error("vault.backup.json 无法读取：" + err.message);
      }
    },

    async saveVaultEnvelope(envelope) {
      const current = await this.fs.readText("vault.json");
      if (current != null && current.trim() !== "") {
        await this.writeText("vault.backup.json", current.endsWith("\n") ? current : current + "\n");
      }
      await this.writeJson("vault.json", envelope);
    },

    async restoreVaultBackup() {
      const backup = await this.loadVaultBackup();
      if (!backup) throw new Error("没有可恢复的资料库备份");
      await this.writeJson("vault.json", backup);
      return backup;
    },

    // readOnly（手机 / IndexedDB 后端用，见 open()）：只把 meta.json 读进内存，
    // 缺了就用内存默认值顶上，绝不落盘。落盘会把「本机还没同步过」伪装成「本机改过」。
    async ensureMeta(options) {
      const fallback = {
        projects: DEFAULT_PROJECTS.slice(),
        lastWeek: null,
        tools: DEFAULT_TOOLS.slice(),
        shortcuts: DEFAULT_SHORTCUTS.slice()
      };
      let meta;
      try {
        if (options && options.readOnly) {
          let text = null;
          try {
            text = await this.fs.readText("meta.json");
          } catch (err) {
            text = null;
          }
          try {
            meta = text == null || text.trim() === "" ? structuredClone(fallback) : JSON.parse(text);
          } catch (err) {
            // 本机这份坏了也不拦着：这个后端只是云端数据的落点，同步会把云端那份拉下来换掉它
            meta = structuredClone(fallback);
          }
        } else {
          meta = await this.readJson("meta.json", fallback);
        }
      } catch (err) {
        throw new Error("meta.json 无法读取：" + err.message);
      }
      if (!Array.isArray(meta.projects) || meta.projects.length === 0) meta.projects = DEFAULT_PROJECTS.slice();
      meta.tools = Array.isArray(meta.tools) ? normalizeTools(meta.tools) : normalizeTools(DEFAULT_TOOLS);
      meta.shortcuts = Array.isArray(meta.shortcuts)
        ? normalizeShortcuts(meta.shortcuts)
        : normalizeShortcuts(DEFAULT_SHORTCUTS);
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

    async loadRecipes() {
      const list = await this.readJson("recipes.json", []);
      const items = normalizeRecipes(list);
      // 头一次打开、且没有一条「还在用」的菜谱时，灌一份示例。
      // 只看未删除的条目：回收站里躺着旧记录也算"没有菜谱"。
      // 已有（含回收站里的）条目会原样保留，示例追加在后面。
      if (activeItems(items).length === 0 && this.meta && !this.meta.recipesSeeded) {
        const seeded = items.concat(normalizeRecipes(defaultRecipes()));
        await this.writeJson("recipes.json", seeded);
        this.meta.recipesSeeded = true;
        await this.saveMeta();
        return seeded;
      }
      return items;
    },

    async saveRecipes(list) {
      await this.writeJson("recipes.json", normalizeRecipes(list));
      root.dispatchEvent(new CustomEvent("workbench-recipes"));
    },

    async loadLedgers() {
      return normalizeLedgers(await this.readJson("ledger.json", []));
    },

    async saveLedgers(list) {
      await this.writeJson("ledger.json", normalizeLedgers(list));
      root.dispatchEvent(new CustomEvent("workbench-ledger"));
    },

    async loadFiles() {
      return normalizeFiles(await this.readJson("files.json", []));
    },

    async saveFiles(list) {
      await this.writeJson("files.json", normalizeFiles(list));
      root.dispatchEvent(new CustomEvent("workbench-files"));
    },

    // 文件本体（二进制）：拖进来的文件、截图都走这两个
    async writeFile(path, blob) {
      await this.fs.writeBinary(path, blob);
      notifyChange("write", path);
    },

    async readFile(path) {
      const buffer = await this.fs.readBinary(path);
      return buffer == null ? null : new Blob([buffer]);
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
      const text = await this.fs.readText("notes.json");
      if (text != null && text.trim() !== "") {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
      }
      const legacy = await this.fs.readText("notes/index.json");
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
      const text = await this.fs.readText(`notes/${id}.md`);
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
      await this.writeText(`notes/${next.id}.md`, body == null ? "" : String(body));
      return next;
    },

    async deleteNote(id) {
      const index = await this.loadNoteIndex();
      await this.saveNoteIndex(index.filter((item) => item.id !== id));
      await this.fs.removeFile(`notes/${id}.md`);
    }
  };

  root.Workbench = Workbench;
})(typeof window !== "undefined" ? window : globalThis);
