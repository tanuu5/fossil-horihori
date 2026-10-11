// 多言語化。辞書は src/i18n/<言語>.js（ja と同じキーを持たせる。足りないキーは ja → キー名の順で代わりに出す）。
//   t('title.start')                     → 「はじめる」
//   t('hud.score', { n: 3 })             → 「スコア 3」（{n} を置き換える）
//   <button data-i18n="title.start">     → applyDom() で中身を差し替える（言語を切り替えたときも）
//   <span data-i18n-title="…">           → title 属性を差し替える
import { ja } from '../i18n/ja.js';
import { en } from '../i18n/en.js';

export const LANGS = [
  { id: 'ja', label: '日本語' },
  { id: 'en', label: 'English' },
];
const DICTS = { ja, en };

let current = 'ja';
const listeners = new Set();

export const isLang = (v) => typeof v === 'string' && v in DICTS;

/** ブラウザの言語から決める（対応していなければ英語）。 */
export function detectLang() {
  const list = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of list) {
    const base = String(l || '').toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }
  return 'en';
}

export const getLang = () => current;

export function setLang(l) {
  if (!isLang(l)) return;
  current = l;
  document.documentElement.lang = l;
  applyDom();
  for (const fn of listeners) fn(l);
}

export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function t(key, p) {
  const raw = DICTS[current][key] ?? DICTS.ja[key] ?? key;
  if (!p) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in p ? String(p[name]) : m));
}

/** data-i18n / data-i18n-title / data-i18n-aria を持つ要素を、今の言語に差し替える。 */
export function applyDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}

/** 辞書のキーがそろっているか（開発中に確かめる用）。足りないキーを言語ごとに返す。 */
export function missingKeys() {
  const base = Object.keys(DICTS.ja);
  return Object.fromEntries(Object.entries(DICTS).map(([l, d]) => [l, base.filter((k) => !(k in d))]));
}
