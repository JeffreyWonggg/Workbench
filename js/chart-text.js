/* 记谱核心 B：段落 / 内联和弦 / 谱面解析 / 对齐格式化 / 粘贴清洗 / 整曲转调。
   对照 Qt src/core 的 SectionParser、InlineChordConverter、ChartParser、
   ChartTextFormatter、TextCleaner、ChordTransposer 重写。 */
(function (root) {
  "use strict";
  const Core = root.ChartCore;

  // ===== 段落 =====
  const SECTION_KEYWORDS = [
    "主歌", "副歌", "桥段", "桥", "前奏", "间奏", "尾奏", "尾声", "插曲", "反复", "合唱", "独唱",
    "吉他", "对白", "verse", "chorus", "bridge", "intro", "interlude", "outro", "break",
    "hook", "refrain", "pre-chorus", "prechorus"
  ];

  // 整行 [xxx]，或「关键词（可带 ×N 与冒号）」→ 段落标题
  function tryParseSection(line) {
    const text = String(line == null ? "" : line).trim();
    if (!text) return null;
    if (/^\[.*\]$/.test(text)) return text;
    const stripped = text.replace(/[（(]?[×xX]\s*\d+\s*[)）]?$/, "").trim()
      .replace(/[\s\u2236\uFF1A:]+$/, "");
    if (!stripped || stripped.length > 16) return null;
    return SECTION_KEYWORDS.indexOf(stripped.toLowerCase()) >= 0 ? text : null;
  }

  function splitLines(text) { return String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n"); }

  // ===== 内联和弦：上一行纯和弦 + 下一行带 () 标记的歌词 → 合成 {和弦} =====
  const MARKER_RE = /\([^()]{0,2}\)/g;

  function convertPair(chordLine, lyricLine) {
    const names = Core.tokenize(chordLine)
      .map((token) => String(chordLine).substr(token.start, token.length).trim())
      .filter((name) => name.length > 0);
    if (names.length === 0) return lyricLine;
    const queue = names.slice();
    const text = String(lyricLine == null ? "" : lyricLine);
    let out = "";
    let pos = 0;
    MARKER_RE.lastIndex = 0;
    let m;
    while ((m = MARKER_RE.exec(text)) !== null) {
      out += text.slice(pos, m.index);
      const inner = m[0].length > 2 ? m[0].slice(1, -1) : "";   // 括号里的字保留原位
      if (queue.length > 0) out += "{" + queue.shift() + "}";
      out += inner;
      pos = m.index + m[0].length;
    }
    out += text.slice(pos);
    while (queue.length > 0) out += " {" + queue.shift() + "}";   // 多出来的和弦锚到行尾
    return out;
  }

  function inlineConvert(text) {
    const lines = splitLines(text);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (Core.isChordLine(line) && i + 1 < lines.length) {
        const next = lines[i + 1];
        const nextIsSection = !!tryParseSection(next);
        MARKER_RE.lastIndex = 0;
        if (!nextIsSection && !Core.isChordLine(next) && MARKER_RE.test(next)) {
          out.push(convertPair(line, next));
          i++;
          continue;
        }
      }
      out.push(line);
    }
    return out.join("\n");
  }

  // ===== 解析 =====
  function parse(text) {
    const lines = splitLines(inlineConvert(text)).map((raw) => {
      const section = tryParseSection(raw);
      const tokens = Core.tokenize(raw);
      return {
        raw: raw,
        section: section,
        tokens: tokens,
        isChordLine: !section && tokens.length > 0 && Core.coverageRatio(raw, tokens) >= 0.8
      };
    });
    return {
      lines: lines,
      chords: lines.reduce((all, line) => all.concat(line.tokens.map((t) => t.chord)), [])
    };
  }

  // ===== 格式化（列对齐，无引导点号）=====
  const BRACE_RE = /\{([^{}]+)\}/g;
  const trimEnd = (text) => String(text).replace(/\s+$/, "");

  function buildSpans(line) {
    return line.tokens.map((token) => ({ start: token.start, length: token.length, name: token.raw }));
  }

  // 单行混排（和弦 + 歌词同一行）：和弦抄到上排，歌词留下排，花括号本身抹掉
  function splitMixed(line) {
    const raw = line.raw;
    const chordChars = new Array(raw.length).fill(" ");
    const lyricChars = raw.split("");
    line.tokens.forEach((token) => {
      for (let i = 0; i < token.length; i++) {
        const at = token.start + i;
        if (at >= raw.length) break;
        chordChars[at] = raw.charAt(at);
        lyricChars[at] = " ";
      }
    });
    BRACE_RE.lastIndex = 0;
    let m;
    while ((m = BRACE_RE.exec(raw)) !== null) {
      if (!Core.isValidChord(m[1].trim())) continue;
      const head = m.index;
      const tail = m.index + m[0].length - 1;
      chordChars[head] = " ";
      chordChars[tail] = " ";
      lyricChars[head] = " ";
      lyricChars[tail] = " ";
    }
    const chordRow = trimEnd(chordChars.join(""));
    return { chordRow: chordRow, lyricRow: lyricChars.join("") };
  }

  function normalizedLines(text) {
    return parse(text).lines.map((line) => {
      const item = { sectionTitle: line.section || "", chordRow: "", lyricRow: "", spans: [] };
      if (line.section) return item;
      if (line.isChordLine) {
        item.chordRow = trimEnd(line.raw);
        item.spans = buildSpans(line);
        return item;
      }
      if (line.tokens.length === 0) {
        item.lyricRow = line.raw;
        return item;
      }
      const mixed = splitMixed(line);
      item.chordRow = mixed.chordRow;
      item.lyricRow = mixed.lyricRow;
      item.spans = buildSpans(line);
      return item;
    });
  }

  function format(text) {
    const out = [];
    normalizedLines(text).forEach((line) => {
      if (line.sectionTitle) { out.push(line.sectionTitle); return; }
      if (trimEnd(line.chordRow).trim()) out.push(line.chordRow);
      if (String(line.lyricRow).trim()) out.push(line.lyricRow);
      if (!trimEnd(line.chordRow).trim() && !String(line.lyricRow).trim()) out.push("");
    });
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }

  // ===== 粘贴清洗 =====
  const URL_LINE_RE = /^((https?:\/\/|www\.)[^\s]+|[\w.-]+\.(com|cn|net|org|cc|me|xyz))$/i;
  const DECOR_LINE_RE = /^[\s\-=*_~·.、+]+$/;
  const SITE_TAG_RE = /[\(（]?\s*(?:www\.)?[\w-]+\.(?:com|cn|net|org|cc|me|xyz)[^\s\)）]*\s*[\)）]?\s*$/gi;
  const HEADER_LINE_RE = new RegExp("^(?:原调|变调夹|Capo|歌手|演唱|歌名|歌曲名|作词|作曲|编曲|原版|弹唱谱|指弹谱|和弦谱|词曲|调弦|降半音|标准调弦|选调|1=[A-G][#b]?|[A-G][#b]?调)", "i");
  const BARE_SCHEME_RE = /^https?:\/\/?$/i;

  const ENTITIES = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'",
    "&nbsp;": "\u00A0", "&copy;": "©", "&reg;": "®", "&trade;": "™", "&hellip;": "…",
    "&mdash;": "—", "&ndash;": "–", "&lsquo;": "\u2018", "&rsquo;": "\u2019",
    "&ldquo;": "\u201C", "&rdquo;": "\u201D"
  };

  function htmlDecode(input) {
    let text = String(input == null ? "" : input);
    Object.keys(ENTITIES).forEach((key) => { text = text.split(key).join(ENTITIES[key]); });
    return text.replace(/&#(x?)([0-9a-fA-F]+);/g, (whole, hex, digits) => {
      const code = parseInt(digits, hex ? 16 : 10);
      return code > 0 ? String.fromCodePoint(code) : whole;
    });
  }

  function normalizeLine(line) {
    let text = String(line).replace(/\u3000/g, " ").replace(/\u00A0/g, " ").replace(/\t/g, " ");
    text = text.replace(SITE_TAG_RE, "").trim();
    // 和弦行要保持列对齐，不能折叠空格
    return Core.isChordLine(text) ? text : text.replace(/ {2,}/g, " ");
  }

  function isNoiseLine(line) {
    if (URL_LINE_RE.test(line)) return true;
    // 行尾站点标记被剥掉后只剩协议的残行，也当噪声
    if (BARE_SCHEME_RE.test(line)) return true;
    if (DECOR_LINE_RE.test(line)) return true;
    if (line.length < 40 && /www\./i.test(line)) return true;
    if (line.length < 30 && HEADER_LINE_RE.test(line)) return true;
    return false;
  }

  function clean(input) {
    if (!String(input == null ? "" : input).trim()) return "";
    const lines = splitLines(htmlDecode(input));
    const out = [];
    lines.forEach((raw) => {
      const line = normalizeLine(raw);
      if (!line) { out.push(""); return; }      // 空行保留，段落之间才不至于糊成一坨
      if (isNoiseLine(line)) return;
      out.push(line);
    });
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }

  // ===== 整曲转调 =====
  // 拼写只看目标调是否用升号；新名比原位短就补空格，保住上下两行的列对齐
  function transposeChart(text, semitones, key) {
    return parse(text).lines.map((line) => {
      if (line.tokens.length === 0) return line.raw;
      let raw = line.raw;
      const ordered = line.tokens.slice().sort((a, b) => b.start - a.start);
      ordered.forEach((token) => {
        const name = Core.chordName(Core.transposeChord(token.chord, semitones), key.useSharps);
        const padded = name.length < token.length
          ? name + " ".repeat(token.length - name.length)
          : name;
        raw = raw.slice(0, token.start) + padded + raw.slice(token.start + token.length);
      });
      return raw;
    }).join("\n");
  }

  root.ChartText = {
    tryParseSection: tryParseSection,
    splitLines: splitLines,
    inlineConvert: inlineConvert,
    parse: parse,
    normalizedLines: normalizedLines,
    format: format,
    clean: clean,
    transposeChart: transposeChart
  };
})(typeof window !== "undefined" ? window : globalThis);
