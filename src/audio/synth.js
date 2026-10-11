// 音源と効果音。音声ファイルは使わず、Web Audio のオシレーターとノイズで鳴らす。
// どの関数も (ctx, out, t, p) の形：out はミキサーの系統（{ dry, wet }）、t は鳴らす時刻（ctx.currentTime 基準）。
// p は { f（Hz）or m（MIDI）, dur, vel（0〜1）, pan（-1〜1）, rev（リバーブへの送り 0〜1） } など。
// 値はすべて fin() で確かめてから使う（NaN が AudioParam に入ると、その音はもう鳴らない）。

const fin = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const FLOOR = 0.0001; // 指数ランプは 0 に向かえないので、ここまで下げる

const noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let b = noiseCache.get(ctx);
  if (!b) {
    const n = ctx.sampleRate * 1.5;
    b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    let s = 22222;
    for (let i = 0; i < n; i++) d[i] = ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

/** node → 音量 → 定位 → out.dry（と、rev があれば out.wet）につなぐ。音量の GainNode を返す。 */
function route(ctx, node, out, p) {
  const g = ctx.createGain();
  g.gain.value = 0;
  let last = node.connect(g);
  if (p.pan) {
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, fin(p.pan, 0)));
    last = last.connect(pan);
  }
  last.connect(out.dry);
  const rev = fin(p.rev, 0);
  if (rev > 0) { const s = ctx.createGain(); s.gain.value = rev; last.connect(s).connect(out.wet); }
  return g;
}

/** 立ち上がり a、減衰 d で peak から消える（打楽器・効果音の形）。 */
function perc(param, t, peak, a, d) {
  param.setValueAtTime(FLOOR, t);
  param.linearRampToValueAtTime(Math.max(FLOOR, peak), t + a);
  param.exponentialRampToValueAtTime(FLOOR, t + a + d);
}
/** 立ち上がり a、保持、離して r で消える（持続音の形）。 */
function adsr(param, t, peak, a, hold, r) {
  param.setValueAtTime(FLOOR, t);
  param.linearRampToValueAtTime(Math.max(FLOOR, peak), t + a);
  param.setValueAtTime(Math.max(FLOOR, peak), t + a + hold);
  param.exponentialRampToValueAtTime(FLOOR, t + a + hold + r);
}

function osc(ctx, type, f, t, end) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(1, f), t);
  o.start(t);
  o.stop(end + 0.05);
  return o;
}

function noise(ctx, t, end) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx);
  s.loop = true;
  s.start(t, Math.random() * 1.2);
  s.stop(end + 0.05);
  return s;
}

function filter(ctx, type, f, q = 0.8) {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = Math.max(10, f);
  b.Q.value = q;
  return b;
}

const hz = (p, def) => fin(p.f, p.m !== undefined ? mtof(fin(p.m, 69)) : def);

// ---------------------------------------------------------------- 楽器（シーケンサーから使う）
export const INSTRUMENTS = {
  /** 矩形波のリード（チップチューン寄り）。 */
  lead(ctx, out, t, p) {
    const f = hz(p, 440), dur = fin(p.dur, 0.25), vel = fin(p.vel, 0.8);
    const o = osc(ctx, 'square', f, t, t + dur + 0.2);
    const lp = filter(ctx, 'lowpass', Math.min(9000, f * 6), 0.7);
    const g = route(ctx, o.connect(lp), out, { rev: 0.18, ...p });
    adsr(g.gain, t, 0.14 * vel, 0.006, Math.max(0, dur - 0.03), 0.12);
  },
  /** のこぎり波のベース（フィルターで弾く）。 */
  bass(ctx, out, t, p) {
    const f = hz(p, 55), dur = fin(p.dur, 0.25), vel = fin(p.vel, 0.8);
    const o = osc(ctx, 'sawtooth', f, t, t + dur + 0.15);
    const lp = filter(ctx, 'lowpass', 900, 3);
    lp.frequency.setValueAtTime(220 + 2200 * vel, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + 0.18);
    const g = route(ctx, o.connect(lp), out, p);
    adsr(g.gain, t, 0.3 * vel, 0.004, Math.max(0, dur - 0.04), 0.08);
  },
  /** 少しずらした 3 本ののこぎり波のパッド（和音向け）。 */
  pad(ctx, out, t, p) {
    const f = hz(p, 220), dur = fin(p.dur, 1), vel = fin(p.vel, 0.6);
    const lp = filter(ctx, 'lowpass', 1800, 0.5);
    const mix = ctx.createGain();
    for (const det of [-9, 0, 8]) { const o = osc(ctx, 'sawtooth', f, t, t + dur + 0.8); o.detune.value = det; o.connect(mix); }
    mix.gain.value = 0.33;
    const g = route(ctx, mix.connect(lp), out, { rev: 0.35, ...p });
    adsr(g.gain, t, 0.08 * vel, 0.12, Math.max(0, dur - 0.12), 0.6);
  },
  /** 弾いた音（三角波＋短い倍音）。アルペジオ・メロディに。 */
  pluck(ctx, out, t, p) {
    const f = hz(p, 440), vel = fin(p.vel, 0.8);
    const o = osc(ctx, 'triangle', f, t, t + 0.6);
    const o2 = osc(ctx, 'sine', f * 2, t, t + 0.25);
    const m = ctx.createGain();
    o.connect(m); o2.connect(m);
    const g = route(ctx, m, out, { rev: 0.2, ...p });
    perc(g.gain, t, 0.25 * vel, 0.003, 0.45);
  },
  /** 鐘（FM）。完成・ご褒美の合図に。 */
  bell(ctx, out, t, p) {
    const f = hz(p, 880), vel = fin(p.vel, 0.7), dur = fin(p.dur, 1.4);
    const car = osc(ctx, 'sine', f, t, t + dur);
    const mod = osc(ctx, 'sine', f * 3.5, t, t + dur);
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(f * 2.2, t);
    mg.gain.exponentialRampToValueAtTime(Math.max(1, f * 0.05), t + dur);
    mod.connect(mg).connect(car.frequency);
    const g = route(ctx, car, out, { rev: 0.35, ...p });
    perc(g.gain, t, 0.18 * vel, 0.002, dur);
  },
  kick(ctx, out, t, p) {
    const vel = fin(p.vel, 0.9);
    const o = osc(ctx, 'sine', 150, t, t + 0.45);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = route(ctx, o, out, p);
    perc(g.gain, t, 0.9 * vel, 0.002, 0.38);
  },
  snare(ctx, out, t, p) {
    const vel = fin(p.vel, 0.8);
    const n = noise(ctx, t, t + 0.25);
    const g = route(ctx, n.connect(filter(ctx, 'bandpass', 1800, 0.7)), out, { rev: 0.15, ...p });
    perc(g.gain, t, 0.5 * vel, 0.001, 0.18);
    const o = osc(ctx, 'triangle', 190, t, t + 0.15);
    const g2 = route(ctx, o, out, p);
    perc(g2.gain, t, 0.3 * vel, 0.001, 0.09);
  },
  hat(ctx, out, t, p) {
    const vel = fin(p.vel, 0.6), open = !!p.open;
    const n = noise(ctx, t, t + (open ? 0.35 : 0.08));
    const g = route(ctx, n.connect(filter(ctx, 'highpass', 7500, 0.7)), out, p);
    perc(g.gain, t, 0.22 * vel, 0.001, open ? 0.3 : 0.05);
  },
};

// ---------------------------------------------------------------- 効果音（audio.sfx(name) で鳴らす）
// 作品に合わせて足す・作り替える。名前はゲームの出来事に合わせる（coin, hit, gameover …）。
export const SFX = {
  ui_move(ctx, out, t) { INSTRUMENTS.pluck(ctx, out, t, { f: 1320, vel: 0.35, rev: 0 }); },
  ui_ok(ctx, out, t) { INSTRUMENTS.pluck(ctx, out, t, { f: 988, vel: 0.5 }); INSTRUMENTS.pluck(ctx, out, t + 0.06, { f: 1480, vel: 0.5 }); },
  ui_back(ctx, out, t) { INSTRUMENTS.pluck(ctx, out, t, { f: 880, vel: 0.45 }); INSTRUMENTS.pluck(ctx, out, t + 0.06, { f: 587, vel: 0.45 }); },
  pause(ctx, out, t) { INSTRUMENTS.bell(ctx, out, t, { f: 784, vel: 0.9, dur: 0.6 }); },
  jump(ctx, out, t, p = {}) {
    const o = osc(ctx, 'square', 300, t, t + 0.2);
    o.frequency.exponentialRampToValueAtTime(760 * fin(p.pitch, 1), t + 0.14);
    const g = route(ctx, o.connect(filter(ctx, 'lowpass', 3200)), out, p);
    perc(g.gain, t, 0.12, 0.004, 0.16);
  },
  land(ctx, out, t, p = {}) {
    const n = noise(ctx, t, t + 0.12);
    const g = route(ctx, n.connect(filter(ctx, 'lowpass', 600, 0.9)), out, p);
    perc(g.gain, t, 0.35 * fin(p.vel, 1), 0.002, 0.1);
  },
  coin(ctx, out, t, p = {}) {
    const k = fin(p.pitch, 1);
    for (const [dt, f] of [[0, 1319], [0.07, 1976]]) {
      const o = osc(ctx, 'square', f * k, t + dt, t + dt + 0.3);
      const g = route(ctx, o.connect(filter(ctx, 'lowpass', 6000)), out, { rev: 0.15, ...p });
      perc(g.gain, t + dt, 0.1, 0.002, dt ? 0.26 : 0.08);
    }
  },
  hit(ctx, out, t, p = {}) {
    const o = osc(ctx, 'sawtooth', 220, t, t + 0.25);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.2);
    const g = route(ctx, o.connect(filter(ctx, 'lowpass', 1400)), out, p);
    perc(g.gain, t, 0.3, 0.002, 0.22);
    SFX.land(ctx, out, t, { vel: 0.8 });
  },
  explode(ctx, out, t, p = {}) {
    const dur = fin(p.dur, 1.1);
    const n = noise(ctx, t, t + dur);
    const lp = filter(ctx, 'lowpass', 3000, 0.6);
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + dur);
    const g = route(ctx, n.connect(lp), out, { rev: 0.3, ...p });
    perc(g.gain, t, 0.7, 0.004, dur);
    INSTRUMENTS.kick(ctx, out, t, { vel: 1 });
  },
  powerup(ctx, out, t, p = {}) {
    [523, 659, 784, 1047, 1319].forEach((f, i) => INSTRUMENTS.pluck(ctx, out, t + i * 0.055, { f, vel: 0.55, rev: 0.25, ...p }));
  },

  // ---- 化石ほりほり
  tool(ctx, out, t) { INSTRUMENTS.pluck(ctx, out, t, { f: 1760, vel: 0.3, rev: 0 }); SFX.tick(ctx, out, t, { vel: 0.3, pitch: 1.6 }); },
  /** やわらかい地層をハンマーで打つ：低いドスッ＋崩れる音。 */
  thud(ctx, out, t, p = {}) {
    const vel = fin(p.vel, 0.7), k = fin(p.pitch, 1);
    const o = osc(ctx, 'sine', 150 * k, t, t + 0.3);
    o.frequency.exponentialRampToValueAtTime(48 * k, t + 0.12);
    const g = route(ctx, o, out, p);
    perc(g.gain, t, 0.55 * vel, 0.002, 0.22);
    const n = noise(ctx, t, t + 0.2);
    const lp = filter(ctx, 'lowpass', 1400 * k, 0.8);
    lp.frequency.setValueAtTime(2400 * k, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.15);
    const g2 = route(ctx, n.connect(lp), out, { rev: 0.12, ...p });
    perc(g2.gain, t, 0.45 * vel, 0.001, 0.14);
  },
  /** 硬いものに当たる：金属の響き（倍音がずれた正弦波）＋カチッ。 */
  clink(ctx, out, t, p = {}) {
    const vel = fin(p.vel, 0.7), k = fin(p.pitch, 1);
    const base = 1650 * k;
    for (const [r, a, d] of [[1, 0.16, 0.35], [2.76, 0.09, 0.22], [5.4, 0.05, 0.12], [8.93, 0.03, 0.07]]) {
      const o = osc(ctx, 'sine', base * r, t, t + d + 0.05);
      const g = route(ctx, o, out, { rev: 0.25, ...p });
      perc(g.gain, t, a * vel, 0.001, d);
    }
    const n = noise(ctx, t, t + 0.04);
    const g = route(ctx, n.connect(filter(ctx, 'highpass', 4000)), out, p);
    perc(g.gain, t, 0.3 * vel, 0.0005, 0.03);
  },
  /** ノミ：短く高いコツッ。 */
  tick(ctx, out, t, p = {}) {
    const vel = fin(p.vel, 0.6), k = fin(p.pitch, 1);
    const n = noise(ctx, t, t + 0.06);
    const g = route(ctx, n.connect(filter(ctx, 'bandpass', 3200 * k, 1.6)), out, p);
    perc(g.gain, t, 0.5 * vel, 0.0005, 0.045);
    const o = osc(ctx, 'triangle', 1900 * k, t, t + 0.08);
    const g2 = route(ctx, o, out, p);
    perc(g2.gain, t, 0.12 * vel, 0.0005, 0.05);
  },
  /** 崩れる土：小さな粒の音をばらばらに。 */
  crumble(ctx, out, t, p = {}) {
    const vel = fin(p.vel, 0.6);
    const n = 5 + Math.floor(vel * 9);
    for (let i = 0; i < n; i++) {
      const dt = Math.random() * 0.35 * (0.5 + vel);
      const src = noise(ctx, t + dt, t + dt + 0.05);
      const f = 800 + Math.random() * 2600;
      const g = route(ctx, src.connect(filter(ctx, 'bandpass', f, 2)), out, { pan: (Math.random() - 0.5) * 0.6 });
      perc(g.gain, t + dt, (0.22 + Math.random() * 0.2) * vel, 0.001, 0.03 + Math.random() * 0.03);
    }
  },
  /** 化石にヒビ：パキッ。 */
  crack(ctx, out, t, p = {}) {
    const vel = fin(p.vel, 0.8);
    for (let i = 0; i < 4; i++) {
      const dt = i * 0.012 + Math.random() * 0.01;
      const src = noise(ctx, t + dt, t + dt + 0.04);
      const g = route(ctx, src.connect(filter(ctx, 'highpass', 1800 + i * 900)), out, { rev: 0.2 });
      perc(g.gain, t + dt, (0.55 - i * 0.1) * vel, 0.0003, 0.02 + i * 0.008);
    }
    const o = osc(ctx, 'square', 320, t, t + 0.08);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.06);
    const g = route(ctx, o.connect(filter(ctx, 'lowpass', 1500)), out, p);
    perc(g.gain, t, 0.12 * vel, 0.001, 0.06);
  },
  /** 化石が粉々：大きな崩れ＋パキパキ＋ガラスのような細かい音。 */
  shatter(ctx, out, t, p = {}) {
    SFX.explode(ctx, out, t, { dur: 1.3, rev: 0.4 });
    for (let i = 0; i < 14; i++) SFX.crack(ctx, out, t + i * 0.035 + Math.random() * 0.05, { vel: 0.9 - i * 0.04 });
    for (let i = 0; i < 10; i++) {
      const dt = 0.1 + Math.random() * 0.8;
      INSTRUMENTS.bell(ctx, out, t + dt, { f: 2400 + Math.random() * 2600, vel: 0.12, dur: 0.3, rev: 0.4 });
    }
    SFX.crumble(ctx, out, t + 0.2, { vel: 1 });
  },
  warn(ctx, out, t) {
    for (const dt of [0, 0.09]) {
      const o = osc(ctx, 'square', 1480, t + dt, t + dt + 0.06);
      const g = route(ctx, o.connect(filter(ctx, 'lowpass', 3500)), out, {});
      perc(g.gain, t + dt, 0.07, 0.002, 0.05);
    }
  },
  overdrive(ctx, out, t) {
    const o = osc(ctx, 'sawtooth', 300, t, t + 0.4);
    o.frequency.exponentialRampToValueAtTime(1400, t + 0.3);
    const g = route(ctx, o.connect(filter(ctx, 'lowpass', 2600)), out, { rev: 0.2 });
    perc(g.gain, t, 0.12, 0.01, 0.35);
  },
  perfect(ctx, out, t) {
    INSTRUMENTS.bell(ctx, out, t, { f: 1568, vel: 0.5, dur: 0.8 });
    INSTRUMENTS.bell(ctx, out, t + 0.07, { f: 2093, vel: 0.45, dur: 0.9 });
    INSTRUMENTS.pluck(ctx, out, t + 0.12, { f: 3136, vel: 0.25 });
  },
  discover(ctx, out, t) { [784, 988, 1175, 1568, 1976].forEach((f, i) => INSTRUMENTS.bell(ctx, out, t + i * 0.07, { f, vel: 0.4, dur: 1.0 })); },
  chime(ctx, out, t, p = {}) { const k = fin(p.pitch, 1); INSTRUMENTS.bell(ctx, out, t, { f: 1046 * k, vel: 0.5 }); INSTRUMENTS.bell(ctx, out, t + 0.12, { f: 1568 * k, vel: 0.45 }); },
  alarm(ctx, out, t) {
    for (let i = 0; i < 3; i++) for (const [dt, f] of [[0, 880], [0.11, 660]]) {
      const tt = t + i * 0.24 + dt;
      const o = osc(ctx, 'square', f, tt, tt + 0.1);
      const g = route(ctx, o.connect(filter(ctx, 'lowpass', 2400)), out, {});
      perc(g.gain, tt, 0.06, 0.003, 0.09);
    }
  },
  /** ロボットの声（ピポッ）。 */
  beep(ctx, out, t) {
    for (const [dt, f0, f1] of [[0, 900, 1500], [0.08, 1300, 1700]]) {
      const o = osc(ctx, 'sine', f0, t + dt, t + dt + 0.07);
      o.frequency.exponentialRampToValueAtTime(f1, t + dt + 0.05);
      const g = route(ctx, o, out, { rev: 0.1 });
      perc(g.gain, t + dt, 0.09, 0.004, 0.06);
    }
  },
  beep_warn(ctx, out, t) {
    for (const dt of [0, 0.11]) {
      const o = osc(ctx, 'triangle', 1100, t + dt, t + dt + 0.08);
      const g = route(ctx, o, out, {});
      perc(g.gain, t + dt, 0.11, 0.004, 0.07);
    }
  },
  beep_sad(ctx, out, t) {
    const o = osc(ctx, 'sine', 900, t, t + 0.5);
    o.frequency.exponentialRampToValueAtTime(280, t + 0.45);
    const g = route(ctx, o, out, { rev: 0.15 });
    perc(g.gain, t, 0.1, 0.01, 0.45);
  },
  /** スキャン：ソナーのピーン＋広がる音。 */
  scan(ctx, out, t) {
    const o = osc(ctx, 'sine', 1400, t, t + 1.6);
    o.frequency.exponentialRampToValueAtTime(1100, t + 1.2);
    const g = route(ctx, o, out, { rev: 0.6 });
    perc(g.gain, t, 0.13, 0.005, 1.3);
    const n = noise(ctx, t, t + 1.3);
    const bp = filter(ctx, 'bandpass', 600, 3);
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(5000, t + 1.2);
    const g2 = route(ctx, n.connect(bp), out, { rev: 0.4 });
    adsr(g2.gain, t, 0.05, 0.3, 0.6, 0.35);
  },
  extract(ctx, out, t) {
    const n = noise(ctx, t, t + 2.6);
    const bp = filter(ctx, 'bandpass', 300, 1.5);
    bp.frequency.setValueAtTime(250, t);
    bp.frequency.exponentialRampToValueAtTime(3200, t + 2.2);
    const g = route(ctx, n.connect(bp), out, { rev: 0.5 });
    adsr(g.gain, t, 0.12, 1.4, 0.6, 0.5);
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => INSTRUMENTS.bell(ctx, out, t + 0.7 + i * 0.16, { f, vel: 0.35, dur: 1.2 }));
  },
  stamp(ctx, out, t) {
    INSTRUMENTS.kick(ctx, out, t, { vel: 0.8 });
    const n = noise(ctx, t, t + 0.12);
    const g = route(ctx, n.connect(filter(ctx, 'lowpass', 2500)), out, { rev: 0.2 });
    perc(g.gain, t, 0.4, 0.001, 0.1);
  },
  jingle(ctx, out, t) {
    [[0, 784], [0.12, 988], [0.24, 1175], [0.42, 1568]].forEach(([dt, f]) => INSTRUMENTS.pluck(ctx, out, t + dt, { f, vel: 0.6, rev: 0.25 }));
    INSTRUMENTS.bell(ctx, out, t + 0.42, { f: 1568, vel: 0.4, dur: 1.4 });
  },
  fanfare(ctx, out, t) {
    [[0, 523], [0.1, 659], [0.2, 784], [0.3, 1047], [0.5, 988], [0.6, 1047], [0.72, 1319]].forEach(([dt, f]) => INSTRUMENTS.lead(ctx, out, t + dt, { f, vel: 0.55, dur: dt >= 0.72 ? 0.8 : 0.09 }));
    for (const f of [523, 659, 784]) INSTRUMENTS.pad(ctx, out, t + 0.72, { f, vel: 0.5, dur: 1.2 });
    INSTRUMENTS.bell(ctx, out, t + 0.72, { f: 2093, vel: 0.4, dur: 1.6 });
  },
};
