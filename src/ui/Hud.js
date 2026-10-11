// ゲーム中の表示（スコアと操作の案内）。作品に合わせて足していく。
import { t, onLangChange } from '../core/i18n.js';

export class Hud {
  constructor(root) {
    root.insertAdjacentHTML('beforeend', `
<div id="hud" class="hidden">
  <div class="score"></div>
  <div class="hints">
    <span><i data-glyph="move"></i></span>
    <span><i data-glyph="jump"></i><b data-i18n="howto.jump">${t('howto.jump')}</b></span>
    <span><i data-glyph="pause"></i><b data-i18n="howto.pause">${t('howto.pause')}</b></span>
  </div>
</div>`);
    this.el = root.querySelector('#hud');
    this.scoreEl = this.el.querySelector('.score');
    this.score = 0;
    onLangChange(() => this.setScore(this.score));
  }
  show(on) { this.el.classList.toggle('hidden', !on); }
  setScore(n) {
    this.score = n;
    this.scoreEl.textContent = t('hud.score', { n });
  }
}
