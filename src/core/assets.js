// アセット（public/ に置いた画像・音・モデル）の URL を 1 か所で決める。
//   loader.load(asset('tex/wall.jpg'))
//
// なぜ要るか：'./tex/wall.jpg' のような相対パスは「開いているページ」から解決されるので、
// ゲーム（/index.html）では動いても、確認台（/dev/viewer.html）から同じモジュールを読むと /dev/tex/… を探してしまう。
// - 開発サーバー：public/ はサイトの根（/）にあるので、どのページからでも '/tex/…' で届く
// - 公開ビルド：base: './' なので index.html からの相対（GitHub Pages のサブパスでも動く）
// ほかの場所に置くとき（CDN など）は setAssetBase() で変える。
//
// src/ の中に置いて import するアセット（new URL('./x.png', import.meta.url)）は、Vite がどのページからでも解決するので、これは要らない。

let base = (() => {
  try {
    if (import.meta.env?.DEV) return '/';
    if (import.meta.env?.BASE_URL) return import.meta.env.BASE_URL;
  } catch { /* Vite 以外 */ }
  return './';
})();

export function setAssetBase(url) { base = url.endsWith('/') ? url : url + '/'; }
export const assetBase = () => base;
export const asset = (path) => base + String(path).replace(/^\.?\//, '');
