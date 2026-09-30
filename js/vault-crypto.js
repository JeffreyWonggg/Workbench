(function (root) {
  "use strict";

  const VERSION = 1;
  const ITERATIONS = 600000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

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

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    root.crypto.getRandomValues(bytes);
    return bytes;
  }

  async function deriveKey(password, salt, iterations) {
    const material = await root.crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return root.crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function validateEnvelope(envelope) {
    if (!envelope || envelope.version !== VERSION || envelope.kdf !== "PBKDF2-SHA-256" ||
        envelope.cipher !== "AES-GCM" || !Number.isInteger(envelope.iterations) ||
        envelope.iterations < 100000 || !envelope.salt || !envelope.iv || !envelope.ciphertext) {
      throw new Error("资料库文件格式不受支持");
    }
  }

  async function encryptWithKey(key, data, settings) {
    const iv = randomBytes(12);
    const plaintext = encoder.encode(JSON.stringify(data));
    const ciphertext = await root.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return {
      version: VERSION,
      kdf: "PBKDF2-SHA-256",
      iterations: settings.iterations,
      salt: settings.salt,
      cipher: "AES-GCM",
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
      updatedAt: new Date().toISOString()
    };
  }

  async function create(password, data) {
    if (!root.crypto || !root.crypto.subtle) throw new Error("当前浏览器不支持加密资料库");
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt, ITERATIONS);
    const settings = { iterations: ITERATIONS, salt: toBase64(salt) };
    const envelope = await encryptWithKey(key, data, settings);
    return { key, settings, envelope };
  }

  async function unlock(password, envelope) {
    try {
      validateEnvelope(envelope);
      const salt = fromBase64(envelope.salt);
      const key = await deriveKey(password, salt, envelope.iterations);
      const plaintext = await root.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(envelope.iv) },
        key,
        fromBase64(envelope.ciphertext)
      );
      const data = JSON.parse(decoder.decode(plaintext));
      return {
        key,
        settings: { iterations: envelope.iterations, salt: envelope.salt },
        data
      };
    } catch (err) {
      if (err && err.message === "资料库文件格式不受支持") throw err;
      throw new Error("无法解锁，请检查主密码或资料库文件");
    }
  }

  async function encrypt(key, settings, data) {
    if (!key || !settings) throw new Error("资料库尚未解锁");
    return encryptWithKey(key, data, settings);
  }

  root.VaultCrypto = { create, unlock, encrypt, validateEnvelope };
})(typeof window !== "undefined" ? window : globalThis);
