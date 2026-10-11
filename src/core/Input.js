// 入力：キーボード・マウス・ゲームパッド・タッチを「動作」にまとめる。
//
//   input.update(dt)            毎フレームのはじめに
//   input.down('jump')          押している間 true
//   input.pressed('jump')       押した瞬間だけ true（そのフレームのみ）
//                               押しっぱなしで繰り返す動作（剣を振る・植える）は down() || pressed() で見る
//                               （1 コマより短い叩き＝撮影ツールの --key は down() に出ない）
//   input.move   { x, y }       移動（WASD・矢印・左スティック・タッチのスティック。長さ 1 まで）
//   input.look   { x, y }       視点（右スティック・マウス・タッチのドラッグ。1 フレームぶん）。
//                               どの機器でも「x が正なら右を向く、y が正なら下を向く」にそろえてある（画面の座標と同じ向き）
//   input.mode   'play' | 'actions' | 'menu'
//                               play：全部 ／ actions：移動と視点は止めて、ボタンは全部通す（会話・手紙・カットシーン）
//                               menu：一時停止・決定・もどるだけ通す（タイトル・一時停止の画面）
//   input.lockPointer()         マウスを画面に閉じ込める（一人称・肩越しのカメラ向け。クリックの中で呼ぶ）
//   input.onPointerLock(locked) 閉じ込めが変わったとき（外れたら一時停止、など）
//   input.menu   { up, down, left, right, ok, back, start }   メニュー用（押しっぱなしで連続入力）
//   input.device 'kb' | 'pad' | 'touch'   最後にさわった機器（ボタン表示の切り替えに使う）
//   input.padType 'type1' | 'type2'       つながっているゲームパッドの種類（type1 = A/B/X/Y、type2 = ×/○/□/△）
//   input.endFrame()            毎フレームの最後に
//
// 動作の割り当ては BINDINGS を作品に合わせて書き換える。ゲームパッドは標準配置（Standard Gamepad）の番号。
// mouse：マウスのボタン（0 = 左、2 = 右）。一人称（POINTER_LOCK）では、ロック中だけ数える（閉じ込めるためのクリックで動作しない）。
//   ロックできない環境（埋めこみの表示など）では lockFailed になり、ドラッグで視点・クリックで動作になる
//   input.sens：視点の速さの倍率（設定の「視点の速さ」とつなぐ）
//   0 A/× 1 B/○ 2 X/□ 3 Y/△ 4 LB/L1 5 RB/R1 6 LT/L2 7 RT/R2 8 Back/Share 9 Start/Options 12〜15 十字キー

export const BINDINGS = {
  // 掘る：押してためて、離すと打つ（ブラシは押しているあいだ払う）
  use: { keys: ['Space'], mouse: [0], pad: [0, 7] },
  scan: { keys: ['KeyF'], mouse: [2], pad: [3] },
  extract: { keys: ['KeyX'], pad: [2] },
  hammer: { keys: ['Digit1'] },
  chisel: { keys: ['Digit2'] },
  brush: { keys: ['Digit3'] },
  toolPrev: { keys: ['KeyQ'], pad: [4] },
  toolNext: { keys: ['KeyE', 'Tab'], pad: [5] },
  zoomIn: { keys: ['KeyZ'] },
  zoomOut: { keys: ['KeyC'] },
  pause: { keys: ['Escape', 'KeyP'], pad: [9] },
  // メニューの決定・もどる（ゲーム中の動作と同じボタンを使ってよい）
  confirm: { keys: ['Enter', 'Space'], pad: [0] },
  back: { keys: ['Backspace'], pad: [1] },
};

const MOVE_KEYS = { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'] };
const DIRS = ['up', 'down', 'left', 'right'];
const DEAD = 0.18;
const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
// menu のときも通す動作（作品で「手帳」「地図」など、開いた画面を同じボタンで閉じたい動作があれば足す）
const ALWAYS = new Set(['pause', 'confirm', 'back']);

export class Input {
  constructor(dom, bindings = BINDINGS) {
    this.dom = dom;
    this.bindings = bindings;
    this.keys = new Set();
    this.keysPressed = new Set();
    this.move = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    this.menu = { up: false, down: false, left: false, right: false, ok: false, back: false, start: false };
    this.device = 'kb';
    this.padType = 'type1';
    this.mode = 'play';
    this.lookSpeed = { mouse: 0.005, pad: 2.6, touch: 0.007 };
    this.sens = 1;               // 視点の速さの倍率
    this.mouseDown = new Set();
    this.mousePressed = new Set();
    this.mouseNeedsLock = false; // true：マウスのボタンはポインターロック中だけ動作にする（main.js が POINTER_LOCK から決める）
    this.lockFailed = false;     // ポインターロックできなかった（ドラッグで視点、クリックで動作）
    this.wheel = 0;              // マウスのホイール（そのフレームで回した向きの合計。トラックパッドは続けて届くので、使う側で間をあける）
    this._wheelAcc = 0;
    this._down = {};
    this._pressed = {};
    this._padPrev = [];
    this._rep = Object.fromEntries(DIRS.map((d) => [d, { held: false, t: 0 }]));
    this._touch = { x: 0, y: 0, buttons: {}, edges: new Set() };
    this._drag = null;
    this._lookAcc = { x: 0, y: 0 };
    this.onDevice = null;      // (device) => void　機器が変わったとき

    addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code) && !isTyping(e.target)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.keysPressed.add(e.code);
      this._setDevice('kb');
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    // アプリの切り替えなどで keyup / touchend が届かないと押しっぱなしになるので、離れたら全部戻す
    const release = () => this.releaseAll();
    addEventListener('blur', release);
    addEventListener('pagehide', release);
    document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

    // 画面をタップすると、ブラウザは互換のためにマウスのイベントも送ってくる。それで「キーボード・マウス」に切り替わって
    // キーの案内が出ないよう、押したのが指か（pointerType）を見る。指でさわったら、すぐ「タッチ」にする
    addEventListener('touchstart', () => this._setDevice('touch'), { passive: true });
    dom.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      if ((e.button === 0 || e.button === 2) && !this.pointerLocked) this._drag = { x: e.clientX, y: e.clientY };
      if (this.pointerLocked || !this.mouseNeedsLock || this.lockFailed) { this.mouseDown.add(e.button); this.mousePressed.add(e.button); }
      this._setDevice('kb');
    });
    addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') this.mouseDown.delete(e.button); });
    addEventListener('wheel', (e) => { if (e.deltaY) this._wheelAcc += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockerror', () => { this.lockFailed = true; });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === dom) this._addLook(e.movementX * this.lookSpeed.mouse, e.movementY * this.lookSpeed.mouse);
      else if (this._drag) {
        this._addLook((e.clientX - this._drag.x) * this.lookSpeed.mouse, (e.clientY - this._drag.y) * this.lookSpeed.mouse);
        this._drag.x = e.clientX;
        this._drag.y = e.clientY;
      }
    });
    addEventListener('mouseup', () => { this._drag = null; });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('gamepadconnected', (e) => { this.padType = padTypeOf(e.gamepad.id); });
    document.addEventListener('pointerlockchange', () => this.onPointerLock?.(this.pointerLocked));
  }

  /** 以前の書き方（true = play、false = menu）。 */
  get enabled() { return this.mode === 'play'; }
  set enabled(v) { this.mode = v ? 'play' : 'menu'; }

  get pointerLocked() { return document.pointerLockElement === this.dom; }
  lockPointer() {
    if (this.pointerLocked || this.device === 'touch') return;
    try {
      if (!this.dom.requestPointerLock) { this.lockFailed = true; return; }
      const r = this.dom.requestPointerLock();
      r?.catch?.(() => { this.lockFailed = true; });
    } catch { this.lockFailed = true; /* 拒否されても遊べる（ドラッグで視点、クリックで動作） */ }
  }
  unlockPointer() { if (this.pointerLocked) document.exitPointerLock?.(); }

  down(a) { return !!this._down[a]; }
  pressed(a) { return !!this._pressed[a]; }

  releaseAll() {
    this.keys.clear();
    this.mouseDown.clear();
    this._drag = null;
    this._touch.x = this._touch.y = 0;
    this._touch.buttons = {};
    for (const r of Object.values(this._rep)) r.held = false;
    this.onRelease?.();
  }

  // ---- タッチ（ui/TouchControls.js から呼ばれる）
  setTouchStick(x, y) { this._touch.x = x; this._touch.y = y; this._setDevice('touch'); }
  setTouchButton(action, on) {
    if (on && !this._touch.buttons[action]) this._touch.edges.add(action);
    this._touch.buttons[action] = on;
    this._setDevice('touch');
  }
  addTouchLook(dx, dy) { this._addLook(dx * this.lookSpeed.touch, dy * this.lookSpeed.touch); } // 右へなぞると右を向く

  update(dt) {
    const k = this.keys;
    const kp = this.keysPressed;
    const down = {};
    const pressed = {};
    for (const [a, b] of Object.entries(this.bindings)) {
      down[a] = b.keys?.some((c) => k.has(c)) || b.mouse?.some((m) => this.mouseDown.has(m)) || false;
      pressed[a] = b.keys?.some((c) => kp.has(c)) || b.mouse?.some((m) => this.mousePressed.has(m)) || false;
    }
    const held = Object.fromEntries(DIRS.map((d) => [d, MOVE_KEYS[d].some((c) => k.has(c))]));
    let mx = (held.right ? 1 : 0) - (held.left ? 1 : 0);
    let my = (held.up ? 1 : 0) - (held.down ? 1 : 0);
    let start = false;

    // ゲームパッド（最初につながっている 1 台）
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      const dz = (v) => (Math.abs(v) < DEAD ? 0 : v);
      const ax = dz(gp.axes[0] || 0);
      const ay = dz(gp.axes[1] || 0);
      const rx = dz(gp.axes[2] || 0);
      const ry = dz(gp.axes[3] || 0);
      const btn = (i) => !!gp.buttons[i]?.pressed;
      const edge = (i) => btn(i) && !this._padPrev[i];
      let any = ax || ay || rx || ry;
      if (ax || ay) { mx = ax; my = -ay; }
      if (rx || ry) this._addLook(rx * this.lookSpeed.pad * dt, ry * this.lookSpeed.pad * dt * 0.6);
      for (const [a, b] of Object.entries(this.bindings)) {
        for (const i of b.pad || []) {
          if (btn(i)) { down[a] = true; any = true; }
          if (edge(i)) pressed[a] = true;
        }
      }
      held.up ||= btn(12) || ay < -0.5;
      held.down ||= btn(13) || ay > 0.5;
      held.left ||= btn(14) || ax < -0.5;
      held.right ||= btn(15) || ax > 0.5;
      if (btn(12) || btn(13) || btn(14) || btn(15)) any = true;
      if (edge(9)) start = true;
      this._padPrev = gp.buttons.map((b) => b.pressed);
      if (any) { this.padType = padTypeOf(gp.id); this._setDevice('pad'); }
      break;
    }

    // タッチ
    const T = this._touch;
    if (Math.abs(T.x) + Math.abs(T.y) > 0.05) { mx = T.x; my = T.y; }
    for (const [a, on] of Object.entries(T.buttons)) if (on) down[a] = true;
    for (const a of T.edges) pressed[a] = true;
    T.edges.clear();

    // メニュー：押した瞬間に 1 回、押しっぱなしなら少し待ってから連続で。
    // 1 コマより短いキーの叩き（押して離すまでがフレームの間）は held に出ないので、押した瞬間の記録でも数える
    for (const d of DIRS) {
      const r = this._rep[d];
      let fire = MOVE_KEYS[d].some((c) => kp.has(c));
      if (held[d]) {
        if (!r.held) { fire = true; r.t = 0.38; }
        else if ((r.t -= dt) <= 0) { fire = true; r.t = 0.11; }
      }
      r.held = held[d];
      this.menu[d] = fire;
    }
    this.menu.ok = !!pressed.confirm;
    this.menu.back = !!pressed.back;
    this.menu.start = start;

    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    const moving = this.mode === 'play';
    this.wheel = moving ? this._wheelAcc : 0;
    this._wheelAcc = 0;
    this.move.x = moving ? mx : 0;
    this.move.y = moving ? my : 0;
    this.look.x = moving ? this._lookAcc.x : 0;
    this.look.y = moving ? this._lookAcc.y : 0;
    // menu のときは一時停止・決定・もどるだけ通す
    for (const a of Object.keys(this.bindings)) {
      const ok = this.mode !== 'menu' || ALWAYS.has(a);
      this._down[a] = down[a] && ok;
      this._pressed[a] = pressed[a] && ok;
    }
  }

  endFrame() {
    this.keysPressed.clear();
    this.mousePressed.clear();
    this._lookAcc.x = this._lookAcc.y = 0;
  }

  /** window.__dev.input 用：キー名（KeyboardEvent.code）で押す・離す。 */
  devInput() {
    return {
      down: (code) => { this.keys.add(code); this.keysPressed.add(code); },
      up: (code) => { this.keys.delete(code); },
      tap: (code) => { this.keysPressed.add(code); },
    };
  }

  _addLook(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this._lookAcc.x += x * this.sens;
    this._lookAcc.y += y * this.sens;
  }

  _setDevice(d) {
    if (this.device === d) return;
    this.device = d;
    this.onDevice?.(d);
  }
}

export function padTypeOf(id = '') {
  // ×/○/□/△ のパッドは、ベンダー ID（054c）か名前で見分ける。それ以外は A/B/X/Y の配置として扱う。
  // Xbox のパッドも名前に "Wireless Controller" を含む（"Xbox Wireless Controller"）ので、先に Xbox（045e）を見分ける
  if (/xbox|045e|xinput/i.test(id)) return 'type1';
  return /054c|playstation|dualsense|dualshock|wireless controller/i.test(id) ? 'type2' : 'type1';
}

function isTyping(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) && el.type !== 'range';
}
