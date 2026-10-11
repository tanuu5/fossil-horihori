// 環境音の層。ずっと鳴り続ける音（風・雨・低い持続音・機械のうなり）を、層ごとの音量で混ぜる。
// audio.setAmbience({ wind: 0.6, rain: 1 }) で層の大きさ（0〜1）を変える。渡さなかった層は消える。
// 層を足すときは LAYERS に「作る関数」と「最大の音量（level）」を書く。作る関数は (ctx, A) → 出口の GainNode。
// （ホラーゲームの環境音を元にした。作品に合わせて足す・消す）

export const LAYERS = {
  /** 風：ゆっくり揺れる帯域のノイズ。 */
  wind: { level: 0.25, build(ctx, A) {
    const bp = A.filter('bandpass', 380, 0.8);
    A.noise().connect(bp);
    A.lfo(0.07, 180, bp.frequency);
    return bp;
  } },
  /** 雨（外）：さらさらとした高い音と、地面に当たる低い音。 */
  rain: { level: 0.5, build(ctx, A) {
    const mix = A.gain(1);
    A.noise().connect(A.filter('highpass', 500)).connect(A.filter('lowpass', 7500)).connect(mix);
    A.noise(1.3).connect(A.filter('lowpass', 420, 0.9)).connect(A.gain(0.7)).connect(mix);
    return mix;
  } },
  /** 雨（屋内）：屋根を打つこもった音。 */
  rainIndoor: { level: 0.5, build(ctx, A) {
    return A.noise(0.7).connect(A.filter('lowpass', 900, 0.8));
  } },
  /** 低い持続音（不安・広さ）。 */
  drone: { level: 0.08, build(ctx, A) {
    const lp = A.filter('lowpass', 380, 0.9);
    for (const [f, det] of [[55, 0], [82.6, 4], [110.3, -3], [164.8, 7]]) {
      const o = A.osc(f > 100 ? 'sine' : 'sawtooth', f);
      o.detune.value = det;
      o.connect(A.gain(f > 100 ? 0.25 : 0.12)).connect(lp);
    }
    A.lfo(0.05, 140, lp.frequency);
    return lp;
  } },
  /** 蛍光灯・機械のうなり。 */
  hum: { level: 0.025, build(ctx, A) {
    const mix = A.gain(1);
    for (const [f, v] of [[100, 0.5], [200, 0.25], [300, 0.12]]) A.osc('sine', f).connect(A.gain(v)).connect(mix);
    return mix;
  } },
};

/** 層を全部作って、音量 0 で鳴らしておく。戻り値 { 層の名前: { gain, level } }。 */
export function buildAmbience(ctx, out) {
  const n = ctx.sampleRate * 3;
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  let s = 4242;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0; // ピンクに近いノイズ（ざらつきが自然）
    for (let i = 0; i < n; i++) {
      const w = ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
  }
  const A = {
    gain: (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; },
    filter: (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; },
    noise: (rate = 1) => { const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.playbackRate.value = rate; src.start(ctx.currentTime, Math.random() * 2); return src; },
    osc: (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; },
    lfo: (rate, depth, param) => { const o = A.osc('sine', rate); o.connect(A.gain(depth)).connect(param); return o; },
  };
  const layers = {};
  for (const [name, L] of Object.entries(LAYERS)) {
    const g = A.gain(0);
    L.build(ctx, A).connect(g);
    g.connect(out.dry);
    g.connect(A.gain(0.4)).connect(out.wet);
    layers[name] = { gain: g, level: L.level };
  }
  return layers;
}
