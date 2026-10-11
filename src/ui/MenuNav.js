// ゲームパッドとキーボードでメニューを操作する（マウス・タッチはふつうにクリックできる）。
// 十字キー・左スティック・矢印キーで選び、A / Enter / Space で決定（ボタンをクリックしたのと同じ）。
// つまみ（range）は左右で値を変え、select は左右・決定で切り替える。ボタンが 1 つだけの長い画面は上下でスクロール。
// 選んでいる項目には枠（.gp-focus）を付ける。マウスやタッチで操作したら枠は消す。
//
//   const nav = new MenuNav(() => screens.current(), () => audio.sfx('ui_move'));
//   毎フレーム nav.update(input.menu)

const ITEMS = 'button:not([disabled]), input[type="range"], select';

export class MenuNav {
  constructor(getContainer, onMove = () => {}) {
    this.getContainer = getContainer;
    this.onMove = onMove;
    this.index = new WeakMap(); // 画面ごとに、選んでいた項目の番号を覚えておく
    this.el = null;
    this.shown = false;
    this.last = null;
    const hide = () => this.show(false);
    addEventListener('pointerdown', hide);
    addEventListener('mousemove', (e) => { if (e.movementX || e.movementY) hide(); });
  }

  items(c) { return [...c.querySelectorAll(ITEMS)].filter((e) => e.offsetParent !== null && !e.closest('[data-nav-skip]')); }

  show(on) {
    this.shown = on;
    this.el?.classList.toggle('gp-focus', on);
  }

  setFocus(el) {
    if (this.el && this.el !== el) this.el.classList.remove('gp-focus');
    this.el = el;
    el?.classList.toggle('gp-focus', this.shown);
    if (el && this.shown) el.scrollIntoView?.({ block: 'nearest' });
  }

  update(m) {
    const c = this.getContainer();
    // 新しく開いた画面は先頭の項目から
    if (c !== this.last) { if (c) this.index.delete(c); this.last = c; }
    const items = c ? this.items(c) : [];
    if (!items.length) { this.setFocus(null); return; }
    let i = this.index.get(c) ?? 0;
    if (i >= items.length) i = 0;
    const cur = items[i];
    const dir = m.up || m.down || m.left || m.right;
    // 枠が出ていないときの最初の方向入力は、いま選ばれている項目を見せるだけ
    if (dir && !this.shown) { this.show(true); this.setFocus(cur); this.onMove(); return; }
    if (m.up || m.down) {
      const scroller = c.querySelector('[data-scroll]');
      if (items.length === 1 && scroller && scroller.scrollHeight > scroller.clientHeight + 4) scroller.scrollBy(0, m.down ? 90 : -90);
      else { i = (i + (m.down ? 1 : -1) + items.length) % items.length; this.onMove(); }
    }
    if (m.left || m.right) {
      const d = m.right ? 1 : -1;
      if (cur.type === 'range') {
        const step = +cur.step || 5;
        const v = Math.max(+cur.min || 0, Math.min(+cur.max || 100, +cur.value + d * step));
        if (v !== +cur.value) { cur.value = String(v); cur.dispatchEvent(new Event('input', { bubbles: true })); this.onMove(); }
      } else if (cur.tagName === 'SELECT') this.cycle(cur, d);
      else { i = (i + d + items.length) % items.length; this.onMove(); }
    }
    if (dir) this.show(true);
    this.index.set(c, i);
    this.setFocus(items[i]);
    if (m.ok) {
      const el = items[i];
      if (el.tagName === 'SELECT') this.cycle(el, 1);
      else if (el.tagName === 'BUTTON') el.click();
    }
  }

  cycle(sel, d) {
    const n = sel.options.length;
    sel.selectedIndex = (sel.selectedIndex + d + n) % n;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    this.onMove();
  }
}
