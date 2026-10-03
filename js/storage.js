(function (root) {
  /* 数据落地后端。两种实现，接口一致，js/model.js 只认接口：
       本地文件夹：用户选的数据文件夹（File System Access API），数据就是明文 JSON 文件，
                   和以前一样可以自己打开看、自己改。电脑端默认走这条。
       IndexedDB ：没有文件夹可用时（手机浏览器不支持 showDirectoryPicker）的落地处，
                   配合云同步使用，云端才是权威副本。
     目录句柄本身仍然存在 IndexedDB 的 workbench 库里，文件库单独一个，互不干扰。 */

  const HANDLE_DB = "workbench";
  const HANDLE_VERSION = 3;
  const HANDLE_STORE = "handles";
  const HANDLE_KEY = "dir";

  const FILE_DB = "workbench-fs";
  const FILE_VERSION = 1;
  const FILE_STORE = "files";

  const dbCache = Object.create(null);

  function upgradeHandles(db) {
    if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    // 第 2 版遗留的 kv 存储保留不动，避免误删历史数据
  }

  function upgradeFiles(db) {
    if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE);
  }

  function openDb(name) {
    if (dbCache[name]) return dbCache[name];
    const version = name === FILE_DB ? FILE_VERSION : HANDLE_VERSION;
    const upgrade = name === FILE_DB ? upgradeFiles : upgradeHandles;
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      const req = indexedDB.open(name, version);

      req.onupgradeneeded = () => {
        upgrade(req.result);
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
        delete dbCache[name];
        reject(req.error || new Error("打不开本地数据库"));
      };

      req.onblocked = () => {
        settled = true;
        delete dbCache[name];
        reject(new Error("数据库被其它标签页占用了。关掉其它工作台页面，再刷新这一页。"));
      };
    });
    dbCache[name] = promise;
    return promise;
  }

  function idbGet(dbName, key) {
    return openDb(dbName).then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(FILE_STORE, "readonly");
      const req = tx.objectStore(FILE_STORE).get(key);
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

  function idbPut(dbName, key, value) {
    return openDb(dbName).then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(FILE_STORE, "readwrite");
      const req = tx.objectStore(FILE_STORE).put(value, key);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  function idbDelete(dbName, key) {
    return openDb(dbName).then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(FILE_STORE, "readwrite");
      const req = tx.objectStore(FILE_STORE).delete(key);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  function idbKeys(dbName) {
    return openDb(dbName).then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(FILE_STORE, "readonly");
      const req = tx.objectStore(FILE_STORE).getAllKeys();
      let keys = [];
      req.onsuccess = () => {
        keys = req.result || [];
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(keys);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  async function loadHandle() {
    const value = await idbGetByName(HANDLE_DB, HANDLE_STORE, HANDLE_KEY);
    if (!value || typeof value.queryPermission !== "function") return null;
    return value;
  }

  async function saveHandle(handle) {
    await idbPutByName(HANDLE_DB, HANDLE_STORE, HANDLE_KEY, handle);
  }

  // 句柄库和数据库的 store 名不同，读写句柄时显式指定 store
  function idbGetByName(dbName, store, key) {
    return openDb(dbName).then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
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

  function idbPutByName(dbName, store, key, value) {
    return openDb(dbName).then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      // 文件夹句柄是结构化克隆对象，只能存进 IndexedDB，localStorage 存不了
      const req = tx.objectStore(store).put(value, key);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  /* ===== 本地文件夹后端 ===== */

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

  // 二进制：拖进来的文件、截图都走这里。路径里带子目录时会自动建出来
  async function readBinary(dir, path) {
    const loc = await resolveParent(dir, path, false);
    if (!loc) return null;
    try {
      const handle = await loc.parent.getFileHandle(loc.name, { create: false });
      const file = await handle.getFile();
      return await file.arrayBuffer();
    } catch (err) {
      if (err && err.name === "NotFoundError") return null;
      throw err;
    }
  }

  async function writeBinary(dir, path, data) {
    const loc = await resolveParent(dir, path, true);
    const handle = await loc.parent.getFileHandle(loc.name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  // 列出某个前缀下的文件（同步时要枚举 notes/ 里的正文）
  async function listFiles(dir, prefix) {
    const clean = String(prefix || "");
    const parts = clean.split("/").filter(Boolean);
    let current = dir;
    for (const part of parts) {
      try {
        current = await current.getDirectoryHandle(part, { create: false });
      } catch (err) {
        if (err && err.name === "NotFoundError") return [];
        throw err;
      }
    }
    const out = [];
    for await (const entry of current.entries()) {
      const name = entry[0];
      const handle = entry[1];
      if (handle && handle.kind === "file") out.push(clean + name);
    }
    return out.sort();
  }

  /* ===== IndexedDB 后端 ===== */

  async function readIndexed(path) {
    const value = await idbGet(FILE_DB, String(path));
    return typeof value === "string" ? value : null;
  }

  async function writeIndexed(path, text) {
    await idbPut(FILE_DB, String(path), String(text));
  }

  async function removeIndexed(path) {
    await idbDelete(FILE_DB, String(path));
  }

  async function listIndexed(prefix) {
    const keys = await idbKeys(FILE_DB);
    const clean = String(prefix || "");
    return keys
      .filter((key) => typeof key === "string" && key.indexOf(clean) === 0)
      .sort();
  }

  // IndexedDB 能直接存 Blob（结构化克隆），二进制原样进出
  async function readIndexedBinary(path) {
    const value = await idbGet(FILE_DB, String(path));
    if (value instanceof Blob) return await value.arrayBuffer();
    return null;
  }

  async function writeIndexedBinary(path, data) {
    await idbPut(FILE_DB, String(path), new Blob([data]));
  }

  /* ===== 后端工厂：两种实现接口逐字一致 ===== */

  function createLocal(dir) {
    if (!dir) throw new Error("没有可用的数据文件夹");
    return {
      kind: "local",
      name: dir.name || "数据文件夹",
      handle: dir,
      readText: (path) => readText(dir, path),
      writeText: (path, text) => writeText(dir, path, text),
      readBinary: (path) => readBinary(dir, path),
      writeBinary: (path, data) => writeBinary(dir, path, data),
      removeFile: (path) => removeFile(dir, path),
      list: (prefix) => listFiles(dir, prefix)
    };
  }

  function createIndexed() {
    return {
      kind: "indexed",
      name: "本机浏览器",
      handle: null,
      readText: readIndexed,
      writeText: writeIndexed,
      readBinary: readIndexedBinary,
      writeBinary: writeIndexedBinary,
      removeFile: removeIndexed,
      list: listIndexed
    };
  }

  /* 手机环境判定。手机浏览器现在也开始暴露 showDirectoryPicker 了，
     但那个入口在手机上既难操作，选出来的目录也常常不是用户心里"那份数据"，
     所以判断"能不能用文件夹"时得把设备类型一并算上。
     iPadOS 13+ 的 Safari 把自己报成 Mac，只能再靠触屏点数认出来。 */
  function isMobileEnv() {
    const nav = root.navigator || {};
    const ua = nav.userAgent || "";
    if (/Android|iPhone|iPad|iPod|Windows Phone|HarmonyOS|Mobile/i.test(ua)) return true;
    return /Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1;
  }

  root.Storage = {
    loadHandle,
    saveHandle,
    createLocal,
    createIndexed,
    isMobileEnv,
    // 「能真正当数据落点用的文件夹」：光有 API 不够，明文 HTTP（非安全上下文）和手机上都没有
    hasDirectoryPicker: () => typeof root.showDirectoryPicker === "function" && !isMobileEnv()
  };
})(typeof window !== "undefined" ? window : globalThis);
