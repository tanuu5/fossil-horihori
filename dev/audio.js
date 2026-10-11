// 効果音と曲の試聴・確認（dev/audio.html）。window.__audioCheck() はヘッドレスの確認からも呼べる。
import { GameAudio, renderOffline } from '../src/audio/Audio.js';
import { SFX } from '../src/audio/synth.js';
import { SONGS } from '../src/audio/songs.js';
import { Sequencer, compile } from '../src/audio/sequencer.js';

const audio = new GameAudio({ master: 0.9, music: 0.6, sfx: 0.8 });
addEventListener('pointerdown', () => audio.unlock(), { once: true });
const add = (row, label, fn) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = async () => { await audio.unlock(); fn(); };
  document.getElementById(row).appendChild(b);
};
for (const name of Object.keys(SFX)) add('sfx', name, () => audio.sfx(name));
for (const id of Object.keys(SONGS)) add('songs', '▶ ' + id, () => audio.music(id));
add('songs', '■ 止める', () => audio.stopMusic());

/** 全部の効果音と曲を書き出して、ピーク・RMS・NaN・曲の書き間違いを返す。 */
async function check() {
  const rows = [];
  for (const name of Object.keys(SFX)) {
    const r = await renderOffline((ctx, mix) => SFX[name](ctx, mix.sfx, 0.05, {}), 2.5);
    rows.push({ name: 'sfx ' + name, peak: r.peak, rms: r.rms, nan: r.nan, warn: [] });
  }
  for (const [id, song] of Object.entries(SONGS)) {
    const seconds = Math.min(16, (compile(song).bars.length * 16 * 60) / (song.bpm || 120) / 4 + 1);
    const r = await renderOffline((ctx, mix) => new Sequencer(ctx, mix.music, song).prime(seconds - 1), seconds);
    rows.push({ name: 'song ' + id, peak: r.peak, rms: r.rms, nan: r.nan, warn: compile(song).warn });
  }
  return rows.map((r) => ({ ...r, peak: +r.peak.toFixed(3), rms: +r.rms.toFixed(4), silent: r.peak < 0.001 }));
}
window.__audioCheck = check;

document.getElementById('check').onclick = async () => {
  const rows = await check();
  document.getElementById('out').innerHTML = '<tr><th>音</th><th>ピーク</th><th>RMS</th><th>NaN</th><th>注意</th></tr>' + rows.map((r) =>
    `<tr><td>${r.name}</td><td>${r.peak}</td><td>${r.rms}</td><td class="${r.nan ? 'bad' : ''}">${r.nan}</td><td class="bad">${[r.silent ? '無音' : '', r.peak > 0.95 ? '大きすぎ' : '', ...r.warn].filter(Boolean).join(' / ')}</td></tr>`).join('');
};
