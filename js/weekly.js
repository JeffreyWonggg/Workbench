(function () {
  // 模型清单：每家一行，自带接口地址、模型名和密钥来源，以后加模型只改这里。
  // 密钥放在 js/openrouter.local.js（不进版本库）。
  const MODELS = [
    {
      id: "deepseek-flash",
      label: "DeepSeek-V4.1-Flash",
      url: "https://api.deepseek.com/chat/completions",
      model: "deepseek-flash",
      key: () => window.DEEPSEEK_API_KEY
    },
    {
      id: "ark-deepseek-v41",
      label: "火山方舟-deepseek-v4.1",
      url: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      model: "ep-20260929143640-d6pbl",
      key: () => window.ARK_API_KEY
    }
  ];

  function findModel(id) {
    return MODELS.find((item) => item.id === id) || MODELS[0];
  }

  // 润色力度：只改提示词和温度。任何力度下条目数量都不变，
  // 这样解析回写的结构始终是稳的。
  const POLISH_MODES = {
    polish: { label: "保守润色", temperature: 0.3 },
    expand: { label: "适度扩写", temperature: 0.5 },
    detail: { label: "充分扩写", temperature: 0.7 }
  };

  let year = 0;
  let week = 0;
  let report = null;
  let saveTimer = 0;
  let dirty = false;
  let spanDays = 7;
  let endDate = null;

  Nav.boot("weekly", async () => {
    const current = Workbench.isoWeek(new Date());
    const params = new URLSearchParams(location.search);
    if (params.get("week") === "current" || !Workbench.meta.lastWeek) {
      year = current.year;
      week = current.week;
    } else {
      year = Number(Workbench.meta.lastWeek.year) || current.year;
      week = Number(Workbench.meta.lastWeek.week) || current.week;
    }
    await loadWeek();
    document.getElementById("prev-week").addEventListener("click", () => changeWeek(-1));
    document.getElementById("next-week").addEventListener("click", () => changeWeek(1));
    document.getElementById("this-week").addEventListener("click", async () => {
      const now = Workbench.isoWeek(new Date());
      await persist();
      year = now.year;
      week = now.week;
      await loadWeek();
    });
    document.getElementById("add-section").addEventListener("click", () => {
      const used = new Set(report.sections.map((section) => section.project));
      const project = Workbench.meta.projects.find((name) => !used.has(name)) || Workbench.meta.projects[0];
      report.sections.push({ project, hours: 0, items: [""] });
      renderSections();
      scheduleSave();
    });
    document.getElementById("fill-done").addEventListener("click", fillFromDone);
    document.getElementById("copy-md").addEventListener("click", copyMarkdown);
    document.getElementById("week-span").addEventListener("change", onSpanChange);
    document.getElementById("week-end").addEventListener("change", onEndChange);
    const modelSelect = document.getElementById("polish-model");
    MODELS.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      modelSelect.append(option);
    });

    const modeSelect = document.getElementById("polish-mode");
    Object.keys(POLISH_MODES).forEach((id) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = POLISH_MODES[id].label;
      if (id === "expand") option.selected = true;
      modeSelect.append(option);
    });
    document.getElementById("polish-prompt").addEventListener("click", openPromptEditor);
    document.getElementById("prompt-cancel").addEventListener("click", () => {
      document.getElementById("prompt-dialog").close();
    });
    document.getElementById("prompt-reset").addEventListener("click", () => {
      document.getElementById("prompt-editor").value = defaultPromptTemplate();
    });
    document.getElementById("prompt-save").addEventListener("click", savePromptTemplate);
    document.getElementById("polish-report").addEventListener("click", polishReport);
    document.getElementById("polish-cancel").addEventListener("click", () => {
      document.getElementById("polish-dialog").close();
    });
    document.getElementById("polish-apply").addEventListener("click", applyPolish);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") persist();
    });
    window.addEventListener("workbench-projects", renderSections);
    window.addEventListener("resize", () => {
      document.querySelectorAll("textarea.item-text").forEach(fitItem);
    });
    // 周报按周存一份：别处改了这一周就重新读。有没存完的改动时不打断。
    Workbench.onChange(["reports.json"], async () => {
      if (dirty) return;
      await loadWeek();
    });
  });

  async function changeWeek(delta) {
    await persist();
    const next = Workbench.shiftWeek(year, week, delta);
    year = next.year;
    week = next.week;
    await loadWeek();
  }

  async function loadWeek() {
    const existing = await Workbench.getReport(year, week);
    report = existing ? structuredClone(existing) : { year, week, sections: [] };
    report.year = year;
    report.week = week;
    if (!Array.isArray(report.sections)) report.sections = [];
    spanDays = Number(report.spanDays) || 7;
    const monday = Workbench.weekMonday(year, week);
    endDate = report.endDate ? new Date(report.endDate + "T00:00:00Z") : Workbench.addUtcDays(monday, 6);
    report.spanDays = spanDays;
    report.endDate = endDate.toISOString().slice(0, 10);
    dirty = false;
    paintHeading();
    renderSections();
    updateSpanControls();
    const last = Workbench.meta.lastWeek;
    if (!last || last.year !== year || last.week !== week) {
      Workbench.meta.lastWeek = { year, week };
      await Workbench.saveMeta();
    }
  }

  function paintHeading() {
    const start = Workbench.addUtcDays(endDate, -(spanDays - 1));
    document.getElementById("week-title").textContent = `第 ${week} 周`;
    document.getElementById("week-range").textContent =
      `${Workbench.formatUtcMonthDay(start)} – ${Workbench.formatUtcMonthDay(endDate)}（${spanDays} 天）`;
    const total = report.sections.reduce((sum, section) => sum + (Number(section.hours) || 0), 0);
    document.getElementById("hours-total").textContent = `合计 ${Workbench.formatHours(total)} 小时`;
  }

  function onSpanChange(event) {
    spanDays = Math.max(1, Math.min(120, Number(event.target.value) || 7));
    report.spanDays = spanDays;
    paintHeading();
    scheduleSave();
  }

  function onEndChange(event) {
    const value = event.target.value;
    if (!value) return;
    endDate = new Date(value + "T00:00:00Z");
    report.endDate = value;
    paintHeading();
    scheduleSave();
  }

  function updateSpanControls() {
    document.getElementById("week-span").value = String(spanDays);
    document.getElementById("week-end").value = endDate.toISOString().slice(0, 10);
  }

  function renderSections() {
    const root = document.getElementById("sections");
    root.innerHTML = "";
    if (report.sections.length === 0) {
      const empty = document.createElement("div");
      empty.className = "card empty";
      empty.textContent = "这周还没有项目。添加一个，或从已完成待办填入。";
      root.append(empty);
      paintHeading();
      return;
    }
    report.sections.forEach((section, index) => root.append(sectionCard(section, index)));
    root.querySelectorAll("textarea.item-text").forEach(fitItem);
    paintHeading();
  }

  function sectionCard(section, index) {
    const card = document.createElement("section");
    card.className = "card section-card";
    const head = document.createElement("div");
    head.className = "section-head";
    const project = document.createElement("select");
    project.setAttribute("aria-label", "项目");
    Nav.fillProjects(project, section.project);
    project.value = section.project;
    project.addEventListener("change", () => {
      section.project = project.value;
      scheduleSave();
    });
    const hours = document.createElement("input");
    hours.type = "number";
    hours.min = "0";
    hours.step = "0.5";
    hours.value = section.hours || 0;
    hours.setAttribute("aria-label", "小时");
    hours.addEventListener("input", () => {
      section.hours = Number(hours.value) || 0;
      paintHeading();
      scheduleSave();
    });
    const tools = document.createElement("div");
    tools.className = "todo-actions";
    tools.append(
      textButton("上移", () => move(index, -1), index === 0),
      textButton("下移", () => move(index, 1), index === report.sections.length - 1),
      textButton("删除", async () => {
        const label = section.project || "这个项目";
        const ok = await askDelete(`删除「${label}」？这一周的工时和内容会一起移除。`);
        if (!ok) return;
        const removed = report.sections.splice(index, 1)[0];
        renderSections();
        scheduleSave();
        Nav.toast(`已删除「${label}」`, {
          label: "撤销",
          onSelect: () => {
            // 撤销时放回原来的位置；中间若上移/下移过，位置取较小值兜底
            report.sections.splice(Math.min(index, report.sections.length), 0, removed);
            renderSections();
            scheduleSave();
          }
        });
      })
    );
    head.append(project, hours, tools);
    card.append(head);
    (section.items || []).forEach((item, itemIndex) => {
      card.append(itemRow(section, itemIndex));
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn";
    add.textContent = "添加一条";
    add.addEventListener("click", () => {
      section.items.push("");
      renderSections();
      scheduleSave();
      const blocks = document.getElementById("sections").querySelectorAll(".section-card");
      const inputs = blocks[index] ? blocks[index].querySelectorAll("textarea.item-text") : [];
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    card.append(add);
    return card;
  }

  function itemRow(section, itemIndex) {
    const row = document.createElement("div");
    row.className = "item-row";
    const no = document.createElement("span");
    no.className = "item-no";
    no.textContent = `${itemIndex + 1}、`;
    const input = document.createElement("textarea");
    input.className = "item-text";
    input.rows = 1;
    input.value = section.items[itemIndex] || "";
    input.placeholder = "这周做了什么";
    input.addEventListener("input", () => {
      section.items[itemIndex] = input.value;
      fitItem(input);
      scheduleSave();
    });
    const remove = textButton("删除", () => {
      section.items.splice(itemIndex, 1);
      if (section.items.length === 0) section.items.push("");
      renderSections();
      scheduleSave();
    });
    row.append(no, input, remove);
    return row;
  }

  function fitItem(area) {
    area.style.height = "auto";
    area.style.height = area.scrollHeight + "px";
  }

  function textButton(label, onclick, disabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "linkish";
    button.textContent = label;
    button.disabled = !!disabled;
    button.addEventListener("click", onclick);
    return button;
  }

  // 删除确认：用页面里的对话框，而不是浏览器原生 confirm()——
  // 原生弹窗是系统样式，和本项目的毛玻璃弹窗不是一套观感。
  function askDelete(message) {
    return new Promise((resolve) => {
      const dialog = document.getElementById("del-dialog");
      const form = document.getElementById("del-form");
      const cancel = document.getElementById("del-cancel");
      document.getElementById("del-text").textContent = message;

      function finish(value) {
        form.removeEventListener("submit", onSubmit);
        cancel.removeEventListener("click", onCancel);
        dialog.removeEventListener("close", onClose);
        if (dialog.open) dialog.close();
        resolve(value);
      }
      function onSubmit(event) {
        event.preventDefault();
        finish(true);
      }
      function onCancel() {
        finish(false);
      }
      function onClose() {
        // 按 Esc 关闭也按“取消”处理
        finish(false);
      }

      form.addEventListener("submit", onSubmit);
      cancel.addEventListener("click", onCancel);
      dialog.addEventListener("close", onClose);
      dialog.showModal();
      document.getElementById("del-ok").focus();
    });
  }

  function move(index, delta) {
    const next = index + delta;
    if (next < 0 || next >= report.sections.length) return;
    const [section] = report.sections.splice(index, 1);
    report.sections.splice(next, 0, section);
    renderSections();
    scheduleSave();
  }

  // 写盘失败要重试：以前失败后没人再排定时器，改动就停在页面上不再落盘
  const SAVE_RETRY_MS = [800, 3000, 8000, 20000];
  let saveFailures = 0;

  function scheduleSave() {
    dirty = true;
    saveFailures = 0;   // 又有新改动，退避从头算
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistQuietly, 400);
  }

  // 定时触发的那次不往外抛（冒出去只弹一条 toast，问题依旧），失败由 scheduleRetry 记账
  async function persistQuietly() {
    try {
      await persist();
    } catch (err) {
      /* 重试已经排好了 */
    }
  }

  function scheduleRetry() {
    saveFailures += 1;
    if (saveFailures > SAVE_RETRY_MS.length) {
      Nav.toast("周报没能写进数据文件夹，改动还在页面上，检查下文件夹权限后重试");
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistQuietly, SAVE_RETRY_MS[saveFailures - 1]);
  }

  async function persist() {
    clearTimeout(saveTimer);
    if (!report || !dirty) return;
    const snapshot = structuredClone(report);
    dirty = false;
    try {
      await Workbench.saveReport(snapshot);
      saveFailures = 0;
    } catch (err) {
      dirty = true;
      scheduleRetry();
      throw err;   // 直接 await persist() 的地方（切周、润色）仍要知道这一趟没存上
    }
  }

  async function fillFromDone() {
    const todos = await Workbench.loadTodos();
    const start = Workbench.addUtcDays(endDate, -(spanDays - 1));
    const startMonday = Workbench.weekMonday(start.getUTCFullYear(), Workbench.isoWeek(start).week);
    const endMonday = Workbench.weekMonday(endDate.getUTCFullYear(), Workbench.isoWeek(endDate).week);
    const done = Workbench.activeItems(todos)
      .filter((todo) => {
        if (todo.state !== "DONE") return false;
        const tw = Workbench.todoWeekIso(todo);
        const tm = Workbench.weekMonday(tw.year, tw.week);
        return tm.getTime() >= startMonday.getTime() && tm.getTime() <= endMonday.getTime();
      });
    if (done.length === 0) {
      Nav.toast("本周没有已完成的待办");
      return;
    }
    let added = 0;
    done.forEach((todo) => {
      const project = todo.project || "其他";
      let section = report.sections.find((item) => item.project === project);
      if (!section) {
        section = { project, hours: 0, items: [] };
        report.sections.push(section);
      }
      const title = (todo.title || "").trim();
      const exists = section.items.some((item) => String(item).trim() === title);
      if (title && !exists) {
        if (section.items.length === 1 && !String(section.items[0]).trim()) section.items = [];
        section.items.push(title);
        added += 1;
      }
    });
    dirty = true;
    renderSections();
    await persist();
    Nav.toast(added ? `已填入 ${added} 条` : "这些待办已经在周报里");
  }

  async function copyMarkdown() {
    await persist();
    const text = Workbench.reportToMarkdown(report);
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    Nav.toast("已复制");
  }

  function reportText() {
    const blocks = [];
    (report.sections || []).forEach((section) => {
      const items = (section.items || []).map((item) => String(item).trim()).filter(Boolean);
      if (!section.project || !items.length) return;
      const lines = ["项目：" + section.project, "工时：" + Workbench.formatHours(section.hours || 0)];
      items.forEach((item, index) => lines.push((index + 1) + "、" + item));
      blocks.push(lines.join("\n"));
    });
    return blocks.join("\n\n");
  }

  function reportIsEmpty() {
    return !report.sections.some((section) => {
      return (section.items || []).some((item) => String(item).trim());
    });
  }

  const PROMPT_STORAGE = "wb-polish-prompt";

  /* 提示词的关键是把「不许做什么」写精确，而不是一刀切禁止：
     以前的写法让模型只能换词，现在是明确要求扩写，只把编造事实这条路堵死。 */
  function modeGoal(modeId) {
    const goals = {
      polish: "只优化表达：把每条改得更准确、更专业、更通顺。篇幅与原来基本一致，不补充新内容。",
      expand: "在保持原意的前提下扩写每条：一句话的条目写成 2-3 句，把「做了什么 → 怎么做的 → 结果或当前状态」说清楚；遇到过的卡点也可以点一句。",
      detail: "充分扩写每条：写成 3-4 句的一段，包含背景或目的、具体做法与关键技术点、当前进展与结果、遗留问题或下一步打算（下一步写在本条内部，不要单列新条目）。"
    };
    return goals[POLISH_MODES[modeId] ? modeId : "expand"];
  }

  function defaultPromptTemplate() {
    return [
      "你是一名资深研发经理，负责帮工程师把周报写清楚、写完整。",
      "",
      "任务：处理下面这份研发周报。",
      "",
      "【本次要求】",
      "{{要求}}",
      "",
      "【你可以做】",
      "1. 在不改变原意的前提下，补充合理的工程细节：使用的手段、排查思路、验证方式、协作对象（用「配合测试」「与相关同事」这类泛指，不要写具体人名）。",
      "2. 把含糊的说法改成具体描述，例如「处理了问题」改成「定位到某原因、用某方式修复、验证结果如何」。",
      "3. 保留原文已有的全部信息，一条都不能丢。",
      "",
      "【绝对不能做】",
      "1. 不得编造具体数字、百分比、时间、金额、人名、客户名、订单号等事实。",
      "2. 不得添加原文没有提到的新工作项、新成果、新项目。",
      "3. 不得夸大：不要用「圆满完成 / 显著提升 / 大幅优化 / 卓越 / 突破性成果 / 巨大价值」这类词。",
      "4. 不得改动项目名称、产品型号、软件号和专业术语，必须原样保留。",
      "",
      "【原文太短不足以展开时】",
      "保留原意，只补一层通用、合理的工程上下文即可，不要硬凑细节，也不要输出「信息不足」这类说明。",
      "",
      "【输出格式】（严格遵守，程序要解析）",
      "1. 不要用 Markdown：不要 #、*、**、-、> 或代码块。",
      "2. 每个项目先写一行「项目：名称」，下一行「工时：数字」，然后用「1、」「2、」「3、」逐条列出。",
      "3. 条目数量与顺序和原文保持一致：不合并、不拆分、不新增、不删减。",
      "4. 项目之间空一行。不写标题，不写总结段，不加任何解释。",
      "5. 直接输出结果。",
      "",
      "下面是本周周报原文：",
      "",
      "{{周报}}"
    ].join("\n");
  }

  function activePromptTemplate() {
    try {
      const saved = localStorage.getItem(PROMPT_STORAGE);
      if (saved && saved.trim()) return saved;
    } catch (err) {}
    return defaultPromptTemplate();
  }

  function openPromptEditor() {
    document.getElementById("prompt-editor").value = activePromptTemplate();
    document.getElementById("prompt-dialog").showModal();
  }

  function savePromptTemplate() {
    const text = document.getElementById("prompt-editor").value.replace(/\r\n/g, "\n");
    try {
      if (!text.trim() || text === defaultPromptTemplate()) localStorage.removeItem(PROMPT_STORAGE);
      else localStorage.setItem(PROMPT_STORAGE, text);
    } catch (err) {
      Nav.toast("浏览器不允许保存提示词");
      return;
    }
    document.getElementById("prompt-dialog").close();
    Nav.toast(text.trim() && text !== defaultPromptTemplate() ? "提示词已保存" : "已恢复默认提示词");
  }

  function buildPrompt(report, modeId) {
    let template = activePromptTemplate();
    if (template.indexOf("{{周报}}") < 0) {
      template = template.replace(/\s*$/, "") + "\n\n下面是本周周报原文：\n\n{{周报}}";
    }
    return template.split("{{要求}}").join(modeGoal(modeId)).split("{{周报}}").join(report);
  }

  async function polishReport() {
    if (reportIsEmpty()) {
      Nav.toast("这周还没有可润色的内容");
      return;
    }
    const button = document.getElementById("polish-report");
    const modelId = document.getElementById("polish-model").value || MODELS[0].id;
    const model = findModel(modelId);
    const modeId = document.getElementById("polish-mode").value || "expand";
    const mode = POLISH_MODES[modeId] || POLISH_MODES.expand;
    const key = model.key();
    if (!key) {
      Nav.toast("没有配置「" + model.label + "」的密钥");
      return;
    }
    button.disabled = true;
    button.textContent = "润色中…";
    document.getElementById("polish-usage").hidden = true;
    try {
      await persist();
      const weeklyReport = reportText();
      const response = await fetch(
        model.url,
        {
            method: "POST",
            headers: {
                Authorization: "Bearer " + key,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: model.model,
                temperature: mode.temperature,
                max_tokens: 4000,
                messages: [{
                    role: "user",
                    content: buildPrompt(weeklyReport, modeId)
                }]
            })
        }
    );

      let data = null;
      try {
        data = await response.json();
      } catch (err) {
        data = null;
      }
      showTokenUsage(data && data.usage);
      if (!response.ok) {
        const message = data && data.error && data.error.message ? data.error.message : "接口返回 " + response.status;
        Nav.toast(message);
        return;
      }
      const result = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!result || !String(result).trim()) {
        Nav.toast("接口没有返回润色内容");
        return;
      }
      document.getElementById("polish-result").value = stripFence(result);
      document.getElementById("polish-dialog").showModal();
    } catch (err) {
      Nav.toast(err && err.message ? err.message : "调用接口失败");
    } finally {
      button.disabled = false;
      button.textContent = "润色";
    }
  }

  function showTokenUsage(usage) {
    const node = document.getElementById("polish-usage");
    const prompt = usage ? Number(usage.prompt_tokens) : NaN;
    const completion = usage ? Number(usage.completion_tokens) : NaN;
    let total = usage ? Number(usage.total_tokens) : NaN;
    if (!Number.isFinite(total) && Number.isFinite(prompt) && Number.isFinite(completion)) {
      total = prompt + completion;
    }
    node.hidden = false;
    if (!Number.isFinite(total)) {
      node.textContent = "本次未返回 token 用量";
      return;
    }
    const parts = ["本次消耗 " + total.toLocaleString("zh-CN") + " token"];
    if (Number.isFinite(prompt)) parts.push("输入 " + prompt.toLocaleString("zh-CN"));
    if (Number.isFinite(completion)) parts.push("输出 " + completion.toLocaleString("zh-CN"));
    node.textContent = parts.join(" · ");
  }

  function stripFence(text) {
    return String(text || "").trim().replace(/^```[^\n]*\n/, "").replace(/\n```$/, "").trim();
  }

  function parsePolished(text) {
    const sections = [];
    let current = null;
    stripFence(text).replace(/\r\n/g, "\n").split("\n").forEach((raw) => {
      const line = raw.trim().replace(/^#{1,6}\s*/, "").replace(/\*\*/g, "");
      if (!line) return;
      const project = /^(?:项目|项目名称)\s*[:：]\s*(.+)$/.exec(line);
      if (project) {
        current = { project: project[1].trim(), hours: null, items: [] };
        sections.push(current);
        return;
      }
      const hours = /^(?:工时|小时)\s*[:：]\s*([0-9.]+)/.exec(line);
      if (hours && current) {
        current.hours = Number(hours[1]);
        return;
      }
      const item = /^(?:\d+\s*[.、．])\s*(.+)$/.exec(line);
      if (!item) return;
      if (!current) {
        current = { project: report.sections[0] ? report.sections[0].project : "其他", hours: null, items: [] };
        sections.push(current);
      }
      current.items.push(item[1].trim());
    });
    return sections.filter((section) => section.project);
  }

  async function applyPolish() {
    const parsed = parsePolished(document.getElementById("polish-result").value);
    if (!parsed.length) {
      Nav.toast("没有识别出项目，没有写回");
      return;
    }
    parsed.forEach((section) => {
      const previous = report.sections.find((item) => item.project === section.project);
      if (section.hours == null) section.hours = previous ? Number(previous.hours) || 0 : 0;
      if (!section.items.length) section.items = [""];
    });
    report.sections = parsed;
    dirty = true;
    renderSections();
    document.getElementById("polish-dialog").close();
    await persist();
    Nav.toast("已写回本周周报");
  }
})();
