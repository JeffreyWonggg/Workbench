(function (root) {
  /* 同步包的加解密，以及本机怎么保管同步配置。
     信封格式直接复用 js/vault-crypto.js（PBKDF2-SHA-256 → AES-256-GCM），云端只存不透明密文。
     同步密码独立于资料库主密码：vault.json 本身已经是密文，这里再套一层用不同的密码，
     管理上更清楚，也免得「没设资料库主密码就同步不了」。
     「在这台设备上记住」不存密码明文：派生出的密钥先用本机一把设备密钥包起来，
     再落 localStorage；设备密钥是非导出的 CryptoKey，存在 IndexedDB 里，
     换设备或清了浏览器数据就失效。 */

  const ITERATIONS = 600000;
  const SETTINGS_KEY = "wb-sync-settings";
  const CONFIG_KEY = "wb-sync-config";
  const REMEMBER_KEY = "wb-sync-remember";
  const DEVICE_DB = "workbench-sync";
  const DEVICE_STORE = "device";
  const DEVICE_KEY = "wrap";

  const encoder = new TextEncoder();

  let key = null;
  let settings = null;

  function toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function fromBase64(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(password, salt, iterations) {
    const material = await root.crypto.subtle.importKey(
      "raw",
      encoder.encode(String(password)),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return root.crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  /* ===== 本机设备密钥：只在 IndexedDB 里，不可导出 ===== */

  let devicePromise = null;

  function openDeviceDb() {
    if (devicePromise) return devicePromise;
    devicePromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DEVICE_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DEVICE_STORE)) req.result.createObjectStore(DEVICE_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("打不开本机密钥库"));
    });
    return devicePromise;
  }

  async function deviceKey() {
    const db = await openDeviceDb();
    const found = await new Promise((resolve, reject) => {
      const tx = db.transaction(DEVICE_STORE, "readonly");
      const req = tx.objectStore(DEVICE_STORE).get(DEVICE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (found) return found;
    const created = await root.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DEVICE_STORE, "readwrite");
      tx.objectStore(DEVICE_STORE).put(created, DEVICE_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
    return created;
  }

  /* ===== 配置与解锁 ===== */

  function hasConfig() {
    try {
      return !!localStorage.getItem(SETTINGS_KEY) && !!localStorage.getItem(CONFIG_KEY);
    } catch (err) {
      return false;
    }
  }

  function readSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  // 首次配置：重新生成盐，把配置封进信封（配置里有云环境信息，不落明文）
  async function setup(password, config) {
    if (!root.crypto || !root.crypto.subtle) throw new Error("当前环境不支持加密（需要 HTTPS 或本机地址）");
    if (!password) throw new Error("请设置同步密码");
    const salt = root.crypto.getRandomValues(new Uint8Array(16));
    const next = await deriveKey(password, salt, ITERATIONS);
    const nextSettings = { iterations: ITERATIONS, salt: toBase64(salt) };
    const envelope = await root.VaultCrypto.encrypt(next, nextSettings, config);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings));
    localStorage.setItem(CONFIG_KEY, JSON.stringify(envelope));
    key = next;
    settings = nextSettings;
    return config;
  }

  async function unlock(password) {
    if (!hasConfig()) throw new Error("还没有配置云同步");
    const saved = readSettings();
    const candidate = await deriveKey(password, fromBase64(saved.salt), saved.iterations);
    let config;
    try {
      config = await root.VaultCrypto.decrypt(candidate, JSON.parse(localStorage.getItem(CONFIG_KEY)));
    } catch (err) {
      throw new Error("同步密码不对");
    }
    key = candidate;
    settings = saved;
    return config;
  }

  async function updateConfig(config) {
    if (!key) throw new Error("同步尚未解锁");
    const envelope = await root.VaultCrypto.encrypt(key, settings, config);
    localStorage.setItem(CONFIG_KEY, JSON.stringify(envelope));
    return config;
  }

  function isUnlocked() {
    return !!key;
  }

  function lock() {
    key = null;
    settings = null;
  }

  function clear() {
    lock();
    try {
      localStorage.removeItem(SETTINGS_KEY);
      localStorage.removeItem(CONFIG_KEY);
      localStorage.removeItem(REMEMBER_KEY);
    } catch (err) {
      /* 隐私模式下可能写不了，忽略 */
    }
  }

  async function remember() {
    if (!key) return false;
    const raw = new Uint8Array(await root.crypto.subtle.exportKey("raw", key));
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await root.crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deviceKey(), raw);
    localStorage.setItem(REMEMBER_KEY, JSON.stringify({
      iv: toBase64(iv),
      data: toBase64(new Uint8Array(wrapped))
    }));
    return true;
  }

  function forget() {
    try {
      localStorage.removeItem(REMEMBER_KEY);
    } catch (err) {
      /* 忽略 */
    }
  }

  function remembered() {
    try {
      return !!localStorage.getItem(REMEMBER_KEY);
    } catch (err) {
      return false;
    }
  }

  // 用设备密钥解出同步密钥：解不开就当没记住，要求输密码
  async function recall() {
    const raw = localStorage.getItem(REMEMBER_KEY);
    const saved = readSettings();
    if (!raw || !saved) return false;
    try {
      const payload = JSON.parse(raw);
      const plain = await root.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(payload.iv) },
        await deviceKey(),
        fromBase64(payload.data)
      );
      key = await root.crypto.subtle.importKey("raw", plain, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
      settings = saved;
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ===== 单元加解密 ===== */

  async function seal(data) {
    if (!key) throw new Error("同步尚未解锁");
    return JSON.stringify(await root.VaultCrypto.encrypt(key, settings, data));
  }

  async function open(text) {
    if (!key) throw new Error("同步尚未解锁");
    return root.VaultCrypto.decrypt(key, JSON.parse(text));
  }

  root.SyncCrypto = {
    setup,
    unlock,
    updateConfig,
    isUnlocked,
    lock,
    clear,
    remember,
    forget,
    remembered,
    recall,
    hasConfig,
    seal,
    open
  };
})(typeof window !== "undefined" ? window : globalThis);
