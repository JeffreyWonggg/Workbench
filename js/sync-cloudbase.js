(function (root) {
  /* 腾讯云 CloudBase 云存储适配。
     只暴露 getIndex / putIndex / getObject / putObject / deleteObject / probe 六个方法，
     换成别家云（OSS、R2、MinIO）只要照这个接口再写一个，同步引擎一行都不用改。
     鉴权走匿名登录换临时凭证，密钥不进前端；数据在进这里之前已经加密好了，
     所以就算有人拿到环境 ID 匿名登录，拿到的也只是一堆解不开的密文。 */

  const SDK_PATH = "js/vendor/cloudbase.full.js";
  const PREFIX = "workbench";
  const INDEX_PATH = PREFIX + "/index.json";
  const PROBE_PATH = PREFIX + "/probe.json";

  let sdkPromise = null;
  let app = null;
  let auth = null;
  let idBase = null;   // cloud://环境.存储桶，用来拼 fileID
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

  async function loggedIn() {
    if (!auth) return false;
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
    app = sdk.init({ env: config.env });
    auth = app.auth({ persistence: "local" });
    if (!(await loggedIn())) await auth.anonymousAuthProvider().signIn();
    return app;
  }

  // CloudBase 删/下文件都要 fileID（cloud://环境.桶/路径），桶名只能通过一次上传的返回值拿到
  async function ensureIdBase() {
    if (idBase) return idBase;
    await ensureApp();
    const file = new File(["{}"], "probe.json", { type: "application/json" });
    const res = await app.uploadFile({ cloudPath: PROBE_PATH, filePath: file });
    const fileID = res && res.fileID ? String(res.fileID) : "";
    const cut = fileID.indexOf("/", "cloud://".length);
    if (!fileID || cut < 0) throw new Error("云存储返回异常，拿不到文件地址");
    idBase = fileID.slice(0, cut);
    return idBase;
  }

  function fileIDOf(cloudPath) {
    return idBase + "/" + cloudPath;
  }

  function dataPath(key) {
    return PREFIX + "/data/" + String(key).replace(/^\/+/, "");
  }

  async function download(cloudPath) {
    await ensureApp();
    await ensureIdBase();
    try {
      const res = await app.downloadFile({ fileID: fileIDOf(cloudPath) });
      const blob = res && res.data ? res.data : res;
      if (!blob || typeof blob.text !== "function") return null;
      return await blob.text();
    } catch (err) {
      // 不存在、读不了都当「没有」，交给同步引擎按首次同步处理
      return null;
    }
  }

  async function upload(cloudPath, text) {
    await ensureApp();
    const name = String(cloudPath).split("/").pop() || "file";
    const file = new File([text], name, { type: "application/json" });
    return app.uploadFile({ cloudPath, filePath: file });
  }

  function explain(err) {
    const text = err && err.message ? String(err.message) : String(err || "未知错误");
    if (/anonymous|signIn|登录/i.test(text)) {
      return "匿名登录失败：到 CloudBase 控制台 → 登录授权，开启「匿名登录」后再试";
    }
    if (/env/i.test(text)) return "环境 ID 不对，到控制台复制环境 ID 再填一次";
    if (/network|fetch|timeout|failed/i.test(text)) return "连不上云开发环境，检查网络或环境 ID";
    return text;
  }

  function create(remoteConfig) {
    config = remoteConfig || null;
    app = null;
    auth = null;
    idBase = null;

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
        await ensureApp();
        await ensureIdBase();
        try {
          await app.deleteFile({ fileList: [fileIDOf(dataPath(key))] });
        } catch (err) {
          // 云端本来就没这个文件，删不掉也不算失败
        }
      },

      async probe() {
        try {
          await ensureApp();
          await ensureIdBase();
          return { ok: true, message: "已连上环境 " + config.env };
        } catch (err) {
          return { ok: false, message: explain(err) };
        }
      }
    };
  }

  root.SyncCloudbase = { create, loadSdk };
})(typeof window !== "undefined" ? window : globalThis);
