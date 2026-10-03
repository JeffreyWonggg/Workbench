(function (root) {
  /* 腾讯云 CloudBase 云存储适配。
     只暴露 getIndex / putIndex / getObject / putObject / deleteObject / probe 六个方法，
     换成别家云（OSS、R2、MinIO）只要照这个接口再写一个，同步引擎一行都不用改。
     鉴权走匿名登录换临时凭证，密钥不进前端；数据在进这里之前已经加密好了，
     所以就算有人拿到环境 ID 匿名登录，拿到的也只是一堆解不开的密文。

     存储走「对象接口」/v1/storages/object/{桶名}/{路径}，也就是 SDK 里的 app.storage.from(桶名)。
     不用 app.uploadFile / downloadFile / deleteFile：那几个走的是老的「传统云存储」接口
     /v1/storages/get-objects-upload-info，在新一代（PG）环境上服务端对任何非空请求一律回
     INVALID_PARAM，跟桶建没建、权限开没开都无关。 */

  const SDK_PATH = "js/vendor/cloudbase.full.js";
  const PREFIX = "workbench";
  const INDEX_PATH = PREFIX + "/index.json";
  const PROBE_PATH = PREFIX + "/probe.json";
  const DEFAULT_BUCKET = "workbench";   // 控制台「云存储」里的桶名，可用云同步配置里的 bucket 覆盖

  let sdkPromise = null;
  let app = null;
  let auth = null;
  let storage = null;   // app.storage.from(桶名)，对象接口的入口
  let config = null;

  function loadSdk() {
    if (root.cloudbase) return Promise.resolve(root.cloudbase);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SDK_PATH;
      script.async = true;
      script.onload = () => {
        if (root.cloudbase) resolve(root.cloudbase);
        else reject(new Error("云 SDK 加载异常"));
      };
      script.onerror = () => reject(new Error("加载云 SDK 失败，检查 js/vendor/cloudbase.full.js 是否存在"));
      document.head.appendChild(script);
    });
    return sdkPromise;
  }

  // SDK 有新旧两套匿名登录写法：老版 app.auth() 出来的是 provider（anonymousAuthProvider），
  // 新版是同名的直接方法（signInAnonymously）。两套都兜住，顺便探测结果留着报错时显示。
  function authApi(target) {
    if (target && typeof target.signInAnonymously === "function") return "direct";
    if (target && typeof target.anonymousAuthProvider === "function") return "provider";
    return "";
  }

  async function anonymousSignIn(target) {
    const api = authApi(target);
    let res;
    if (api === "direct") res = await target.signInAnonymously();
    else if (api === "provider") res = await target.anonymousAuthProvider().signIn();
    else throw new Error("这个云 SDK 没有匿名登录接口（既没有 signInAnonymously 也没有 anonymousAuthProvider），换一份 cloudbase.full.js 再试");
    // 新版 SDK 登录失败时不会抛错，而是把错误塞在返回值里：这里统一抛出去，
    // 否则上层会以为已经登录成功，后面每一步都报些看不懂的错
    if (res && res.error) {
      const e = res.error;
      throw new Error(String(e.code || e.name || "auth_error") + " " + String(e.message || e.helpMessage || ""));
    }
    return res;
  }

  async function loggedIn() {
    if (!auth || typeof auth.getLoginState !== "function") return false;
    try {
      const state = await auth.getLoginState();
      return !!state;
    } catch (err) {
      return false;
    }
  }

  async function ensureApp() {
    if (app && await loggedIn()) return app;
    const sdk = await loadSdk();
    if (!config || !config.env) throw new Error("还没有填环境 ID");
    // 新一代（PG）环境必须走 GATEWAY：默认的 CLOUD_API 会打到老域名 tcb-api.tencentcloudapi.com，
    // 老域名对这类环境一律回 4045/100007「匿名登录未开启」，跟控制台开关无关
    app = sdk.init({ env: config.env, endPointMode: "GATEWAY" });
    auth = app.auth({ persistence: "local" });
    if (!(await loggedIn())) await anonymousSignIn(auth);
    return app;
  }

  function bucketName() {
    const name = config && config.bucket ? String(config.bucket).trim() : "";
    return name || DEFAULT_BUCKET;
  }

  // 对象接口的入口。桶名必须显式传：不传的话 SDK 会退回那套在新环境下不可用的传统接口
  async function ensureStorage() {
    if (storage) return storage;
    await ensureApp();
    if (!app.storage || typeof app.storage.from !== "function") {
      throw new Error("这份云 SDK 没有对象存储接口（app.storage.from），换一份 cloudbase.full.js 再试");
    }
    storage = app.storage.from(bucketName());
    return storage;
  }

  function dataPath(key) {
    return PREFIX + "/data/" + String(key).replace(/^\/+/, "");
  }

  // 上一次「防缓存读取通道」失败的原因。probe() 会把它原样报在面板上：
  // 这条通道失败是静默退回常规下载的，不把原因带出来的话，现象只会是
  // 「明明加了防缓存，怎么还是要清缓存」。
  let freshError = "";

  // 取一次签名链接再自己 fetch，唯一目的是能说上一句「这次别用缓存」。
  // SDK 的 download 内部是「createSignedUrl 拿链接 → GET（headers 写死为空对象）」，
  // 我们插不进任何头；而同一个 key 的下载链接是稳定复用的，浏览器就把第一次读到的
  // 响应按 URL 存了下来。于是 index.json 和 data/*.json 每次同步都从缓存里回旧副本，
  // 且「旧清单配旧数据」哈希自洽，同步引擎一路报「两边本来就一致」/「拉回 N 项」却看不到新内容
  // （手机端现象：电脑上加了待办怎么同步都不过来，单清一次浏览器缓存立刻就好）。
  //
  // 注意这里的两层字段名：app.storage.from(桶) 走的是新版对象接口，
  // createSignedUrl 返回的是 { data: { fullSignedURL } }（handleOperation 包了一层 data）；
  // 老版 app.storage 才返回 { data: { signedUrl } }。只认 signedUrl 的话这里恒为空串，
  // 于是每一轮都静默退回下面那条带缓存的常规下载——防缓存通道等于从来没接上。
  async function signedUrlOf(api, cloudPath, nonce) {
    const signed = await api.createSignedUrl(cloudPath, 600, nonce ? { cacheNonce: String(nonce) } : undefined);
    // shouldThrowOnError 为假时 SDK 不抛错，而是把失败塞在返回值里：这里统一抛出去
    if (signed && signed.error) {
      const e = signed.error;
      throw new Error("取签名链接失败：" + String(e.code || e.name || "") + " " + String(e.message || ""));
    }
    const info = (signed && (signed.data || signed)) || {};
    const url = String(info.fullSignedURL || info.signedUrl || info.downloadUrl || "");
    if (!url) throw new Error("签名链接里没有 URL（返回字段：" + Object.keys(info).join(",") + "）");
    return url;
  }

  async function tryFresh(api, cloudPath, nonce) {
    const url = await signedUrlOf(api, cloudPath, nonce);
    const res = await fetch(url, { cache: "no-store", credentials: "omit" });
    if (!res || !res.ok) throw new Error("取签名链接失败 HTTP " + (res ? res.status : "无响应"));
    return await res.text();
  }

  // 拿不到签名链接、跨域被拦、浏览器不支持时一律返回 null，由调用方退回 SDK 的常规下载。
  async function downloadFresh(api, cloudPath) {
    if (!api || typeof api.createSignedUrl !== "function") {
      freshError = "这份 SDK 没有 createSignedUrl";
      return null;
    }
    // cacheNonce 是 SDK 自带的防缓存参数：每轮换一个 URL，按 URL 缓存就必然落空。
    // 万一服务端不认这个参数，再退回不带它的那种签名链接，别把整条通道一起搭进去。
    try {
      const text = await tryFresh(api, cloudPath, Date.now());
      freshError = "";
      return text;
    } catch (err) {
      freshError = (err && err.message) || String(err);
    }
    try {
      const text = await tryFresh(api, cloudPath, 0);
      freshError = "";
      return text;
    } catch (err) {
      freshError = (err && err.message) || String(err);
      return null;
    }
  }

  async function download(cloudPath) {
    try {
      const api = await ensureStorage();
      const fresh = await downloadFresh(api, cloudPath);
      if (fresh != null) return fresh;
      const res = await api.download(cloudPath);
      const blob = res && !res.error ? res.data : null;
      if (!blob) return null;
      // SDK 给的是 Blob，取文本；万一直接给字符串也认
      if (typeof blob.text === "function") return await blob.text();
      return String(blob);
    } catch (err) {
      // 不存在、读不了都当「没有」，交给同步引擎按首次同步处理
      return null;
    }
  }

  async function upload(cloudPath, text) {
    const api = await ensureStorage();
    // upsert：同一个 key 必须能反复重写（清单每次同步都重写一遍），
    // 不带它服务端会回 STORAGE_KEY_ALREADY_EXISTS
    //
    // cacheControl 是必须显式声明的，不能省：云存储对象默认不带 Cache-Control，
    // 浏览器只能按「启发式缓存」处理 GET 响应（按 Last-Modified 推一个过期时间），
    // 而 workbench/index.json 与 workbench/data/*.json 的 key 是固定的、
    // 签名下载 URL 在有效期内也复用，于是手机第一次读到的那份就被浏览器按 URL 存住了。
    // 之后每次同步都命中这份旧副本，且「旧清单 + 旧数据」哈希自洽，
    // 同步引擎一路报「两边本来就一致」/「拉回 N 项」却永远看不到另一台设备的新内容。
    // 设成 no-store 后，云端明确表态「这份响应不许缓存」，浏览器与 CDN 才不会自作主张。
    const res = await api.upload(cloudPath, String(text), {
      upsert: true,
      contentType: "application/json",
      cacheControl: "no-store, no-cache, must-revalidate"
    });
    if (res && res.error) throw res.error;
    return res;
  }

  // 猜的提示永远附上原文：归类猜错时，至少还能照着原文去搜
  function explain(err) {
    const raw = err && err.message ? String(err.message) : String(err || "未知错误");
    const code = err && err.code ? String(err.code) + " · " : "";
    return hintOf(code + raw) + "｜原始报错：" + code + raw;
  }

  function hintOf(text) {
    // 云端回了「匿名登录被禁用」：先分清楚是老域名报的还是新网关报的
    if (/anonymous authentication is disabled|100007|login_type_disabled|4045/i.test(text)) {
      return "云端拒了匿名登录：确认控制台「身份认证 → 登录方式」里匿名登录是开启的；报 100007 说明 SDK 打到了老域名（老 API 不支持新型环境），需要用 GATEWAY 模式的新版 SDK";
    }
    if (/STORAGE_BUCKET_NOT_FOUND|bucket not found/i.test(text)) {
      return "这个环境还没有云存储桶：去控制台「云存储」页面新建（或开通）一个存储桶，存储桶建好前无法同步";
    }
    if (/STORAGE_INVALID_KEY|invalid key/i.test(text)) {
      return "存储 key 里有云存储不认的字符：key 里出现 % 或 %2F 说明路径被整条做了 URL 编码，斜杠被转义了；同步引擎已改成只按路径分段编码";
    }
    if (/STORAGE_ACCESS_DENIED|row-level security|RLS/i.test(text)) {
      return "存储桶的权限策略（PG 环境的 RLS）拦下了这次读写：到控制台「云存储」给这个桶配一条允许匿名读写的策略（storage.objects / storage.buckets 的 RLS policy），策略没配好时桶等于只对管理端可用";
    }
    if (/INVALID_PARAM|invalid request param/i.test(text)) {
      return "云存储接口不认这次请求：多半是 SDK 走了老的「传统云存储」接口（app.uploadFile），新一代（PG）环境上这条路服务端一律拒；本条适配层已改成对象接口（app.storage.from），若仍报此错，检查存储桶名是否与控制台里的一致";
    }
    if (/network|fetch|timeout|ENOTFOUND|offline|proxy|代理|超时|加载云 SDK|初始化失败/i.test(text)) {
      return "连不上云开发环境：先看网络 / 代理（公司网络常拦 tcloudbase.com），再确认环境 ID 没写错";
    }
    if (/permission|denied|权限|存储返回异常/i.test(text)) {
      return "云存储拒绝了这次请求：确认环境 ID 属于你自己的账号，云存储没有被停用";
    }
    if (/anonymous|signIn|登录|auth|凭证|token|401|403/i.test(text)) {
      return "云开发没认下这次登录：确认「身份认证 → 登录方式」里匿名登录是开启状态，并把工作台的访问地址加进 WEB 安全域名";
    }
    if (/env|环境/i.test(text)) return "环境 ID 不对，到控制台复制环境 ID 再填一次";
    return "云开发返回了错误";
  }

  function create(remoteConfig) {
    config = remoteConfig || null;
    app = null;
    auth = null;
    storage = null;

    return {
      kind: "cloudbase",

      async getIndex() {
        const raw = await download(INDEX_PATH);
        if (!raw) return { etag: null, text: null };
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          parsed = null;
        }
        if (!parsed) return { etag: null, text: null };
        return { etag: String(parsed.seq || 0), text: parsed.payload || null };
      },

      async putIndex(text, expected) {
        await ensureApp();
        const raw = await download(INDEX_PATH);
        let currentSeq = 0;
        if (raw) {
          try {
            currentSeq = Number(JSON.parse(raw).seq || 0);
          } catch (err) {
            currentSeq = 0;
          }
        }
        // 云存储没有 ETag 可用，用清单自带的 seq 当乐观锁：
        // 版本号对不上，说明这一会儿被别的设备写过了
        if (expected != null && String(currentSeq) !== String(expected)) return false;
        await upload(INDEX_PATH, JSON.stringify({
          seq: currentSeq + 1,
          updatedAt: new Date().toISOString(),
          payload: text
        }));
        return true;
      },

      async getObject(key) {
        return download(dataPath(key));
      },

      async putObject(key, body) {
        await upload(dataPath(key), body);
      },

      async deleteObject(key) {
        try {
          const api = await ensureStorage();
          // 对象接口的删除是按前缀删的，这里传的是完整 key（都以 .json / .md 结尾，
          // 不会互相成为前缀），效果等同精确删除
          await api.remove([dataPath(key)]);
        } catch (err) {
          // 云端本来就没这个文件，删不掉也不算失败
        }
      },

      async probe() {
        try {
          await ensureStorage();
          // 真写一次再读回来：只做登录不做读写的话，桶没建、权限策略没配都发现不了
          const stamp = "probe-" + Date.now();
          await upload(PROBE_PATH, stamp);
          const back = await download(PROBE_PATH);
          if (back !== stamp) throw new Error("存储桶能写进去但读不回来，检查存储桶的权限策略");
          // 再单独验一次「绕过缓存」这条读通道：它自己取签名链接 + no-store fetch，
          // 跟 SDK 内置下载是两条路。被浏览器跨域策略拦下时同步仍然可用（会退回常规下载），
          // 只是又会踩回「手机一直读到旧副本」的老毛病，所以这一项得能在面板上看出来。
          const api = await ensureStorage();
          const bypass = await downloadFresh(api, PROBE_PATH);
          return { ok: true, message: "已连上环境 " + config.env + "（存储桶 " + bucketName() + "）"
            + "｜防缓存读取通道：" + (bypass === stamp
              ? "可用"
              : "不可用（" + (freshError || "原因不明") + "，会退回常规下载，仍可能读到浏览器缓存的旧副本）") };
        } catch (err) {
          return { ok: false, message: explain(err)
            + "｜本次用的环境：" + (config && config.env)
            + "｜存储桶：" + bucketName()
            + "｜SDK 登录接口：" + (authApi(auth) || "没找到") };
        }
      }
    };
  }

  root.SyncCloudbase = { create, loadSdk };
})(typeof window !== "undefined" ? window : globalThis);
