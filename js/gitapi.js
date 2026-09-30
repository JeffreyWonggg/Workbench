(function (root) {
  "use strict";

  // 本地服务端 /git/* 的薄封装：
  // - 每次请求自动带上 meta.json 里的代码根目录（服务端据此做越权校验）
  // - 统一超时与错误归一，失败也返回对象（不抛异常），调用方只看 ok / stderr
  // - 状态查询带 20 秒缓存，写操作后由调用方 invalidate()

  const READ_TIMEOUT = 30000;
  const NET_TIMEOUT = 190000;
  const STATUS_TTL = 20000;
  const NET_OPS = ["fetch", "pull", "push", "push-upstream", "push-force", "tag-push"];

  let statusCache = { at: 0, key: "", data: null };

  function roots() {
    try {
      return root.Workbench.gitConfig().roots;
    } catch (err) {
      return [];
    }
  }

  function repoKeys(list) {
    return (list || []).map((item) => String(item).toLowerCase()).sort().join("|");
  }

  async function post(path, payload, timeout) {
    const body = Object.assign({ roots: roots() }, payload || {});
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout || READ_TIMEOUT) : 0;
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
      if (response.status === 403) {
        return fail("被本地服务拒绝（403）。请用「打开工作台.bat」以 http://127.0.0.1:47321 打开本页。");
      }
      if (response.status === 404) {
        return fail("本地服务没有 git 接口（404）。需要重新编译 scripts\\workbench-host.exe 后重启服务。");
      }
      if (!response.ok) {
        return fail("本地服务返回 " + response.status);
      }
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (err) {
        return fail("本地服务返回了非 JSON 内容");
      }
    } catch (err) {
      const aborted = err && err.name === "AbortError";
      return fail(aborted ? "请求超时（命令可能还在后台跑）" : "连不上本地服务：" + (err && err.message ? err.message : "未知错误"));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function fail(message) {
    return { ok: false, repo: "", exitCode: -1, stdout: "", stderr: message, truncated: false, timeout: false };
  }

  // 服务端把 git 的 stderr 原样带回，这里挑一行给用户看
  function errorText(result) {
    if (!result) return "未知错误";
    const raw = String(result.stderr || "").trim();
    if (!raw) return result.ok ? "" : "命令失败";
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^(error|fatal|warning: |使用|usage)/i.test(lines[i])) return lines[i];
    }
    return lines[lines.length - 1] || raw;
  }

  const GitApi = {
    READ_TIMEOUT,
    NET_TIMEOUT,
    post,
    fail,
    errorText,
    roots,

    async scan() {
      return post("/git/scan", {}, READ_TIMEOUT);
    },

    // repos: 仓库绝对路径数组；options.force 绕过缓存
    async status(repos, options) {
      const list = (repos || []).slice();
      const key = repoKeys(list);
      if (!(options && options.force) && statusCache.data && statusCache.key === key && Date.now() - statusCache.at < STATUS_TTL) {
        return statusCache.data;
      }
      const data = await post("/git/status", { repos: list }, READ_TIMEOUT);
      if (data && data.ok) statusCache = { at: Date.now(), key, data };
      return data;
    },

    invalidate() {
      statusCache = { at: 0, key: "", data: null };
    },

    async log(repo, options) {
      const opts = options || {};
      return post("/git/log", {
        repo,
        limit: opts.limit || 50,
        skip: opts.skip || 0,
        ref: opts.ref || ""
      }, READ_TIMEOUT);
    },

    async diff(repo, options) {
      const opts = options || {};
      return post("/git/diff", {
        repo,
        scope: opts.scope || "worktree",
        path: opts.path || "",
        ref: opts.ref || ""
      }, READ_TIMEOUT);
    },

    async branches(repo) {
      return post("/git/branches", { repo }, READ_TIMEOUT);
    },

    async tags(repo) {
      return post("/git/tags", { repo }, READ_TIMEOUT);
    },

    // fields: { paths } | { ref } | { name, message } | { message }
    async exec(repo, op, fields) {
      const payload = Object.assign({ repo, op }, fields || {});
      return post("/git/exec", payload, NET_OPS.indexOf(op) >= 0 ? NET_TIMEOUT : READ_TIMEOUT);
    },

    isNetOp(op) {
      return NET_OPS.indexOf(op) >= 0;
    }
  };

  root.GitApi = GitApi;
})(typeof window !== "undefined" ? window : this);
