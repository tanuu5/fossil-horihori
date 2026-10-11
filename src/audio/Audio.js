// ゲームの音。すべて Web Audio で合成する（音声ファイルなし）。
//
//   const audio = new GameAudio(settings.volume);
//   audio.unlock()                 最初のクリック・キー・タッチで呼ぶ（ブラウザは操作の前に音を出させない）
//   audio.sfx('coin', { pitch })   効果音（synth.js の SFX）。{ pos: Vector3 } を渡すと、その場所から聞こえる（3D の定位と距離の減衰）
//   audio.loop(id, 'coin', { period, pos })   同じ効果音をくり返す（ベル・足音・機械の音など）。stopLoop(id) で止める
//   audio.music('play')            曲（songs.js）。同じ曲なら何もしない。unlock 前に呼ばれたら、unlock 後に流す
//   audio.setAmbience({ wind: 0.5, rain: 1 })   環境音の層（ambience.js の LAYERS。0〜1。渡さなかった層は消える）
//   audio.listen(camera)           聞く位置と向き（毎フレーム。pos つきの音を使うなら必須）
//   audio.tick(dt)                 くり返す音を予約する（毎フレーム）
//   audio.stopMusic()  audio.duck(true/false)  audio.setVolume({ master, music, sfx })
//
// 音まわりの失敗でゲームを止めない：どの入口も例外を握りつぶして警告だけ出す（最初の数回）。
import { createMixer } from './mixer.js';
import { SFX } from './synth.js';
import { Sequencer } from './sequencer.js';
import { SONGS } from './songs.js';
import { buildAmbience } from './ambience.js';

let warned = 0;
const warn = (where, e) => { if (warned++ < 8) console.warn('[audio] ' + where + ':', e); };

export class GameAudio {
  constructor(volume, { muted = false } = {}) {
    this.vol = { ...volume };
    this.muted = muted;
    this.ctx = null;
    this.mix = null;
    this.seq = null;
    this.songId = null;
    this.pending = null;
    this._last = new Map(); // 効果音ごとの最後に鳴らした時刻（同じ音の連打で音が割れないように）
    this.loops = new Map();
    this.amb = null;        // 環境音の層（unlock 後に作る）
    this.ambWant = {};
    // タブが裏に回ったら止める（戻ったら再開）
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend().catch(() => {});
      else if (this._unlocked) this.ctx.resume().catch(() => {});
    });
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  async unlock() {
    if (this.muted) return false;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.mix = createMixer(this.ctx, this.ctx.destination, this.vol);
      }
      if (this.ctx.state !== 'running') await this.ctx.resume();
      this._unlocked = true;
      if (!this.amb) { try { this.amb = buildAmbience(this.ctx, this.mix.amb); this.setAmbience(this.ambWant); } catch (e) { warn('ambience', e); } }
      if (this.pending && !this.seq) { const p = this.pending; this.pending = null; this.music(p.id, p.opts); }
    } catch (e) { warn('unlock', e); }
    return this.ready;
  }

  sfx(name, p = {}) {
    try {
      if (!this.ready) return;
      const fn = SFX[name];
      if (!fn) { warn('sfx', `unknown "${name}"`); return; }
      const now = this.ctx.currentTime;
      if (now - (this._last.get(name) ?? -1) < (p.minGap ?? 0.03)) return;
      this._last.set(name, now);
      const out = p.pos ? this._spatial(p.pos, p) : p.bus === 'amb' ? this.mix.amb : this.mix.sfx;
      fn(this.ctx, out, now + 0.005, p);
    } catch (e) { warn('sfx ' + name, e); }
  }

  /** その場所から聞こえる出口（PannerNode）。refDistance より近いと減衰しない。 */
  _spatial(pos, { refDistance = 2.5, rolloff = 1.1, rev = 0.35 } = {}) {
    const ctx = this.ctx;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.rolloffFactor = rolloff;
    p.maxDistance = 500;
    const v = (x) => (Number.isFinite(x) ? x : 0);
    p.positionX.value = v(pos.x); p.positionY.value = v(pos.y); p.positionZ.value = v(pos.z);
    p.connect(this.mix.sfx.dry);
    const send = ctx.createGain();
    send.gain.value = rev;
    p.connect(send).connect(this.mix.sfx.wet);
    const dry = ctx.createGain(), wet = ctx.createGain();
    dry.connect(p);
    wet.connect(p);
    return { dry, wet };
  }

  /** 鳴らし続ける音（ためている音・ブラシの音）。毎フレーム呼んで高さ・大きさを変える。stopTone(id) で止める。
   *  type：'sine' / 'square' / 'sawtooth' / 'triangle' / 'noise'。lp：ローパスの周波数 */
  tone(id, { f = 440, gain = 0.05, type = 'sine', lp = 4000 } = {}) {
    try {
      if (!this.ready) return;
      this.tones ||= new Map();
      const ctx = this.ctx, t = ctx.currentTime;
      let T = this.tones.get(id);
      if (!T) {
        let src;
        if (type === 'noise') {
          const n = ctx.sampleRate;
          const buf = ctx.createBuffer(1, n, ctx.sampleRate);
          const d = buf.getChannelData(0);
          for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
          src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        } else { src = ctx.createOscillator(); src.type = type; src.frequency.value = f; }
        const filt = ctx.createBiquadFilter(); filt.type = type === 'noise' ? 'bandpass' : 'lowpass'; filt.frequency.value = lp; filt.Q.value = type === 'noise' ? 0.9 : 0.7;
        const g = ctx.createGain(); g.gain.value = 0;
        src.connect(filt).connect(g).connect(this.mix.sfx.dry);
        src.start();
        T = { src, filt, g, type };
        this.tones.set(id, T);
      }
      const fin = (x, d) => (Number.isFinite(x) ? x : d);
      if (T.type !== 'noise') T.src.frequency.setTargetAtTime(Math.max(20, fin(f, 440)), t, 0.02);
      T.filt.frequency.setTargetAtTime(Math.max(40, fin(lp, 4000)), t, 0.03);
      T.g.gain.setTargetAtTime(Math.max(0, Math.min(0.5, fin(gain, 0))), t, 0.03);
    } catch (e) { warn('tone ' + id, e); }
  }
  stopTone(id) {
    try {
      const T = this.tones?.get(id);
      if (!T) return;
      const t = this.ctx.currentTime;
      T.g.gain.setTargetAtTime(0, t, 0.025);
      T.src.stop(t + 0.2);
      this.tones.delete(id);
    } catch (e) { warn('stopTone ' + id, e); }
  }

  /** 同じ効果音を period 秒ごとにくり返す（tick() で予約する）。jitter で間隔を揺らす。 */
  loop(id, name, { period = 2, jitter = 0, ...p } = {}) {
    this.loops.set(id, { name, period, jitter, p, wait: 0 });
  }
  stopLoop(id) { this.loops.delete(id); }

  /** 毎フレーム呼ぶ：くり返す音を鳴らす。 */
  tick(dt) {
    if (!this.ready) return;
    for (const L of this.loops.values()) {
      if ((L.wait -= dt) > 0) continue;
      L.wait = Math.max(0.05, L.period + (Math.random() * 2 - 1) * L.jitter);
      this.sfx(L.name, { minGap: 0, ...L.p });
    }
  }

  /** 聞く位置と向きをカメラに合わせる（毎フレーム）。 */
  listen(camera) {
    if (!this.ctx) return;
    try {
      const L = this.ctx.listener;
      const p = camera.position;
      const e = camera.matrixWorld.elements;
      const t = this.ctx.currentTime;
      if (L.positionX) {
        L.positionX.setValueAtTime(p.x, t); L.positionY.setValueAtTime(p.y, t); L.positionZ.setValueAtTime(p.z, t);
        L.forwardX.setValueAtTime(-e[8], t); L.forwardY.setValueAtTime(-e[9], t); L.forwardZ.setValueAtTime(-e[10], t);
        L.upX.setValueAtTime(e[4], t); L.upY.setValueAtTime(e[5], t); L.upZ.setValueAtTime(e[6], t);
      } else {
        L.setPosition(p.x, p.y, p.z);
        L.setOrientation(-e[8], -e[9], -e[10], e[4], e[5], e[6]);
      }
    } catch (e) { warn('listen', e); }
  }

  /** 環境音の層の大きさ（0〜1）。渡さなかった層は 0 に。ゆっくり（約 1 秒で）変わる。unlock 前に呼んでもよい。 */
  setAmbience(spec = {}) {
    this.ambWant = { ...spec };
    if (!this.amb || !this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [k, L] of Object.entries(this.amb)) {
      const v = Math.max(0, Math.min(1, Number(spec[k]) || 0)) * L.level;
      L.gain.gain.cancelScheduledValues(t);
      L.gain.gain.setTargetAtTime(v, t, 0.8);
    }
  }

  music(id, opts = {}) {
    try {
      if (!SONGS[id]) { warn('music', `unknown "${id}"`); return; }
      if (!this.ctx || !this.ready) { this.pending = { id, opts }; return; }
      if (this.seq && this.songId === id) return;
      this.seq?.stop(opts.crossfade ?? 0.6);
      this.seq = new Sequencer(this.ctx, this.mix.music, SONGS[id]);
      this.seq.start(this.ctx.currentTime + 0.08, opts.fadeIn ?? 0.6);
      this.songId = id;
    } catch (e) { warn('music', e); }
  }

  stopMusic(fadeOut = 0.8) {
    try {
      this.pending = null;
      this.seq?.stop(fadeOut);
      this.seq = null;
      this.songId = null;
    } catch (e) { warn('stopMusic', e); }
  }

  duck(on) { try { this.mix?.duck(on); } catch (e) { warn('duck', e); } }

  setVolume(v) {
    Object.assign(this.vol, v);
    try { this.mix?.setVolume(this.vol); } catch (e) { warn('setVolume', e); }
  }
}

/**
 * 音を OfflineAudioContext で書き出して確かめる（dev/audio.html から使う）。
 * fn(ctx, mix) で鳴らす。戻り値 { buffer, peak, rms, nan }。
 */
export async function renderOffline(fn, seconds = 2, sampleRate = 48000) {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const mix = createMixer(ctx, ctx.destination);
  fn(ctx, mix);
  const buffer = await ctx.startRendering();
  let peak = 0, sum = 0, nan = 0, n = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) { nan++; continue; }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v; n++;
    }
  }
  return { buffer, peak, rms: Math.sqrt(sum / Math.max(1, n)), nan };
}
