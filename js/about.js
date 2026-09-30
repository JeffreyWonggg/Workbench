(function () {
  const BASE = "http://127.0.0.1:47321/";
  const INFO_FILE = "about.json";

  // 「关于」页的文案全部来自 about.json，改那个文件就行，不用动代码。
  // 文件读不到（被删了或格式坏了）时用下面的兜底值，页面不至于空白。
  const DEFAULTS = {
    name: "工作台",
    description: "完全离线运行的个人工作台。数据保存在你自己的文件夹中。",
    author: "Zhenhui Wang",
    version: "1.0.0",
    copyright: ""
  };

  Nav.boot("about", async () => {
    const about = await loadInfo();
    const name = text(about, "name") || DEFAULTS.name;
    const version = text(about, "version") || DEFAULTS.version;
    const author = text(about, "author") || DEFAULTS.author;
    const copyright = text(about, "copyright") || ("© " + new Date().getFullYear() + " " + author);

    document.title = "关于 · " + name;
    document.getElementById("about-name").textContent = name;
    document.getElementById("about-desc").textContent = text(about, "description") || DEFAULTS.description;
    document.getElementById("about-version").textContent = withPrefix(version);
    document.getElementById("about-version-row").textContent = withPrefix(version);
    document.getElementById("about-author").textContent = author;
    document.getElementById("about-copyright").textContent = copyright;

    renderFolder();
    await renderHost();
  }, { optionalFolder: true });

  async function loadInfo() {
    try {
      const response = await fetch(INFO_FILE, { cache: "no-store" });
      if (!response.ok) return null;
      const data = await response.json();
      return data && typeof data === "object" ? data : null;
    } catch (err) {
      return null;
    }
  }

  function text(source, key) {
    const value = source ? source[key] : "";
    if (value == null) return "";
    return String(value).trim();
  }

  // 版本号统一显示成 v1.0.0：填了 v 也不会变成 vv
  function withPrefix(version) {
    const value = String(version || "").trim();
    if (!value) return "—";
    return "v" + value.replace(/^v/i, "");
  }

  function renderFolder() {
    const el = document.getElementById("about-folder");
    const status = Workbench.status || {};
    if (status.ok && status.folderName) {
      el.textContent = status.folderName;
      return;
    }
    el.textContent = "未连接（点侧栏「选择数据文件夹」）";
  }

  async function renderHost() {
    const hostEl = document.getElementById("about-host");
    const iniEl = document.getElementById("about-ini");
    try {
      const response = await fetch(BASE + "config", { cache: "no-store" });
      if (!response.ok) throw new Error("config failed");
      const data = await response.json();
      hostEl.textContent = "运行中 · " + BASE.replace(/\/$/, "");
      iniEl.textContent = data.configured ? data.iniPath : "未指定";
    } catch (err) {
      hostEl.textContent = "未连接（双击「打开工作台」启动）";
      iniEl.textContent = "—";
    }
  }
})();
