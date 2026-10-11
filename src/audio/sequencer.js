// 小さなステップシーケンサー（先読みで予約する方式。メインスレッドが少し詰まっても音はずれない）。
//
// 曲はデータで書く（songs.js）。1 小節 = 16 ステップ（16 分音符）。小節の文字列は空白区切りでステップを並べる：
//   'C5'  音（C4 = 60）   'C4+E4+G4' 和音   'n62' MIDI 番号   '-' 前の音をのばす（小節の頭なら前の小節の最後の音）   '.' 休み
//   末尾に '!' で強く、'?' で弱く
// ドラムは { kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' }
//   x = ふつう、X = 強く、o = 弱く
// tracks の bars は曲の長さより短くてよい（足りない小節は先頭から繰り返す）。
import { INSTRUMENTS } from './synth.js';

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function noteToMidi(s) {
  if (s[0] === 'n') return Number(s.slice(1));
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(s);
  return m ? 12 * (Number(m[3]) + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) : NaN;
}

/** 曲のデータを、小節ごとのイベント列に直す（[{ step, inst, m, len, vel }]）。おかしな音は warn に入れて飛ばす。 */
export function compile(song) {
  const steps = song.steps || 16;
  const bars = song.bars || Math.max(...Object.values(song.tracks).map((tr) => tr.bars.length));
  const warn = [];
  const out = Array.from({ length: bars }, () => []);
  for (const [name, tr] of Object.entries(song.tracks)) {
    let cur = null; // のばしている音（小節をまたいでも '-' でのばせるように、列ごとに持つ）
    for (let b = 0; b < bars; b++) {
      const bar = tr.bars[b % tr.bars.length];
      if (!bar) { cur = null; continue; }
      if (typeof bar === 'object') {
        cur = null;
        // ドラム
        for (const [inst, pat] of Object.entries(bar)) {
          [...pat.replace(/\s/g, '')].forEach((ch, i) => {
            if (ch === '.' || i >= steps) return;
            const vel = ch === 'X' ? 1 : ch === 'o' ? 0.45 : 0.75;
            out[b].push({ step: i, inst, len: 1, vel: vel * (tr.vol ?? 1), pan: tr.pan, rev: tr.rev, open: inst === 'hat' && ch === 'O' });
          });
        }
        continue;
      }
      const toks = bar.trim().split(/\s+/);
      if (toks.length !== steps) warn.push(`${name} 小節 ${b + 1}: ${toks.length} 個（${steps} 個のはず）`);
      toks.forEach((tk, i) => {
        if (tk === '-') { if (cur) cur.forEach((e) => e.len++); return; }
        cur = null;
        if (tk === '.') return;
        const m = /^([^!?]+)([!?]?)$/.exec(tk);
        const ms = m ? m[1].split('+').map(noteToMidi) : [NaN];
        if (ms.some((x) => !Number.isFinite(x))) { warn.push(`${name} 小節 ${b + 1}: '${tk}' が読めない`); return; }
        const vel = (m[2] === '!' ? 1 : m[2] === '?' ? 0.5 : 0.8) * (tr.vol ?? 1);
        cur = ms.map((mm) => ({ step: i, inst: tr.inst, m: mm + (tr.transpose || 0), len: 1, vel, pan: tr.pan, rev: tr.rev }));
        out[b].push(...cur);
      });
    }
  }
  return { bars: out, steps, warn };
}

export class Sequencer {
  /** out はミキサーの系統（{ dry, wet }）。曲は loop: false なら最後の小節で止まる。 */
  constructor(ctx, out, song) {
    this.ctx = ctx;
    this.song = song;
    const c = compile(song);
    if (c.warn.length) console.warn('[sequencer]', song.id || '', c.warn);
    this.bars = c.bars;
    this.steps = c.steps;
    this.stepDur = 60 / (song.bpm || 120) / 4;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry.connect(this.gain).connect(out.dry);
    this.wet.connect(out.wet);
    this.bus = { dry: this.dry, wet: this.wet };
    this.timer = 0;
    this.playing = false;
  }

  /** until 秒（ctx の時刻）までを、時計を使わずに先に全部予約する（OfflineAudioContext で書き出すとき）。 */
  prime(until, at = 0) {
    this.playing = true;
    this.t0 = at;
    this.next = 0;
    this.gain.gain.setValueAtTime(this.song.gain ?? 1, at);
    this._schedule(until);
    this.playing = false;
  }

  start(at = this.ctx.currentTime + 0.05, fadeIn = 0.3) {
    this.playing = true;
    this.t0 = at;
    this.next = 0; // 次に予約するステップの通し番号
    const g = this.gain.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(0.0001, at);
    g.linearRampToValueAtTime(this.song.gain ?? 1, at + Math.max(0.01, fadeIn));
    this._tick();
    this.timer = setInterval(() => this._tick(), 25);
  }

  stop(fadeOut = 0.5) {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    const g = this.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + Math.max(0.02, fadeOut));
    setTimeout(() => { this.dry.disconnect(); this.wet.disconnect(); }, (fadeOut + 1.5) * 1000);
  }

  _finish(endT) {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    const g = this.gain.gain;
    g.setValueAtTime(this.song.gain ?? 1, endT);
    g.linearRampToValueAtTime(0, endT + 2.5);
    const wait = Math.max(0, endT - this.ctx.currentTime) + 4;
    setTimeout(() => { this.dry.disconnect(); this.wet.disconnect(); }, wait * 1000);
  }

  _tick() {
    if (!this.playing) return;
    this._schedule(this.ctx.currentTime + 0.12);
  }

  _schedule(ahead) {
    const total = this.bars.length * this.steps;
    while (this.t0 + this.next * this.stepDur < ahead) {
      // 最後まで来たら、最後の音が鳴り終わるころに消す（今の時刻ではなく、曲の終わりの時刻で。書き出しのときも同じ）
      if (this.next >= total && this.song.loop === false) { this._finish(this.t0 + total * this.stepDur); return; }
      const n = this.next % total;
      const bar = this.bars[Math.floor(n / this.steps)];
      const step = n % this.steps;
      const t = this.t0 + this.next * this.stepDur;
      for (const e of bar) {
        if (e.step !== step) continue;
        const fn = INSTRUMENTS[e.inst];
        if (!fn) continue;
        try { fn(this.ctx, this.bus, t, { m: e.m, dur: e.len * this.stepDur, vel: e.vel, pan: e.pan, rev: e.rev, open: e.open }); }
        catch (err) { console.warn('[sequencer]', e.inst, err); }
      }
      this.next++;
    }
  }
}
