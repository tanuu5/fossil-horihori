// 地層のブロック（スラブ）。高さ場で「どこまで掘ったか」を持ち、化石（BoneField）と重ねて描く。
//
// データ（グリッド NX×NZ、1 セル = 1 頂点）
//   h      堆積物の上面の高さ（m）。骨のセルでは骨の上面 top より下がらない
//   dmg    化石へのダメージ（0〜。1 を超えると欠ける）
//   dust   ホコリ（0〜1）。打つと周りに積もり、ブラシで払う
//   cut    最後に削った時刻（掘りたての湿った色に使う）
// テクスチャ
//   tDyn  (h, dmg, dust, cut)   tBone (top, bot, mat, mask)   どちらも HalfFloat の RGBA
// 描画は MeshStandardMaterial を onBeforeCompile で書き換え、頂点を tDyn で動かし、法線はピクセルごとに求める。
import * as THREE from 'three';
import { BoneField, FOSSILS } from './fossils.js';
import { NOISE_GLSL, BONE_GLSL } from './glsl.js';

export const NX = 321, NZ = 221;
export const FLOOR = -0.46;     // これより下は岩盤（掘れない）
const BORDER = 3;               // 外周のセルは掘らない（穴の縁）
const EXPOSED = 0.0025;         // 骨の上の堆積物がこれより薄ければ「見えている」

// 道具：r0 = 打った穴の半径の基準、depthK = 深さ（出力−硬さ に比例）、A・L = 化石へ伝わる衝撃の強さと届く距離
export const TOOLS = {
  hammer: { kind: 'strike', r0: 0.085, depthK: 0.15, A: 1.0, L: 0.085, sharp: 2, res: 0.62, cost: [0.35, 0.55], dust: 1 },
  chisel: { kind: 'strike', r0: 0.038, depthK: 0.05, A: 0.5, L: 0.03, sharp: 3, res: 1.0, cost: [0.12, 0.18], dust: 0.45 },
  // reach：化石からこの距離（m）より離れた土は払えない（near までは全力）。wear：きれいな骨をこすると傷つく速さ
  brush: { kind: 'brush', r: 0.055, rate: 0.05, strength: 0.33, cost: 0.2, near: 0.02, reach: 0.04, wear: 0.22 },
};
export const OVERDRIVE = 1.15; // がんばりすぎの出力

/** 骨を削ってしまったときのダメージ。骨は堆積物より固いので、その場所に届く力（P_local = P √prof）が
 *  骨の強さ res を超えたときだけ削れる。弱い打撃は骨の表面で止まる。 */
function cutDamage(over, Pl, res, tol) {
  if (over <= 0.0003) return 0;
  const u = Math.max(0, Math.min(1, (Pl - (res - 0.05)) / 0.2));
  const w = u * u * (3 - 2 * u);
  return Math.min(2, (w * (over - 0.0003)) / (0.004 * tol));
}

const _half = THREE.DataUtils.toHalfFloat;

// 地層の境目のゆらぎ（GLSL の warp と同じ式）
function warp(x, z, s) {
  return 0.012 * Math.sin(x * 2.3 + z * 1.1 + s) + 0.008 * Math.sin(x * 5.7 - z * 3.9 + s * 2) + 0.004 * Math.sin(x * 13.1 + z * 7.3 + s * 3);
}
/** なめらかな値ノイズ（0〜1）。打った穴のでこぼこに使う（セルごとの乱数だとトゲになる）。 */
function vnoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z), u = x - i, v = z - j;
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return (a * (1 - su) + b * su) * (1 - sv) + (c * (1 - su) + d * su) * sv;
}
function hash2(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class Slab {
  constructor(stage, rng) {
    const def = FOSSILS[stage.fossil];
    const [W, D] = def.size;
    Object.assign(this, { stage, W, D, nx: NX, nz: NZ });
    this.dx = W / (NX - 1);
    this.dz = D / (NZ - 1);
    this.cellArea = this.dx * this.dz;
    this.seed = rng.range(0, 50);
    this.layers = stage.layers;
    this.tolBase = stage.tol;
    // 大きな現場では道具も少し大きく（打つ回数が増えすぎないように）
    const ts = stage.toolScale || 1;
    this.tools = {
      hammer: { ...TOOLS.hammer, r0: TOOLS.hammer.r0 * ts, depthK: TOOLS.hammer.depthK * ts, L: TOOLS.hammer.L * ts },
      chisel: { ...TOOLS.chisel, r0: TOOLS.chisel.r0 * Math.sqrt(ts) },
      brush: { ...TOOLS.brush, r: TOOLS.brush.r * ts },
    };
    this.boneRes = stage.boneRes ?? 0.46; // 骨の強さ（これを超える力が届くと削れる）
    this.crust = stage.crust;   // { t: 厚さ, hard }

    const bf = (this.bf = new BoneField(NX, NZ, W, D));
    def.build(bf, rng);
    bf.finish();

    const n = NX * NZ;
    this.h = new Float32Array(n);
    this.dmg = new Float32Array(n);
    this.dust = new Float32Array(n);
    this.cut = new Float32Array(n).fill(-1000);
    this.broken = new Uint8Array(n);
    this.strikes = 0;
    this.version = 0;
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
      const x = this.x(i), z = this.z(j);
      // 地表：ゆるい起伏と、小さなでこぼこ（足跡や風で寄った砂のような）
      const n1 = vnoise(x * 9 + this.seed, z * 9), n2 = vnoise(x * 26 - this.seed, z * 26 + 3), n3 = vnoise(x * 70, z * 70 - this.seed);
      this.h[j * NX + i] = 0.003 * Math.sin(x * 3.1 + this.seed) * Math.sin(z * 2.7 - this.seed) + 0.0015 * Math.sin(x * 11 + z * 9)
        + 0.0035 * (n1 - 0.5) + 0.0018 * (n2 - 0.5) + 0.0007 * (n3 - 0.5);
    }
    this.h0 = Float32Array.from(this.h);
    this.placeNodules(rng, stage.nodules || 0);
    // 骨のまわりの固い皮（まだらに。ある所はノミが要り、ない所はブラシで払える）
    this.crustMap = new Uint8Array(n);
    const cov = this.crust?.cover ?? 0.45, cf = 1 / Math.max(0.03, Math.min(W, D) * 0.07), co = this.seed * 3.1;
    for (let k = 0; k < n; k++) {
      if (bf.dist[k] > (this.crust?.t || 0) * 3 + 0.01) continue;
      const i = k % NX, j = (k - i) / NX;
      const v = 0.6 * vnoise(this.x(i) * cf + co, this.z(j) * cf) + 0.4 * vnoise(this.x(i) * cf * 2.7 - co, this.z(j) * cf * 2.7);
      const c = Math.max(0, Math.min(1, (v - (1 - cov) + 0.06) / 0.12));
      // もろい部位（トゲ・肋骨・ヒレ）には固い皮をつけない（ノミでも安全に取れなくなるので）
      let fr = 1;
      if (bf.mask[k]) fr = Math.max(0, Math.min(1, (bf.tol[k] - 0.6) / 0.25));
      this.crustMap[k] = Math.round(c * fr * 255);
    }

    // テクスチャ
    this.dynData = new Uint16Array(n * 4);
    this.boneData = new Uint16Array(n * 4);
    for (let k = 0; k < n; k++) { this.writeDyn(k); this.writeBone(k); }
    const mk = (data) => {
      const t = new THREE.DataTexture(data, NX, NZ, THREE.RGBAFormat, THREE.HalfFloatType);
      t.magFilter = t.minFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    this.tDyn = mk(this.dynData);
    this.tBone = mk(this.boneData);
    this.tCrust = new THREE.DataTexture(this.crustMap, NX, NZ, THREE.RedFormat, THREE.UnsignedByteType);
    this.tCrust.magFilter = this.tCrust.minFilter = THREE.LinearFilter;
    this.tCrust.generateMipmaps = false;
    this.tCrust.unpackAlignment = 1;
    this.tCrust.needsUpdate = true;
    this.dirty = null;
    this.boneDirty = null;

    this.mesh = this.buildMesh();
    this.stats = this.computeStats();
  }

  // ---------------------------------------------------------------- 座標
  x(i) { return (i / (NX - 1) - 0.5) * this.W; }
  z(j) { return (j / (NZ - 1) - 0.5) * this.D; }
  fi(x) { return (x / this.W + 0.5) * (NX - 1); }
  fj(z) { return (z / this.D + 0.5) * (NZ - 1); }
  inside(x, z, margin = BORDER + 1) {
    const i = this.fi(x), j = this.fj(z);
    return i >= margin && i <= NX - 1 - margin && j >= margin && j <= NZ - 1 - margin;
  }
  clampXZ(v, margin = BORDER + 2) {
    const mx = this.W / 2 - margin * this.dx, mz = this.D / 2 - margin * this.dz;
    v.x = Math.max(-mx, Math.min(mx, v.x));
    v.z = Math.max(-mz, Math.min(mz, v.z));
    return v;
  }
  /** 高さ（双一次補間）。 */
  hAt(x, z) {
    let fi = this.fi(x), fj = this.fj(z);
    fi = Math.max(0, Math.min(NX - 1.001, fi));
    fj = Math.max(0, Math.min(NZ - 1.001, fj));
    const i = fi | 0, j = fj | 0, u = fi - i, v = fj - j, k = j * NX + i, h = this.h;
    return (h[k] * (1 - u) + h[k + 1] * u) * (1 - v) + (h[k + NX] * (1 - u) + h[k + NX + 1] * u) * v;
  }

  // ---------------------------------------------------------------- 地層・硬さ
  layerIndex(x, y, z) {
    // 地表の近くではゆらぎを弱める（表土より大きくゆらすと、下の層が地表にしみ出して見える）
    const lc = y + warp(x, z, this.seed) * Math.min(1, Math.max(0, -y / 0.06));
    const L = this.layers;
    for (let k = 0; k < L.length - 1; k++) if (lc > L[k].to) return k;
    return L.length - 1;
  }

  placeNodules(rng, count) {
    const bf = this.bf;
    this.nodules = [];
    for (let tries = 0; tries < count * 30 && this.nodules.length < count; tries++) {
      const r = rng.range(0.035, 0.075) * Math.min(1.4, this.W / 1.5);
      const x = rng.range(-this.W / 2 + r + 0.05, this.W / 2 - r - 0.05);
      const z = rng.range(-this.D / 2 + r + 0.05, this.D / 2 - r - 0.05);
      const y = rng.range(-0.05, -0.3);
      const ry = r * 0.6;
      // 骨と重ならない（1.2 cm 以上はなす）。骨の真上にかぶさるのはよい
      let ok = true;
      const pad = r + 0.012;
      const i0 = Math.max(0, Math.floor(this.fi(x - pad))), i1 = Math.min(NX - 1, Math.ceil(this.fi(x + pad)));
      const j0 = Math.max(0, Math.floor(this.fj(z - pad))), j1 = Math.min(NZ - 1, Math.ceil(this.fj(z + pad)));
      for (let j = j0; j <= j1 && ok; j++) for (let i = i0; i <= i1; i++) {
        const k = j * NX + i;
        if (!bf.mask[k]) continue;
        if (Math.hypot(this.x(i) - x, this.z(j) - z) > pad) continue;
        if (y - ry - 0.012 < bf.top[k] && y + ry + 0.012 > bf.bot[k]) { ok = false; break; }
      }
      for (const nd of this.nodules) if (Math.hypot(nd.x - x, nd.z - z) < nd.r + r) ok = false;
      if (ok) this.nodules.push({ x, y, z, r, ry, hard: rng.range(0.56, 0.66) });
    }
  }

  /** その点の硬さ（0〜1）。k はセル番号（地殻＝骨のまわりの固い層の判定に使う）。 */
  hardAt(x, y, z, k) {
    if (y < FLOOR + 0.008) return 0.95;
    for (const nd of this.nodules) {
      const dx = (x - nd.x) / nd.r, dy = (y - nd.y) / nd.ry, dz = (z - nd.z) / nd.r;
      if (dx * dx + dy * dy + dz * dz < 1) return nd.hard;
    }
    let H = this.layers[this.layerIndex(x, y, z)].hard;
    const bf = this.bf;
    if (k !== undefined && this.crust && this.crustMap[k]) {
      const c = this.crustMap[k] / 255;
      const ch = H + (this.crust.hard - H) * c;
      if (bf.mask[k] && y - bf.top[k] < this.crust.t) H = Math.max(H, ch);
      else if (!bf.mask[k] && bf.dist[k] < this.crust.t && y < bf.etop[k] + this.crust.t && y > bf.ebot[k] - 0.01) H = Math.max(H, ch * 0.95);
    }
    return H;
  }

  /** カーソルの位置の解析：硬さ（必要な出力）と、化石を傷つけない出力の上限。 */
  tool(name) { return this.tools[name]; }

  analyze(x, z, toolName) {
    const T = this.tools[toolName];
    const fi = Math.round(this.fi(x)), fj = Math.round(this.fj(z));
    const k0 = Math.max(0, Math.min(NZ - 1, fj)) * NX + Math.max(0, Math.min(NX - 1, fi));
    const hc = this.hAt(x, z);
    const H = this.hardAt(x, hc - 0.001, z, k0);
    const layer = this.layerIndex(x, hc - 0.001, z);
    const nod = this.nodules.some((nd) => { const dx = (x - nd.x) / nd.r, dy = (hc - 0.001 - nd.y) / nd.ry, dz = (z - nd.z) / nd.r; return dx * dx + dy * dy + dz * dz < 1; });
    const out = { H, layer, nodule: nod, psafe: 2, dBone: Infinity, onBone: false, exposedHere: false };
    const bf = this.bf;
    if (bf.mask[k0] && !bf.extra[k0]) { out.onBone = true; out.exposedHere = this.h[k0] - bf.top[k0] < EXPOSED; }
    if (T.kind === 'brush') {
      // ブラシが届くか（化石からの近さ）と、払える柔らかさか
      const nb = bf.nearest[k0];
      let m = 0;
      if (nb >= 0 && hc > bf.bot[nb]) {
        const e = Math.hypot(bf.dist[k0], Math.max(0, hc - bf.top[nb]));
        m = 1 - Math.max(0, Math.min(1, (e - T.near) / (T.reach - T.near)));
      }
      out.reach = m;
      out.brushable = H < T.strength - 0.005;
      return out;
    }
    if (T.kind !== 'strike') return out;
    // 衝撃の上限：P² A / (1 + (d/L)²) ≤ 許容 → P ≤ sqrt(許容 (1 + (d/L)²) / A)
    let worst = Infinity, dmin = Infinity;
    const R = T.L * 5.5 + T.r0 * 1.6;
    const list = bf.list, top = bf.top, tol = bf.tol;
    for (let n = 0; n < list.length; n++) {
      const k = list[n];
      if (this.broken[k]) continue;
      const i = k % NX, j = (k - i) / NX;
      const dxw = this.x(i) - x, dzw = this.z(j) - z;
      if (Math.abs(dxw) > R || Math.abs(dzw) > R) continue;
      const dy = Math.max(0, hc - top[k]);
      const d2 = dxw * dxw + dzw * dzw + dy * dy;
      const L2 = T.L * T.L;
      const v = this.tolBase * tol[k] * (1 + d2 / L2);
      if (v < worst) worst = v;
      if (d2 < dmin) dmin = d2;
    }
    out.dBone = Math.sqrt(dmin);
    const pShock = worst === Infinity ? 2 : Math.sqrt(worst / T.A);
    // 掘りすぎの上限：穴の中の骨のセルで、削る深さが骨の上の堆積物の厚さを超えない最大の P（二分探索）
    const over = (P) => this.overshootAt(x, z, P, T);
    let lo = Math.max(0, H), hi = Math.min(OVERDRIVE, pShock);
    if (hi <= lo) { out.psafe = Math.min(pShock, lo); return out; }
    if (!over(hi)) { out.psafe = pShock; return out; }
    if (over(lo + 0.001)) { out.psafe = lo; return out; }
    for (let it = 0; it < 11; it++) { const m = (lo + hi) / 2; if (over(m)) hi = m; else lo = m; }
    out.psafe = lo;
    return out;
  }

  /** 出力 P で打ったとき、骨を削ってしまうか（乱れの最大 1.25 倍で見る）。 */
  overshootAt(x, z, P, T) {
    const rc = T.r0 * (0.55 + 0.9 * Math.min(P, OVERDRIVE));
    const bf = this.bf;
    const ci = this.fi(x), cj = this.fj(z);
    const ri = Math.ceil(rc / this.dx) + 1, rj = Math.ceil(rc / this.dz) + 1;
    const i0 = Math.max(BORDER, Math.floor(ci - ri)), i1 = Math.min(NX - 1 - BORDER, Math.ceil(ci + ri));
    const j0 = Math.max(BORDER, Math.floor(cj - rj)), j1 = Math.min(NZ - 1 - BORDER, Math.ceil(cj + rj));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * NX + i;
      if (!bf.mask[k] || bf.extra[k] || this.broken[k]) continue;
      const rho2 = ((this.x(i) - x) ** 2 + (this.z(j) - z) ** 2) / (rc * rc * 1.18 * 1.18);
      if (rho2 >= 1) continue;
      const prof = Math.pow(1 - rho2, T.sharp);
      const Hc = this.hardAt(this.x(i), this.h[k] - 0.001, this.z(j), k);
      const depth = T.depthK * Math.max(0, P - Hc) * prof * 1.2;
      const over = depth - (this.h[k] - bf.top[k]);
      if (over > 0 && cutDamage(over, P * Math.sqrt(prof), T.res * this.boneRes * (0.55 + 0.45 * bf.tol[k]), bf.tol[k]) > 0.012) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- 打つ・払う
  /** 打つ。結果：取った量・はね返ったか・化石へのダメージ・欠けたセル。 */
  strike(x, z, P, toolName, time) {
    const T = this.tools[toolName];
    const bf = this.bf, top = bf.top, mask = bf.mask;
    this.strikes++;
    const rc = T.r0 * (0.55 + 0.9 * Math.min(P, OVERDRIVE));
    const hc = this.hAt(x, z);
    const fi0 = Math.round(this.fi(x)), fj0 = Math.round(this.fj(z));
    const k0 = fj0 * NX + fi0;
    const H0 = this.hardAt(x, hc - 0.001, z, k0);
    const res = { P, H: H0, bounced: P < H0, removed: 0, dmgAdded: 0, overCut: 0, broken: [], hitBone: false, shockMax: 0, layer: this.layerIndex(x, hc - 0.001, z), rc, y: hc };
    const ci = this.fi(x), cj = this.fj(z);
    const ri = Math.ceil(rc / this.dx) + 1, rj = Math.ceil(rc / this.dz) + 1;
    const i0 = Math.max(BORDER, Math.floor(ci - ri)), i1 = Math.min(NX - 1 - BORDER, Math.ceil(ci + ri));
    const j0 = Math.max(BORDER, Math.floor(cj - rj)), j1 = Math.min(NZ - 1 - BORDER, Math.ceil(cj + rj));
    // 穴の形をなめらかなノイズでゆがめる（縁のでこぼこと、底の起伏）
    const ox = this.strikes * 17.31, oz = this.strikes * 9.77;
    const fq = 1 / Math.max(0.008, rc * 0.45);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * NX + i;
      const px = this.x(i), pz = this.z(j);
      const wob = 0.82 + 0.36 * vnoise(px * fq + ox, pz * fq + oz);
      const rho2 = ((px - x) ** 2 + (pz - z) ** 2) / (rc * rc * wob * wob);
      if (rho2 >= 1) continue;
      const prof = Math.pow(1 - rho2, T.sharp);
      const Hc = this.hardAt(px, this.h[k] - 0.001, pz, k);
      const e = P - Hc;
      let depth;
      if (e <= 0) depth = 0.0004 * prof * Math.max(0, P - Hc + 0.15); // はね返る：ほんの少し欠けるだけ
      else depth = T.depthK * e * prof * (0.8 + 0.4 * vnoise(px * fq * 2.3 - oz, pz * fq * 2.3 + ox));
      let hn = Math.max(FLOOR, this.h[k] - depth);
      if (mask[k] && hn < top[k]) {
        const over = top[k] - hn;
        hn = top[k];
        if (!this.broken[k] && !bf.extra[k]) {
          const add = cutDamage(over, P * Math.sqrt(prof), T.res * this.boneRes * (0.55 + 0.45 * bf.tol[k]), bf.tol[k]);
          if (add > 0) {
            this.dmg[k] += add;
            res.dmgAdded += add;
            res.overCut = Math.max(res.overCut, over);
            res.hitBone = true;
          }
        }
      }
      if (hn < this.h[k]) {
        res.removed += (this.h[k] - hn) * this.cellArea;
        this.h[k] = hn;
        this.cut[k] = time;
      }
    }
    // ホコリ：穴の周りに積もる
    const rd = rc * 1.9;
    this.forDisc(x, z, rd, (k, rho) => {
      const amt = T.dust * Math.min(1, P) * 0.28 * (1 - rho) * (rho > 0.45 ? 1 : 0.3);
      this.dust[k] = Math.min(1, this.dust[k] + amt);
    });
    // 衝撃：骨のセルへ距離で弱まりながら伝わる
    const R = T.L * 5.5 + rc;
    const list = bf.list;
    for (let n = 0; n < list.length; n++) {
      const k = list[n];
      const i = k % NX, j = (k - i) / NX;
      const dxw = this.x(i) - x, dzw = this.z(j) - z;
      if (Math.abs(dxw) > R || Math.abs(dzw) > R) continue;
      const dy = Math.max(0, hc - top[k]);
      const S = (T.A * P * P) / (1 + (dxw * dxw + dzw * dzw + dy * dy) / (T.L * T.L));
      const thr = this.tolBase * bf.tol[k];
      const ratio = S / thr;
      if (ratio > res.shockMax) res.shockMax = ratio;
      if (ratio > 1 && !this.broken[k]) {
        const add = Math.min(1.5, 0.85 * (ratio - 1));
        this.dmg[k] += add;
        res.dmgAdded += add;
        this.markDirty(i, i, j, j);
      }
    }
    this.slump(i0 - 2, i1 + 2, j0 - 2, j1 + 2);
    this.applyBreaks(res, time);
    this.markDirty(i0, i1, j0, j1);
    const ri2 = Math.ceil(rd / this.dx) + 1, rj2 = Math.ceil(rd / this.dz) + 1;
    this.markDirty(Math.floor(ci - ri2), Math.ceil(ci + ri2), Math.floor(cj - rj2), Math.ceil(cj + rj2));
    this.version++;
    this.stats = this.computeStats();
    return res;
  }

  /** 細いとがりを崩す：まわり 4 つのうち 3 つ以上より大きく飛び出したセルを低くする（穴が重なった所に残る針のような山よけ）。
   *  骨のセルは骨の上面より下げない。 */
  slump(i0, i1, j0, j1) {
    const bf = this.bf, h = this.h, t = 1.6 * this.dx;
    i0 = Math.max(BORDER + 1, i0); j0 = Math.max(BORDER + 1, j0); i1 = Math.min(NX - 2 - BORDER, i1); j1 = Math.min(NZ - 2 - BORDER, j1);
    for (let pass = 0; pass < 2; pass++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * NX + i;
      const a = h[k - 1], b = h[k + 1], c = h[k - NX], d = h[k + NX];
      const hk = h[k];
      const low = (a < hk - t) + (b < hk - t) + (c < hk - t) + (d < hk - t);
      if (low < 3) continue;
      let hn = (a + b + c + d) / 4 + t;
      if (bf.mask[k]) hn = Math.max(hn, bf.top[k]);
      if (hn < hk) h[k] = hn;
    }
  }

  /** ダメージが 1 を超えたセルを欠けさせる（上面を下げ、見えていればそこまで削る）。 */
  applyBreaks(res, time) {
    const bf = this.bf;
    for (const k of bf.list) {
      if (this.broken[k] || this.dmg[k] < 1) continue;
      this.broken[k] = 1;
      const exposed = this.h[k] - bf.top[k] < EXPOSED * 4;
      const drop = (bf.top[k] - bf.bot[k]) * (0.3 + 0.25 * hash2(k, 7));
      bf.top[k] -= drop;
      bf.etop[k] = bf.top[k];
      if (exposed) { this.h[k] = bf.top[k]; this.cut[k] = time; }
      res.broken.push(k);
      const i = k % NX, j = (k - i) / NX;
      this.markBone(i, j);
      this.markDirty(i, i, j, j);
    }
  }

  /** ブラシ：ホコリを払い、化石のすぐ近くの柔らかい土だけを少しずつ取る。
   *  化石から離れた厚い土には効かない（そこはハンマーで）。ホコリの取れたきれいな骨をこすり続けると、すり減って傷がつく。 */
  brush(x, z, dt, time) {
    const T = this.tools.brush;
    const bf = this.bf;
    const res = { removed: 0, dust: 0, soft: false, onBone: false, thick: false, wear: 0 };
    this.forDisc(x, z, T.r, (k, rho, i, j) => {
      const prof = 1 - rho * rho;
      const d0 = this.dust[k];
      this.dust[k] = Math.max(0, d0 - 3.2 * dt * prof);
      res.dust += d0 - this.dust[k];
      const Hc = this.hardAt(this.x(i), this.h[k] - 0.0005, this.z(j), k);
      const s = Math.max(0, Math.min(1, (T.strength - Hc) / 0.15));
      if (s <= 0) return;
      res.soft = true;
      // 化石からの近さ（横の距離と、いちばん近い骨の上面からの高さ）で効き目を決める
      const nb = bf.nearest[k];
      let m = 0;
      if (nb >= 0 && this.h[k] > bf.bot[nb]) {
        const e = Math.hypot(bf.dist[k], Math.max(0, this.h[k] - bf.top[nb]));
        m = 1 - Math.max(0, Math.min(1, (e - T.near) / (T.reach - T.near)));
      }
      if (m <= 0) { res.thick = true; return; }
      let hn = this.h[k] - T.rate * dt * prof * s * m;
      if (bf.mask[k] && hn < bf.top[k]) { hn = bf.top[k]; res.onBone = true; }
      hn = Math.max(FLOOR, hn);
      if (hn < this.h[k]) { res.removed += (this.h[k] - hn) * this.cellArea; this.h[k] = hn; this.cut[k] = Math.max(this.cut[k], time - 6); }
    });
    // こすりすぎ：ブラシの真ん中が、もうきれいになった骨の上にある状態が続いている
    // （土やホコリの上を払うのはよい。きれいな骨を 0.35 秒以上こすると、真ん中あたりの骨がすり減る）
    const kc = Math.round(this.fj(z)) * NX + Math.round(this.fi(x));
    const centerClean = bf.mask[kc] && !bf.extra[kc] && this.h[kc] - bf.top[kc] < EXPOSED && this.dust[kc] < 0.05;
    this.scrubT = centerClean ? (this.scrubT || 0) + dt : 0;
    if (this.scrubT > 0.35) {
      this.forDisc(x, z, T.r * 0.6, (k, rho) => {
        if (!bf.mask[k] || bf.extra[k] || this.broken[k] || this.h[k] - bf.top[k] >= EXPOSED || this.dust[k] >= 0.05) return;
        const w = (T.wear * dt * (1 - rho * rho)) / bf.tol[k];
        this.dmg[k] += w;
        res.wear += w;
      });
      if (res.wear > 0) this.applyBreaks({ broken: [] }, time);
    }
    const ci = this.fi(x), cj = this.fj(z), r = Math.ceil(T.r / this.dx) + 1;
    this.markDirty(Math.floor(ci - r), Math.ceil(ci + r), Math.floor(cj - r), Math.ceil(cj + r));
    this.version++;
    return res;
  }

  forDisc(x, z, rad, fn) {
    const ci = this.fi(x), cj = this.fj(z);
    const ri = Math.ceil(rad / this.dx) + 1, rj = Math.ceil(rad / this.dz) + 1;
    const i0 = Math.max(BORDER, Math.floor(ci - ri)), i1 = Math.min(NX - 1 - BORDER, Math.ceil(ci + ri));
    const j0 = Math.max(BORDER, Math.floor(cj - rj)), j1 = Math.min(NZ - 1 - BORDER, Math.ceil(cj + rj));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const rho = Math.hypot(this.x(i) - x, this.z(j) - z) / rad;
      if (rho < 1) fn(j * NX + i, rho, i, j);
    }
  }

  // ---------------------------------------------------------------- 集計
  computeStats() {
    const bf = this.bf, list = bf.list;
    let exposed = 0, loss = 0, dustSum = 0, cracked = 0, broken = 0;
    for (let n = 0; n < list.length; n++) {
      const k = list[n];
      if (this.h[k] - bf.top[k] < EXPOSED) { exposed++; dustSum += this.dust[k]; }
      if (this.broken[k]) { loss += 1; broken++; }
      else if (this.dmg[k] > 0.05) { loss += 0.45 * Math.min(1, this.dmg[k]); cracked++; }
    }
    const N = list.length || 1;
    return {
      exposure: exposed / N,
      integrity: Math.max(0, 1 - loss / N),
      clean: exposed ? 1 - dustSum / exposed : 1,
      cracked: cracked / N,
      broken: broken / N,
    };
  }

  // ---------------------------------------------------------------- テクスチャの更新
  writeDyn(k) {
    const o = k * 4, d = this.dynData;
    d[o] = _half(this.h[k]);
    d[o + 1] = _half(Math.min(4, this.dmg[k]));
    d[o + 2] = _half(this.dust[k]);
    d[o + 3] = _half(this.cut[k]);
  }
  writeBone(k) {
    const o = k * 4, d = this.boneData, bf = this.bf;
    d[o] = _half(bf.etop[k]);
    d[o + 1] = _half(bf.ebot[k]);
    d[o + 2] = _half(bf.mat[k]);
    d[o + 3] = _half(bf.mask[k]);
  }
  markDirty(i0, i1, j0, j1) {
    i0 = Math.max(0, i0); j0 = Math.max(0, j0); i1 = Math.min(NX - 1, i1); j1 = Math.min(NZ - 1, j1);
    if (i1 < i0 || j1 < j0) return;
    const d = this.dirty;
    if (!d) this.dirty = [i0, i1, j0, j1];
    else { d[0] = Math.min(d[0], i0); d[1] = Math.max(d[1], i1); d[2] = Math.min(d[2], j0); d[3] = Math.max(d[3], j1); }
  }
  markBone(i, j) {
    const d = this.boneDirty;
    if (!d) this.boneDirty = [i, i, j, j];
    else { d[0] = Math.min(d[0], i); d[1] = Math.max(d[1], i); d[2] = Math.min(d[2], j); d[3] = Math.max(d[3], j); }
  }
  markAll() { this.dirty = [0, NX - 1, 0, NZ - 1]; this.boneDirty = [0, NX - 1, 0, NZ - 1]; }
  /** 変わったところだけ GPU に送る（行ごとの範囲）。毎フレーム呼ぶ。 */
  flush() {
    const up = (rect, tex, write) => {
      const [i0, i1, j0, j1] = rect;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) write(j * NX + i);
        tex.addUpdateRange((j * NX + i0) * 4, (i1 - i0 + 1) * 4);
      }
      tex.needsUpdate = true;
    };
    if (this.dirty) { up(this.dirty, this.tDyn, (k) => this.writeDyn(k)); this.dirty = null; }
    if (this.boneDirty) { up(this.boneDirty, this.tBone, (k) => this.writeBone(k)); this.boneDirty = null; }
  }

  // ---------------------------------------------------------------- カーソル（光線と高さ場の交点）
  raycast(ray, out) {
    const o = ray.origin, d = ray.direction;
    if (d.y > -1e-4) return null;
    let t = (0.03 - o.y) / d.y;
    const tEnd = (FLOOR - 0.02 - o.y) / d.y;
    const hor = Math.hypot(d.x, d.z);
    const dt = Math.min(0.5 * this.dx / Math.max(hor, 1e-4), 0.004 / -d.y);
    let prev = t, hit = -1;
    for (let n = 0; n < 2000 && t <= tEnd; n++, t += dt) {
      const x = o.x + d.x * t, z = o.z + d.z * t;
      const hh = Math.abs(x) < this.W / 2 && Math.abs(z) < this.D / 2 ? this.hAt(x, z) : 0;
      if (o.y + d.y * t <= hh) { hit = t; break; }
      prev = t;
    }
    if (hit < 0) return null;
    let a = prev, b = hit;
    for (let n = 0; n < 10; n++) {
      const m = (a + b) / 2, x = o.x + d.x * m, z = o.z + d.z * m;
      const hh = Math.abs(x) < this.W / 2 && Math.abs(z) < this.D / 2 ? this.hAt(x, z) : 0;
      if (o.y + d.y * m <= hh) b = m; else a = m;
    }
    out.set(o.x + d.x * b, 0, o.z + d.z * b);
    return out;
  }

  // ---------------------------------------------------------------- メッシュとシェーダー
  buildMesh() {
    const n = NX * NZ;
    const pos = new Float32Array(n * 3), grid = new Float32Array(n * 2);
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
      const k = j * NX + i;
      pos[k * 3] = this.x(i); pos[k * 3 + 1] = 0; pos[k * 3 + 2] = this.z(j);
      grid[k * 2] = i; grid[k * 2 + 1] = j;
    }
    const idx = new Uint32Array((NX - 1) * (NZ - 1) * 6);
    let p = 0;
    for (let j = 0; j < NZ - 1; j++) for (let i = 0; i < NX - 1; i++) {
      const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
      if ((i + j) & 1) { idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d; }
      else { idx[p++] = a; idx[p++] = c; idx[p++] = d; idx[p++] = a; idx[p++] = d; idx[p++] = b; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0).map((_, q) => (q % 3 === 1 ? 1 : 0)), 3));
    g.setAttribute('grid', new THREE.BufferAttribute(grid, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-this.W / 2, FLOOR - 0.05, -this.D / 2), new THREE.Vector3(this.W / 2, 0.05, this.D / 2));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());

    const st = this.stage;
    const L = this.layers;
    const pad = (arr, len, fill) => { const a = arr.slice(0, len); while (a.length < len) a.push(fill); return a; };
    const uniforms = (this.uniforms = {
      tDyn: { value: this.tDyn },
      tBone: { value: this.tBone },
      tCrust: { value: this.tCrust },
      uCrustT: { value: this.crust?.t || 0 },
      uCrustCol: { value: new THREE.Color(st.crustCol || 0x8a4a28) },
      uTexel: { value: new THREE.Vector2(1 / NX, 1 / NZ) },
      uCell: { value: new THREE.Vector2(this.dx, this.dz) },
      uGridMax: { value: new THREE.Vector2(NX - 1, NZ - 1) },
      uTime: { value: 0 },
      uSeed: { value: this.seed },
      uLayerBot: { value: pad(L.map((l) => l.to), 8, -10) },
      uLayerCol: { value: pad(L.map((l) => new THREE.Color(l.col)), 8, new THREE.Color(0x808080)) },
      uLayerN: { value: L.length },
      uNod: { value: pad(this.nodules.map((nd) => new THREE.Vector4(nd.x, nd.y, nd.z, nd.r)), 16, new THREE.Vector4(0, 10, 0, 0.001)) },
      uNodN: { value: this.nodules.length },
      uNodCol: { value: new THREE.Color(st.noduleCol || 0x6d6a66) },
      uBoneCol: { value: new THREE.Color(st.boneCol) },
      uBoneCol2: { value: new THREE.Color(st.boneCol2) },
      uToothCol: { value: new THREE.Color(st.toothCol || st.boneCol2) },
      uShellCol: { value: new THREE.Color(st.shellCol || st.boneCol) },
      uCarapaceCol: { value: new THREE.Color(st.carapaceCol || 0x2a2a2e) },
      uIrid: { value: st.irid || 0 },
      uDustCol: { value: new THREE.Color(st.dustCol || L[0].col) },
      uCursor: { value: new THREE.Vector4(0, 0, 0, 0.05) },
      uCursorCol: { value: new THREE.Color(0x66e0ff) },
      uCursorOn: { value: 0 },
      uScan: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCrackScale: { value: 1 / Math.max(0.012, this.dx * 4.5) },
      uHolo: { value: 0 },
    });
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, envMapIntensity: 0.45 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <beginnormal_vertex>', VERT_NORMAL)
        .replace('#include <begin_vertex>', VERT_BEGIN);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <emissivemap_fragment>', `${FRAG_MAIN}\n#include <emissivemap_fragment>`)
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= sAO; reflectedLight.indirectSpecular *= sAO; reflectedLight.directDiffuse *= mix(1.0, sAO, 0.55);`);
    };
    mat.customProgramCacheKey = () => 'slab-v1';
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <begin_vertex>', VERT_BEGIN);
    };
    depth.customProgramCacheKey = () => 'slab-depth-v1';
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'slab';
    mesh.customDepthMaterial = depth;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return mesh;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.customDepthMaterial.dispose();
    this.tDyn.dispose();
    this.tBone.dispose();
    this.tCrust.dispose();
  }
}

// ---------------------------------------------------------------- GLSL
const VERT_PARS = /* glsl */ `
attribute vec2 grid;
uniform sampler2D tDyn;
uniform vec2 uTexel;
uniform vec2 uCell;
uniform vec2 uGridMax;
varying vec2 vTexUv;
varying vec3 vWPos;
float hAtGrid(vec2 g) { return texelFetch(tDyn, ivec2(clamp(g, vec2(0.0), uGridMax)), 0).r; }
`;
const VERT_NORMAL = /* glsl */ `
float nhl = hAtGrid(grid - vec2(1.0, 0.0)), nhr = hAtGrid(grid + vec2(1.0, 0.0));
float nhd = hAtGrid(grid - vec2(0.0, 1.0)), nhu = hAtGrid(grid + vec2(0.0, 1.0));
vec3 objectNormal = normalize(vec3((nhl - nhr) / (2.0 * uCell.x), 1.0, (nhd - nhu) / (2.0 * uCell.y)));
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( tangent.xyz );
#endif
`;
const VERT_BEGIN = /* glsl */ `
vec3 transformed = vec3(position);
transformed.y = hAtGrid(grid);
vTexUv = (grid + 0.5) * uTexel;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D tDyn;
uniform sampler2D tBone;
uniform sampler2D tCrust;
uniform float uCrustT;
uniform vec3 uCrustCol;
uniform vec2 uTexel;
uniform vec2 uCell;
uniform float uTime;
uniform float uSeed;
uniform float uLayerBot[8];
uniform vec3 uLayerCol[8];
uniform int uLayerN;
uniform vec4 uNod[16];
uniform int uNodN;
uniform vec3 uNodCol;
uniform vec3 uBoneCol, uBoneCol2, uToothCol, uShellCol, uCarapaceCol;
uniform float uIrid;
uniform vec3 uDustCol;
uniform vec4 uCursor;
uniform vec3 uCursorCol;
uniform float uCursorOn;
uniform vec4 uScan;
uniform float uCrackScale;
uniform float uHolo;
varying vec2 vTexUv;
varying vec3 vWPos;

${NOISE_GLSL}
${BONE_GLSL}
float warpY(vec2 xz) {
  return 0.012 * sin(xz.x * 2.3 + xz.y * 1.1 + uSeed) + 0.008 * sin(xz.x * 5.7 - xz.y * 3.9 + uSeed * 2.0) + 0.004 * sin(xz.x * 13.1 + xz.y * 7.3 + uSeed * 3.0);
}
vec3 sedimentColor(vec3 p, float flatness, float pxw) {
  float lc = p.y + warpY(p.xz) * clamp(-p.y / 0.06, 0.0, 1.0);
  vec3 col = uLayerCol[0];
  for (int k = 1; k < 8; k++) {
    if (k >= uLayerN) break;
    float t = smoothstep(uLayerBot[k - 1] + 0.0025, uLayerBot[k - 1] - 0.0025, lc);
    col = mix(col, uLayerCol[k], t);
  }
  // 縞（細かい層理）とまだら
  // 平らな面では縞を弱く（ゆるい起伏と交わって、まだらの模様になるので）
  float lamK = 1.0 - 0.85 * smoothstep(0.8, 0.97, flatness);
  float lam = 0.5 + 0.5 * sin(lc * 610.0 + vn2(p.xz * 14.0) * 4.0);
  float lam2 = 0.5 + 0.5 * sin(lc * 170.0 + vn2(p.xz * 5.0) * 3.0);
  col *= 1.0 + (0.06 * lam + 0.05 * lam2 - 0.055) * lamK;
  vec3 mq = p * vec3(14.0, 22.0, 14.0) + uSeed;
  col *= 0.93 + 0.14 * (0.6 * vn3(mq) + 0.4 * vn3(mq * 2.7));
  // 砂粒と小石（遠くでは消す）
  float gk = 1.0 - smoothstep(0.0012, 0.004, pxw);
  float grain = gk > 0.0 ? mix(0.5, vn3(p * 420.0), gk) : 0.5;
  col *= 0.9 + 0.2 * grain;
  // 小石：1 つのノイズの山（暗い石）と谷（明るい石）
  float pn = vn3(p * 130.0 + 3.0);
  col = mix(col, col * vec3(0.72, 0.7, 0.68) + vec3(0.05), smoothstep(0.8, 0.84, pn) * 0.6);
  col = mix(col, col * 1.12 + vec3(0.03), smoothstep(0.19, 0.16, pn) * 0.5);
  return col;
}
float noduleAt(vec3 p) {
  float best = 0.0;
  for (int k = 0; k < 16; k++) {
    if (k >= uNodN) break;
    vec4 n = uNod[k];
    vec3 d = (p - n.xyz) / vec3(n.w, n.w * 0.6, n.w);
    float q = dot(d, d);
    best = max(best, smoothstep(1.02, 0.96, q));
  }
  return best;
}
`;

const FRAG_MAIN = /* glsl */ `
// ---- 高さ場から法線・くぼみ
vec4 dyn = texture2D(tDyn, vTexUv);
float hC = dyn.r;
float hL = texture2D(tDyn, vTexUv - vec2(uTexel.x, 0.0)).r;
float hR = texture2D(tDyn, vTexUv + vec2(uTexel.x, 0.0)).r;
float hD = texture2D(tDyn, vTexUv - vec2(0.0, uTexel.y)).r;
float hU = texture2D(tDyn, vTexUv + vec2(0.0, uTexel.y)).r;
vec3 nW = normalize(vec3((hL - hR) / (2.0 * uCell.x), 1.0, (hD - hU) / (2.0 * uCell.y)));
float avg = 0.0;
for (int k = 0; k < 4; k++) {
  float a = float(k) * 1.5707963 + 0.4;
  vec2 dir = vec2(cos(a), sin(a));
  avg += texture2D(tDyn, vTexUv + dir * uTexel * 3.5).r;
  avg += texture2D(tDyn, vTexUv + vec2(-dir.y, dir.x) * uTexel * 9.0).r * 0.8;
}
avg /= 4.0 * 1.8;
// 画素の大きさ（細かい模様を遠くで消すため。分岐の外で求める）
float pxw = max(fwidth(vWPos.x), fwidth(vWPos.z));
float cav = clamp((avg - hC) / (uCell.x * 7.0), 0.0, 1.0);
float vex = clamp((hC - avg) / (uCell.x * 7.0), 0.0, 1.0);
float sAO = 1.0 - cav * 0.62;
vec3 P = vWPos;

// ---- 化石か、堆積物か
vec4 bone = texture2D(tBone, vTexUv);
float boneW = smoothstep(0.35, 0.65, bone.a) * smoothstep(bone.r + 0.0032, bone.r + 0.0006, P.y) * smoothstep(bone.g - 0.004, bone.g, P.y);
float nod = noduleAt(P);
vec3 sed = sedimentColor(P, nW.y, pxw);
if (nod > 0.0) sed = mix(sed, uNodCol * (0.82 + 0.3 * fbm3(P * 60.0)), nod);
float rough = mix(0.93, 0.8, nod);

// 骨のまわりの固い皮：鉄さびのような色
float crustV = texture2D(tCrust, vTexUv).r;
float inCrust = crustV * smoothstep(bone.r + uCrustT + 0.002, bone.r + uCrustT * 0.6, P.y) * smoothstep(0.0, 0.3, bone.a + 0.15);
if (inCrust > 0.001) {
  sed = mix(sed, uCrustCol * (0.75 + 0.4 * vn3(P * 140.0)), smoothstep(0.35, 0.7, inCrust) * 0.85);
  rough = mix(rough, 0.97, inCrust);
}

// 掘りたては湿って暗い
float fresh = exp(-max(0.0, uTime - dyn.a) / 9.0);
sed *= 1.0 - 0.2 * fresh;
rough -= 0.3 * fresh;

// 骨の色（材質・ヒビ・欠け）
vec3 vV = normalize(vViewPosition);
vec3 nV = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
float brough = 0.5, crack = 0.0;
vec3 bcol = vec3(0.0);
if (boneW > 0.002) {
  bcol = boneShade(P, bone.b, dyn.g, clamp(dot(nV, vV), 0.0, 1.0), pxw, brough, crack);
  // 骨の縁は少し暗く（土がしみている）
  bcol *= 0.82 + 0.18 * smoothstep(0.5, 0.95, bone.a);
}

vec3 col = mix(sed, bcol, boneW);
rough = mix(rough, brough + 0.25 * crack, boneW);

// ホコリ
float dust = clamp(dyn.b, 0.0, 1.0);
float dustN = vn2(P.xz * 90.0);
float dustA = smoothstep(0.0, 1.0, dust) * (0.75 + 0.25 * dustN);
col = mix(col, mix(col, uDustCol, 0.75) * (0.94 + 0.12 * dustN), dustA * 0.8);
rough = mix(rough, 1.0, dustA);

// くぼみは暗く、出っ張りの角は少し明るく
col *= 1.0 - cav * 0.35;
col *= 1.0 + vex * 0.12;
// 細かい凹凸（法線のゆらぎ）
float bumpS = mix(0.12, 0.05, boneW) * (1.0 - dustA * 0.6);
bumpS *= 1.0 - smoothstep(0.0015, 0.005, pxw);
if (bumpS > 0.001) {
  vec2 bq = (P.xz + P.y * 0.7) * mix(260.0, 140.0, boneW);
  float b0 = vn2(bq), bx = vn2(bq + vec2(0.3, 0.0)), bz = vn2(bq + vec2(0.0, 0.3));
  nW = normalize(nW + vec3(b0 - bx, 0.0, b0 - bz) * bumpS * 3.0);
}

diffuseColor.rgb = col;
roughnessFactor = clamp(rough, 0.05, 1.0);
normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);

// ---- スキャン（化石の影をホログラムで見せる）とカーソル
vec3 glow = vec3(0.0);
float covered = smoothstep(bone.r + 0.002, bone.r + 0.006, P.y);
if (uScan.w > 0.001) {
  float ds = length(P.xz - uScan.xy);
  float front = uScan.z;
  float band = exp(-pow((ds - front) / 0.025, 2.0));
  float behind = step(ds, front);
  float edge = clamp(fwidth(bone.a) * 3.0, 0.0, 1.0);
  float sLines = 0.5 + 0.5 * sin((P.x + P.z) * 260.0);
  float holo = smoothstep(0.3, 0.7, bone.a) * covered * behind;
  vec3 cyan = vec3(0.25, 0.85, 1.0);
  glow += cyan * band * 0.9 * uScan.w;
  glow += cyan * holo * (0.18 + 0.32 * sLines + edge * 1.6) * uScan.w;
  float nodEdge = nod * (1.0 - nod) * 4.0;
  glow += vec3(1.0, 0.55, 0.15) * nodEdge * behind * 0.5 * uScan.w;
}
if (uCursorOn > 0.001) {
  float dc = length(P.xz - uCursor.xz);
  float fw = max(fwidth(dc), 1e-4) * 1.6;
  float ring = 1.0 - smoothstep(fw * 0.5, fw * 1.5, abs(dc - uCursor.w));
  float dot0 = 1.0 - smoothstep(fw * 1.2, fw * 2.4, dc);
  float fill = (1.0 - smoothstep(uCursor.w - fw, uCursor.w, dc)) * 0.08;
  glow += uCursorCol * (ring * 0.9 + dot0 * 0.8 + fill) * uCursorOn;
}
totalEmissiveRadiance += glow;
`;
