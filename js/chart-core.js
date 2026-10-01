/* 记谱核心 A：音名 / 和弦 / 调式。对照 Qt src/core 的 Note、Chord、KeySignature 重写。 */
(function (root) {
  "use strict";
  const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const LETTER_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const BLACK_KEYS = [1, 3, 6, 8, 10];

  function mod12(n) { return ((n % 12) + 12) % 12; }

  // "C" / "F#" / "Bb" → 0..11；其它一律失败（与 Note::TryParse 一致）
  function parseNote(text) {
    const name = String(text == null ? "" : text).trim();
    if (name.length < 1 || name.length > 2) return null;
    const base = LETTER_SEMITONE[name.charAt(0).toUpperCase()];
    if (base == null) return null;
    if (name.length === 1) return base;
    const acc = name.charAt(1);
    if (acc === "#") return mod12(base + 1);
    if (acc === "b") return mod12(base - 1);
    return null;
  }

  function noteName(semitone, useSharps) {
    return (useSharps ? SHARP_NAMES : FLAT_NAMES)[mod12(semitone)];
  }

  function isBlackKey(semitone) { return BLACK_KEYS.indexOf(mod12(semitone)) >= 0; }

  // [后缀, 音程]，顺序与 Qt ChordQuality 枚举一致
  const QUALITIES = [
    ["", [0, 4, 7]], ["m", [0, 3, 7]], ["dim", [0, 3, 6]], ["aug", [0, 4, 8]],
    ["sus2", [0, 2, 7]], ["sus4", [0, 5, 7]], ["maj7", [0, 4, 7, 11]], ["m7", [0, 3, 7, 10]],
    ["7", [0, 4, 7, 10]], ["dim7", [0, 3, 6, 9]], ["m7b5", [0, 3, 6, 10]], ["mMaj7", [0, 3, 7, 11]],
    ["add9", [0, 4, 7, 14]], ["6", [0, 4, 7, 9]], ["m6", [0, 3, 7, 9]], ["9", [0, 4, 7, 10, 14]],
    ["maj9", [0, 4, 7, 11, 14]], ["m9", [0, 3, 7, 10, 14]], ["11", [0, 4, 7, 10, 14, 17]],
    ["m11", [0, 3, 7, 10, 14, 17]], ["13", [0, 4, 7, 10, 14, 21]], ["maj13", [0, 4, 7, 11, 14, 21]],
    ["m13", [0, 3, 7, 10, 14, 21]], ["7b9", [0, 4, 7, 10, 13]], ["7#9", [0, 4, 7, 10, 15]],
    ["7b13", [0, 4, 7, 10, 20]], ["7#11", [0, 4, 7, 10, 18]], ["7b5", [0, 4, 6, 10]],
    ["7#5", [0, 4, 8, 10]], ["9sus4", [0, 5, 7, 10, 14]]
  ];

  // 后缀 → 品质下标；别名与 Qt kQualityMap 一致
  const QUALITY_ALIAS = {
    "": 0, "maj": 0, "m": 1, "min": 1, "dim": 2, "°": 2, "aug": 3, "+": 3,
    "sus2": 4, "sus": 5, "sus4": 5, "maj7": 6, "m7": 7, "min7": 7,
    "7": 8, "dim7": 9, "m7b5": 10, "mMaj7": 11, "minmaj7": 11, "add9": 12, "6": 13, "m6": 14,
    "9": 15, "maj9": 16, "min9": 17, "m9": 17, "11": 18, "m11": 19,
    "13": 20, "min13": 22, "maj13": 21, "m13": 22,
    "7b9": 23, "7#9": 24, "7b13": 25, "7#11": 26, "7b5": 27, "7#5": 28, "9sus4": 29
  };

  // 候选顺序即「最长优先」，与 Qt 正则里的写法一致
  const QUALITY_SUFFIXES = [
    "9sus4", "mMaj7", "m7b5", "maj13", "minmaj7", "7b9", "7b13", "7#11", "7#9", "7b5", "7#5",
    "dim7", "maj9", "maj7", "min13", "min9", "min7", "m13", "m11", "m9", "m7", "m6",
    "sus4", "sus2", "add9", "dim", "aug", "sus", "min", "maj", "m", "13", "11", "9", "7", "6", "+", "°"
  ];

  function escapeRe(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  const QUAL_PATTERN = QUALITY_SUFFIXES.map(escapeRe).join("|");
  // 扫描用：前缀/后缀排除字母数字与 =，根音必须大写，避免误吃英文单词
  const TOKEN_RE = new RegExp(
    "(?<![A-Za-z0-9=])[A-G][#b]?(?:" + QUAL_PATTERN + ")?(?:/[A-G][#b]?)?(?![A-Za-z0-9=])", "g");
  // 校验用：整串锚定
  const FULL_TOKEN_RE = new RegExp("^([A-G])([#b]?)(" + QUAL_PATTERN + ")?(/[A-G][#b]?)?$");

  function makeChord(rootSemitone, qualityIndex, bassSemitone) {
    return {
      root: mod12(rootSemitone),
      quality: qualityIndex == null ? 0 : qualityIndex,
      bass: bassSemitone == null ? null : mod12(bassSemitone)
    };
  }

  // 整串解析；多一个字符都算失败（同 Qt TryParseChord）
  function parseChord(text) {
    const token = String(text == null ? "" : text).trim();
    if (!token) return null;
    const m = FULL_TOKEN_RE.exec(token);
    if (!m) return null;
    const root = parseNote(m[1] + (m[2] || ""));
    if (root == null) return null;
    const quality = QUALITY_ALIAS[m[3] || ""];
    let bass = null;
    if (m[4]) {
      bass = parseNote(m[4].slice(1));
      if (bass == null) return null;
    }
    return makeChord(root, quality == null ? 0 : quality, bass);
  }

  function isValidChord(text) { return !!parseChord(text); }

  function chordName(chord, useSharps) {
    const base = noteName(chord.root, useSharps) + QUALITIES[chord.quality][0];
    return chord.bass == null ? base : base + "/" + noteName(chord.bass, useSharps);
  }

  // 组成音：按首次出现顺序去重，不排序（与 GetChordTones 一致）
  function chordTones(chord) {
    const out = [];
    QUALITIES[chord.quality][1].forEach((step) => {
      const tone = mod12(chord.root + step);
      if (out.indexOf(tone) < 0) out.push(tone);
    });
    if (chord.bass != null && out.indexOf(chord.bass) < 0) out.push(chord.bass);
    return out;
  }

  function blackKeyToneCount(chord) {
    return chordTones(chord).filter(isBlackKey).length;
  }

  function transposeChord(chord, semitones) {
    return makeChord(chord.root + semitones, chord.quality,
      chord.bass == null ? null : chord.bass + semitones);
  }

  function chordKey(chord) { return chord.root + ":" + chord.quality; }   // 忽略斜杠低音

  // [名字, 根音, 升降号数, 是否用升号]；C#/D#/G#/A# 用等音调 Db/Eb/Ab/Bb 代替
  const MAJOR_KEYS = [
    ["C", 0, 0, true], ["Db", 1, 5, false], ["D", 2, 2, true], ["Eb", 3, 3, false],
    ["E", 4, 4, true], ["F", 5, 1, false], ["F#", 6, 6, true], ["G", 7, 1, true],
    ["Ab", 8, 4, false], ["A", 9, 3, true], ["Bb", 10, 2, false], ["B", 11, 5, true]
  ];

  const KEYS = (function () {
    const list = MAJOR_KEYS.map((item) => ({
      name: item[0], root: item[1], major: true, accidentals: item[2], useSharps: item[3]
    }));
    // 关系小调：调号取自上方小三度的大调（Aeolian 关系），根音仍是本名音
    MAJOR_KEYS.forEach((item) => {
      const relative = MAJOR_KEYS.find((cand) => cand[1] === mod12(item[1] + 3));
      if (!relative) return;
      list.push({
        name: item[0] + "m", root: item[1], major: false,
        accidentals: relative[2], useSharps: relative[3]
      });
    });
    return list;
  })();

  function findKey(name) {
    const low = String(name == null ? "" : name).replace(/\s+/g, "").toLowerCase();
    if (!low) return null;
    return KEYS.find((key) => key.name.toLowerCase() === low) || null;
  }

  function semitonesBetween(from, to) { return mod12(to.root - from.root); }

  function keyName(key, semitone) { return noteName(semitone, key.useSharps); }

  // 全文扫描出和弦 token：start/length 是原文列坐标，后续对齐、转调都靠它
  function tokenize(line) {
    const text = String(line == null ? "" : line);
    const tokens = [];
    if (!text) return tokens;
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      const chord = parseChord(m[0]);
      if (chord) tokens.push({ start: m.index, length: m[0].length, raw: m[0], chord: chord });
      if (m.index === TOKEN_RE.lastIndex) TOKEN_RE.lastIndex++;
    }
    return tokens;
  }

  // 覆盖率 = 和弦占用的字符数 / 非空白字符数；≥ 0.8 才算「纯和弦行」
  function coverageRatio(line, tokens) {
    const total = String(line == null ? "" : line).replace(/\s/g, "").length;
    if (!total) return 0;
    return tokens.reduce((sum, token) => sum + token.length, 0) / total;
  }

  function isChordLine(line) {
    const tokens = tokenize(line);
    return tokens.length > 0 && coverageRatio(line, tokens) >= 0.8;
  }

  root.ChartCore = {
    mod12: mod12,
    tokenize: tokenize,
    coverageRatio: coverageRatio,
    isChordLine: isChordLine,
    parseNote: parseNote,
    noteName: noteName,
    isBlackKey: isBlackKey,
    QUALITIES: QUALITIES,
    QUALITY_SUFFIXES: QUALITY_SUFFIXES,
    makeChord: makeChord,
    parseChord: parseChord,
    isValidChord: isValidChord,
    chordName: chordName,
    chordTones: chordTones,
    blackKeyToneCount: blackKeyToneCount,
    transposeChord: transposeChord,
    chordKey: chordKey,
    KEYS: KEYS,
    findKey: findKey,
    semitonesBetween: semitonesBetween,
    keyName: keyName
  };
})(typeof window !== "undefined" ? window : globalThis);
