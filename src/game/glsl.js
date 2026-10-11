// シェーダーで共有するノイズ（ハッシュ・値ノイズ・fbm・ボロノイ）
export const NOISE_GLSL = /* glsl */ `
float sh12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float sh13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vn2(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sh12(i), sh12(i + vec2(1, 0)), u.x), mix(sh12(i + vec2(0, 1)), sh12(i + vec2(1, 1)), u.x), u.y);
}
float vn3(vec3 p) {
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(sh13(i), sh13(i + vec3(1,0,0)), u.x), mix(sh13(i + vec3(0,1,0)), sh13(i + vec3(1,1,0)), u.x), u.y);
  float b = mix(mix(sh13(i + vec3(0,0,1)), sh13(i + vec3(1,0,1)), u.x), mix(sh13(i + vec3(0,1,1)), sh13(i + vec3(1,1,1)), u.x), u.y);
  return mix(a, b, u.z);
}
float fbm3(vec3 p) { float s = 0.0, a = 0.5; for (int k = 0; k < 4; k++) { s += a * vn3(p); p *= 2.03; a *= 0.5; } return s; }
// ボロノイ：x = 最も近い点まで、y = 境界までの距離の目安（F2 - F1）、z = セルの乱数
vec3 voro(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(sh12(i + g), sh12(i + g + 17.3));
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = sh12(i + g + 4.1); } else if (d < d2) d2 = d;
  }
  return vec3(sqrt(d1), sqrt(d2) - sqrt(d1), id);
}
`;

// 化石の色。uBoneCol などのユニフォームが要る。matv：0 骨、0.5 歯、0.75 甲殻、1 殻。dmg：ダメージ
export const BONE_GLSL = /* glsl */ `
vec3 boneShade(vec3 P, float matv, float dmg, float ndv, float px, out float brough, out float crack) {
  // 遠くでは細かい模様を消す（画素より細かい模様はちらつき、毛羽立って見える）。px：画素の大きさ（呼ぶ側で fwidth から）
  float lod1 = 1.0 - smoothstep(0.003, 0.008, px);
  float lod2 = 1.0 - smoothstep(0.001, 0.003, px);
  float fib = lod1 > 0.0 ? mix(0.5, vn3(P * 160.0), lod1) : 0.5;
  float pores = lod2 > 0.0 ? smoothstep(0.62, 0.7, vn3(P * 520.0)) * lod2 : 0.0;
  vec3 bcol = mix(uBoneCol, uBoneCol2, smoothstep(0.25, 0.75, fbm3(P * 26.0)));
  bcol *= 0.86 + 0.22 * fib;
  bcol *= 1.0 - 0.25 * pores;
  brough = 0.5;
  // 皮・うろこの跡（炭化した黒っぽい膜）
  float isSkin = smoothstep(0.15, 0.22, matv) * (1.0 - smoothstep(0.3, 0.38, matv));
  bcol = mix(bcol, uBoneCol * vec3(0.55, 0.5, 0.48) * (0.8 + 0.4 * vn3(P * 90.0)), isSkin);
  brough = mix(brough, 0.75, isSkin);
  // 歯・爪（エナメル）
  float isTooth = smoothstep(0.35, 0.45, matv) * (1.0 - smoothstep(0.6, 0.7, matv));
  bcol = mix(bcol, uToothCol * (0.9 + 0.15 * fib), isTooth);
  brough = mix(brough, 0.28, isTooth);
  // 甲殻（三葉虫）
  float isCar = smoothstep(0.65, 0.72, matv) * (1.0 - smoothstep(0.85, 0.9, matv));
  bcol = mix(bcol, uCarapaceCol * (0.85 + 0.3 * fib), isCar);
  brough = mix(brough, 0.32, isCar);
  // 殻（アンモライト：見る角度で色が変わる）
  float isShell = smoothstep(0.9, 0.96, matv);
  if (isShell > 0.0) {
    float iPatch = smoothstep(0.38, 0.72, fbm3(P * 9.0 + 2.0));
    // 遊色は赤〜金〜緑の範囲に寄せる（虹色になりすぎない）
    float ph = fract(ndv * 1.1 + fbm3(P * 30.0) * 1.2);
    vec3 irid = mix(mix(vec3(0.85, 0.28, 0.12), vec3(0.95, 0.72, 0.2), smoothstep(0.0, 0.45, ph)), vec3(0.25, 0.75, 0.35), smoothstep(0.45, 0.9, ph));
    vec3 shell = uShellCol * (0.85 + 0.25 * fib);
    shell = mix(shell, irid * (0.45 + 0.55 * length(shell)), uIrid * iPatch * 0.7);
    bcol = mix(bcol, shell, isShell);
    brough = mix(brough, 0.22, isShell);
  }
  // ヒビ（ダメージに応じて増える）と欠け
  crack = 0.0;
  if (dmg > 0.1) {
    vec3 vo = voro(P.xz * uCrackScale);
    vec3 vo2 = voro(P.xz * uCrackScale * 2.7 + 9.0);
    float cw = 0.035 + 0.09 * clamp(dmg, 0.0, 1.0);
    crack = (1.0 - smoothstep(cw * 0.4, cw, vo.y)) * step(vo.z * 0.85 + 0.12, dmg);
    crack = max(crack, (1.0 - smoothstep(cw * 0.3, cw * 0.8, vo2.y)) * step(vo2.z * 0.7 + 0.35, dmg) * 0.8);
    float brk = smoothstep(0.98, 1.05, dmg);
    vec3 frac = mix(bcol * 1.35 + vec3(0.07, 0.06, 0.05), vec3(0.55, 0.52, 0.48), 0.35) * (0.8 + 0.3 * vn3(P * 300.0));
    bcol = mix(bcol, frac, brk * 0.85);
    bcol *= 1.0 - crack * (0.8 - brk * 0.3);
    brough = mix(brough, 0.85, brk);
  }
  return bcol;
}
`;
