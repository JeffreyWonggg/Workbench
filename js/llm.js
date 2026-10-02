(function (root) {
  /* 模型通路：兼容 OpenAI 协议的 chat/completions（DeepSeek / 火山方舟）。
     密钥放 js/openrouter.local.js（不进版本库），以后加模型只改下面这张表。
     各页面自己的提示词不放这里——这里只管「把消息发出去、把回包取出来」。 */

  const MODELS = [
    {
      id: "deepseek-flash",
      label: "DeepSeek-V4.1-Flash",
      url: "https://api.deepseek.com/chat/completions",
      model: "deepseek-flash",
      keyName: "DEEPSEEK_API_KEY",
      key: () => root.DEEPSEEK_API_KEY,
      // 官方支持 response_format: json_object，要结构化的地方用得上
      jsonMode: true
    },
    {
      id: "ark-deepseek-v41",
      label: "火山方舟-deepseek-v4.1",
      url: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      model: "ep-20260929143640-d6pbl",
      keyName: "ARK_API_KEY",
      key: () => root.ARK_API_KEY,
      jsonMode: false
    }
  ];

  function findModel(id) {
    return MODELS.find((item) => item.id === id) || MODELS[0];
  }

  function keyOf(model) {
    return String((model && model.key ? model.key() : "") || "").trim();
  }

  /* 要哪个模型：给了 id 就用它（没配密钥则退回默认）；没给就用第一个配了密钥的。
     两个都没配返回 null，调用方据此提示「去配密钥」。 */
  function pickModel(id) {
    if (id) {
      const wanted = findModel(id);
      if (keyOf(wanted)) return wanted;
    }
    return MODELS.find((item) => keyOf(item)) || null;
  }

  function fillSelect(select, currentId) {
    if (!select) return;
    MODELS.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = keyOf(item) ? item.label : item.label + "（未配密钥）";
      select.append(option);
    });
    if (currentId) select.value = currentId;
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (err) {
      return url;
    }
  }

  /* 一次会话请求。options：{ model, messages, temperature, maxTokens, json }
     成功返回 { content, usage, model }；失败抛 Error（能带上的 usage 挂在 err.usage 上，
     因为失败的调用一样花钱）。 */
  async function chat(options) {
    const model = options.model;
    if (!model) {
      throw new Error("没有配置模型密钥：在 js/openrouter.local.js 里写 window." + MODELS[0].keyName);
    }
    const key = keyOf(model);
    if (!key) {
      throw new Error("没有配置「" + model.label + "」的密钥：在 js/openrouter.local.js 里写 window." + model.keyName);
    }

    const body = {
      model: model.model,
      temperature: Number.isFinite(options.temperature) ? options.temperature : 0.3,
      max_tokens: Number.isFinite(options.maxTokens) ? options.maxTokens : 2000,
      messages: options.messages
    };
    if (options.json && model.jsonMode) body.response_format = { type: "json_object" };

    let response;
    try {
      response = await fetch(model.url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw new Error("连不上 " + hostOf(model.url) + "（检查网络或代理）");
    }

    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }
    if (!response.ok) {
      const message = data && data.error && data.error.message
        ? data.error.message
        : "接口返回 " + response.status;
      const error = new Error(message);
      error.usage = data && data.usage;
      throw error;
    }

    const choice = data && data.choices && data.choices[0];
    const content = choice && choice.message ? choice.message.content : "";
    const usage = data && data.usage;
    if (!content || !String(content).trim()) {
      const error = new Error("接口没有返回内容");
      error.usage = usage;
      throw error;
    }
    return { content: String(content), usage: usage, model: model };
  }

  // 去掉 ```json 这类围栏（保留原样时也无害）
  function stripFence(text) {
    return String(text || "").trim().replace(/^```[^\n]*\n/, "").replace(/\n```$/, "").trim();
  }

  /* 从回包里抠出第一个完整的 JSON 对象。
     比 JSON.parse 直接吃全文稳：模型偶尔会在前后加一句解释或包代码块。 */
  function firstJson(text) {
    const source = stripFence(text);
    const start = source.indexOf("{");
    if (start < 0) return "";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (!depth) return source.slice(start, i + 1);
      }
    }
    return "";
  }

  function usageText(usage) {
    const prompt = usage ? Number(usage.prompt_tokens) : NaN;
    const completion = usage ? Number(usage.completion_tokens) : NaN;
    let total = usage ? Number(usage.total_tokens) : NaN;
    if (!Number.isFinite(total) && Number.isFinite(prompt) && Number.isFinite(completion)) {
      total = prompt + completion;
    }
    if (!Number.isFinite(total)) return "";
    const parts = [total.toLocaleString("zh-CN") + " token"];
    if (Number.isFinite(prompt)) parts.push("输入 " + prompt.toLocaleString("zh-CN"));
    if (Number.isFinite(completion)) parts.push("输出 " + completion.toLocaleString("zh-CN"));
    return parts.join(" · ");
  }

  root.LLM = {
    MODELS: MODELS,
    findModel: findModel,
    pickModel: pickModel,
    fillSelect: fillSelect,
    chat: chat,
    stripFence: stripFence,
    firstJson: firstJson,
    usageText: usageText
  };
})(typeof window !== "undefined" ? window : globalThis);
