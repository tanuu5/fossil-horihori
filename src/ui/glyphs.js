// 操作の案内に出すボタンの絵。最後にさわった機器（キーボード／ゲームパッド／タッチ）に合わせて切り替え、
// ゲームパッドは タイプ1（A/B/X/Y）とタイプ2（×/○/□/△）の表示を選べる（設定の「ボタン表示」。自動ならつないだ機器から）。
// 画面にはメーカー名・製品名を出さない（商標に配慮して、最近のゲームと同じく「タイプ」で呼ぶ）。
//   <span data-glyph="jump"></span>  → refreshGlyphs() で中身が入る
// 動作の割り当ては core/Input.js の BINDINGS から読むので、割り当てを変えれば表示も変わる。
import { BINDINGS } from '../core/Input.js';

const svg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const TYPE2_FACE = {
  0: '<path d="M7.5 7.5 L16.5 16.5 M16.5 7.5 L7.5 16.5" stroke="#86b6ff" stroke-width="2.4" stroke-linecap="round" fill="none"/>',
  1: '<circle cx="12" cy="12" r="5.2" stroke="#ff7d86" stroke-width="2.2" fill="none"/>',
  2: '<rect x="7.2" y="7.2" width="9.6" height="9.6" rx="0.6" stroke="#f3a0d6" stroke-width="2.2" fill="none"/>',
  3: '<path d="M12 6.6 L17.6 16.2 H6.4 Z" stroke="#56d6a9" stroke-width="2.1" stroke-linejoin="round" fill="none"/>',
};
const TYPE1_FACE = { 0: ['A', '#7bd36a'], 1: ['B', '#ff6a5c'], 2: ['X', '#5aa2ff'], 3: ['Y', '#ffd24a'] };
const SHOULDER = { type1: { 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'View', 9: 'Menu' }, type2: { 4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2', 8: 'Share', 9: 'Options' } };
const DPAD = { 12: 'u', 13: 'd', 14: 'l', 15: 'r' };

const KEY_LABEL = {
  Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backspace: 'Back', Tab: 'Tab',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', AltLeft: 'Alt',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};
export const keyLabel = (code) => KEY_LABEL[code] || code.replace(/^Key|^Digit/, '');

function padButton(i, type) {
  if (i <= 3) {
    if (type === 'type2') return `<span class="gl gl-face">${svg(TYPE2_FACE[i])}</span>`;
    const [l, c] = TYPE1_FACE[i];
    return `<span class="gl gl-face" style="color:${c}">${l}</span>`;
  }
  if (DPAD[i]) {
    const on = (d) => (DPAD[i] === d ? '#fff' : 'rgba(255,255,255,0.28)');
    return `<span class="gl gl-dpad">${svg(`<rect x="9" y="2.5" width="6" height="7" rx="1.2" fill="${on('u')}"/><rect x="9" y="14.5" width="6" height="7" rx="1.2" fill="${on('d')}"/><rect x="2.5" y="9" width="7" height="6" rx="1.2" fill="${on('l')}"/><rect x="14.5" y="9" width="7" height="6" rx="1.2" fill="${on('r')}"/>`)}</span>`;
  }
  return `<span class="gl gl-pill">${SHOULDER[type][i] || '#' + i}</span>`;
}
const stick = (side) => `<span class="gl gl-stick">${svg('<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="4.4" fill="currentColor" opacity="0.35"/>')}<b>${side}</b></span>`;
const key = (k) => `<kbd class="gl gl-key">${k}</kbd>`;
// マウス（ボタン 0 = 左、2 = 右、-1 = 動かす）。BINDINGS に mouse がある動作は、キーより先にマウスの絵を出す
const mouse = (btn) => `<span class="gl gl-mouse">${svg(`<rect x="6" y="3" width="12" height="18" rx="6" fill="none" stroke="currentColor" stroke-width="1.6"/>
  <path d="M12 3 V11" stroke="currentColor" stroke-width="1.4"/>${btn === 0 ? '<path d="M12 3.8 A5.2 5.2 0 0 0 6.8 9 V11 H12 Z" fill="#ffd34a"/>' : btn === 2 ? '<path d="M12 3.8 A5.2 5.2 0 0 1 17.2 9 V11 H12 Z" fill="#ffd34a"/>' : '<path d="M3 12 H1.5 M21 12 H22.5" stroke="currentColor" stroke-width="1.6"/>'}`)}</span>`;

/** 動作の絵（HTML）。action は BINDINGS の名前か、'move' / 'look'。 */
export function glyph(action, device, padType) {
  if (action === 'move') return device === 'pad' ? stick('L') : `${mouse(-1)}<small class="gl-or">/</small>${key('W')}${key('A')}${key('S')}${key('D')}`;
  if (action === 'look') return device === 'pad' ? stick('R') : mouse(-1);
  const b = BINDINGS[action];
  if (!b) return key(action);
  if (device === 'pad' && b.pad?.length) return padButton(b.pad[0], padType);
  if (device === 'pad') return action === 'zoomIn' ? stick('R') : ''; // パッドに割り当てのない動作（数字キーの道具など）は出さない
  if (b.mouse?.length) return mouse(b.mouse[0]) + (b.keys?.length ? `<small class="gl-or">/</small>${key(keyLabel(b.keys[0]))}` : '');
  return b.keys?.length ? key(keyLabel(b.keys[0])) : '';
}

/** [data-glyph] の要素を、今の機器に合わせて描き直す。タッチのときは隠す（画面のボタンを使うので）。 */
export function refreshGlyphs(input, settings, root = document) {
  const type = settings.padType === 'auto' ? input.padType : settings.padType;
  document.documentElement.dataset.device = input.device;
  for (const el of root.querySelectorAll('[data-glyph]')) {
    el.innerHTML = input.device === 'touch' ? '' : glyph(el.dataset.glyph, input.device, type);
  }
}
