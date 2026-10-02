/* 记谱核心 C：推荐调 / 和弦补全。
   对照 Qt src/core 的 KeyRecommender、ChordAutocomplete 与
   data/chord_progressions.json 重写。 */
(function (root) {
  "use strict";
  const Core = root.ChartCore;

  const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
  const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
  const TRIAD_MAJOR = [0, 1, 1, 0, 0, 1, 2];   // 1..7 → 大三/小三/减三 的品质下标
  const TRIAD_MINOR = [1, 2, 0, 1, 1, 0, 0];

  function scaleOf(key) { return key.major ? MAJOR_SCALE : MINOR_SCALE; }

  function degreeToNote(key, degree) {
    const scale = scaleOf(key);
    const index = ((degree - 1) % 7 + 7) % 7;
    return Core.mod12(key.root + scale[index]);
  }

  // 正度数走级数和弦；负度数（bVII、bII 之类）取音阶音降半音，按大三和弦处理
  function chordFromDegree(key, degree) {
    if (degree > 0) {
      const table = key.major ? TRIAD_MAJOR : TRIAD_MINOR;
      const index = ((degree - 1) % 7 + 7) % 7;
      return Core.makeChord(degreeToNote(key, degree), table[index], null);
    }
    const scale = scaleOf(key);
    const index = ((-degree - 1) % 7 + 7) % 7;
    return Core.makeChord(Core.mod12(key.root + scale[index] - 1), 0, null);
  }

  function seventhFromDegree(key, degree) {
    if (key.major) {
      if (degree === 1) return 6;   // maj7
      if (degree === 2 || degree === 6) return 7;   // m7
      if (degree === 5) return 8;   // 属七
      return null;
    }
    if (degree === 1 || degree === 4) return 7;
    if (degree === 5) return 8;
    return null;
  }

  const PROGRESSIONS = [
    [1, 5, 6, 4], [6, 4, 1, 5], [1, 4, 5], [1, 5, 6, 3, 4, 1, 4, 5], [2, 5, 1], [1, 6, 2, 5]
  ];

  // ===== 和弦补全 =====

  const POOL_QUALITIES = [0, 1, 8, 6, 7, 5, 4, 2, 3, 13, 14, 15, 16, 17, 20];

  function suggest(chords, key, options) {
    const opts = options || {};
    const prefix = String(opts.prefix || "").trim().toLowerCase();
    const favorites = (opts.favorites || []).map((name) => String(name).trim().toLowerCase());
    const current = String(opts.current || "").trim();
    const limit = opts.count || 6;
    const names = [];
    const seen = new Set();
    const push = (chord) => {
      const name = Core.chordName(chord, key.useSharps);
      const low = name.toLowerCase();
      if (seen.has(low)) return;
      seen.add(low);
      names.push(name);
    };

    PROGRESSIONS.forEach((item) => item.forEach((degree) => push(chordFromDegree(key, degree))));
    for (let degree = 1; degree <= 7; degree++) push(chordFromDegree(key, degree));
    (key.major ? [1, 2, 5, 6] : [1, 4, 5]).forEach((degree) => {
      const quality = seventhFromDegree(key, degree);
      if (quality != null) push(Core.makeChord(degreeToNote(key, degree), quality, null));
    });

    // 本曲已用和弦：按出现次数降序，同频按名字排
    const counts = new Map();
    used.forEach((name) => {
      const text = String(name || "").trim();
      if (text) counts.set(text, (counts.get(text) || 0) + 1);
    });
    Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
      .forEach((entry) => {
        const low = entry[0].toLowerCase();
        if (!seen.has(low)) { seen.add(low); names.push(entry[0]); }
      });

    for (let semitone = 0; semitone < 12; semitone++) {
      POOL_QUALITIES.forEach((quality) => push(Core.makeChord(semitone, quality, null)));
    }

    const mark = (name) => {
      const low = name.toLowerCase();
      return {
        prefix: prefix && !low.startsWith(prefix) ? 1 : 0,
        favorite: favorites.indexOf(low) >= 0 ? 0 : 1
      };
    };
    const pool = current ? names.filter((name) => name.toLowerCase() !== current.toLowerCase()) : names;
    return pool
      .map((name, index) => ({ name: name, index: index, rank: mark(name) }))
      .sort((a, b) => a.rank.prefix - b.rank.prefix
        || a.rank.favorite - b.rank.favorite
        || a.index - b.index)
      .slice(0, limit)
      .map((item) => item.name);
  }

  // ===== 推荐调 =====

  // 擅长和弦是绝对指法集合，不随目标调平移；歌曲和弦按候选调平移后再比对
  function hitRatio(chords, favorites, offset) {
    if (!favorites || favorites.length === 0 || chords.length === 0) return 0;
    const set = new Set(favorites.map((chord) => Core.chordKey(chord)));
    const hits = chords.filter((chord) => set.has(Core.chordKey(Core.transposeChord(chord, offset)))).length;
    return hits / chords.length;
  }

  // score 越低越好：黑键少优先，擅长和弦覆盖率高次之
  function recommendKeys(chords, currentKey, options) {
    const opts = options || {};
    const favorites = (opts.favorites || []).map((name) => Core.parseChord(name)).filter(Boolean);
    const weight = Math.min(1, Math.max(0, Number(opts.weight) || 0));
    const list = chords || [];
    return Core.KEYS.map((key) => {
      const offset = Core.mod12(key.root - currentKey.root);
      const blackKeyCount = list.reduce(
        (sum, chord) => sum + Core.blackKeyToneCount(Core.transposeChord(chord, offset)), 0);
      const coverage = hitRatio(list, favorites, offset);
      const blackKeyNorm = list.length ? Math.min(1, blackKeyCount / (list.length * 4)) : 0;
      return {
        key: key,
        name: key.name,
        offset: offset,
        blackKeyCount: blackKeyCount,
        coverage: coverage,
        score: (1 - weight) * blackKeyNorm - weight * coverage
      };
    }).sort((a, b) => a.score - b.score
      || a.blackKeyCount - b.blackKeyCount
      || a.key.accidentals - b.key.accidentals
      || (a.key.name < b.key.name ? -1 : a.key.name > b.key.name ? 1 : 0));
  }

  root.ChartSuggest = {
    chordFromDegree: chordFromDegree,
    degreeToNote: degreeToNote,
    suggest: suggest,
    recommendKeys: recommendKeys,
    PROGRESSIONS: PROGRESSIONS
  };
})(typeof window !== "undefined" ? window : globalThis);
