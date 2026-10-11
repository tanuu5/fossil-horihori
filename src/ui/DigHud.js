// 発掘中の表示：電池・保存度・露出度のメーター、道具の切り替え、出力ゲージ（カーソルの横）、
// ロボット AI の発言、取り出しの案内、飛び出す文字。動きはゲームの時間（update(dt)）で進める（CSS の transition は使わない）。
import { t, onLangChange } from '../core/i18n.js';

const TOOL_ICONS = {
  hammer: '<svg viewBox="0 0 32 32"><path d="M7 25 L19 13" stroke="#c98b4f" stroke-width="3.2" stroke-linecap="round"/><path d="M14.5 8.5 L23.5 17.5 L26 15 L17 6 Z" fill="#c6cdd6"/><path d="M23.5 17.5 L28.5 24" stroke="#c6cdd6" stroke-width="2.6" stroke-linecap="round"/></svg>',
  chisel: '<svg viewBox="0 0 32 32"><path d="M8 24 L14 18" stroke="#ffb21a" stroke-width="4.5" stroke-linecap="round"/><path d="M14 18 L24 8" stroke="#d5dbe2" stroke-width="2.6" stroke-linecap="round"/><path d="M24 8 L27 5" stroke="#eef2f6" stroke-width="1.6" stroke-linecap="round"/></svg>',
  brush: '<svg viewBox="0 0 32 32"><path d="M7 25 L16 16" stroke="#d9a066" stroke-width="3" stroke-linecap="round"/><path d="M15 13 L19 17" stroke="#b08850" stroke-width="5"/><path d="M18 10 L25 17 L28 12 L23 7 Z" fill="#4a3526"/></svg>',
  scan: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="3" fill="#5ff4ff"/><circle cx="16" cy="16" r="8" fill="none" stroke="#5ff4ff" stroke-width="2" opacity="0.7"/><circle cx="16" cy="16" r="13" fill="none" stroke="#5ff4ff" stroke-width="1.6" opacity="0.4"/></svg>',
};

export class DigHud {
  constructor(root, { onTool, onScan, onExtract } = {}) {
    root.insertAdjacentHTML('beforeend', `
<div id="dig" class="hidden">
  <div class="dig-top">
    <div class="site"><b class="site-name"><span class="sn"></span><em class="diff hidden"></em></b><small class="site-sub"></small></div>
    <div class="meters">
      <div class="meter m-bat"><span class="ml" data-i18n="hud.battery">${t('hud.battery')}</span><div class="bar"><i></i></div><b class="mv"></b></div>
      <div class="meter m-int"><span class="ml" data-i18n="hud.integrity">${t('hud.integrity')}</span><div class="bar"><i></i><em class="limit"></em></div><b class="mv"></b></div>
      <div class="meter m-exp"><span class="ml" data-i18n="hud.exposure">${t('hud.exposure')}</span><div class="bar"><i></i><em class="goal"></em></div><b class="mv"></b></div>
    </div>
  </div>
  <div class="toolbar">
    ${['hammer', 'chisel', 'brush'].map((k, i) => `<button class="tool" data-tool="${k}"><span class="ti">${TOOL_ICONS[k]}</span><span class="tn" data-i18n="tool.${k}">${t('tool.' + k)}</span><span class="tk" data-glyph="${k}"></span></button>`).join('')}
    <button class="tool scan" data-tool="scan"><span class="ti">${TOOL_ICONS.scan}</span><span class="tn" data-i18n="tool.scan">${t('tool.scan')}</span><span class="tk" data-glyph="scan"></span></button>
  </div>
  <div class="ai gone"><div class="ai-face"><i></i><i></i></div><p class="ai-text"></p></div>
  <button class="extract hidden"><span data-i18n="hud.extract">${t('hud.extract')}</span><span class="tk" data-glyph="extract"></span></button>
  <div class="gauge hidden">
    <div class="g-bar"><div class="g-zone"></div><div class="g-fill"></div><div class="g-mark m-min"></div><div class="g-mark m-safe"></div></div>
    <div class="g-label"><b class="g-p"></b><small class="g-info"></small></div>
  </div>
  <div class="pops"></div>
  <div class="hints"><span><i data-glyph="use"></i><b data-i18n="hint.use">${t('hint.use')}</b></span><span><i data-glyph="pause"></i><b data-i18n="howto.pause">${t('howto.pause')}</b></span></div>
</div>`);
    const el = (this.el = root.querySelector('#dig'));
    this.q = (s) => el.querySelector(s);
    this.meters = { bat: this.q('.m-bat'), int: this.q('.m-int'), exp: this.q('.m-exp') };
    this.gauge = this.q('.gauge');
    this.aiText = this.q('.ai-text');
    this.ai = this.q('.ai');
    this.extractBtn = this.q('.extract');
    this.pops = this.q('.pops');
    for (const b of el.querySelectorAll('.tool')) {
      b.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
      b.addEventListener('click', (e) => { e.stopPropagation(); const k = b.dataset.tool; if (k === 'scan') onScan?.(); else onTool?.(k); });
    }
    this.extractBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.extractBtn.addEventListener('click', (e) => { e.stopPropagation(); onExtract?.(); });
    this.msg = null;
    this.queue = [];
    this.popList = [];
    this.time = 0;
    this.lastMeters = null;
    onLangChange(() => { if (this.siteKey) this.setSite(this.siteKey, this.siteSub); });
  }

  show(on) { this.el.classList.toggle('hidden', !on); }

  setSite(key, sub = '') {
    this.siteKey = key; this.siteSub = sub;
    this.q('.site-name .sn').textContent = t(key);
    this.q('.site-sub').textContent = sub ? t(sub) : '';
  }

  /** 難易度の札（「かんたん」など。ふつうなら空で隠す）。 */
  setDifficulty(label) {
    const e = this.q('.site-name .diff');
    e.textContent = label;
    e.classList.toggle('hidden', !label);
  }

  setTool(name) {
    for (const b of this.el.querySelectorAll('.tool[data-tool]')) b.classList.toggle('on', b.dataset.tool === name);
  }
  setScanReady(ok) { this.q('.tool.scan').classList.toggle('off', !ok); }

  /** おすすめの道具を光らせる（null で消す）。光り方は update() でゲームの時間に合わせて動かす。 */
  recommend(name, sec = 10) {
    for (const b of this.el.querySelectorAll('.tool[data-tool]')) {
      b.classList.toggle('rec', b.dataset.tool === name);
      if (b.dataset.tool !== name) b.style.boxShadow = '';
    }
    this.rec = name;
    this.recT = name ? sec : 0;
  }

  setMeters({ battery, integrity, exposure, goal = 0.6, limit = 0.6, charging = false }) {
    const set = (m, v, txt) => {
      m.querySelector('.bar i').style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
      m.querySelector('.mv').textContent = txt;
    };
    set(this.meters.bat, battery, `${Math.ceil(battery * 100)}%`);
    set(this.meters.int, integrity, `${Math.floor(integrity * 100)}%`);
    set(this.meters.exp, exposure, `${Math.floor(exposure * 100)}%`);
    this.meters.exp.querySelector('.goal').style.left = `${goal * 100}%`;
    this.meters.int.querySelector('.limit').style.left = `${limit * 100}%`;
    this.meters.bat.classList.toggle('low', battery < 0.2 && !charging);
    this.meters.bat.classList.toggle('charging', charging);
    this.meters.int.classList.toggle('low', integrity < limit + 0.12);
    this.meters.exp.classList.toggle('ok', exposure >= goal);
  }

  /** 出力ゲージ。x, y は画面の位置（px）。P は今の出力、pmin は必要な出力、psafe は安全な上限。 */
  setGauge(o) {
    const g = this.gauge;
    if (!o || !o.visible) { g.classList.add('hidden'); return; }
    g.classList.remove('hidden');
    const W = innerWidth, H = innerHeight;
    let x = o.x + 34, y = o.y - 70;
    if (x + 110 > W) x = o.x - 34 - 26;
    y = Math.max(70, Math.min(H - 200, y));
    g.style.transform = `translate(${x}px, ${y}px)`;
    const pct = (v) => `${Math.max(0, Math.min(1, v)) * 100}%`;
    const pmin = Math.max(0, Math.min(1, o.pmin)), psafe = Math.max(0, Math.min(1.0001, o.psafe));
    const lo = Math.min(pmin, psafe);
    // 下から：弱すぎ（灰）、ちょうどよい（緑）、危ない（赤）
    const zone = psafe <= pmin
      ? `linear-gradient(to top, rgba(140,150,160,0.55) 0 ${pct(psafe)}, rgba(255,70,60,0.75) ${pct(psafe)} 100%)`
      : `linear-gradient(to top, rgba(140,150,160,0.55) 0 ${pct(lo)}, rgba(70,230,140,0.8) ${pct(lo)} ${pct(psafe)}, rgba(255,70,60,0.75) ${pct(psafe)} 100%)`;
    const z = this.q('.g-zone');
    if (z._v !== zone) { z.style.background = zone; z._v = zone; }
    this.q('.g-fill').style.height = pct(o.P);
    this.q('.m-min').style.bottom = pct(pmin);
    this.q('.m-safe').style.bottom = pct(Math.min(1, psafe));
    this.q('.m-safe').classList.toggle('hidden', psafe > 1);
    g.classList.toggle('over', o.P > psafe + 0.005 && o.P > 0.02);
    g.classList.toggle('weak', o.P > 0.02 && o.P < pmin);
    g.classList.toggle('od', !!o.overdrive);
    g.classList.toggle('charging', o.P > 0.001);
    this.q('.g-p').textContent = o.label ?? `${Math.round(o.P * 100)}%`;
    this.q('.g-info').textContent = o.info || '';
  }

  /** ロボット AI の発言（文字が一つずつ出る）。mood：normal / warn / bad / good */
  say(text, mood = 'normal', { priority = 0, hold = 3.6 } = {}) {
    if (this.msg && this.msg.priority > priority && this.msg.age < this.msg.hold) { this.queue.push({ text, mood, priority, hold }); return; }
    this.msg = { text, mood, priority, hold, age: 0, shown: 0 };
    this.ai.dataset.mood = mood;
    this.ai.classList.remove('gone');
    this.ai.style.opacity = 1;
    this.aiText.textContent = '';
  }

  popup(text, x, y, cls = '') {
    const d = document.createElement('div');
    d.className = 'pop ' + cls;
    d.textContent = text;
    this.pops.append(d);
    this.popList.push({ d, x, y, age: 0 });
  }

  showExtract(on, glow) {
    this.extractBtn.classList.toggle('hidden', !on);
    this.extractBtn.classList.toggle('glow', !!glow);
  }

  update(dt) {
    this.time += dt;
    if (this.rec) {
      this.recT -= dt;
      const b = this.el.querySelector(`.tool[data-tool="${this.rec}"]`);
      const k = 0.5 + 0.5 * Math.sin(this.time * 6);
      if (this.recT <= 0) this.recommend(null);
      else if (b) b.style.boxShadow = `0 0 ${6 + 10 * k}px rgba(95, 244, 255, ${0.45 + 0.45 * k})`;
    }
    const m = this.msg;
    if (m) {
      m.age += dt;
      const n = Math.min(m.text.length, Math.floor(m.age * 38));
      if (n !== m.shown) { m.shown = n; this.aiText.textContent = m.text.slice(0, n); }
      const end = m.text.length / 38 + m.hold;
      if (m.age > end && this.queue.length) { const q = this.queue.shift(); this.msg = null; this.say(q.text, q.mood, q); }
      // 読み終わって少したったら、うすくして消す（ずっと残すと、謝りっぱなしのように見えるので）
      const fade = m.age > end + 2.5 ? Math.max(0, 1 - (m.age - end - 2.5) / 0.8) : 1;
      this.ai.style.opacity = fade;
      if (fade <= 0) { this.msg = null; this.ai.classList.add('gone'); }
    }
    for (let i = this.popList.length - 1; i >= 0; i--) {
      const p = this.popList[i];
      p.age += dt;
      const u = p.age / 1.1;
      if (u >= 1) { p.d.remove(); this.popList.splice(i, 1); continue; }
      p.d.style.transform = `translate(${p.x}px, ${p.y - 40 * Math.sqrt(u)}px) translate(-50%, -50%) scale(${u < 0.12 ? 0.6 + u * 3.4 : 1})`;
      p.d.style.opacity = u > 0.7 ? (1 - u) / 0.3 : 1;
    }
  }

  clearPops() { for (const p of this.popList) p.d.remove(); this.popList = []; }
}
