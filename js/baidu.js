(function (root) {
  /* 「出行路况」卡片
     只监控一条固定驾车线路（如家→公司），同时服务两件事：

       看当前状态：预计耗时、里程、实时路况，以及"现在走值不值"的一句结论。
       想知道堵在哪一段，点「看分段路况」——分段明细本来就随每次采集一起回来了，
       点开只是把它显示出来（见服务端 BaiduRouteJson）。
       看时间段规律：点「详情」——某一天的小时段平均耗时（24 根柱，可挑最近 30 天里的任一天）、
       最近七天每天的平均耗时条形图（数值直接写在柱子上）、最近 30 天热力格。
       「现在走值不值」那句结论仍然拿工作日/周末的同时段历史均值当基准。

     取数不经过浏览器直连百度（Web 服务 API 没有 CORS 头），而是打同源接口
     GET /baidu/route，由 workbench-host.exe 拿着根目录 baidu.local.json 里的 AK
     去问百度，再把精简结果回给页面——AK 永远不会出现在这里。
     每次成功取到数据都往数据文件夹的 commute.json 追加一条样本，
     样本是统计的唯一依据，所以按 180 天 / 12000 条裁剪，体积保持在几百 KB。
     字段用短名压缩：t=时间戳(ms)、d=耗时(秒)、m=距离(米)、x=路况文案。

     页面不一定一直开着，所以本机服务自己也有一份采集（/baidu/watch、/baidu/spool）：
     线路由这里同步过去，服务端每 15 分钟采一条攒在仓库根目录的 spool 文件里，
     页面打开时取回来、按时间戳去重后并进 commute.json。页面自己采到的那条也会
     回传一份，两边共用同一条采集时间线，谁都不会重复问百度。 */

  const FILE = "commute.json";
  const ROUTE_API = "/baidu/route";
  const STATUS_API = "/baidu/status";
  const GEOCODE_API = "/baidu/geocode";
  const SUGGEST_API = "/baidu/suggest";
  const WATCH_API = "/baidu/watch";
  const SPOOL_API = "/baidu/spool";
  const FRESH_MS = 15 * 60 * 1000;
  const DETAIL_FRESH_MS = 60 * 1000;
  const TICK_MS = 30 * 1000;
  const REQUEST_TIMEOUT = 12000;
  const KEEP_DAYS = 180;
  const MAX_SAMPLES = 12000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HEAT_DAYS = 30;
  const WEEK_DAYS = 7;   // 详情里「最近七天」的柱子数
  const HOURS = 24;
  const WEEK_LABEL = ["日", "一", "二", "三", "四", "五", "六"];
  const PER_HOUR = 4;           // 15 分钟采一条，一个小时段满格 4 条
  const DAY_PICK_DAYS = 30;     // 详情里能往回挑多少天，跟热力格同一个口径

  let store = null;
  let lastError = "";
  let busy = false;
  let timer = null;
  let configDialog = null;
  let statsDialog = null;
  let detail = null;      // 分段明细（按需取，见 segmentBlock）
  let detailOpen = false;
  let detailBusy = false;
  let detailError = "";
  let statDay = 0;        // 详情里正看着哪一天（那天的零点时间戳；0 = 还没选，按今天算）
  let pickedHour = -1;    // 详情里点中的小时段，-1 表示没点过（那就显示这天最慢的一段）

  // view 是早期「工作日 / 周末」两个页签留下的字段，页签撤掉后不再写也不再读
  function emptyStore() {
    return { version: 1, route: null, last: null, samples: [] };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ===== 数据 ===== */

  function point(raw) {
    if (!raw || typeof raw !== "object") return null;
    const text = String(raw.text == null ? "" : raw.text).trim();
    if (!text) return null;
    return {
      text: text,
      lat: String(raw.lat == null ? "" : raw.lat).trim(),
      lng: String(raw.lng == null ? "" : raw.lng).trim()
    };
  }

  function cleanSample(item) {
    if (!item || typeof item !== "object") return null;
    const t = Number(item.t);
    const d = Number(item.d);
    if (!Number.isFinite(t) || !Number.isFinite(d) || t <= 0 || d <= 0) return null;
    const m = Number(item.m);
    return { t: t, d: Math.round(d), m: Number.isFinite(m) && m > 0 ? Math.round(m) : 0, x: String(item.x == null ? "" : item.x) };
  }

  function prune(samples) {
    const limit = Date.now() - KEEP_DAYS * DAY_MS;
    const kept = [];
    for (let i = 0; i < samples.length && kept.length < MAX_SAMPLES; i++) {
      if (samples[i].t >= limit) kept.push(samples[i]);
    }
    return kept;
  }

  function normalize(raw) {
    const base = emptyStore();
    if (!raw || typeof raw !== "object") return base;
    const route = raw.route && typeof raw.route === "object" ? raw.route : null;
    const origin = route ? point(route.origin) : null;
    const destination = route ? point(route.destination) : null;
    const samples = Array.isArray(raw.samples) ? raw.samples.map(cleanSample).filter(Boolean) : [];
    samples.sort((a, b) => b.t - a.t);
    return {
      version: 1,
      route: origin && destination ? { origin: origin, destination: destination } : null,
      last: raw.last && typeof raw.last === "object" ? raw.last : null,
      samples: prune(samples)
    };
  }

  // 有坐标就发坐标（位置不会漂），没有就把地址交给服务端解析
  function coordOf(place) {
    return place.lat && place.lng ? place.lat + "," + place.lng : place.text;
  }

  /* ===== 取数 ===== */

  async function fetchJson(url) {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    let response;
    try {
      response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("本机服务没在 12 秒内回应");
      throw new Error("连不上本机服务，确认 workbench-host.exe 在跑");
    } finally {
      clearTimeout(abort);
    }
    if (response.status === 403) throw new Error("本机服务拒绝了这次请求（试试用本机地址打开）");
    if (!response.ok) throw new Error("本机服务返回 " + response.status);
    try {
      return await response.json();
    } catch (err) {
      throw new Error("本机服务返回的不是 JSON");
    }
  }

  async function refresh(manual) {
    if (busy) return;
    if (!store || !store.route) {
      if (manual) Nav.toast("还没有设置线路");
      return;
    }
    busy = true;
    paintBusy(true);
    try {
      let url = ROUTE_API
        + "?origin=" + encodeURIComponent(coordOf(store.route.origin))
        + "&destination=" + encodeURIComponent(coordOf(store.route.destination));

      const payload = await fetchJson(url);
      if (!payload || payload.ok !== true) {
        throw new Error(payload && payload.error ? payload.error : "接口没有返回路况");
      }

      // 把服务端解析出的经纬度记下来，下次直接发坐标，省一次地理编码
      copyCoord(payload.origin, store.route.origin);
      copyCoord(payload.destination, store.route.destination);

      const duration = Math.round(Number(payload.duration) || 0);
      const distance = Math.round(Number(payload.distance) || 0);
      const traffic = String(payload.traffic == null ? "" : payload.traffic);
      const at = payload.at ? String(payload.at) : new Date().toISOString();
      const stamp = new Date(at).getTime();
      // 服务端 60 秒内会直接复用上次结果，时间戳可能和最新一条样本一样；
      // 那种情况只更新当前值，不再塞一条重复样本进去（免得把平均值带偏）。
      const newest = store.samples[0];
      if (duration > 0 && !(newest && newest.t === stamp)) {
        store.samples.unshift({ t: Number.isFinite(stamp) ? stamp : Date.now(), d: duration, m: distance, x: traffic });
      }
      store.samples = prune(store.samples);
      store.last = {
        at: at,
        duration: duration,
        distance: distance,
        traffic: traffic,
        origin: store.route.origin.text,
        destination: store.route.destination.text
      };
      await Workbench.writeJson(FILE, store);
      // 自己采的这条回传一份：本机服务拿它判断"刚采过"，就不会再打一次百度
      if (duration > 0) reportSample({ t: Number.isFinite(stamp) ? stamp : Date.now(), d: duration, m: distance, x: traffic });
      lastError = "";
      if (manual) Nav.toast("路况已更新");
    } catch (err) {
      lastError = err && err.message ? err.message : "取路况失败";
      if (manual) Nav.toast("没有更新：" + lastError);
    } finally {
      busy = false;
      paintBusy(false);
      render();
    }
  }

  function copyCoord(source, place) {
    if (!source) return;
    if (source.lat) place.lat = String(source.lat);
    if (source.lng) place.lng = String(source.lng);
  }

  /* ===== 和本机服务对表：后端定时采集 ===== */

  // 把线路交给本机服务，让它在后台每 15 分钟自己采一条；route 为 null 就是叫它别采了。
  // 服务不在（纯 HTTPS 托管页）、或本机校验没过（手机经局域网打开）时静默跳过：
  // 后端定时采集用不上，但页面自己的取数、统计一点都不受影响。
  function syncWatch() {
    const route = store && store.route;
    postJson(WATCH_API, {
      route: route
        ? { origin: coordOf(route.origin), destination: coordOf(route.destination) }
        : null
    });
  }

  // 把本机服务攒下的样本并进本地统计：页面没开的那段时间，一直是它在采。
  // 服务端采的和页面自己采的都在同一份 spool 里，所以按时间戳去重就够了。
  async function syncSpool() {
    if (!store || !store.route) return 0;
    let payload;
    try {
      payload = await fetchJson(SPOOL_API);
    } catch (err) {
      return 0; // 取不到就当这轮没有新样本
    }
    if (!payload || payload.ok !== true || !Array.isArray(payload.samples)) return 0;

    const known = {};
    for (let i = 0; i < store.samples.length; i++) known[store.samples[i].t] = true;
    const fresh = [];
    for (let i = 0; i < payload.samples.length; i++) {
      const sample = cleanSample(payload.samples[i]);
      if (!sample || known[sample.t]) continue;
      known[sample.t] = true;
      fresh.push(sample);
    }
    if (!fresh.length) return 0;

    store.samples = prune(store.samples.concat(fresh).sort((a, b) => b.t - a.t));
    // 页面关着的时候服务端一直在采：卡片上的「当前」也得跟着推到最新那条
    const newest = store.samples[0];
    if (newest && (!store.last || !store.last.at || new Date(store.last.at).getTime() < newest.t)) {
      store.last = {
        at: new Date(newest.t).toISOString(),
        duration: newest.d,
        distance: newest.m,
        traffic: newest.x || "",
        origin: store.route.origin.text,
        destination: store.route.destination.text
      };
    }
    try {
      await Workbench.writeJson(FILE, store);
    } catch (err) {
      lastError = "服务端采到的样本并进 " + FILE + " 时写盘失败";
    }
    return fresh.length;
  }

  function reportSample(sample) {
    if (sample) postJson(SPOOL_API, { samples: [sample] });
  }

  // 只发不管结果：本机服务的写接口只认本机页面，手机/托管页静默忽略就行
  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).catch(() => null);
  }

  /* ===== 统计 ===== */

  function emptyBuckets() {
    const list = [];
    for (let i = 0; i < HOURS; i++) list.push({ sum: 0, count: 0 });
    return list;
  }

  function aggregate() {
    const buckets = { workday: emptyBuckets(), weekend: emptyBuckets() };
    const days = {};
    const now = Date.now();
    let recentSum = 0;
    let recentCount = 0;
    for (let i = 0; i < store.samples.length; i++) {
      const sample = store.samples[i];
      const date = new Date(sample.t);
      const group = isWeekend(date.getDay()) ? "weekend" : "workday";
      const bucket = buckets[group][date.getHours()];
      bucket.sum += sample.d;
      bucket.count += 1;
      if (now - sample.t <= DAY_MS) {
        recentSum += sample.d;
        recentCount += 1;
      }
      const key = dayKey(date);
      if (!days[key]) days[key] = { sum: 0, count: 0, at: sample.t };
      days[key].sum += sample.d;
      days[key].count += 1;
    }
    return {
      buckets: buckets,
      days: days,
      recentMean: recentCount ? recentSum / recentCount : 0,
      recentCount: recentCount,
      total: store.samples.length,
      coveredDays: Object.keys(days).length
    };
  }

  /* 某一天的小时段：把那天 0 点到 24 点之间的样本按小时归拢（15 分钟采一条，
     所以每段通常 4 条；只走通勤时段的线路，夜里那些段自然是 0 条）。 */
  function dayHours(stamp) {
    const buckets = emptyBuckets();
    const start = startOfDay(stamp);
    const end = start + DAY_MS;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < store.samples.length; i++) {
      const sample = store.samples[i];
      if (sample.t < start || sample.t >= end) continue;
      const bucket = buckets[new Date(sample.t).getHours()];
      bucket.sum += sample.d;
      bucket.count += 1;
      sum += sample.d;
      count += 1;
    }
    return { buckets: buckets, sum: sum, count: count };
  }

  function startOfDay(stamp) {
    const day = new Date(stamp);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  }

  // 能往回挑的范围：今天往前 30 天（跟热力格同一个口径）
  function pickRange() {
    const today = startOfDay(Date.now());
    return { min: today - (DAY_PICK_DAYS - 1) * DAY_MS, max: today };
  }

  // <input type="date"> 给的是 "2026-10-03"，按本地时区还原成那天的零点
  function dayStamp(value) {
    const parts = String(value == null ? "" : value).split("-");
    if (parts.length !== 3) return 0;
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (Number.isNaN(date.getTime())) return 0;
    return startOfDay(date.getTime());
  }

  function isWeekend(dow) {
    return dow === 0 || dow === 6;
  }

  function groupLabel(group) {
    return group === "weekend" ? "周末" : "工作日";
  }

  function currentGroup() {
    return isWeekend(new Date().getDay()) ? "weekend" : "workday";
  }

  function dayKey(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function clockText(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  // 时长一律按「x 时 x 分」写：不足一小时只写「x 分」，正好整点只写「x 时」
  function durationText(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) / 60));
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    if (hours <= 0) return minutes + " 分";
    if (minutes === 0) return hours + " 时";
    return hours + " 时 " + minutes + " 分";
  }

  function kilometersText(meters) {
    return (meters / 1000).toFixed(1) + " 公里";
  }

  // 柱子上那行字要窄：统一按分钟写，超过一小时也不写成「1 时 30 分」，
  // 否则窄屏下相邻两根柱子的数字会挤到一起（悬浮里的完整写法仍是 durationText）
  function minutesText(seconds) {
    return Math.round(Number(seconds) / 60) + " 分";
  }

  // 基准：优先用"当前时段 + 当前是工作日/周末"的历史均值；
  // 那种样本太少时退回最近 24 小时，避免拿一两天的数据当规律。
  function baseline(agg, group) {
    const bucket = agg.buckets[group][new Date().getHours()];
    if (bucket.count >= 3) {
      return { value: bucket.sum / bucket.count, source: groupLabel(group) + " " + pad(new Date().getHours()) + " 点", count: bucket.count };
    }
    if (agg.recentCount >= 3) {
      return { value: agg.recentMean, source: "最近 24 小时", count: agg.recentCount };
    }
    return null;
  }

  /* ===== 渲染：卡片上的当前状态 ===== */

  function paintBusy(state) {
    const button = document.getElementById("commute-refresh");
    if (button) button.disabled = state;
  }

  function actionButton(label, onClick) {
    const node = el("button", "linkish");
    node.type = "button";
    node.textContent = label;
    node.addEventListener("click", onClick);
    return node;
  }

  function minMax(values) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < values.length; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    return { min: min, max: max };
  }

  function render() {
    const card = document.getElementById("commute-card");
    const body = document.getElementById("commute-box");
    if (!card || !body) return;
    card.hidden = false;
    body.innerHTML = "";

    if (!store.route) {
      body.append(el("p", "empty", "还没设线路。设一条（比如家 → 公司），以后每 15 分钟就帮你看一次路况。"));
      body.append(actionButton("设置线路", openConfig));
      return;
    }

    body.append(routeLine());
    if (!store.last || !store.last.duration) {
      body.append(el("p", "empty", lastError ? "还没取到路况：" + lastError : "正在读取路况…"));
      const actions = el("div", "commute-actions");
      actions.append(actionButton("重新读取", () => refresh(true)));
      actions.append(actionButton("设置线路", openConfig));
      body.append(actions);
      return;
    }

    const agg = aggregate();
    body.append(figure());
    body.append(deltaBar(agg));
    body.append(verdictLine(agg));
    body.append(segmentBlock());
    if (lastError) body.append(el("p", "commute-note muted", "上次刷新失败：" + lastError));
  }

  function routeLine() {
    const line = el("div", "commute-route");
    line.append(el("span", "commute-pair", store.route.origin.text + " → " + store.route.destination.text));
    const clock = store.last && store.last.at ? clockText(store.last.at) : "";
    line.append(el("span", "muted", clock ? clock + " 更新" : "还没取到数据"));
    return line;
  }

  function figure() {
    const box = el("div", "commute-figure");
    const left = el("div", "commute-figure-main");
    // 主数字拆成「数字 + 单位」，单位沿用 .commute-value span 的小字号
    const value = el("div", "commute-value");
    const totalMinutes = Math.round(store.last.duration / 60);
    const hours = Math.floor(totalMinutes / 60);
    const restMinutes = totalMinutes % 60;
    if (hours > 0) {
      value.append(document.createTextNode(String(hours)));
      value.append(el("span", null, "时"));
    }
    if (hours <= 0 || restMinutes > 0) {
      value.append(document.createTextNode(String(restMinutes)));
      value.append(el("span", null, "分"));
    }
    left.append(value);
    const meta = [kilometersText(Number(store.last.distance) || 0)];
    if (store.last.traffic) meta.push(store.last.traffic);
    left.append(el("p", "commute-meta muted", meta.join(" · ")));
    box.append(left);
    box.append(sparkline());
    return box;
  }

  // 最近 24 小时的迷你折线：只看"今天在变好还是变差"，所以不画坐标轴
  function sparkline() {
    const box = el("div", "commute-spark");
    const now = Date.now();
    const points = [];
    for (let i = store.samples.length - 1; i >= 0; i--) {
      if (now - store.samples[i].t <= DAY_MS) points.push(store.samples[i]);
    }
    if (points.length < 2) {
      box.append(el("p", "muted", "再跑几次就能看出今天的走势"));
      return box;
    }
    const values = points.map((sample) => sample.d);
    const stats = minMax(values);
    const span = stats.max - stats.min || 1;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 100 30");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "最近 24 小时的耗时走势");
    const coords = [];
    for (let i = 0; i < points.length; i++) {
      coords.push([(i / (points.length - 1)) * 100, 27 - ((points[i].d - stats.min) / span) * 24]);
    }
    const line = document.createElementNS(ns, "polyline");
    line.setAttribute("points", coords.map((p) => p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" "));
    line.setAttribute("class", "commute-spark-line");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(line);
    const tail = coords[coords.length - 1];
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", tail[0].toFixed(2));
    dot.setAttribute("cy", tail[1].toFixed(2));
    dot.setAttribute("r", "2.4");
    dot.setAttribute("class", "commute-spark-dot");
    svg.append(dot);
    box.append(svg);
    box.append(el("p", "muted", "最近 24 小时 · " + durationText(stats.min) + " ~ " + durationText(stats.max)));
    return box;
  }

  // 偏差条：以基准均值为中线，右边是更慢（红）、左边是更快（绿）
  function deltaBar(agg) {
    const box = el("div", "commute-delta");
    const base = baseline(agg, currentGroup());
    const current = store.last.duration;
    if (!base) {
      box.append(el("p", "muted", "样本还太少，先按 " + durationText(current) + " 记着"));
      return box;
    }
    const ratio = (current - base.value) / base.value;
    const tone = ratio > 0.12 ? "danger" : (ratio < -0.12 ? "ok" : "hold");
    const width = Math.min(50, Math.abs(ratio) * 100);
    const bar = el("div", "commute-bar");
    const fill = el("span", "commute-bar-fill " + tone);
    fill.style.left = (ratio >= 0 ? 50 : 50 - width) + "%";
    fill.style.width = Math.max(1.5, width) + "%";
    bar.append(fill);
    box.append(bar);

    const diff = Math.round((current - base.value) / 60);
    let text;
    if (diff === 0) {
      text = "跟" + base.source + "的平均（" + durationText(base.value) + "）基本一样";
    } else {
      text = "比" + base.source + "的平均（" + durationText(base.value) + "）"
        + (diff > 0 ? "慢 " + durationText(diff * 60) : "快 " + durationText(-diff * 60));
    }
    box.append(el("p", "muted", text));
    return box;
  }

  function verdictLine(agg) {
    const line = el("p", "commute-verdict");
    const base = baseline(agg, currentGroup());
    const current = store.last.duration;
    if (!base) {
      line.append(el("i", "commute-dot hold"));
      line.append(document.createTextNode("样本还太少，先跑几天再看结论"));
      return line;
    }
    const ratio = (current - base.value) / base.value;
    const diff = Math.abs(Math.round((current - base.value) / 60));
    if (ratio <= -0.12) {
      line.append(el("i", "commute-dot ok"));
      line.append(document.createTextNode("现在走合适：比平时快 " + durationText(diff * 60) + "，趁现在出门"));
    } else if (ratio < 0.12) {
      line.append(el("i", "commute-dot ok"));
      line.append(document.createTextNode("路况正常，按平常的时间出门就行"));
    } else if (ratio < 0.3) {
      line.append(el("i", "commute-dot hold"));
      line.append(document.createTextNode("有点堵：比平时慢 " + durationText(diff * 60) + "，路上留点余量"));
    } else {
      line.append(el("i", "commute-dot danger"));
      line.append(document.createTextNode("明显堵：比平时慢 " + durationText(diff * 60) + "，建议错峰"));
    }
    return line;
  }

  /* ===== 分段明细：默认收起，点开再看（数据其实已经随采集带回来了） ===== */

  // 服务端每次采集都是一次完整版请求，分段明细（哪条路堵多少米）也在里面，
  // 所以点开时复用 60 秒缓存就行；这里再发一次只是为了防止上一次采集已经过去很久。
  function segmentBlock() {
    const box = el("div", "commute-seg");
    const head = el("div", "commute-seg-head");
    head.append(actionButton(detailOpen ? "收起分段" : "看分段路况", toggleSegments));
    if (detailOpen && detail) {
      const bits = [];
      if (detail.traffic) bits.push(detail.traffic);
      const clock = detail.at ? clockText(detail.at) : "";
      if (clock) bits.push(clock + " 取");
      if (bits.length) head.append(el("span", "commute-seg-sum muted", bits.join(" · ")));
    }
    box.append(head);

    if (!detailOpen) return box;

    if (detailBusy) {
      box.append(el("p", "commute-seg-note muted", "正在问百度要分段明细…"));
      return box;
    }
    if (detailError) {
      box.append(el("p", "commute-seg-note muted", "没取到分段：" + detailError));
      return box;
    }
    if (!detail || !detail.segments.length) {
      box.append(el("p", "commute-seg-note muted", "百度这次没给出分段明细。"));
      return box;
    }

    const rows = detail.segments.filter((segment) => segment.level > 1).sort(byWorst);
    if (!rows.length) {
      box.append(el("p", "commute-seg-note muted", "整条路线都是畅通的，没有要绕开的路段。"));
      return box;
    }
    const list = el("div", "commute-seg-list");
    rows.slice(0, 8).forEach((segment) => list.append(segmentRow(segment)));
    box.append(list);
    if (rows.length > 8) {
      box.append(el("p", "commute-seg-note muted",
        "还有 " + (rows.length - 8) + " 段缓行或拥堵，先列最要紧的前 8 段。"));
    }
    return box;
  }

  // 把最差的排前面；同样堵，先看堵得长的那段
  function byWorst(a, b) {
    if (b.level !== a.level) return b.level - a.level;
    if (b.jam !== a.jam) return b.jam - a.jam;
    return b.duration - a.duration;
  }

  function segmentRow(segment) {
    const row = el("div", "commute-seg-row");
    row.append(el("i", "commute-dot " + (segment.level >= 3 ? "danger" : "hold")));
    row.append(el("span", "commute-seg-road", segment.road || "未命名路段"));
    const bits = [levelText(segment.level)];
    if (segment.jam > 0) bits.push(metersText(segment.jam));
    if (segment.duration > 0) bits.push(durationText(segment.duration));
    row.append(el("span", "commute-seg-meter muted", bits.join(" · ")));
    return row;
  }

  function levelText(level) {
    if (level >= 4) return "严重拥堵";
    return level === 3 ? "拥堵" : "缓行";
  }

  // 几百米写成「米」更好读，上了公里才换成公里
  function metersText(meters) {
    return meters >= 1000 ? (meters / 1000).toFixed(1) + " 公里" : Math.round(meters) + " 米";
  }

  function toggleSegments() {
    detailOpen = !detailOpen;
    if (detailOpen && !detailBusy && staleDetail()) {
      loadSegments();
      return;
    }
    render();
  }

  // 「哪条路在堵」是一分钟一变的信息，手里这份旧了就重新问一次。
  // 服务端同一线路 60 秒内直接复用上次结果，所以连着点开收起也不会真的多打百度。
  function staleDetail() {
    if (!detail) return true;
    const at = detail.at ? new Date(detail.at).getTime() : 0;
    if (!Number.isFinite(at) || !at) return true;
    return Date.now() - at >= DETAIL_FRESH_MS;
  }

  async function loadSegments() {
    if (detailBusy || !store || !store.route) return;
    detailBusy = true;
    detailError = "";
    render();
    try {
      const payload = await fetchJson(ROUTE_API + "?detail=1"
        + "&origin=" + encodeURIComponent(coordOf(store.route.origin))
        + "&destination=" + encodeURIComponent(coordOf(store.route.destination)));
      if (!payload || payload.ok !== true) {
        throw new Error(payload && payload.error ? payload.error : "接口没有返回分段明细");
      }
      copyCoord(payload.origin, store.route.origin);
      copyCoord(payload.destination, store.route.destination);
      detail = {
        at: payload.at ? String(payload.at) : "",
        traffic: String(payload.traffic == null ? "" : payload.traffic),
        segments: Array.isArray(payload.segments) ? payload.segments.map(cleanSegment).filter(Boolean) : []
      };
    } catch (err) {
      detail = null;
      detailError = err && err.message ? err.message : "取分段明细失败";
    } finally {
      detailBusy = false;
      render();
    }
  }

  function cleanSegment(raw) {
    if (!raw || typeof raw !== "object") return null;
    const level = Math.round(Number(raw.level));
    return {
      road: String(raw.road == null ? "" : raw.road).trim(),
      level: Number.isFinite(level) ? Math.min(4, Math.max(1, level)) : 1,
      distance: Number(raw.distance) || 0,
      duration: Number(raw.duration) || 0,
      jam: Number(raw.jam) || 0,
      slow: Number(raw.slow) || 0
    };
  }

  // 换了线路，之前那份分段明细说的就不是这条路了
  function resetDetail() {
    detail = null;
    detailError = "";
    detailOpen = false;
  }

  /* ===== 详情弹窗：时间段统计 ===== */

  let statsParts = null;

  function openStats() {
    if (!statsDialog) statsDialog = buildStatsDialog();
    if (!store.route) {
      Nav.toast("先设置一条线路，才有统计");
      openConfig();
      return;
    }
    paintStats();
    if (typeof statsDialog.showModal === "function") statsDialog.showModal();
  }

  function buildStatsDialog() {
    const dialog = el("dialog", "code-dialog commute-stats-dialog");
    const form = el("form", "commute-stats");
    form.method = "dialog";
    form.append(el("h3", null, "出行路况 · 统计"));

    const summary = el("p", "commute-summary muted");
    form.append(summary);

    form.append(el("h4", null, "最近七天"));
    const bars = el("div", "commute-bars-host");
    form.append(bars);

    form.append(el("h4", null, "某一天的小时段（1 小时一段）"));
    const dayHead = el("div", "commute-day-head");
    const dayInput = document.createElement("input");
    dayInput.type = "date";
    dayInput.className = "commute-day-input";
    dayInput.addEventListener("change", () => {
      const stamp = dayStamp(dayInput.value);
      if (!stamp) return; // 手输半截或清空时先不动，等它成为完整日期
      statDay = stamp;
      pickedHour = -1;
      paintDayHours();
    });
    const dayToday = el("button", "btn", "今天");
    dayToday.type = "button";
    dayToday.addEventListener("click", () => {
      statDay = pickRange().max;
      pickedHour = -1;
      paintDayHours();
    });
    dayHead.append(dayInput, dayToday, el("span", "muted", "每段取这一小时里的样本平均"));
    const daySum = el("p", "commute-day-sum muted");
    const hours = el("div", "commute-hours-host");
    const dayPick = el("p", "commute-day-pick muted");
    form.append(dayHead, daySum, hours, dayPick);

    form.append(el("h4", null, "最近 30 天"));
    const heat = el("div", "commute-heat-host");
    form.append(heat);

    const actions = el("div", "dialog-actions");
    const close = el("button", "btn", "关闭");
    close.type = "submit";
    close.value = "close";
    actions.append(close);
    form.append(actions);

    dialog.append(form);
    document.body.append(dialog);
    statsParts = {
      summary: summary,
      bars: bars,
      heat: heat,
      dayInput: dayInput,
      dayToday: dayToday,
      daySum: daySum,
      dayPick: dayPick,
      hours: hours
    };
    return dialog;
  }

  function paintStats() {
    if (!statsParts) return;
    const agg = aggregate();
    const days = weekDays(agg);

    let sum = 0;
    let count = 0;
    days.forEach((item) => {
      if (!item.entry) return;
      sum += item.entry.sum;
      count += item.entry.count;
    });
    const bits = ["样本 " + agg.total + " 条", "覆盖 " + agg.coveredDays + " 天"];
    if (count) bits.push("最近七天平均 " + durationText(sum / count));
    statsParts.summary.textContent = bits.join(" · ");

    paintWeekBars(statsParts.bars, days, agg.total);
    paintDayHours();
    paintHeat(statsParts.heat, agg);
  }

  /* 某一天的小时段：24 根柱子，柱高是这一段里样本的平均耗时（按这天最慢的一段归一）。
     一天最多 96 条样本摊到 24 段，格子窄得写不下数字，所以数值放在上面那行总结和
     下面点选后的那一行里 —— 手机上也能看到，不靠悬浮。 */
  function paintDayHours() {
    if (!statsParts) return;
    const range = pickRange();
    if (!statDay) statDay = range.max;
    if (statDay < range.min) statDay = range.min;
    if (statDay > range.max) statDay = range.max;
    const day = new Date(statDay);
    statsParts.dayInput.min = dayKey(new Date(range.min));
    statsParts.dayInput.max = dayKey(new Date(range.max));
    statsParts.dayInput.value = dayKey(day);
    statsParts.dayToday.disabled = statDay === range.max;

    const label = (statDay === range.max ? "今天 " : "")
      + pad(day.getMonth() + 1) + "-" + pad(day.getDate()) + " 周" + WEEK_LABEL[day.getDay()];
    const view = dayHours(statDay);
    const host = statsParts.hours;
    host.innerHTML = "";
    statsParts.dayPick.textContent = "";

    if (!view.count) {
      statsParts.daySum.textContent = label + " 没有样本。";
      host.append(el("p", "empty", statDay === range.max
        ? "今天还没采到样本：页面或本机服务每 15 分钟采一条，等等就有了。"
        : "这天没采到样本，换一天看看。"));
      return;
    }

    let max = 0;
    let slowest = -1;
    let fastest = -1;
    let filled = 0;
    view.buckets.forEach((bucket, hour) => {
      if (!bucket.count) return;
      filled += 1;
      const mean = bucket.sum / bucket.count;
      if (mean > max) max = mean;
      if (slowest < 0 || mean > view.buckets[slowest].sum / view.buckets[slowest].count) slowest = hour;
      if (fastest < 0 || mean < view.buckets[fastest].sum / view.buckets[fastest].count) fastest = hour;
    });
    if (max <= 0) max = 1;
    statsParts.daySum.textContent = label + " · " + view.count + " 条样本，落在 " + filled
      + " 个小时段上 · 这天平均 " + durationText(view.sum / view.count);

    const chart = el("div", "commute-hours");
    view.buckets.forEach((bucket, hour) => {
      const cell = el("div", "commute-bar-col");
      const bar = el("span", "commute-bar-col-fill");
      if (!bucket.count) {
        bar.style.height = "2px";
        bar.classList.add("is-none");
        cell.title = pad(hour) + ":00-" + pad(hour + 1) + ":00 · 没有样本";
      } else {
        const mean = bucket.sum / bucket.count;
        bar.style.height = Math.max(4, Math.round((mean / max) * 100)) + "%";
        // 满格 4 条，采得少的那段淡一些，免得一两条样本看着像规律
        if (bucket.count < PER_HOUR) bar.classList.add("is-thin");
        // 没点过的时候把最慢的那段标出来，跟下面那行文字对得上
        if (hour === pickedHour || (pickedHour < 0 && hour === slowest)) bar.classList.add("is-picked");
        cell.title = pad(hour) + ":00-" + pad(hour + 1) + ":00 · 平均 " + durationText(mean)
          + " · " + bucket.count + " 条样本";
        cell.addEventListener("click", () => {
          pickedHour = hour;
          paintDayHours();
        });
      }
      cell.append(bar);
      chart.append(cell);
    });
    host.append(chart);

    // 横轴每 3 小时标一次：24 格全标会糊成一片
    const axis = el("div", "commute-hour-axis");
    for (let hour = 0; hour < HOURS; hour++) {
      axis.append(el("span", null, hour % 3 === 0 ? String(hour) : ""));
    }
    host.append(axis);

    const hour = pickedHour >= 0 && view.buckets[pickedHour].count ? pickedHour : slowest;
    const bucket = view.buckets[hour];
    let tail = "";
    if (slowest !== fastest) {
      if (hour === slowest) tail = "（这天最慢）";
      else if (hour === fastest) tail = "（这天最快）";
    }
    statsParts.dayPick.textContent = pad(hour) + ":00-" + pad(hour + 1) + ":00 · 平均 "
      + durationText(bucket.sum / bucket.count) + " · " + bucket.count + " 条样本" + tail;
  }

  // 最近七天（含今天）每天一条：sum / count 就是那天的均值，没样本的那天 entry 为 null
  function weekDays(agg) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const list = [];
    for (let i = WEEK_DAYS - 1; i >= 0; i--) {
      const day = new Date(today.getTime() - i * DAY_MS);
      const entry = agg.days[dayKey(day)] || null;
      list.push({
        day: day,
        key: dayKey(day),
        entry: entry,
        mean: entry ? entry.sum / entry.count : 0,
        today: i === 0
      });
    }
    return list;
  }

  // 七根柱子：高度是当天的平均耗时（按这七天的最大值归一），数值直接写在柱子上面。
  // 以前画的是 24 小时分布、数值藏在 title 里——手机上根本没有悬浮，等于看不到数。
  function paintWeekBars(host, days, total) {
    host.innerHTML = "";
    let max = 0;
    let count = 0;
    days.forEach((item) => {
      count += item.entry ? item.entry.count : 0;
      if (item.mean > max) max = item.mean;
    });
    if (!count) {
      host.append(el("p", "empty", total
        ? "最近七天没有样本（更早的样本还在，只是这几天没采到）。"
        : "还没有样本。每 15 分钟会自动采一条，攒上几天就看得出来了。"));
      return;
    }
    if (max <= 0) max = 1;

    const chart = el("div", "commute-bars");
    days.forEach((item) => {
      const cell = el("div", "commute-bar-col");
      const bar = el("span", "commute-bar-col-fill");
      let height = 0;
      if (item.entry) {
        height = Math.max(4, Math.round((item.mean / max) * 100));
        bar.style.height = height + "%";
        // 一天只有一条样本时弱化显示，免得一条数据看着像规律
        if (item.entry.count < 2) bar.classList.add("is-thin");
        const value = el("span", "commute-bar-value", minutesText(item.mean));
        // 柱高是百分比，数字跟着柱顶走：柱子上方永远显示当天耗时，不用悬浮
        value.style.bottom = "calc(" + height + "% + 3px)";
        cell.append(value);
      } else {
        bar.style.height = "2px";
        bar.classList.add("is-none");
      }
      cell.title = item.entry
        ? item.key + " 周" + WEEK_LABEL[item.day.getDay()] + " · 平均 " + durationText(item.mean)
          + " · " + item.entry.count + " 条样本"
        : item.key + " · 还没有样本";
      cell.append(bar);
      chart.append(cell);
    });
    host.append(chart);

    const axis = el("div", "commute-axis");
    days.forEach((item) => {
      axis.append(el("span", item.today ? "is-today" : null,
        pad(item.day.getMonth() + 1) + "-" + pad(item.day.getDate())));
    });
    host.append(axis);
    host.append(el("p", "commute-caption muted",
      "横轴是最近七天（最后一格是今天），柱子上是那天的平均耗时（分钟），纵轴按这七天里最慢的一天归一。"
      + "只采到一两条的那天会淡一些，灰色短条表示那天没有样本。"));
  }

  function paintHeat(host, agg) {
    host.innerHTML = "";
    const grid = el("div", "commute-heat");
    const head = ["日", "一", "二", "三", "四", "五", "六"];
    head.forEach((label) => grid.append(el("span", "commute-heat-head", label)));

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today.getTime() - (HEAT_DAYS - 1) * DAY_MS);
    for (let i = 0; i < start.getDay(); i++) grid.append(el("span", "commute-heat-pad"));

    const days = [];
    let min = Infinity;
    let max = 0;
    for (let i = 0; i < HEAT_DAYS; i++) {
      const day = new Date(start.getTime() + i * DAY_MS);
      const entry = agg.days[dayKey(day)];
      const mean = entry ? entry.sum / entry.count : 0;
      if (entry && mean > max) max = mean;
      if (entry && mean < min) min = mean;
      days.push({ day: day, entry: entry, mean: mean });
    }

    days.forEach((item) => {
      const cell = el("span", "commute-heat-cell");
      if (!item.entry) {
        cell.classList.add("is-none");
        cell.title = dayKey(item.day) + " · 没有样本";
      } else {
        const span = max - min || 1;
        const level = item.mean <= min + span / 3 ? "ok" : (item.mean <= min + (span * 2) / 3 ? "hold" : "danger");
        cell.classList.add(level);
        cell.title = dayKey(item.day) + " · 平均 " + durationText(item.mean) + " · " + item.entry.count + " 条样本";
        cell.append(el("span", "commute-heat-text", String(item.day.getDate())));
      }
      grid.append(cell);
    });

    host.append(grid);
    host.append(el("p", "commute-caption muted",
      "每格是一天的平均耗时，绿 → 黄 → 红按这段时间里的相对快慢分档；鼠标停上去看当天具体数值。"));
  }

  /* ===== 设置弹窗 ===== */

  let configParts = null;
  let resolving = false; // 保存流程（解析 + 落库）在跑时挡住连点

  const HINT_DEFAULT = "只监控这一条线路。地址尽量从候选里选——选中的是百度自己认得的规范地点，"
    + "不会像纯文本那样被认到别的城市去；直接填「纬度,经度」也一样准。";

  function field(label, placeholder, id) {
    const wrap = el("label", "commute-field");
    wrap.append(el("span", null, label));
    const input = el("input");
    input.type = "text";
    input.id = id;
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    wrap.append(input);
    return { wrap: wrap, input: input };
  }

  // 「纬度,经度」的写法：交给本机服务就是坐标，不用问百度
  function isLatLngText(text) {
    const parts = String(text).split(",");
    if (parts.length !== 2) return false;
    const lat = Number(parts[0].trim());
    const lng = Number(parts[1].trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0);
  }

  /* 起点/终点：敲两个字向百度要候选，选中即拿到规范名称 + 坐标。
     百度那边没开通「地点检索」时这里只是没有候选，输入框照常能用，
     保存时仍然会解析并回显——不会因为少勾一个接口整块就不能用。 */
  function placeField(label, placeholder, id) {
    const base = field(label, placeholder, id);
    const list = el("div", "commute-suggest");
    list.hidden = true;
    const note = el("p", "commute-resolve");
    note.hidden = true;
    base.wrap.append(list, note);

    const part = {
      wrap: base.wrap,
      input: base.input,
      list: list,
      note: note,
      picked: null, // 用户从候选里选的（带百度给的坐标）
      items: [],
      active: -1,
      timer: null,
      seq: 0
    };

    base.input.addEventListener("input", () => {
      part.picked = null; // 手改过字，之前选中的坐标就不算数了
      hideNote(part);
      scheduleSuggest(part);
    });
    base.input.addEventListener("keydown", (event) => onSuggestKey(part, event));
    base.input.addEventListener("blur", () => {
      // 别抢在点击候选之前把列表收起来
      setTimeout(() => closeSuggest(part), 150);
    });
    return part;
  }

  function showNote(part, kind, text) {
    part.note.textContent = text;
    part.note.className = "commute-resolve" + (kind ? " " + kind : "");
    part.note.hidden = false;
  }

  function hideNote(part) {
    part.note.textContent = "";
    part.note.hidden = true;
  }

  function closeSuggest(part) {
    if (part.timer) { clearTimeout(part.timer); part.timer = null; }
    part.items = [];
    part.active = -1;
    part.list.textContent = "";
    part.list.hidden = true;
  }

  function renderSuggest(part) {
    part.list.textContent = "";
    if (!part.items.length) {
      part.list.hidden = true;
      return;
    }
    part.items.forEach((item, index) => {
      const row = el("button", "commute-suggest-item");
      row.type = "button";
      if (index === part.active) row.classList.add("is-active");
      row.append(el("span", "commute-suggest-name", item.name));
      const sub = [item.tag, item.address].filter(Boolean).join(" · ");
      if (sub) row.append(el("span", "commute-suggest-sub", sub));
      // mousedown 早于 blur，用它把选择定在输入框失焦之前
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        pickSuggest(part, item);
      });
      part.list.append(row);
    });
    part.list.hidden = false;
  }

  function moveSuggest(part, step) {
    if (!part.items.length) return;
    const next = part.active + step;
    part.active = next < 0 ? part.items.length - 1 : (next >= part.items.length ? 0 : next);
    renderSuggest(part);
  }

  function onSuggestKey(part, event) {
    if (event.key === "ArrowDown") { event.preventDefault(); moveSuggest(part, 1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); moveSuggest(part, -1); return; }
    if (event.key === "Enter") {
      if (!part.list.hidden && part.items.length) {
        event.preventDefault();
        pickSuggest(part, part.items[part.active >= 0 ? part.active : 0]);
      }
      return;
    }
    if (event.key === "Escape" && !part.list.hidden) {
      event.preventDefault(); // 只是收起候选，别把整个弹窗关掉
      closeSuggest(part);
    }
  }

  function pickSuggest(part, item) {
    part.input.value = item.name;
    part.picked = { text: item.name, lat: item.lat, lng: item.lng };
    closeSuggest(part);
    showNote(part, "ok", "已选定百度给出的地点：" + item.name + "（" + item.lat + ", " + item.lng + "）");
  }

  function scheduleSuggest(part) {
    if (part.timer) clearTimeout(part.timer);
    const text = part.input.value.trim();
    if (text.length < 2 || isLatLngText(text)) { closeSuggest(part); return; }
    part.timer = setTimeout(() => suggest(part, text), 260);
  }

  async function suggest(part, text) {
    const seq = ++part.seq;
    const url = SUGGEST_API + "?q=" + encodeURIComponent(text);
    let payload;
    try {
      payload = await fetchJson(url);
    } catch (err) {
      closeSuggest(part); // 本机服务没起来之类：静默退化成普通输入框
      return;
    }
    if (seq !== part.seq) return; // 又敲了新内容，这份结果作废
    const items = payload && payload.ok === true && Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) { closeSuggest(part); return; }
    part.items = items;
    part.active = 0;
    renderSuggest(part);
  }

  function buildConfigDialog() {
    const dialog = el("dialog", "code-dialog commute-config-dialog");
    const form = el("form", "commute-form");
    form.method = "dialog";
    form.append(el("h3", null, "设置出行线路"));

    const grid = el("div", "commute-form-grid");
    const origin = placeField("起点", "敲两个字从候选里选，比如「厚街万达」", "commute-origin");
    const destination = placeField("终点", "敲两个字从候选里选，比如「十字门」", "commute-destination");
    grid.append(origin.wrap, destination.wrap);
    form.append(grid);

    const hint = el("p", "commute-form-hint muted", HINT_DEFAULT);
    form.append(hint);

    const actions = el("div", "dialog-actions");
    const clear = el("button", "btn", "清除线路");
    const cancel = el("button", "btn", "取消");
    const save = el("button", "btn primary", "保存");
    [clear, cancel, save].forEach((node) => { node.type = "button"; });
    clear.addEventListener("click", askClearRoute);
    cancel.addEventListener("click", () => dialog.close());
    save.addEventListener("click", saveRoute);
    actions.append(el("span", "dialog-spacer"), clear, cancel, save);
    form.append(actions);

    dialog.append(form);
    document.body.append(dialog);
    // Esc 关窗也要把「仍然保存」这类状态和候选列表复位
    dialog.addEventListener("close", resetConfigState);
    configParts = {
      origin: origin,
      destination: destination,
      hint: hint,
      saveButton: save,
      canForce: false
    };
    return dialog;
  }

  function resetConfigState() {
    if (!configParts) return;
    configParts.canForce = false;
    configParts.saveButton.textContent = "保存";
    [configParts.origin, configParts.destination].forEach((part) => {
      part.picked = null;
      closeSuggest(part);
      hideNote(part);
    });
  }

  function setHint(text, kind) {
    configParts.hint.textContent = text;
    configParts.hint.className = "commute-form-hint" + (kind === "warn" ? " warn" : " muted");
  }

  function setSaveBusy(working) {
    configParts.saveButton.disabled = !!working;
    configParts.saveButton.textContent = working
      ? "确认中…"
      : (configParts.canForce ? "仍然保存" : "保存");
  }

  function openConfig() {
    if (!configDialog) configDialog = buildConfigDialog();
    const route = store.route;
    configParts.origin.input.value = route ? route.origin.text : "";
    configParts.destination.input.value = route ? route.destination.text : "";
    resetConfigState();
    setHint(HINT_DEFAULT, "");
    checkBaiduKey();
    if (typeof configDialog.showModal === "function") configDialog.showModal();
  }

  // 顺手问一下本机服务有没有读到 AK：只回布尔值，密钥本身不会传到这里
  async function checkBaiduKey() {
    try {
      const payload = await fetchJson(STATUS_API);
      if (payload && payload.configured === false) {
        setHint("本机服务还没读到百度 AK。在 " + String(payload.path || "baidu.local.json")
          + " 里填 {\"ak\":\"你的服务端 AK\"}，再重启工作台（README 的「出行路况」一节有申请步骤）。", "warn");
      }
    } catch (err) {
      // 本机服务没起来时不用在这里报错，真正取数的时候会提示
    }
  }

  /* 保存前先让百度确认一遍：地址是它认得的规范地点就直接存；
     认到别处去了（precise≠1，比如「东莞厚街万达」被理解成北京石景山）
     就先停下来把结果显示出来，让人看过再决定 —— 而不是默默存一条错线路天天算。 */
  async function saveRoute() {
    if (resolving) return;
    const originText = configParts.origin.input.value.trim();
    const destinationText = configParts.destination.input.value.trim();
    if (!originText || !destinationText) {
      setHint("起点和终点都要填。可以敲两个字从候选里选，也可以直接填「纬度,经度」。", "warn");
      return;
    }
    resolving = true;
    setSaveBusy(true);
    try {
      const previous = store.route;
      const origin = await resolvePoint(configParts.origin, previous, "origin", originText);
      const destination = await resolvePoint(configParts.destination, previous, "destination", destinationText);

      const risky = [];
      if (origin.precise !== 1) risky.push("起点「" + originText + "」");
      if (destination.precise !== 1) risky.push("终点「" + destinationText + "」");
      if (risky.length && !configParts.canForce) {
        configParts.canForce = true;
        setHint(risky.join("、") + " 百度没能精确匹配，它给出的位置很可能不是你要的地方"
          + "（常见原因是地址少了「市 / 区」这类行政区划，被认到同名的外地去了）。"
          + "核对上面的坐标，不对就回候选列表里选一个，或者直接填「纬度,经度」；"
          + "确认没错再点一次「仍然保存」。", "warn");
        return;
      }

      store.route = {
        origin: { text: originText, lat: origin.lat, lng: origin.lng },
        destination: { text: destinationText, lat: destination.lat, lng: destination.lng }
      };
      resetDetail(); // 线路换了，之前那份分段明细说的就不是这条路了
      await Workbench.writeJson(FILE, store);
      syncWatch(); // 线路给本机服务一份，页面关了它也接着采
      configDialog.close();
      lastError = "";
      render();
      refresh(true);
    } catch (err) {
      setHint(err && err.message ? err.message : "解析地址失败", "warn");
    } finally {
      resolving = false;
      setSaveBusy(false);
    }
  }

  /* 把一个输入框定成坐标。能从候选取、是手填的坐标、或和上次一样，都不去问百度；
     真需要解析时拿到 precise 一并回显 —— 这一个字段就是「认错地方」的判据。 */
  async function resolvePoint(part, previous, key, text) {
    if (part.picked && part.picked.text === text) {
      showNote(part, "ok", "百度候选：" + text + " → " + part.picked.lat + ", " + part.picked.lng);
      return { lat: part.picked.lat, lng: part.picked.lng, precise: 1 };
    }
    if (isLatLngText(text)) {
      const parts = text.split(",");
      showNote(part, "ok", "直接当作坐标：" + parts[0].trim() + ", " + parts[1].trim());
      return { lat: parts[0].trim(), lng: parts[1].trim(), precise: 1 };
    }
    const before = previous && previous[key];
    if (before && before.text === text && before.lat && before.lng) {
      showNote(part, "muted", "地址没变，沿用上次的坐标：" + before.lat + ", " + before.lng);
      return { lat: before.lat, lng: before.lng, precise: 1 };
    }
    const url = GEOCODE_API + "?address=" + encodeURIComponent(text);
    const payload = await fetchJson(url);
    if (!payload || payload.ok !== true) {
      throw new Error(payload && payload.error ? payload.error : "百度没给出解析结果");
    }
    const precise = Number(payload.precise);
    const where = (payload.level ? payload.level + " · " : "") + payload.lat + ", " + payload.lng;
    if (precise === 1) {
      showNote(part, "ok", text + " → " + where);
    } else {
      showNote(part, "warn", text + " → " + where + "（没精确匹配上，这个位置很可能不对）");
    }
    return { lat: String(payload.lat || ""), lng: String(payload.lng || ""), precise: precise };
  }

  function askClearRoute() {
    Nav.ask({
      title: "清除线路",
      text: "会一并清掉这条线路攒下的历史样本，之后就看不到统计了。",
      okText: "清除",
      danger: true
    }).then((ok) => {
      if (!ok) return;
      store.route = null;
      store.last = null;
      store.samples = [];
      resetDetail();
      lastError = "";
      syncWatch(); // 叫本机服务停采，并把攒下的样本清掉
      Workbench.writeJson(FILE, store).then(() => {
        configDialog.close();
        render();
        Nav.toast("线路和样本都清掉了");
      }).catch(() => Nav.toast("清除失败，磁盘没写进去"));
    });
  }

  /* ===== 启动 ===== */

  function tick() {
    if (document.visibilityState !== "visible") return; // 页面在后台不偷请求，省配额也省电
    if (!store || !store.route) return;
    // 先把本机服务采到的收回来：它刚采过，这里就不用自己再问一次百度
    syncSpool().then((added) => {
      if (added) render();
      const age = store.last && store.last.at ? Date.now() - new Date(store.last.at).getTime() : Infinity;
      if (!Number.isFinite(age) || age >= FRESH_MS) refresh(false);
    });
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") tick();
  }

  async function init() {
    const card = document.getElementById("commute-card");
    if (!card) return;
    const refreshButton = document.getElementById("commute-refresh");
    if (refreshButton) refreshButton.addEventListener("click", () => refresh(true));
    const configButton = document.getElementById("commute-note");
    if (configButton) configButton.addEventListener("click", openConfig);
    const statsButton = document.getElementById("commute-stats");
    if (statsButton) statsButton.addEventListener("click", openStats);

    try {
      store = normalize(await Workbench.readJson(FILE, emptyStore()));
    } catch (err) {
      store = emptyStore();
      lastError = "读不到 " + FILE;
    }

    // 页面没开的这段时间是本机服务在采：先把样本收回来，再决定要不要自己取一次
    syncWatch();
    await syncSpool();

    render();

    if (store.route) {
      const age = store.last && store.last.at ? Date.now() - new Date(store.last.at).getTime() : Infinity;
      if (!Number.isFinite(age) || age > FRESH_MS) refresh(false);
    }

    if (timer) clearInterval(timer);
    timer = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  root.BaiduCard = { init: init };
})(typeof window !== "undefined" ? window : globalThis);
