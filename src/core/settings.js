// 遊ぶ人の設定（音量・画質・言語・ボタン表示）。localStorage に残し、URL で一時的に上書きできる：
//   ?quality=high   画質を固定（撮影のときは high にする。auto だと重い場面で解像度が下がる）
//   ?lang=en        言語        ?mute=1  音を出さない
import { createStore } from './save.js';
import { detectLang, isLang } from './i18n.js';

export const QUALITIES = ['auto', 'high', 'medium', 'low'];
// ゲームパッドの表示：type1 = A/B/X/Y の配置、type2 = ×/○/□/△ の配置（メーカー名は画面に出さない）
export const PAD_TYPES = ['auto', 'type1', 'type2'];
// 難易度：easy = ブラシでどこでも掘れて電池が充電される、normal = ふつう、hard = 電池少なめ・化石がもろい
export const DIFFICULTIES = ['easy', 'normal', 'hard'];

const store = createStore('fossil-horihori.settings', {
  volume: { master: 0.9, music: 0.6, sfx: 0.8 },
  quality: 'auto',
  lang: '',
  padType: 'auto',
  difficulty: 'normal',
}, 1);

export const settings = store.data;
if (!isLang(settings.lang)) settings.lang = detectLang();
if (!QUALITIES.includes(settings.quality)) settings.quality = 'auto';
if (!PAD_TYPES.includes(settings.padType)) settings.padType = 'auto';
if (!DIFFICULTIES.includes(settings.difficulty)) settings.difficulty = 'normal';

// URL の上書きは保存しない（その回だけ）
const q = new URLSearchParams(location.search);
export const overrides = {
  quality: QUALITIES.includes(q.get('quality')) ? q.get('quality') : null,
  lang: isLang(q.get('lang')) ? q.get('lang') : null,
  mute: q.has('mute'),
  paddiag: q.has('paddiag'),   // ゲームパッド・フォーカスの状態を画面に出す（Safari などで調べるとき）
  debug: q.has('debug'),       // タイトルの版表記に時刻とコミットのハッシュも出す（不具合の報告を受けるとき）
};

export const effective = {
  get quality() { return overrides.quality || settings.quality; },
  get lang() { return overrides.lang || settings.lang; },
};

export function saveSettings() { store.save(); }
