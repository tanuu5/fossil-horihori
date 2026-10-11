// スマホ用の操作：画面の左側で仮想スティック、右側のドラッグで視点、右下に動作のボタン、右上に一時停止。
// 最初に画面がさわられたときに出す（パソコンでは出ない）。ボタンは BUTTONS を作品に合わせて書き換える。
// slot は置き場所（右下を起点に 0〜3。0 がいちばん大きく親指の真下、1 がその左、2 が上、3 が左上）。
import { t } from '../core/i18n.js';

export const BUTTONS = [
  { action: 'use', label: 'touch.use', slot: 0 },
];
// この作品では、スティックと視点のドラッグは使わない（カーソルは Game がドラッグで動かす）
const STICK = false;

export class TouchControls {
  constructor(root, surface, input, { onPause } = {}) {
    this.input = input;
    this.visible = false; // ゲーム中だけ true にする（setVisible）
    this.enabled = false; // タッチを一度でも使ったら true
    const el = document.createElement('div');
    el.id = 'touch';
    el.className = 'hidden';
    el.innerHTML = `<div class="stick${STICK ? '' : ' hidden'}"><div class="knob"></div></div>
      ${BUTTONS.map((b, i) => `<button class="tbtn slot-${b.slot ?? i} ${b.cls || ''}" data-i="${i}" data-i18n="${b.label}">${t(b.label)}</button>`).join('')}
      <button class="tbtn pause" data-i18n-aria="pause.title" aria-label="${t('pause.title')}">Ⅱ</button>`;
    root.appendChild(el);
    this.el = el;
    this.stick = el.querySelector('.stick');
    this.knob = el.querySelector('.knob');

    for (const b of el.querySelectorAll('.tbtn[data-i]')) {
      const action = BUTTONS[+b.dataset.i].action;
      const set = (on) => (e) => { e.preventDefault(); input.setTouchButton(action, on); b.classList.toggle('on', on); };
      b.addEventListener('touchstart', set(true), { passive: false });
      b.addEventListener('touchend', set(false), { passive: false });
      b.addEventListener('touchcancel', set(false), { passive: false });
    }
    el.querySelector('.tbtn.pause').addEventListener('touchstart', (e) => { e.preventDefault(); onPause?.(); }, { passive: false });

    let stickId = null, lookId = null, sx = 0, sy = 0, lx = 0, ly = 0;
    const R = 55;
    if (STICK) surface.addEventListener('touchstart', (e) => {
      for (const tc of e.changedTouches) {
        if (tc.clientX < innerWidth * 0.45 && stickId === null) {
          stickId = tc.identifier; sx = tc.clientX; sy = tc.clientY;
          this.stick.style.left = `${sx - 60}px`;
          this.stick.style.top = `${sy - 60}px`;
          this.stick.classList.add('on');
        } else if (lookId === null) { lookId = tc.identifier; lx = tc.clientX; ly = tc.clientY; }
      }
    }, { passive: true });
    if (STICK) surface.addEventListener('touchmove', (e) => {
      for (const tc of e.changedTouches) {
        if (tc.identifier === stickId) {
          let dx = tc.clientX - sx, dy = tc.clientY - sy;
          const l = Math.hypot(dx, dy);
          if (l > R) { dx *= R / l; dy *= R / l; }
          this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
          input.setTouchStick(dx / R, -dy / R);
        } else if (tc.identifier === lookId) {
          input.addTouchLook(tc.clientX - lx, tc.clientY - ly);
          lx = tc.clientX; ly = tc.clientY;
        }
      }
    }, { passive: true });
    const end = (e) => {
      for (const tc of e.changedTouches) {
        if (tc.identifier === stickId) { stickId = null; this.resetStick(); }
        else if (tc.identifier === lookId) lookId = null;
      }
    };
    surface.addEventListener('touchend', end, { passive: true });
    surface.addEventListener('touchcancel', end, { passive: true });
    addEventListener('touchstart', () => { this.enabled = true; this.refresh(); }, { once: true, passive: true });
    // 画面を離れたときはスティックとボタンを戻す
    input.onRelease = () => {
      stickId = lookId = null;
      this.resetStick();
      for (const b of el.querySelectorAll('.tbtn.on')) b.classList.remove('on');
    };
  }

  resetStick() {
    this.knob.style.transform = '';
    this.stick.classList.remove('on');
    this.input.setTouchStick(0, 0);
  }

  /** ボタンの言葉を替える（狙っているものでできること：「植える」「話す」など）。text を null にすると元に戻す。 */
  setLabel(action, text) {
    const i = BUTTONS.findIndex((b) => b.action === action);
    const b = this.el.querySelector(`.tbtn[data-i="${i}"]`);
    if (!b) return;
    const want = text || t(BUTTONS[i].label);
    if (b.textContent !== want) b.textContent = want;
    b.classList.toggle('ctx', !!text);
  }

  setVisible(v) { this.visible = v; this.refresh(); }
  refresh() { this.el.classList.toggle('hidden', !(this.visible && this.enabled)); }
}
