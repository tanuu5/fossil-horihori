// 化石ほりほり：ロボット AI「ホリボ」と化石を掘る。
//   押しているあいだ出力がたまり、離すと打つ。弱すぎると削れない、強すぎると化石が傷つく（がんばりすぎると砕ける）。
// 形（雛形の約束）：async init() / step(dt) / render(dt) / STATES と setState() / snapshot()
import * as THREE from 'three';
import { clamp, damp, lerp, ease } from '../core/math.js';
import { Rng } from '../core/rng.js';
import { events } from '../core/events.js';
import { createStore } from '../core/save.js';
import { t, onLangChange } from '../core/i18n.js';
import { settings, saveSettings, DIFFICULTIES } from '../core/settings.js';
import { Slab, TOOLS, OVERDRIVE, FLOOR, NX } from './Slab.js';
import { STAGES, stageById } from './stages.js';
import { Env } from './Env.js';
import { Robot } from './Robot.js';
import { Particles } from './Particles.js';
import { FossilMesh } from './FossilMesh.js';
import { DigHud } from '../ui/DigHud.js';
import { refreshGlyphs } from '../ui/glyphs.js';

const GOAL = 0.6;          // これだけ見えたら取り出せる
// 難易度。battery：電池の量の倍率、tol / res：化石のじょうぶさの倍率、brushFree：ブラシがどこでも効く、
// wear：こすりすぎの強さの倍率、regen：道具を使っていないあいだの充電（1 秒あたりの割合）、shatter：保存度がこれを下回ると砕ける
const DIFF = {
  easy: { battery: 1.3, tol: 1.3, res: 1.15, brushFree: true, wear: 0, regen: 0.012, shatter: 0.5 },
  normal: { battery: 1, tol: 1, res: 1, brushFree: false, wear: 1, regen: 0, shatter: 0.6 },
  hard: { battery: 0.9, tol: 0.85, res: 0.95, brushFree: false, wear: 1.5, regen: 0, shatter: 0.62 },
};
const SCAN_COST = 6;
const CHARGE_TIME = { hammer: 1.05, chisel: 1.9 };
const TOOL_ORDER = ['hammer', 'chisel', 'brush'];

// 状態の表。dig：発掘の HUD を出す ／ touch：タッチの操作 ／ input：play・actions・menu ／ music ／ modal ／ duck
export const STATES = {
  title: { title: true, input: 'menu', music: 'title' },
  select: { input: 'menu', modal: 'select', music: 'title' },
  intro: { input: 'menu', music: 'dig' },
  play: { dig: true, touch: true, input: 'play', music: 'dig' },
  paused: { dig: true, input: 'menu', modal: 'pause', duck: true },
  extract: { input: 'menu', music: 'dig' },
  result: { input: 'menu', modal: 'result' },
  shatter: { input: 'menu' },
  fail: { input: 'menu', modal: 'fail' },
};

export class Game {
  constructor({ renderer, input, audio, screens, touch, hud }) {
    Object.assign(this, { renderer, input, audio, screens, touch, hud });
    const recDef = Object.fromEntries(STAGES.map((s) => [s.id, { best: 0, grade: '', cleared: false, tries: 0 }]));
    this.save = createStore('fossil-horihori.save', { records: recDef, tutorial: false }, 1);
    this.time = 0;
    this.digTime = 0;
    this.state = 'title';

    const scene = (this.scene = new THREE.Scene());
    this.camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.05, 200);
    this.env = new Env(scene, renderer.renderer);
    renderer.onQuality = (p) => {
      const sun = this.env.sun;
      sun.shadow.mapSize.set(p.shadowSize, p.shadowSize);
      sun.shadow.map?.dispose(); sun.shadow.map = null;
    };
    renderer.onQuality(renderer.preset);
    renderer.onResize = (w, h) => this.particles?.setViewport(h * renderer.pixelRatio, this.camera.fov);
    this.robot = new Robot();
    scene.add(this.robot.group);
    this.particles = new Particles(scene);
    renderer.setScene(scene, this.camera);

    // カメラ
    this.cam = { target: new THREE.Vector3(0, -0.1, 0), dist: 3, pitch: 0.98, yaw: 0, zoom: 1, shake: 0, shakeT: 0 };
    this.camPos = new THREE.Vector3(0, 2.5, 2.5);
    this.camLook = new THREE.Vector3();

    // カーソル（掘る場所）
    this.cursor = new THREE.Vector3();
    this.cursorMode = 'mouse';
    this.pointer = { x: 0, y: 0, has: false };
    this.ray = new THREE.Raycaster();
    const dom = renderer.domElement;
    dom.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this.pointer.x = e.clientX; this.pointer.y = e.clientY; this.pointer.has = true;
      this.cursorMode = 'mouse';
    });
    dom.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      this.pointer.x = e.clientX; this.pointer.y = e.clientY; this.pointer.has = true;
      this.cursorMode = 'mouse';
    });
    this.installTouch(dom);

    this.dig = new DigHud(document.getElementById('ui'), {
      onTool: (k) => { if (this.state === 'play') this.setTool(k); },
      onScan: () => { if (this.state === 'play') this.scan(); },
      onExtract: () => { if (this.state === 'play') this.tryExtract(); },
    });
    this.buildModals();
    this.introEl = document.createElement('div');
    this.introEl.id = 'intro';
    this.introEl.className = 'hidden';
    document.getElementById('ui').append(this.introEl);
    onLangChange(() => { this.refreshSelect(); if (this.stage) this.dig.setSite('site.' + this.stage.id, 'site.' + this.stage.id + '.sub'); });

    this.tool = 'hammer';
    this.reset();
  }

  async init() {
    await document.fonts?.ready;
    this.loadStage('ammonite', { demo: true });
    // 最初のコンパイルを済ませておく（はじめの数コマが固まらないように）
    try { this.renderer.renderer.compile(this.scene, this.camera); } catch { /* 失敗しても描くときにコンパイルされる */ }
    this.setState('title');
  }

  // ---------------------------------------------------------------- ステージ
  loadStage(id, { demo = false, seed } = {}) {
    const stage = stageById(id);
    this.stage = stage;
    this.demo = demo;
    const rec = this.save.data.records[stage.id];
    const s = seed ?? (demo ? 7 : stage.seed + (rec?.tries || 0) * 31);
    const rng = new Rng(s);
    if (this.slab) { this.scene.remove(this.slab.mesh); this.slab.dispose(); }
    if (this.fossil) { this.scene.remove(this.fossil.mesh); this.fossil.dispose(); this.fossil = null; }
    this.slab = new Slab(stage, rng);
    this.scene.add(this.slab.mesh);
    this.env.build(this.slab, stage);
    const L = this.env.setLight(stage.light);
    this.renderer.setLook({
      exposure: L.exposure, bloomStrength: 0.32, bloomRadius: 0.5, bloomThreshold: 0.93,
      vignette: 0.32, saturation: 1.08, contrast: 1.05, grain: 0.018, ca: 0.25,
      lift: [0.012, 0.01, 0.014], gain: [1, 1, 1],
    });
    this.particles.clear();
    this.particles.light.set(L.sun).lerp(new THREE.Color(1, 1, 1), 0.5);
    this.dig.setSite('site.' + stage.id, 'site.' + stage.id + '.sub');
    this.battery = stage.battery;
    this.batteryMax = stage.battery;
    this.applyDifficulty();
    this.digTime = 0;
    this.cursor.set(0, 0, this.slab.D * 0.12);
    this.cursor.y = this.slab.hAt(this.cursor.x, this.cursor.z);
    this.cam.zoom = 1;
    this.cam.yaw = 0;
    this.analysis = null;
    this.flags = {};
    this.scanState = null;
    this.slab.uniforms.uScan.value.set(0, 0, 0, 0);
    this.milestone = 0;
    this.lastSay = -10;
    this.hintT = -99;
    this.hintN = 0;
    this.thickT = -99;
    this.thickN = 0;
    this.dig.recommend(null);
    if (demo) this.revealDemo();
  }

  get diffId() { return settings.difficulty; }
  get diff() { return DIFF[settings.difficulty] || DIFF.normal; }
  get shatterLimit() { return this.diff.shatter; }

  /** 難易度を今のスラブ・電池に当てはめる（発掘の途中で変えても、その場で効く）。 */
  applyDifficulty() {
    const D = this.diff, s = this.slab, st = this.stage;
    if (s && st) {
      s.tolBase = st.tol * D.tol;
      s.boneRes = (st.boneRes ?? 0.46) * D.res;
      s.tools.brush.reach = D.brushFree ? Infinity : TOOLS.brush.reach;
      s.tools.brush.wear = TOOLS.brush.wear * D.wear;
      const max = st.battery * D.battery;
      this.battery = this.batteryMax ? (this.battery * max) / this.batteryMax : max;
      this.batteryMax = max;
      this.analysis = null;
    }
    this.dig.setDifficulty(this.diffId === 'normal' ? '' : t('settings.difficulty.' + this.diffId));
    if (this.selectEl) this.refreshSelect();
  }

  /** タイトル用：途中まで掘った状態にする。 */
  revealDemo() {
    const s = this.slab, bf = s.bf;
    let lvl = 0;
    for (const k of bf.list) lvl += bf.top[k];
    lvl /= Math.max(1, bf.list.length);
    for (let j = 3; j < s.nz - 3; j++) for (let i = 3; i < s.nx - 3; i++) {
      const k = j * s.nx + i, x = s.x(i), z = s.z(j);
      const wob = 0.02 * Math.sin(x * 9 + z * 4) + 0.015 * Math.sin(x * 23 - z * 17);
      const cover = clamp((Math.hypot(x * 0.8, z) - 0.18 + wob) / 0.22);
      const d = bf.dist[k];
      const want = lerp(lvl - 0.012, s.h0[k], clamp((d - 0.02) / 0.16)) * (1 - cover) + s.h0[k] * cover;
      if (bf.mask[k]) s.h[k] = cover < 0.5 ? bf.top[k] : Math.max(bf.top[k] + 0.006, want);
      else s.h[k] = Math.min(s.h0[k], Math.max(FLOOR, want));
      s.dust[k] = clamp(0.5 * (1 - cover) * Math.max(0, Math.sin(x * 13 + z * 7)));
    }
    s.markAll();
    s.stats = s.computeStats();
  }

  reset() {
    this.charging = false;
    this.charge = 0;
    this.chargeT = 0;
    this.odT = 0;
    this.pending = null;
    this.swingLock = 0;
    this.hitstop = 0;
    this.grace = 0;
    this.brushing = false;
    this.scene && this.dig?.clearPops();
  }

  // ---------------------------------------------------------------- 状態
  setState(s) {
    const S = STATES[s];
    if (!S) throw new Error('状態がありません: ' + s);
    const prev = this.state;
    this.state = s;
    this.screens.showTitle(!!S.title);
    this.hud.show(false);
    this.dig.show(!!S.dig);
    this.touch.setVisible(!!S.touch);
    this.input.mode = S.input || 'menu';
    if (!S.modal) this.screens.closeAll();
    else if (!this.screens.isOpen(S.modal)) { this.screens.closeAll(); this.screens.open(S.modal); }
    if (S.music) this.audio.music(S.music);
    this.audio.duck(!!S.duck);
    this[`enter_${s}`]?.(prev);
    if (prev !== s) events.emit('state', { from: prev, to: s });
  }

  /** 状態に必要な画面（地図・一時停止・結果・失敗）が、もどる操作などで閉じてしまったときの行き止まりよけ。 */
  ensureScreen() {
    const S = STATES[this.state];
    if (!S.modal || this.screens.isOpen(S.modal)) return;
    if (this.state === 'select') this.setState('title');
    else if (this.state === 'paused') this.setState('play');
    else this.screens.open(S.modal);
  }

  /** 雛形の「はじめる」：地図を開く。 */
  start(opts = {}) {
    if (opts.stage) { this.beginStage(opts.stage, { skipIntro: true }); return; }
    this.setState('select');
  }
  retry() { this.beginStage(this.stage.id, { skipIntro: true }); }

  beginStage(id, { skipIntro = false } = {}) {
    const rec = this.save.data.records[id];
    if (rec) { rec.tries++; this.save.save(); }
    this.loadStage(id);
    this.reset();
    this.setTool('hammer', true);
    this.robot.setMood('normal');
    this.robot.pos.set(this.slab.W / 2 + 0.4, 0.5, this.slab.D / 2 + 0.3);
    this.setState(skipIntro ? 'play' : 'intro');
  }

  enter_title() {
    this.reset();
    if (!this.demo) this.loadStage('ammonite', { demo: true });
    this.robot.setMood('normal');
    this.robot.emote('happy', 2);
  }
  enter_select() { this.refreshSelect(); }
  enter_intro() {
    this.introT = 0;
    const st = this.stage;
    const n = STAGES.indexOf(st) + 1;
    this.introEl.innerHTML = `<small>${t('intro.site', { n })}</small><h2>${t('site.' + st.id)}</h2><p>${t('site.' + st.id + '.sub')}</p>`;
    this.introEl.classList.remove('hidden');
    this.introEl.style.opacity = 0;
    this.cam.zoom = 1.6;
  }
  enter_play(prev) {
    this.grace = 0.25;
    this.introEl.classList.add('hidden');
    if (prev !== 'paused') this.cam.zoom = 0.9;
    if (prev !== 'paused') {
      this.dig.say(t(this.stage.id === 'ammonite' ? 'ai.start' : 'ai.start.' + this.stage.id), 'normal', { priority: 1 });
      this.updateMeters();
    }
    this.charging = false;
  }
  enter_paused() { this.audio.sfx('pause'); this.charging = false; this.charge = 0; this.audio.stopTone('charge'); this.audio.stopTone('brush'); }

  // ---------------------------------------------------------------- 1 コマ
  step(dt) {
    const input = this.input;
    input.update(dt);
    this.time += dt;
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      this.updateCamera(dt * 0.25);
      input.endFrame();
      return;
    }
    this.ensureScreen();
    this[`update_${this.state}`]?.(dt);
    this.updateWorld(dt);
    this.audio.listen(this.camera);
    this.audio.tick(dt);
    input.endFrame();
  }

  update_title(dt) {
    if (this.input.menu.back && this.screens.back()) this.audio.sfx('ui_back');
    this.cam.yaw = Math.sin(this.time * 0.12) * 0.45;
    this.cam.zoom = 0.95;
    // ロボットはカーソルの位置をゆっくり動かして、掘る真似をする
    const a = this.time * 0.35;
    this.cursor.set(Math.cos(a) * this.slab.W * 0.18, 0, Math.sin(a * 1.3) * this.slab.D * 0.15);
    this.cursor.y = this.slab.hAt(this.cursor.x, this.cursor.z);
  }

  update_select(dt) {
    if (this.input.menu.back) { this.audio.sfx('ui_back'); this.setState('title'); }
    this.update_title(dt);
  }

  update_intro(dt) {
    this.introT += dt;
    const u = this.introT;
    this.introEl.style.opacity = u < 0.3 ? u / 0.3 : u > 2.1 ? Math.max(0, 1 - (u - 2.1) / 0.4) : 1;
    this.cam.zoom = lerp(1.6, 1, ease.inOutCubic(clamp(u / 2.2)));
    if (u > 2.5 || this.input.menu.ok || this.input.pressed('use')) this.setState('play');
  }

  update_paused() {
    const input = this.input;
    if (input.menu.back || input.menu.start || input.pressed('pause')) {
      if (this.screens.top !== this.screens.modals.pause) { this.screens.back(); this.audio.sfx('ui_back'); }
      else this.setState('play');
    }
  }

  update_play(dt) {
    const input = this.input;
    if (input.pressed('pause') || input.menu.start) { this.setState('paused'); return; }
    this.digTime += dt;
    this.slab.uniforms.uTime.value = this.digTime;
    this.grace = Math.max(0, this.grace - dt);
    this.swingLock = Math.max(0, this.swingLock - dt);

    // 道具の切り替え
    if (!this.charging) {
      for (const k of TOOL_ORDER) if (input.pressed(k)) this.setTool(k);
      if (input.pressed('toolNext')) this.setTool(TOOL_ORDER[(TOOL_ORDER.indexOf(this.tool) + 1) % 3]);
      if (input.pressed('toolPrev')) this.setTool(TOOL_ORDER[(TOOL_ORDER.indexOf(this.tool) + 2) % 3]);
    }
    if (input.pressed('scan')) this.scan();
    if (input.pressed('extract')) this.tryExtract();
    // ズーム（ホイール・Z/C・右スティック）
    let zoomIn = 0;
    if (input.wheel) zoomIn -= input.wheel * 0.12;
    if (input.down('zoomIn')) zoomIn += dt * 1.2;
    if (input.down('zoomOut')) zoomIn -= dt * 1.2;
    if (input.device === 'pad') { zoomIn -= input.look.y * 0.8; this.cam.yaw = clamp(this.cam.yaw - input.look.x * 0.6, -0.5, 0.5); }
    this.cam.zoom = clamp(this.cam.zoom - zoomIn, 0.36, 1.0);

    this.updateCursor(dt);
    this.updateAnalysis();
    this.updateTool(dt);
    this.updateScan(dt);
    // かんたん：道具を使っていないあいだ（1 秒たってから）電池が充電される
    const regen = this.diff.regen;
    if (regen && !this.charging && !this.brushing && !this.pending && this.battery < this.batteryMax) {
      this.idleT = (this.idleT || 0) + dt;
      this.recharging = this.idleT > 1;
      if (this.recharging) this.battery = Math.min(this.batteryMax, this.battery + regen * this.batteryMax * dt);
    } else { this.idleT = 0; this.recharging = false; }
    this.updateMeters();

    if (this.pending) {
      this.pending.t -= dt;
      if (this.pending.t <= 0) { const p = this.pending; this.pending = null; this.doStrike(p); }
    }
    // 終わりの判定
    if (this.state !== 'play') return;
    const st = this.slab.stats;
    if (st.integrity < this.shatterLimit) { this.setState('shatter'); return; }
    if (this.battery <= 0 && !this.pending) {
      if (st.exposure >= GOAL) { this.dig.say(t('ai.batOutExtract'), 'warn', { priority: 3 }); this.setState('extract'); }
      else { this.failReason = 'battery'; this.dig.say(t('ai.batOut'), 'bad', { priority: 3 }); this.setState('fail'); }
    }
  }

  /** 道具のボタンを光らせて、次に使うとよい道具を教える（その道具に切りかえたら消える）。 */
  recommend(k) {
    if (this.tool === k) return;
    this.dig.recommend(k);
  }

  setTool(k, silent = false) {
    if (!TOOLS[k]) return;
    if (this.dig.rec === k) this.dig.recommend(null);
    if (this.tool !== k && !silent) this.audio.sfx('tool');
    this.tool = k;
    this.robot.setTool(k);
    this.dig.setTool(k);
    this.analysis = null;
    this.charging = false;
    this.charge = 0;
  }

  // ---------------------------------------------------------------- カーソル
  updateCursor(dt) {
    const input = this.input;
    const mv = input.move;
    if (Math.abs(mv.x) + Math.abs(mv.y) > 0.01) this.cursorMode = 'stick';
    if (this.cursorMode === 'stick') {
      const sp = (0.35 + 0.55 * this.cam.zoom) * (this.charging ? 0.35 : 1);
      // 画面の右 = (cos yaw, -sin yaw)、画面の奥 = (-sin yaw, -cos yaw)
      const yaw = this.yaw, cy = Math.cos(yaw), sy = Math.sin(yaw);
      this.cursor.x += (mv.x * cy - mv.y * sy) * sp * dt;
      this.cursor.z += (-mv.x * sy - mv.y * cy) * sp * dt;
    } else if (this.cursorMode === 'mouse' && this.pointer.has) {
      this.pickAt(this.pointer.x, this.pointer.y, this.cursor);
    }
    this.slab.clampXZ(this.cursor);
    this.cursor.y = this.slab.hAt(this.cursor.x, this.cursor.z);
  }

  /** 画面の点から、スラブの上の点を引く。 */
  pickAt(px, py, out) {
    const ndc = new THREE.Vector2((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.slab.raycast(this.ray.ray, new THREE.Vector3());
    if (hit) { out.x = hit.x; out.z = hit.z; return true; }
    // スラブの外：地面の高さ 0 の面で
    const r = this.ray.ray;
    if (r.direction.y < -1e-4) { const tt = -r.origin.y / r.direction.y; out.x = r.origin.x + r.direction.x * tt; out.z = r.origin.z + r.direction.z * tt; return true; }
    return false;
  }

  updateAnalysis() {
    const c = this.cursor;
    const a = this.analysis;
    if (a && a.v === this.slab.version && a.tool === this.tool && Math.abs(a.x - c.x) < this.slab.dx * 0.4 && Math.abs(a.z - c.z) < this.slab.dz * 0.4) return;
    const r = this.slab.analyze(c.x, c.z, this.tool);
    r.v = this.slab.version; r.tool = this.tool; r.x = c.x; r.z = c.z;
    this.analysis = r;
  }

  // ---------------------------------------------------------------- 道具を使う
  updateTool(dt) {
    const input = this.input;
    const T = this.slab.tool(this.tool);
    const a = this.analysis;
    const want = input.down('use');
    const press = input.pressed('use');
    if (T.kind === 'strike') {
      if (this.brushing) { this.brushing = false; this.audio.stopTone('brush'); }
      if (!this.charging && press && !this.grace && !this.swingLock && !this.pending && this.battery > 0) {
        this.charging = true; this.chargeT = 0; this.odT = 0; this.warned = false;
      }
      if (this.charging) {
        if (want) {
          this.chargeT += dt;
          const P = Math.min(1, Math.pow(this.chargeT / CHARGE_TIME[this.tool], 1.35));
          // 安全な上限を超えた瞬間に警告音
          if (a && !this.warned && P > a.psafe && a.psafe < 1) { this.warned = true; this.audio.sfx('warn'); }
          this.charge = P;
          if (P >= 1) {
            this.odT += dt;
            if (this.odT > 0.55) { this.release(OVERDRIVE, true); return; }
          }
          this.audio.tone('charge', { f: 180 + 520 * P + (P >= 1 ? Math.sin(this.time * 60) * 40 : 0), gain: 0.04 + 0.05 * P, type: 'sawtooth', lp: 900 + 2600 * P });
        } else {
          this.release(this.charge, false);
        }
      }
    } else {
      // ブラシ：押しているあいだ払う
      this.charging = false;
      if (want && !this.grace && this.battery > 0) {
        const r = this.slab.brush(this.cursor.x, this.cursor.z, dt, this.digTime);
        this.battery -= T.cost * dt;
        this.brushing = true;
        this.brushStats = r;
        this.audio.tone('brush', { f: 2400, gain: r.removed > 0 || r.dust > 0.002 ? 0.05 : 0.025, type: 'noise', lp: 3200 + Math.sin(this.time * 18) * 1200 });
        if (Math.random() < dt * 22 && (r.removed > 0 || r.dust > 0.001)) {
          const col = this.layerColor(this.cursor.x, this.cursor.y, this.cursor.z);
          this.particles.dustAt(this.cursor, col, 1, 0.6, { size: 0.018, alpha: 0.35, life: 0.9 });
        }
        if (!r.soft && r.dust < 0.0005 && !this.flags.brushHard && !a?.exposedHere) { this.flags.brushHard = true; this.say('ai.brushHard', 'warn', 1); this.recommend('chisel'); }
        // 土が厚くて払えない（化石から遠い）：ハンマーをすすめる。15 秒あけて、2 回まで
        if (r.thick && r.removed <= 0 && r.dust < 0.0005 && (this.thickN || 0) < 2 && this.digTime - (this.thickT ?? -99) > 15) {
          this.thickT = this.digTime; this.thickN = (this.thickN || 0) + 1;
          this.say('ai.brushThick', 'warn', 1); this.recommend('hammer');
        }
        // こすりすぎ：きれいになった骨をこすり続けている
        if (r.wear > 0) {
          this.wearT = (this.wearT || 0) + dt;
          if (this.wearT > 0.25 && this.time - (this.wearPopT ?? -9) > 1.4) {
            this.wearPopT = this.time;
            const sp = this.toScreen(this.cursor);
            this.dig.popup(t('pop.wear'), sp.x, sp.y - 30, 'warn');
            this.audio.sfx('warn');
            this.robot.emote('worried', 1);
            if (!this.flags.overBrush) { this.flags.overBrush = true; this.say('ai.overBrush', 'warn', 1); }
          }
        } else this.wearT = 0;
        this.updateStatsSoon();
      } else if (this.brushing) {
        this.brushing = false;
        this.audio.stopTone('brush');
        this.updateStatsNow();
      }
    }
  }

  release(P, overdrive) {
    this.charging = false;
    this.charge = 0;
    this.audio.stopTone('charge');
    this.robot.swing(Math.min(1, P));
    this.pending = { t: this.tool === 'hammer' ? 0.07 : 0.05, P, overdrive, x: this.cursor.x, z: this.cursor.z, tool: this.tool };
    this.swingLock = 0.22;
    if (overdrive) { this.audio.sfx('overdrive'); this.robot.emote('strain', 0.6); }
  }

  doStrike({ P, overdrive, x, z, tool }) {
    const T = this.slab.tool(tool);
    const s = this.slab;
    const a0 = this.analysis;
    const before = s.stats;
    const res = s.strike(x, z, P, tool, this.digTime);
    this.battery -= T.cost[0] + T.cost[1] * Math.min(1, P);
    const pos = new THREE.Vector3(x, res.y, z);
    const sp = this.toScreen(pos);
    const layerCol = this.layerColor(x, res.y - 0.002, z);
    // 粒子
    const amt = Math.min(1, res.removed / 0.0006);
    if (res.removed > 1e-7) {
      this.particles.dustAt(pos, layerCol, Math.round(4 + 22 * amt * (tool === 'hammer' ? 1 : 0.5)), 0.6 + P, { size: tool === 'hammer' ? 0.04 : 0.022, alpha: 0.5 });
      this.particles.chips(pos, new THREE.Color(layerCol).multiplyScalar(0.8).getHex(), Math.round(1 + 7 * amt), 0.4 + P * 0.8, tool === 'hammer' ? 0.007 : 0.004, { life: 1.4 });
    }
    if (res.bounced || res.H > 0.5) this.particles.sparksAt(pos, Math.round(6 + 14 * P), 0xffc070, 0.6 + P * 0.6);
    if (res.hitBone || res.broken.length) {
      const bc = this.stage.boneCol2;
      this.particles.chips(pos, bc, 3 + res.broken.length, 0.6 + P, 0.007);
    }
    for (let n = 0; n < Math.min(12, res.broken.length); n += 2) {
      const k = res.broken[Math.floor((n / Math.min(12, res.broken.length)) * res.broken.length)];
      const i = k % NX, j = (k - i) / NX;
      const bp = new THREE.Vector3(s.x(i), s.h[k] + 0.004, s.z(j));
      this.particles.chips(bp, this.stage.boneCol2, 2, 0.8, 0.006);
      this.particles.dustAt(bp, this.stage.boneCol2, 3, 0.6, { size: 0.02, alpha: 0.4 });
    }
    // 手ごたえ：揺れ・一瞬止める・音
    const big = tool === 'hammer' ? 1 : 0.45;
    this.cam.shake = Math.max(this.cam.shake, (0.004 + 0.012 * P) * big * (overdrive ? 2.2 : 1));
    this.hitstop = (0.02 + 0.05 * P * big) * (overdrive ? 2 : 1);
    const hardHit = res.bounced || res.H > 0.5;
    if (res.hitBone || res.broken.length) this.audio.sfx('crack', { vel: Math.min(1, 0.4 + res.dmgAdded) });
    if (tool === 'hammer') this.audio.sfx(hardHit ? 'clink' : 'thud', { vel: 0.4 + 0.6 * Math.min(1, P), pitch: 0.9 + res.H * 0.4 });
    else this.audio.sfx(hardHit ? 'clink' : 'tick', { vel: 0.4 + 0.5 * Math.min(1, P), pitch: 1.3 + res.H * 0.3 });
    if (res.removed > 0.0002) this.audio.sfx('crumble', { vel: Math.min(1, res.removed / 0.0012) });
    // 文字と、ロボットの反応
    const newDmg = res.dmgAdded;
    if (res.broken.length) { this.dig.popup(t('pop.chip'), sp.x, sp.y - 30, 'bad'); this.robot.startle(); this.say('ai.chip', 'bad', 2); }
    else if (newDmg > 0.03) { this.dig.popup(t('pop.crack'), sp.x, sp.y - 30, 'warn'); this.robot.emote('worried', 1.2); this.say(overdrive ? 'ai.overdrive' : 'ai.crack', 'warn', 1); }
    else if (res.bounced) { this.dig.popup(t('pop.bounce'), sp.x, sp.y - 30, 'dim'); this.robot.emote(P > 0.5 ? 'dizzy' : 'blink', 0.8); if (a0) this.say('ai.hard', 'normal', 0, { n: Math.ceil(a0.H * 100) }); }
    else if (overdrive) { this.dig.popup(t('pop.over'), sp.x, sp.y - 30, 'warn'); this.say('ai.overdrive', 'warn', 1); }
    else if (a0 && a0.psafe < 1 && P > a0.H && P <= a0.psafe && a0.psafe - P < 0.08 && res.removed > 0) {
      // 上限ぎりぎりを攻めて、無傷
      this.dig.popup(t('pop.perfect'), sp.x, sp.y - 30, 'good');
      this.robot.emote('happy', 1);
      this.audio.sfx('perfect');
    }
    if (overdrive) this.cam.shake = 0.03;
    s.stats = s.computeStats();
    this.afterStats(before);
    // 化石のそばでハンマーを使い続けていたら、ブラシ（固い所はノミ）をすすめる。20 秒あけて、3 回まで
    if (tool === 'hammer' && a0 && this.flags.firstBone && this.hintN < 3 && this.digTime - this.hintT > 20) {
      const close = a0.onBone || a0.dBone < 0.04 || a0.psafe - a0.H < 0.15;
      if (close) {
        this.hintT = this.digTime;
        this.hintN++;
        const hard = a0.H >= this.slab.tool('brush').strength - 0.01;
        this.say(hard ? 'ai.useChisel' : 'ai.useBrush', 'normal', 1);
        this.recommend(hard ? 'chisel' : 'brush');
      }
    }
    this.analysis = null;
  }

  updateStatsSoon() { this._statsT = (this._statsT || 0) + 1; if (this._statsT % 10 === 0) this.updateStatsNow(); }
  updateStatsNow() { const before = this.slab.stats; this.slab.stats = this.slab.computeStats(); this.afterStats(before); }

  /** 露出度の節目、保存度の警告、電池の残りなど。 */
  afterStats(before) {
    const st = this.slab.stats;
    if (before.exposure < 0.01 && st.exposure >= 0.01 && !this.flags.firstBone) {
      // 少しでも見えたら：ここからはブラシ（固い所はノミ）をすすめ、道具のボタンを光らせる
      this.flags.firstBone = true;
      this.hintT = this.digTime; // 続けて「ブラシのほうが安全」とは言わない（20 秒あける）
      this.say(this.tool === 'brush' ? 'ai.firstBone.brush' : 'ai.firstBone', 'good', 2);
      if (this.tool !== 'brush') this.recommend('brush');
      this.robot.emote('happy', 1.5);
      this.audio.sfx('discover');
    }
    if (before.exposure < 0.5 && st.exposure >= 0.5 && !this.flags.half) { this.flags.half = true; this.say('ai.half', 'good', 2); this.audio.sfx('chime'); }
    if (before.exposure < GOAL && st.exposure >= GOAL && !this.flags.ready) { this.flags.ready = true; this.say('ai.ready', 'good', 3); this.audio.sfx('chime', { pitch: 1.25 }); }
    if (st.integrity < this.shatterLimit + 0.1 && !this.flags.danger) { this.flags.danger = true; this.say('ai.danger', 'bad', 3); this.audio.sfx('alarm'); }
    if (this.battery / this.batteryMax < 0.2 && !this.flags.batLow) { this.flags.batLow = true; this.say('ai.batLow', 'warn', 2); }
    if (st.exposure > 0.3 && st.clean < 0.55 && !this.flags.dusty) { this.flags.dusty = true; this.say('ai.dusty', 'normal', 0); }
  }

  say(key, mood = 'normal', priority = 0, vars) {
    if (priority < 1 && this.time - this.lastSay < 2.5) return;
    this.lastSay = this.time;
    this.dig.say(t(key, vars), mood, { priority });
    this.audio.sfx(mood === 'bad' ? 'beep_sad' : mood === 'warn' ? 'beep_warn' : 'beep', { minGap: 0.4 });
  }

  // ---------------------------------------------------------------- スキャン
  scan() {
    if (this.scanState && this.scanState.t < 1.4) return;
    if (this.battery < SCAN_COST) { this.say('ai.scanNoBat', 'warn', 1); return; }
    this.battery -= SCAN_COST;
    this.scanState = { t: 0, x: this.robot.pos.x, z: this.robot.pos.z };
    this.robot.emote('scan', 1.4);
    this.audio.sfx('scan');
    this.say('ai.scan', 'normal', 1);
  }

  updateScan(dt) {
    const sc = this.scanState;
    const u = this.slab.uniforms.uScan.value;
    if (!sc) { u.w = 0; return; }
    sc.t += dt;
    const R = Math.hypot(this.slab.W, this.slab.D);
    const front = R * ease.outQuad(clamp(sc.t / 1.3));
    const strength = sc.t < 4.5 ? 1 : Math.max(0, 1 - (sc.t - 4.5) / 2.5);
    u.set(sc.x, sc.z, front, strength);
    if (sc.t > 1.0 && !sc.told) { sc.told = true; this.say(this.slab.stats.exposure > 0.5 ? 'ai.scanDone' : 'ai.scanFound', 'good', 1); }
    if (strength <= 0) this.scanState = null;
  }

  tryExtract() {
    if (this.slab.stats.exposure < GOAL) { this.say('ai.notYet', 'normal', 1, { n: Math.round(GOAL * 100) }); this.audio.sfx('ui_back'); return; }
    this.setState('extract');
  }

  // ---------------------------------------------------------------- 取り出し・結果
  enter_extract() {
    this.charging = false; this.charge = 0; this.brushing = false;
    this.audio.stopTone('charge'); this.audio.stopTone('brush');
    this.extractT = 0;
    this.result = this.computeResult();
    this.fossil = new FossilMesh(this.slab);
    this.fossil.mesh.visible = false;
    // 大きな化石はあまり傾けず、低めに持ち上げる
    const fs = this.fossil.size;
    this.fossil.lift = 0.12 + Math.min(0.35, 0.3 * fs);
    this.fossil.tilt = fs > 1 ? 0.42 : 0.72;
    this.scene.add(this.fossil.mesh);
    this.robot.emote('scan', 2);
    this.audio.sfx('extract');
    this.slab.uniforms.uScan.value.w = 0;
    this.scanState = null;
  }

  update_extract(dt) {
    this.extractT += dt;
    const u = this.extractT;
    const f = this.fossil;
    if (u > 0.7 && !f.mesh.visible) {
      // 化石を持ち上げ、スラブには型（くぼみ）を残す
      f.mesh.visible = true;
      const s = this.slab, bf = s.bf;
      for (const k of bf.list) { s.h[k] = Math.max(FLOOR, bf.bot[k]); s.dust[k] = 0; bf.mask[k] = 0; bf.etop[k] = -9; bf.ebot[k] = 9; }
      s.markAll();
      for (let n = 0; n < 40; n++) {
        const k = bf.list[Math.floor(Math.random() * bf.list.length)];
        const i = k % NX, j = (k - i) / NX;
        this.particles.dustAt(new THREE.Vector3(s.x(i), s.h[k] + 0.01, s.z(j)), this.layerColor(s.x(i), s.h[k], s.z(j)), 2, 0.5, { size: 0.03, alpha: 0.4 });
      }
      this.cam.shake = 0.01;
    }
    if (f.mesh.visible) {
      const k = ease.inOutCubic(clamp((u - 0.7) / 1.8));
      f.mesh.position.set(f.center.x * (1 - k), f.center.y + k * (f.lift - f.center.y), f.center.z * (1 - k));
      f.mesh.rotation.set(k * f.tilt, Math.sin(u * 0.6) * 0.2 * k, 0);
      f.uniforms.uGlow.value = Math.max(0, 0.5 - Math.abs(u - 1.6)) * 1.5;
    }
    if (u > 2.8) this.setState('result');
  }

  computeResult() {
    const st = this.slab.stats;
    const bat = clamp(this.battery / this.batteryMax);
    const q = Math.pow(st.exposure, 1.3) * Math.pow(st.integrity, 2.2) * (0.88 + 0.12 * st.clean);
    const score = Math.round(q * 10000 + bat * 1500);
    const grade = q >= 0.82 ? 'S' : q >= 0.66 ? 'A' : q >= 0.5 ? 'B' : 'C';
    return { ...st, battery: bat, q, score, grade };
  }

  enter_result() {
    const r = this.result;
    const rec = this.save.data.records[this.stage.id];
    const isNew = r.score > rec.best;
    if (isNew) { rec.best = r.score; rec.grade = r.grade; }
    else if (gradeRank(r.grade) > gradeRank(rec.grade)) rec.grade = r.grade;
    rec.cleared = true;
    this.save.save();
    this.resultT = 0;
    this.fillResult(r, isNew);
    this.audio.music('result');
    this.audio.sfx(r.grade === 'S' ? 'fanfare' : 'jingle');
    if (r.grade === 'S' || r.grade === 'A') this.robot.celebrate(); else this.robot.emote('happy', 3);
    this.robot.setMood('happy');
  }

  update_result(dt) {
    this.resultT += dt;
    const f = this.fossil;
    if (f) {
      f.mesh.rotation.y += dt * 0.35;
      f.mesh.position.y = f.lift + Math.sin(this.time * 1.4) * 0.015;
      f.uniforms.uGlow.value = 0;
    }
    // 評価のはんこを時間で押す（CSS のアニメーションは使わない）
    const st = this.resultEl.querySelector('.r-grade');
    const k = clamp((this.resultT - 0.9) / 0.25);
    st.style.opacity = k;
    st.style.transform = `scale(${lerp(2.4, 1, ease.outBack(k))}) rotate(-12deg)`;
    if (k >= 1 && !this.stamped) { this.stamped = true; this.audio.sfx('stamp'); this.cam.shake = 0.006; }
    for (const el of this.resultEl.querySelectorAll('[data-count]')) {
      const v = +el.dataset.count, d = +el.dataset.delay || 0;
      const p = ease.outCubic(clamp((this.resultT - d) / 0.7));
      el.textContent = el.dataset.fmt === 'pct' ? `${Math.floor(v * p * 100)}%` : `${Math.round(v * p)}`;
      const bar = el.parentElement.querySelector('.bar b');
      if (bar) bar.style.width = `${v * p * 100}%`;
    }
  }

  enter_shatter() {
    this.charging = false; this.charge = 0;
    this.audio.stopTone('charge'); this.audio.stopTone('brush');
    this.shatterT = 0;
    this.robot.startle();
    this.audio.sfx('crack', { vel: 1 });
    this.hitstop = 0.18;
  }

  update_shatter(dt) {
    this.shatterT += dt;
    const u = this.shatterT;
    const s = this.slab, bf = s.bf;
    if (!this.shattered && u > 0.05) {
      this.shattered = true;
      this.audio.sfx('shatter');
      this.renderer.setFx({ flash: 0.35, flashColor: 0xfff4e0 });
      this.cam.shake = 0.04;
      for (const k of bf.list) { s.dmg[k] = Math.max(s.dmg[k], 1.2 + Math.random()); }
      const res = { broken: [] };
      s.applyBreaks(res, this.digTime);
      s.markAll();
      s.stats = s.computeStats();
      const list = bf.list;
      for (let n = 0; n < 70; n++) {
        const k = list[Math.floor(Math.random() * list.length)];
        if (s.h[k] - bf.top[k] > 0.01) continue;
        const i = k % NX, j = (k - i) / NX;
        const p = new THREE.Vector3(s.x(i), s.h[k] + 0.005, s.z(j));
        this.particles.chips(p, n % 2 ? this.stage.boneCol : this.stage.boneCol2, 2, 1.1, 0.008);
        if (n % 3 === 0) this.particles.dustAt(p, this.stage.boneCol2, 3, 0.9, { size: 0.03, alpha: 0.5 });
      }
    }
    this.renderer.setFx({ flash: Math.max(0, 0.35 - u * 0.8) });
    if (u > 1.4 && !this.sadDone) { this.sadDone = true; this.robot.emote('sad', 10); this.robot.setMood('sad'); this.audio.sfx('beep_sad'); }
    if (u > 2.4) { this.failReason = 'shatter'; this.setState('fail'); }
  }

  enter_fail() {
    this.shattered = false; this.sadDone = false;
    const el = this.failEl;
    el.querySelector('h2').textContent = t(this.failReason === 'battery' ? 'fail.battery' : 'fail.shatter');
    el.querySelector('.f-body').textContent = t(this.failReason === 'battery' ? 'fail.battery.body' : 'fail.shatter.body');
    // 失敗したら、難易度を下げられることを案内する（すでに「かんたん」なら出さない）
    const easy = this.diffId === 'easy';
    el.querySelector('.f-hint').classList.toggle('hidden', easy);
    el.querySelector('.f-easy').classList.toggle('hidden', easy);
    this.audio.music('fail');
    this.robot.setMood('sad');
  }

  onAction(act, el) {
    if (act === 'site') { if (!el.disabled) this.beginStage(el.dataset.id); }
    else if (act === 'next') {
      const i = STAGES.indexOf(this.stage);
      if (i < STAGES.length - 1) this.beginStage(STAGES[i + 1].id); else this.setState('select');
    } else if (act === 'again') this.beginStage(this.stage.id);
    else if (act === 'map') { this.loadStage('ammonite', { demo: true }); this.setState('select'); }
    // 地図の「もどる」：札を閉じるだけでなく、タイトルの状態へ（閉じるだけだと何もない画面で止まる）
    else if (act === 'selectBack') this.setState('title');
    else if (act === 'easyRetry') { this.setDifficulty('easy'); this.beginStage(this.stage.id); }
    else if (act === 'diff') this.setDifficulty(DIFFICULTIES[(DIFFICULTIES.indexOf(this.diffId) + 1) % DIFFICULTIES.length]);
  }

  setDifficulty(d) {
    settings.difficulty = d;
    saveSettings();
    this.applyDifficulty();
  }

  // ---------------------------------------------------------------- 画面（地図・結果・失敗）
  buildModals() {
    this.selectEl = this.screens.addModal('select', `
<section id="m-select" class="modal hidden"><div class="card select" data-scroll>
  <h2 data-i18n="select.title">${t('select.title')}</h2>
  <div class="sites">${STAGES.map((s, i) => `<button class="site-card" data-act="site" data-id="${s.id}"><b class="num">${i + 1}</b><span class="sc-body"><span class="nm"></span><small class="sub"></small></span><em class="grade"></em></button>`).join('')}</div>
  <button data-act="diff" class="diff-btn"></button>
  <button data-act="selectBack" data-i18n="ui.back">${t('ui.back')}</button>
</div></section>`);
    this.resultEl = this.screens.addModal('result', `
<section id="m-result" class="modal side hidden"><div class="card result">
  <small class="r-site"></small>
  <h2 class="r-name"></h2>
  <div class="r-grade"><b></b></div>
  <dl class="r-stats">
    <dt data-i18n="hud.exposure">${t('hud.exposure')}</dt><dd><i class="bar"><b></b></i><span data-count data-fmt="pct" data-delay="0.1" class="r-exp"></span></dd>
    <dt data-i18n="hud.integrity">${t('hud.integrity')}</dt><dd><i class="bar"><b></b></i><span data-count data-fmt="pct" data-delay="0.3" class="r-int"></span></dd>
    <dt data-i18n="result.clean">${t('result.clean')}</dt><dd><i class="bar"><b></b></i><span data-count data-fmt="pct" data-delay="0.5" class="r-cln"></span></dd>
    <dt data-i18n="hud.battery">${t('hud.battery')}</dt><dd><i class="bar"><b></b></i><span data-count data-fmt="pct" data-delay="0.7" class="r-bat"></span></dd>
  </dl>
  <p class="r-score"><span data-i18n="result.score">${t('result.score')}</span> <b data-count data-delay="0.9" class="r-pts"></b><em class="r-new hidden" data-i18n="result.new">${t('result.new')}</em></p>
  <p class="r-comment"></p>
  <div class="r-btns"><button data-act="next" class="r-next" data-i18n="result.next">${t('result.next')}</button><button data-act="again" data-i18n="result.again">${t('result.again')}</button><button data-act="map" data-i18n="result.map">${t('result.map')}</button></div>
</div></section>`);
    this.failEl = this.screens.addModal('fail', `
<section id="m-fail" class="modal hidden"><div class="card fail">
  <h2></h2><p class="f-body"></p>
  <p class="f-hint" data-i18n="fail.easyHint">${t('fail.easyHint')}</p>
  <button data-act="easyRetry" class="f-easy" data-i18n="fail.easyRetry">${t('fail.easyRetry')}</button>
  <button data-act="again" data-i18n="result.again">${t('result.again')}</button>
  <button data-act="map" data-i18n="result.map">${t('result.map')}</button>
</div></section>`);
  }

  refreshSelect() {
    const recs = this.save.data.records;
    const db = this.selectEl.querySelector('.diff-btn');
    db.textContent = t('select.difficulty', { d: t('settings.difficulty.' + this.diffId) });
    db.dataset.d = this.diffId;
    STAGES.forEach((s, i) => {
      const b = this.selectEl.querySelector(`[data-id="${s.id}"]`);
      const open = i === 0 || recs[STAGES[i - 1].id].cleared || this.unlockAll;
      const r = recs[s.id];
      b.disabled = !open;
      b.querySelector('.nm').textContent = open ? t('site.' + s.id) : t('select.locked');
      b.querySelector('.sub').textContent = open ? (r.cleared ? t('fossil.' + s.id) : t('site.' + s.id + '.sub')) : '';
      const g = b.querySelector('.grade');
      g.textContent = r.grade || '';
      g.dataset.g = r.grade || '';
    });
  }

  fillResult(r, isNew) {
    const el = this.resultEl;
    this.stamped = false;
    el.querySelector('.r-site').textContent = t('site.' + this.stage.id) + (this.diffId === 'normal' ? '' : ' ・ ' + t('settings.difficulty.' + this.diffId));
    el.querySelector('.r-name').textContent = t('result.found', { name: t('fossil.' + this.stage.id) });
    const g = el.querySelector('.r-grade');
    g.querySelector('b').textContent = r.grade;
    g.dataset.g = r.grade;
    g.style.opacity = 0;
    el.querySelector('.r-exp').dataset.count = r.exposure;
    el.querySelector('.r-int').dataset.count = r.integrity;
    el.querySelector('.r-cln').dataset.count = r.clean;
    el.querySelector('.r-bat').dataset.count = r.battery;
    el.querySelector('.r-pts').dataset.count = r.score;
    el.querySelector('.r-new').classList.toggle('hidden', !isNew);
    el.querySelector('.r-comment').textContent = t('grade.' + r.grade);
    const last = STAGES.indexOf(this.stage) === STAGES.length - 1;
    const nx = el.querySelector('.r-next');
    nx.dataset.i18n = last ? 'result.map' : 'result.next';
    nx.textContent = t(nx.dataset.i18n);
    if (last) nx.dataset.act = 'map'; else nx.dataset.act = 'next';
    el.querySelector('.r-btns [data-act="map"]:last-child').classList.toggle('hidden', last);
    for (const e of el.querySelectorAll('[data-count]')) e.textContent = '';
    for (const b of el.querySelectorAll('.bar b')) b.style.width = '0%';
  }

  // ---------------------------------------------------------------- タッチ（ドラッグでカーソル、2 本指でズーム）
  installTouch(dom) {
    const touches = new Map();
    let pinch0 = 0, zoom0 = 1, moved = false;
    const start = new THREE.Vector3();
    dom.addEventListener('touchstart', (e) => {
      if (this.state !== 'play') return;
      for (const tc of e.changedTouches) touches.set(tc.identifier, { x: tc.clientX, y: tc.clientY, x0: tc.clientX, y0: tc.clientY });
      this.cursorMode = 'touch';
      if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = this.cam.zoom; }
      moved = false;
    }, { passive: true });
    dom.addEventListener('touchmove', (e) => {
      if (this.state !== 'play') return;
      for (const tc of e.changedTouches) {
        const p = touches.get(tc.identifier);
        if (!p) continue;
        if (touches.size === 1) {
          // 1 本指：なぞった分だけカーソルを動かす（トラックパッドのように）
          const a = new THREE.Vector3(), b = new THREE.Vector3();
          this.pickPlane(p.x, p.y, a); this.pickPlane(tc.clientX, tc.clientY, b);
          const gain = this.charging ? 0.4 : 1;
          this.cursor.x += (b.x - a.x) * gain; this.cursor.z += (b.z - a.z) * gain;
          if (Math.hypot(tc.clientX - p.x0, tc.clientY - p.y0) > 8) moved = true;
        }
        p.x = tc.clientX; p.y = tc.clientY;
      }
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch0 > 0) this.cam.zoom = clamp(zoom0 * pinch0 / Math.max(10, d), 0.36, 1);
      }
    }, { passive: true });
    const end = (e) => {
      for (const tc of e.changedTouches) {
        const p = touches.get(tc.identifier);
        // 動かさずに離したら、その場所へカーソルを置く
        if (p && touches.size === 1 && !moved && this.state === 'play') { this.pickAt(tc.clientX, tc.clientY, start); this.cursor.x = start.x; this.cursor.z = start.z; }
        touches.delete(tc.identifier);
      }
      if (touches.size < 2) pinch0 = 0;
    };
    dom.addEventListener('touchend', end, { passive: true });
    dom.addEventListener('touchcancel', end, { passive: true });
  }

  pickPlane(px, py, out) {
    const ndc = new THREE.Vector2((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const r = this.ray.ray, y = this.cursor.y;
    if (Math.abs(r.direction.y) < 1e-4) return out.set(0, y, 0);
    const tt = (y - r.origin.y) / r.direction.y;
    return out.set(r.origin.x + r.direction.x * tt, y, r.origin.z + r.direction.z * tt);
  }

  // ---------------------------------------------------------------- 世界の更新・カメラ
  updateWorld(dt) {
    const s = this.slab;
    s.flush();
    const playing = this.state === 'play' || this.state === 'paused';
    const showCursor = this.state === 'play';
    const a = this.analysis;
    const danger = showCursor && a && TOOLS[this.tool].kind === 'strike' && a.psafe < 0.85;
    // カーソルの輪（打ったときの穴の大きさ）
    const T = s.tool(this.tool);
    const P = this.charging ? this.charge : 0.5;
    const rad = T.kind === 'strike' ? T.r0 * (0.55 + 0.9 * P) : T.r;
    const u = s.uniforms;
    u.uCursor.value.set(this.cursor.x, this.cursor.y, this.cursor.z, rad);
    u.uCursorOn.value = damp(u.uCursorOn.value, showCursor ? 0.9 : 0, 10, dt);
    let col;
    if (T.kind === 'brush') {
      // ブラシ：こすりすぎは赤、届かない（土が厚い・固い）所は灰色
      const wearing = this.brushing && this.brushStats?.wear > 0;
      const useless = a && !a.exposedHere && (a.reach < 0.05 || !a.brushable);
      col = wearing ? 0xff4a3a : useless ? 0x8a96a0 : 0x66e0ff;
    } else col = !a ? 0x66e0ff : this.charging && this.charge > a.psafe ? 0xff4a3a : danger ? 0xffc23a : 0x66e0ff;
    u.uCursorCol.value.set(col);
    if (!playing && this.state !== 'shatter') u.uTime.value = this.time;

    // ロボット
    const home = this.state === 'extract' || this.state === 'result' || this.state === 'fail' || this.state === 'shatter';
    let homePos = null;
    if (home) {
      const c = this.fossil ? this.fossil.mesh.position : new THREE.Vector3(0, 0, 0);
      const fs = this.fossil ? this.fossil.size : 0.4;
      // 結果：化石の左うしろ（カメラから遠い側）に浮かぶ。手前だと大きく写って化石を隠す
      homePos = new THREE.Vector3(c.x - fs * 0.62 - 0.06, Math.max(c.y, 0) + 0.04, c.z - fs * 0.15);
      if (this.state === 'fail' || this.state === 'shatter') homePos.set(this.slab.W * 0.2, 0.35, -0.1);
    }
    let maxH = 0;
    this.robot.zoom = this.cam.zoom;
    this.robot.update(dt, {
      target: this.cursor, charge: this.charging ? this.charge : 0, camera: this.camera, active: this.brushing,
      home: homePos, surfaceAt: (x, z) => (Math.abs(x) < s.W / 2 && Math.abs(z) < s.D / 2 ? s.hAt(x, z) : 0), surfaceMax: maxH,
      danger: !!danger, psafe: a ? a.psafe : 2, battery: this.battery / this.batteryMax, tool: this.tool,
    });
    this.particles.update(dt, (x, z) => (Math.abs(x) < s.W / 2 && Math.abs(z) < s.D / 2 ? s.hAt(x, z) : 0.0));
    // がんばりすぎの湯気
    if (this.charging && this.charge >= 1 && Math.random() < dt * 30) {
      const rp = this.robot.root.position;
      this.particles.dustAt(new THREE.Vector3(rp.x + (Math.random() - 0.5) * 0.1, rp.y + 0.12, rp.z), 0xffffff, 1, 0.7, { size: 0.025, alpha: 0.35, rise: 2, life: 0.8 });
    }
    this.env.update(dt, this.time);
    this.updateCamera(dt);
    this.updateGauge();
    this.dig.update(dt);
  }

  /** 縦長の画面では、スラブの長い辺が縦になるようにカメラを 90° 回す。 */
  get portrait() { return this.camera.aspect < 0.85; }
  get yaw() { return (this.portrait ? Math.PI / 2 : 0) + this.cam.yaw; }

  updateCamera(dt) {
    const c = this.cam, s = this.slab;
    const fov = (this.camera.fov * Math.PI) / 180;
    const tv = Math.tan(fov / 2), th = tv * this.camera.aspect;
    const pitch = c.pitch;
    const sw = this.portrait ? s.D : s.W, sd = this.portrait ? s.W : s.D;
    const dw = (sw / 2 + 0.25) / th;
    const dd = ((sd / 2) * Math.sin(pitch) + 0.42) / tv;
    const base = Math.max(dw, dd) * (this.portrait ? 1.0 : 1.08);
    let focus;
    let dist = base * c.zoom;
    if (this.state === 'result' && this.fossil) {
      const f = this.fossil;
      focus = new THREE.Vector3().copy(f.mesh.position);
      const narrow = this.camera.aspect < 1;
      dist = Math.max(0.9, f.size * (narrow ? 2.6 : f.size > 1 ? 1.75 : 2.2));
      if (narrow) {
        // 縦長：下に結果の札があるので、化石は画面の上へ（注視点をカメラ側へ寄せる）
        const yw = this.yaw;
        focus.x += Math.sin(yw) * dist * 0.42;
        focus.z += Math.cos(yw) * dist * 0.42;
      } else focus.x += f.size * 0.35;   // 右に結果の札があるので、化石は左寄せに
    } else {
      const k = clamp((1 - c.zoom) / 0.64);
      focus = new THREE.Vector3(lerp(0, this.cursor.x, k * 0.95), lerp(-0.12, this.cursor.y, k), lerp(0.04, this.cursor.z, k * 0.95));
      // タイトルと地図：スラブを右に寄せて、左に文字を置く（縦長の画面では、スラブを上に）
      if (this.state === 'title' || this.state === 'select') {
        if (this.camera.aspect > 1) focus.x -= s.W * 0.36;
        else if (this.portrait) focus.x += s.W * 0.42;
      }
    }
    const lam = this.state === 'play' ? 5 : 2.5;
    c.target.x = damp(c.target.x, focus.x, lam, dt);
    c.target.y = damp(c.target.y, focus.y, lam, dt);
    c.target.z = damp(c.target.z, focus.z, lam, dt);
    c.dist = damp(c.dist, dist, lam, dt);
    const yaw = this.yaw;
    const want = new THREE.Vector3(
      c.target.x + Math.sin(yaw) * Math.cos(pitch) * c.dist,
      c.target.y + Math.sin(pitch) * c.dist,
      c.target.z + Math.cos(yaw) * Math.cos(pitch) * c.dist,
    );
    this.camPos.copy(want);
    c.shake = Math.max(0, c.shake - dt * 0.12);
    c.shake *= Math.exp(-dt * 6);
    const sh = c.shake;
    this.camera.position.set(want.x + (Math.random() - 0.5) * sh, want.y + (Math.random() - 0.5) * sh, want.z + (Math.random() - 0.5) * sh);
    this.camera.lookAt(c.target);
    this.camera.updateMatrixWorld();
  }

  updateGauge() {
    if (this.state !== 'play') { this.dig.setGauge(null); return; }
    const a = this.analysis;
    const T = TOOLS[this.tool];
    if (!a || T.kind !== 'strike') { this.dig.setGauge(null); return; }
    const sp = this.toScreen(this.cursor);
    const P = this.charging ? this.charge : 0;
    const info = a.psafe < a.H + 0.01 ? t('gauge.noSafe') : a.psafe < 1 ? t('gauge.range', { a: Math.ceil(a.H * 100), b: Math.floor(a.psafe * 100) }) : t('gauge.need', { a: Math.ceil(a.H * 100) });
    this.dig.setGauge({ visible: true, x: sp.x, y: sp.y, P, pmin: a.H, psafe: a.psafe, overdrive: this.charging && this.charge >= 1, info, label: this.charging ? (this.charge >= 1 ? t('gauge.over') : `${Math.round(P * 100)}%`) : t('tool.' + this.tool) });
  }

  updateMeters() {
    const st = this.slab.stats;
    this.dig.setMeters({ battery: clamp(this.battery / this.batteryMax), integrity: st.integrity, exposure: st.exposure, goal: GOAL, limit: this.shatterLimit, charging: this.recharging });
    this.dig.showExtract(this.state === 'play' && st.exposure >= GOAL, st.exposure >= 0.85);
    this.dig.setScanReady(this.battery >= SCAN_COST);
  }

  toScreen(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * innerWidth, y: (-p.y * 0.5 + 0.5) * innerHeight };
  }

  layerColor(x, y, z) {
    const s = this.slab;
    for (const nd of s.nodules) { const dx = (x - nd.x) / nd.r, dy = (y - nd.y) / nd.ry, dz = (z - nd.z) / nd.r; if (dx * dx + dy * dy + dz * dz < 1) return this.stage.noduleCol; }
    return this.stage.layers[s.layerIndex(x, y, z)].col;
  }

  render(dt) {
    this.renderer.setFx({ time: this.time });
    this.renderer.render(dt);
  }

  /** window.__dev.state() に出す値。 */
  snapshot() {
    const st = this.slab?.stats || {};
    const a = this.analysis;
    const r2 = (v) => Math.round(v * 1000) / 1000;
    return {
      state: this.state, stage: this.stage?.id, tool: this.tool,
      battery: r2(this.battery / (this.batteryMax || 1)), exposure: r2(st.exposure || 0), integrity: r2(st.integrity || 0), clean: r2(st.clean || 0),
      cursor: [r2(this.cursor.x), r2(this.cursor.y), r2(this.cursor.z)], charge: r2(this.charge),
      pmin: a ? r2(a.H) : null, psafe: a ? r2(Math.min(a.psafe, 2)) : null, onBone: a?.onBone, dBone: a ? r2(Math.min(a.dBone, 9)) : null,
      result: this.result ? { grade: this.result.grade, score: this.result.score } : null,
    };
  }
}

function gradeRank(g) { return { S: 4, A: 3, B: 2, C: 1 }[g] || 0; }
