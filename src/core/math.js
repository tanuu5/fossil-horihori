// 数学の小道具。作品ごとに書き直していた clamp / lerp / damp などをまとめたもの。

export const TAU = Math.PI * 2;
export const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => (b === a ? 0 : (x - a) / (b - a));
export const remap = (x, a0, a1, b0, b1) => lerp(b0, b1, clamp(invLerp(a0, a1, x)));
export const smoothstep = (a, b, x) => { const t = clamp(invLerp(a, b, x)); return t * t * (3 - 2 * t); };

/** 有限の数でなければ d を返す（外から来る値や、割り算の結果の NaN / Infinity よけ）。 */
export const fin = (x, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/**
 * フレームレートによらないなめらかな追従。lambda が大きいほど速く近づく（目安：5〜20）。
 * 毎フレーム a = damp(a, b, 10, dt) のように使う。
 */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** 角度を -π〜π に。 */
export const wrapAngle = (a) => { a = (a + Math.PI) % TAU; return (a < 0 ? a + TAU : a) - Math.PI; };
/** 角度の damp（近いほうの向きへ回る）。 */
export const dampAngle = (a, b, lambda, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt));

/** 0〜1 のイージング。 */
export const ease = {
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outBack: (t, s = 1.70158) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2,
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1),
};
