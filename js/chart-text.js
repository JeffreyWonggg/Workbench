/* 记谱核心 B：段落 / 谱面解析 / 对齐格式化 / 整曲转调。
   谱面只有一种写法：和弦行写在歌词行上方、用空格对齐，位置就对上了。
   对照 Qt src/core 的 SectionParser、ChartParser、ChartTextFormatter、ChordTransposer 重写。 */
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

  // ===== 解析 =====
  // 一行算不算和弦行：去掉段落标题后，和弦 token 要盖住整行 80% 以上
  function parse(text) {
    const lines = splitLines(text).map((raw) => {
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

  // ===== 格式化（列对齐）=====
  const trimEnd = (text) => String(text).replace(/\s+$/, "");

  function buildSpans(line) {
    return line.tokens.map((token) => ({ start: token.start, length: token.length, name: token.raw }));
  }

  // 每行整理成 { 段落标题 | 和弦行 | 歌词行 }：渲染、查看、导出都吃这个结构
  function normalizedLines(text) {
    return parse(text).lines.map((line) => {
      const item = { sectionTitle: line.section || "", chordRow: "", lyricRow: "", spans: [] };
      if (line.section) return item;
      if (line.isChordLine) {
        item.chordRow = trimEnd(line.raw);
        item.spans = buildSpans(line);
        return item;
      }
      item.lyricRow = line.raw;
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

  // ===== 写法规范化（显示用）=====
  // 只把「和弦行」上的写法换成规范写法，歌词和段落标题一个字不动。
  // 这一行宽度尽量不变，否则和弦就跟下面歌词对不齐了：
  //   变短 → 后面补空格（和转调一个做法）
  //   变长 → 先跟紧后面的空格借，借不够才让这行变宽（行尾那个没有后续内容，变宽无妨）
  // 这个函数只用于「显示」：保存的内容、导出、复制、打印仍是用户写的原文。
  function normalizeChart(text) {
    return parse(text).lines.map((line) => {
      // 只动「和弦行」。歌词行里偶尔也有长得像和弦的词（比如英文歌词里的 "Am"），
      // 那是歌词，不能改。
      if (!line.isChordLine) return line.raw;
      let raw = line.raw;
      const ordered = line.tokens.slice().sort((a, b) => b.start - a.start);
      ordered.forEach((token) => {
        const name = Core.canonicalChordText(token.raw);
        if (name === token.raw) return;
        const diff = name.length - token.length;
        if (diff <= 0) {
          raw = raw.slice(0, token.start) + name + " ".repeat(-diff) + raw.slice(token.start + token.length);
          return;
        }
        let end = token.start + token.length;
        let borrowed = 0;
        while (borrowed < diff && raw.charAt(end) === " ") { end++; borrowed++; }
        const pad = borrowed - diff;
        raw = raw.slice(0, token.start) + name + (pad > 0 ? " ".repeat(pad) : "") + raw.slice(end);
      });
      return raw;
    }).join("\n");
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
    parse: parse,
    normalizedLines: normalizedLines,
    format: format,
    normalizeChart: normalizeChart,
    transposeChart: transposeChart
  };
})(typeof window !== "undefined" ? window : globalThis);
