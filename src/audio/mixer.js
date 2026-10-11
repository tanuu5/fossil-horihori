// ミキサー：music（ducking あり）/ sfx / amb の 3 系統 → master → 低音カット → コンプレッサー → 補正
// → ソフトクリッパー（±0.92 を超えない）→ 出力。リバーブは 1 つを全系統で共有する（送り量は系統ごと）。
// ぽんぽこカートのミキサーを元にしたもの。

export const DEFAULT_VOL = { master: 0.9, music: 0.6, sfx: 0.8 };
const DUCK = 0.4;      // 約 -8 dB
const AMB_REL = 0.75;  // 環境音は効果音の音量に対してこの割合
const TRIM = 0.72;     // コンプレッサーの自動メイクアップぶんを戻す

const clamp01 = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : d);

function softClipCurve(n = 4096) {
  const c = new Float32Array(n);
  const knee = 0.72, room = 0.2;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = Math.sign(x) * (a <= knee ? a : knee + room * Math.tanh((a - knee) / room));
  }
  return c;
}

/** 合成したインパルス応答（指数で減衰する、左右で少し違うノイズ）。 */
function makeIR(ctx, seconds = 2.2, decay = 3.2) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = rnd() * Math.pow(1 - t, decay) * (i < ctx.sampleRate * 0.01 ? i / (ctx.sampleRate * 0.01) : 1);
    }
  }
  return buf;
}

export function createMixer(ctx, dest = ctx.destination, vol = DEFAULT_VOL) {
  const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const master = G(clamp01(vol.master, DEFAULT_VOL.master));
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 24;
  hp.Q.value = 0.6;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 10;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;
  const trim = G(TRIM);
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve();
  master.connect(hp).connect(comp).connect(trim).connect(clip).connect(dest);

  const revIn = G(1);
  const conv = ctx.createConvolver();
  conv.buffer = makeIR(ctx);
  revIn.connect(conv).connect(G(0.5)).connect(master);

  const duckDry = G(1), duckWet = G(1);
  duckDry.connect(master);
  duckWet.connect(revIn);
  // 系統：dry（直接）と wet（リバーブへの送り）の 2 本。音を鳴らすときは bus.dry / bus.wet につなぐ
  const bus = (v, dry, wet) => { const b = { dry: G(v), wet: G(v) }; b.dry.connect(dry); b.wet.connect(wet); return b; };
  const cur = { ...DEFAULT_VOL };
  for (const k of Object.keys(cur)) cur[k] = clamp01(vol[k], cur[k]);
  const music = bus(cur.music, duckDry, duckWet);
  const sfx = bus(cur.sfx, master, revIn);
  const amb = bus(cur.sfx * AMB_REL, master, revIn);

  const set = (p, v) => { p.cancelScheduledValues(ctx.currentTime); p.setTargetAtTime(v, ctx.currentTime, 0.04); };
  return {
    ctx, master, music, sfx, amb, revIn,
    get volume() { return { ...cur }; },
    setVolume(v = {}) {
      for (const k of Object.keys(cur)) if (v[k] !== undefined) cur[k] = clamp01(v[k], cur[k]);
      set(master.gain, cur.master);
      set(music.dry.gain, cur.music); set(music.wet.gain, cur.music);
      set(sfx.dry.gain, cur.sfx); set(sfx.wet.gain, cur.sfx);
      set(amb.dry.gain, cur.sfx * AMB_REL); set(amb.wet.gain, cur.sfx * AMB_REL);
    },
    /** 音楽を下げる（ジングルやボイスの間）。on で素早く -8 dB、off でゆっくり戻す。 */
    duck(on, t = ctx.currentTime) {
      for (const p of [duckDry.gain, duckWet.gain]) {
        p.cancelScheduledValues(t);
        p.setTargetAtTime(on ? DUCK : 1, t, on ? 0.05 : 0.35);
      }
    },
  };
}
