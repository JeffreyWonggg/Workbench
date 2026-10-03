(function (root) {
  /* 发布面板：挂在「设置 → 发布」里，把页面发到线上的 CloudBase 静态托管。
     真正干活的还是 scripts/deploy.ps1（挑该发的文件、把密钥和本机数据挡在外面、调 tcb 上传），
     这里只负责三件事：按 /deploy/* 起任务、轮询日志、把结果说清楚。

     任务在服务端跑，所以关掉设置面板、切到别的页面都不影响它；重新打开面板时再拉一次状态。 */

  const RUN_API = "/deploy/run";
  const STATUS_API = "/deploy/status";
  const CANCEL_API = "/deploy/cancel";
  const POLL_MS = 800;
  const BUMP_KEY = "wb-deploy-bump";

  let container = null;   // 面板挂进来的槽位（设置里那个 div）
  let nodes = null;       // 面板里要反复改动的几个节点
  let job = null;         // 最近一次状态：{ hasJob, running, exitCode, log, title, elapsedMs, cancelled }
  let error = "";         // 起任务失败的原因（比如上一次还没跑完）
  let timer = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function toast(text) {
    if (root.Nav && root.Nav.toast) root.Nav.toast(text);
  }

  // 「同时更新同步版本戳」是偶尔才用的（改了 js\sync-*.js 才需要），记在本机，默认不勾
  function bumpOn() {
    try { return localStorage.getItem(BUMP_KEY) === "1"; } catch (err) { return false; }
  }

  function setBump(on) {
    try { localStorage.setItem(BUMP_KEY, on ? "1" : "0"); } catch (err) { }
  }

  function running() {
    return !!(job && job.running);
  }

  async function fetchJson(url, body) {
    const options = body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {};
    const res = await fetch(url, options);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      return { ok: false, error: "本地服务返回的不是 JSON（" + String(text).slice(0, 120) + "）" };
    }
  }

  async function start(only, dryRun) {
    error = "";
    let res;
    try {
      res = await fetchJson(RUN_API, { only: only || "", dryRun: !!dryRun, bump: bumpOn() });
    } catch (err) {
      error = "连不上本地服务：发布要在本机「打开工作台.bat」打开的页面里才用得了";
      paint();
      return;
    }
    if (!res.ok) {
      error = res.error || "起不了发布任务";
      paint();
      return;
    }
    // 先把面板切成「正在发布」，紧接着那次 poll 会拿到真正的状态
    job = { hasJob: true, running: true, exitCode: -1, log: "", title: "", elapsedMs: 0, cancelled: false };
    paint();
    poll();
  }

  async function cancel() {
    let res;
    try {
      res = await fetchJson(CANCEL_API, {});
    } catch (err) {
      error = "连不上本地服务：发布要在本机「打开工作台.bat」打开的页面里才用得了";
      paint();
      return;
    }
    if (!res.ok) {
      error = res.error || "取消失败";
      paint();
    }
  }

  function stopPoll() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // 每 800ms 拉一次：跑着就继续拉，结束了就停（日志一次拿全量，几十行而已）
  async function poll() {
    let res;
    try {
      res = await fetchJson(STATUS_API);
    } catch (err) {
      stopPoll();
      error = "连不上本地服务：发布要在本机「打开工作台.bat」打开的页面里才用得了";
      paint();
      return;
    }
    const was = running();
    job = res;
    if (res.running) {
      if (!timer) timer = setInterval(poll, POLL_MS);
    } else {
      stopPoll();
    }
    paint();
    if (was && !res.running) announce();
  }

  function announce() {
    if (!job) return;
    if (job.cancelled) { toast("发布已取消"); return; }
    if (job.exitCode === 0) { toast("发布完成，手机上刷新页面就能看到"); return; }
    toast("发布失败，设置 → 发布里有日志");
  }

  function mkBtn(text, className, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function build() {
    const box = el("div", "deploy-panel");
    box.append(el("p", "sub",
      "把页面发到线上那台静态托管（手机、别人电脑看到的那一份）。走的是本机 scripts\\deploy.ps1："
      + "自动跳过 js\\openrouter.local.js 这类密钥和本机数据文件，上传前还会再扫一遍。"));

    const opt = el("label", "deploy-opt");
    const bumpBox = document.createElement("input");
    bumpBox.type = "checkbox";
    bumpBox.checked = bumpOn();
    bumpBox.addEventListener("change", () => setBump(bumpBox.checked));
    opt.append(bumpBox, el("span", null,
      "同时更新同步版本戳（改了 js\\sync-*.js 才需要）：顺手把 js/sync-ui.js 的 BUILD 和 index.html 上的 ?v= 改成现在"));
    box.append(opt);

    const row = el("div", "dialog-actions");
    const all = mkBtn("发布全部", "btn primary", () => start("", false));
    const onlyJs = mkBtn("只发 js", "btn", () => start("js", false));
    const dry = mkBtn("空跑看看", "btn", () => start("", true));
    const stop = mkBtn("取消", "btn", cancel);
    row.append(all, onlyJs, dry, el("span", "dialog-spacer"), stop);
    box.append(row);

    const note = el("p", "sync-note is-info", "");
    const log = el("pre", "deploy-log", "");
    box.append(note, log);

    nodes = { all: all, onlyJs: onlyJs, dry: dry, stop: stop, note: note, log: log };
    return box;
  }

  // 只改状态与日志，按钮本身不重建（重建会把正在点的那个按钮的焦点弄丢）
  function paint() {
    if (!nodes) return;
    const busy = running();
    nodes.all.disabled = busy;
    nodes.onlyJs.disabled = busy;
    nodes.dry.disabled = busy;
    nodes.stop.disabled = !busy;

    let text = "还没有发布记录。";
    let kind = "is-info";
    if (error) {
      text = error;
      kind = "is-error";
    } else if (busy) {
      const seconds = Math.max(1, Math.round((job.elapsedMs || 0) / 1000));
      text = "正在发布" + (job.title ? "（" + job.title + "）" : "") + "… 已 " + seconds + " 秒";
    } else if (job && job.hasJob) {
      const seconds = Math.max(0, Math.round((job.elapsedMs || 0) / 1000));
      if (job.cancelled) {
        text = "已取消（" + seconds + " 秒）";
      } else if (job.exitCode === 0) {
        text = "完成，用时 " + seconds + " 秒。手机上刷新页面就能看到。";
        kind = "is-ok";
      } else {
        text = "失败（exit=" + job.exitCode + "），原因见下面的日志。";
        kind = "is-error";
      }
    }
    nodes.note.className = "sync-note " + kind;
    nodes.note.textContent = text;

    const log = (job && job.log) ? job.log : "";
    if (nodes.log.textContent !== log) {
      // 用户正往上翻看旧日志时，别把他拽回底部
      const stick = nodes.log.scrollTop + nodes.log.clientHeight >= nodes.log.scrollHeight - 16;
      nodes.log.textContent = log;
      if (stick) nodes.log.scrollTop = nodes.log.scrollHeight;
    }
  }

  // 打开设置时会反复调用：同一个槽位就地重画（状态在模块里，不会丢）
  function mount(slot) {
    if (!slot) return;
    if (container === slot && nodes) { paint(); poll(); return; }
    container = slot;
    nodes = null;
    slot.innerHTML = "";
    slot.append(build());
    paint();
    poll();
  }

  root.DeployUI = { mount: mount };
})(window);
