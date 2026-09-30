(function (root) {
  const DB_NAME = "workbench";
  const DB_VERSION = 3;
  const STORE = "handles";
  const KEY = "dir";

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let settled = false;
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        // 第 2 版遗留的 kv 存储保留不动，避免误删历史数据
      };

      req.onsuccess = () => {
        if (settled) {
          req.result.close();
          return;
        }
        settled = true;
        resolve(req.result);
      };

      req.onerror = () => {
        settled = true;
        dbPromise = null;
        reject(req.error || new Error("打不开本地数据库"));
      };

      req.onblocked = () => {
        settled = true;
        dbPromise = null;
        reject(new Error("数据库被其它标签页占用了。关掉其它工作台页面，再刷新这一页。"));
      };
    });
    return dbPromise;
  }

  function idbGet(key) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      let value;
      req.onsuccess = () => {
        value = req.result;
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(value === undefined ? null : value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  function idbPut(key, value) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      // 文件夹句柄是结构化克隆对象，只能存进 IndexedDB，localStorage 存不了
      const req = tx.objectStore(STORE).put(value, key);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  async function loadHandle() {
    const handle = await idbGet(KEY);
    if (!handle || typeof handle.queryPermission !== "function") return null;
    return handle;
  }

  async function saveHandle(handle) {
    await idbPut(KEY, handle);
  }

  // 不建目录时，途中任何一层缺失都返回 null，交给调用方按「文件不存在」处理
  async function resolveParent(dir, path, create) {
    const parts = String(path).split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error("路径不合法：" + path);
    let current = dir;
    for (const part of parts) {
      try {
        current = await current.getDirectoryHandle(part, { create });
      } catch (err) {
        if (!create && err && err.name === "NotFoundError") return null;
        throw err;
      }
    }
    return { parent: current, name };
  }

  async function readText(dir, path) {
    const loc = await resolveParent(dir, path, false);
    if (!loc) return null;
    try {
      const handle = await loc.parent.getFileHandle(loc.name, { create: false });
      const file = await handle.getFile();
      return await file.text();
    } catch (err) {
      if (err && err.name === "NotFoundError") return null;
      throw err;
    }
  }

  async function writeText(dir, path, text) {
    const loc = await resolveParent(dir, path, true);
    const handle = await loc.parent.getFileHandle(loc.name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  async function removeFile(dir, path) {
    const loc = await resolveParent(dir, path, false);
    if (!loc) return;
    try {
      await loc.parent.removeEntry(loc.name);
    } catch (err) {
      if (err && err.name === "NotFoundError") return;
      throw err;
    }
  }

  root.Storage = { loadHandle, saveHandle, readText, writeText, removeFile };
})(typeof window !== "undefined" ? window : globalThis);
