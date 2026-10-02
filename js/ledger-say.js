(function (root) {
  /* 口述记账：把一句话解析成 ledger.json 的字段。
     提示词和回包解析都放在这里，不碰 DOM、不碰存储——
     页面只负责把结果填进弹窗，写库仍走 ledger.js 的 save()（解析结果绝不直接落库）。 */

  // 占位符只有这五个，页面和测试脚本按同一套替换：
  // {{今天}} {{昨天}} {{星期}} {{分类}} {{口述}}
  const SAY_PROMPT = `把下面这句口述解析成一条记账记录，只输出一个 JSON 对象，不要解释、不要用代码块。

字段要求：
kind     "expense"（支出）或 "income"（收入）；拿不准填 "expense"
amount   数字，正数，单位元。中文数字换算成阿拉伯数字（"三十五"=35，"一百二"=120，"两块五"=2.5）；句子里没有金额就填 null
date     "YYYY-MM-DD"，相对说法按今天换算（昨天、前天、上周五、3 号）；没提到日期填今天
category 从这些里选最贴切的：{{分类}}；都不合适就自己起一个 2-4 字的词
note     原话里剩下的补充信息，简短，也可以填空字符串

偏收入的线索：工资、奖金、报销到账、退款、收款、卖掉、收到红包、别人还钱。
偏支出的线索：买了、吃了、付了、充了、交了、打车、话费、房租。

今天：{{今天}}（周{{星期}}）

例：
昨天打车 38 → {"kind":"expense","amount":38,"date":"{{昨天}}","category":"交通","note":"打车"}
发工资了，这个月 12000 到账 → {"kind":"income","amount":12000,"date":"{{今天}}","category":"工资","note":"发工资"}

口述：{{口述}}`;

  const FALLBACK_CATEGORIES = ["餐饮", "交通", "购物", "住房", "日用", "医疗", "娱乐", "学习", "人情", "其他"];
  const WEEK = "日一二三四五六";

  const pad2 = (n) => String(n).padStart(2, "0");

  function isoDate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function shiftDay(date, days) {
    const copy = new Date(date.getTime());
    copy.setDate(copy.getDate() + days);
    return copy;
  }

  /* ctx：{ today: Date, categories: string[] } */
  function buildPrompt(text, ctx) {
    const today = ctx && ctx.today ? ctx.today : new Date();
    const list = ctx && ctx.categories && ctx.categories.length ? ctx.categories : FALLBACK_CATEGORIES;
    return SAY_PROMPT
      .split("{{今天}}").join(isoDate(today))
      .split("{{昨天}}").join(isoDate(shiftDay(today, -1)))
      .split("{{星期}}").join(WEEK[today.getDay()])
      .split("{{分类}}").join(list.join("/"))
      .split("{{口述}}").join(String(text || "").trim());
  }

  function cleanText(value, max) {
    let text = String(value == null ? "" : value).trim();
    text = text.replace(/^(?:分类|类别|备注|说明)\s*[:：]\s*/, "").trim();
    if (text.length > max) text = text.slice(0, max);
    return text;
  }

  function parseAmount(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
    const text = String(value).replace(/[,，\s¥￥元块]/g, "");
    const number = Number(text);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function parseDate(value) {
    const text = String(value == null ? "" : value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
    const [year, month, day] = text.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const valid = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
    return valid ? text : "";
  }

  /* 把模型回的字段收拾成能直接填表的样子。
     任何一项不可信就退回安全值，绝不猜：金额认不出就是 null，日期认不出就是空（由页面填今天）。 */
  function normalize(raw) {
    const data = raw && typeof raw === "object" ? raw : {};
    const kind = String(data.kind || "").trim().toLowerCase() === "income" ? "income" : "expense";
    return {
      kind: kind,
      amount: parseAmount(data.amount),
      date: parseDate(data.date),
      category: cleanText(data.category, 12),
      note: cleanText(data.note, 60)
    };
  }

  // 依赖 js/llm.js（页面里先加载它）——抠 JSON 的逻辑只留一份，放那边
  function parseReply(reply) {
    const json = root.LLM.firstJson(reply);
    if (!json) throw new Error("没从回包里找到 JSON");
    let data;
    try {
      data = JSON.parse(json);
    } catch (err) {
      throw new Error("回包不是合法 JSON");
    }
    return normalize(data);
  }

  root.LedgerSay = {
    SAY_PROMPT: SAY_PROMPT,
    buildPrompt: buildPrompt,
    parseReply: parseReply,
    normalize: normalize,
    isoDate: isoDate,
    shiftDay: shiftDay
  };
})(typeof window !== "undefined" ? window : globalThis);
