/* 记谱试听：对照 Qt ChordPreviewer 的合成音回退实现。
   块式和弦 = 组成音同时起奏；琶音 = 升序排列，相邻音错开 0.35s。
   谐波配比 1 : 0.5 : 0.25，指数衰减包络 env = exp(-4t/seconds)。 */
(function (root) {
  "use strict";
  const Core = root.ChartCore;
  const BASE_FREQ = 261.625565;   // C4
  const ARPEGGIO_GAP = 0.35;

  let ctx = null;
  let nodes = [];
  let volume = 0.8;

  function ensure() {
    if (!ctx) {
      const Ctor = root.AudioContext || root.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function setVolume(value) {
    const next = Number(value);
    volume = Number.isFinite(next) ? Math.min(1, Math.max(0, next)) : 0.8;
  }

  function stop() {
    nodes.forEach((node) => {
      try { node.stop(); } catch (err) { /* 已经停了 */ }
    });
    nodes = [];
  }

  // midi 音高 → 一个音（基波 + 二三次谐波），带指数衰减
  function playNote(audio, midi, startAt, seconds, gain) {
    const freq = BASE_FREQ * Math.pow(2, (midi - 60) / 12);
    const amp = audio.createGain();
    amp.gain.setValueAtTime(gain, startAt);
    amp.gain.exponentialRampToValueAtTime(0.0001, startAt + seconds);
    amp.connect(audio.destination);
    [[1, 1], [2, 0.5], [3, 0.25]].forEach((pair) => {
      const osc = audio.createOscillator();
      const mix = audio.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq * pair[0], startAt);
      mix.gain.setValueAtTime(pair[1], startAt);
      osc.connect(mix);
      mix.connect(amp);
      osc.start(startAt);
      osc.stop(startAt + seconds);
      nodes.push(osc);
    });
  }

  // mode: "block" | "arpeggio"
  function playChord(name, mode, seconds) {
    const chord = Core.parseChord(name);
    if (!chord) return false;
    const audio = ensure();
    if (!audio) return false;
    const tones = Core.chordTones(chord);
    if (tones.length === 0) return false;
    const length = Number(seconds) > 0 ? Number(seconds) : 1.0;
    stop();
    const gain = volume * 0.8 / tones.length;
    if (mode === "arpeggio") {
      tones.map((tone) => 60 + tone).sort((a, b) => a - b)
        .forEach((midi, index) => {
          playNote(audio, midi, audio.currentTime + index * ARPEGGIO_GAP, length, gain);
        });
    } else {
      tones.forEach((tone) => playNote(audio, 60 + tone, audio.currentTime, length, gain));
    }
    return true;
  }

  root.ChartAudio = { playChord: playChord, stop: stop, setVolume: setVolume };
})(typeof window !== "undefined" ? window : globalThis);
