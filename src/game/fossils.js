// 化石の形。スラブのグリッドに「骨の上面 top・下面 bot・材質 mat・もろさ tol・部位 piece」を書き込む。
// 形はすべて手続き的な部品（カプセル・楕円体・巻き貝の渦）の組み合わせ。座標はスラブ中心からのメートル、
// x は右、z は手前（カメラ側）。高さ y は地表 0 から下がマイナス。
//
//   const bf = new BoneField(nx, nz, W, D);
//   FOSSILS.ammonite.build(bf, rng);   bf.finish();
//
// mat：0 = 骨、0.25 = 皮・うろこの跡（炭化した膜）、0.5 = 歯・爪（エナメル）、0.75 = 甲殻（三葉虫）、1 = 殻（アンモライトの遊色）
// tol：そのセルの「もろさ」の倍率（1 が標準、小さいほど割れやすい：トゲ・肋骨・ヒレ）

export const MAT = { bone: 0, skin: 0.25, tooth: 0.5, shell: 1, carapace: 0.75 };

export class BoneField {
  constructor(nx, nz, W, D) {
    Object.assign(this, { nx, nz, W, D });
    this.dx = W / (nx - 1);
    this.dz = D / (nz - 1);
    const n = nx * nz;
    this.top = new Float32Array(n).fill(-9);
    this.bot = new Float32Array(n).fill(9);
    this.mat = new Float32Array(n);
    this.tol = new Float32Array(n).fill(1);
    this.piece = new Int16Array(n).fill(-1);
    this.mask = new Uint8Array(n);
    this.pieces = [];     // { name, cells }
    this._piece = -1;
    this.S = 1;           // capsule / ellipse / chain / hole の座標と大きさの倍率（大きな化石を縮めるとき）
  }

  x(i) { return (i / (this.nx - 1) - 0.5) * this.W; }
  z(j) { return (j / (this.nz - 1) - 0.5) * this.D; }
  i(x) { return (x / this.W + 0.5) * (this.nx - 1); }
  j(z) { return (z / this.D + 0.5) * (this.nz - 1); }

  /** 部位の名前を決める（結果画面の「頭骨」「肋骨」などに使う）。以後の部品はこの部位になる。
   *  extra：おまけ（小さな貝・かけら）。集計にも取り出しにも入れず、地層に残る */
  part(name, { extra = false } = {}) {
    let k = this.pieces.findIndex((p) => p.name === name);
    if (k < 0) { k = this.pieces.length; this.pieces.push({ name, cells: 0, extra }); }
    this._piece = k;
    return this;
  }

  /** 範囲 [x0,x1]×[z0,z1] の各セルで fn(x, z) を呼び、{ cy, ht, under?, mat?, tol? } が返れば書き込む。 */
  stamp(x0, z0, x1, z1, fn, { mat = 0, tol = 1 } = {}) {
    const i0 = Math.max(0, Math.floor(this.i(Math.min(x0, x1)))), i1 = Math.min(this.nx - 1, Math.ceil(this.i(Math.max(x0, x1))));
    const j0 = Math.max(0, Math.floor(this.j(Math.min(z0, z1)))), j1 = Math.min(this.nz - 1, Math.ceil(this.j(Math.max(z0, z1))));
    for (let j = j0; j <= j1; j++) {
      const z = this.z(j);
      for (let i = i0; i <= i1; i++) {
        const r = fn(this.x(i), z);
        if (!r || !(r.ht > 0)) continue;
        const k = j * this.nx + i;
        const t = r.cy + r.ht, b = r.cy - r.ht * (r.under ?? 0.9);
        if (t > this.top[k]) {
          this.top[k] = t;
          this.mat[k] = r.mat ?? mat;
          this.tol[k] = r.tol ?? tol;
          this.piece[k] = this._piece;
        }
        if (b < this.bot[k]) this.bot[k] = b;
      }
    }
  }

  /** 先細りのカプセル（a→b、半径 ra→rb）。flat で上下につぶす。 */
  capsule(ax, az, bx, bz, ra, rb, cy, o = {}) {
    const S = this.S; ax *= S; az *= S; bx *= S; bz *= S; ra *= S; rb *= S;
    const flat = o.flat ?? 0.8;
    const pad = Math.max(ra, rb);
    const vx = bx - ax, vz = bz - az, L2 = vx * vx + vz * vz || 1e-9;
    this.stamp(Math.min(ax, bx) - pad, Math.min(az, bz) - pad, Math.max(ax, bx) + pad, Math.max(az, bz) + pad, (x, z) => {
      let t = ((x - ax) * vx + (z - az) * vz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t - x, pz = az + vz * t - z;
      const r = ra + (rb - ra) * t;
      const d2 = px * px + pz * pz;
      if (d2 >= r * r) return null;
      return { cy, ht: Math.sqrt(r * r - d2) * flat };
    }, o);
  }

  /** 楕円のドーム（中心 c、半径 rx, rz、回転 rot、高さ ht）。pow < 1 で上が平たく。 */
  ellipse(cx, cz, rx, rz, ht, cy, o = {}) {
    const S = this.S; cx *= S; cz *= S; rx *= S; rz *= S; ht *= S;
    const rot = o.rot || 0, c = Math.cos(rot), s = Math.sin(rot), pw = o.pow ?? 0.5;
    const R = Math.max(rx, rz);
    this.stamp(cx - R, cz - R, cx + R, cz + R, (x, z) => {
      const lx = (x - cx) * c + (z - cz) * s, lz = -(x - cx) * s + (z - cz) * c;
      if (o.half === 'front' && lz > 0) return null;
      if (o.half === 'back' && lz < 0) return null;
      const q = (lx * lx) / (rx * rx) + (lz * lz) / (rz * rz);
      if (q >= 1) return null;
      return { cy, ht: ht * Math.pow(1 - q, pw) };
    }, o);
  }

  /** 点列をつなぐ骨（背骨・肋骨・尾など）。pts は [x, z, r] の並び。 */
  chain(pts, cy, o = {}) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az, ra] = pts[k], [bx, bz, rb] = pts[k + 1];
      this.capsule(ax, az, bx, bz, ra, rb, cy, o);
    }
  }

  /** 穴（頭骨の窓など）：楕円の中の骨を消す。 */
  hole(cx, cz, rx, rz, rot = 0) {
    const S = this.S; cx *= S; cz *= S; rx *= S; rz *= S;
    const c = Math.cos(rot), s = Math.sin(rot), R = Math.max(rx, rz);
    const i0 = Math.max(0, Math.floor(this.i(cx - R))), i1 = Math.min(this.nx - 1, Math.ceil(this.i(cx + R)));
    const j0 = Math.max(0, Math.floor(this.j(cz - R))), j1 = Math.min(this.nz - 1, Math.ceil(this.j(cz + R)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = this.x(i) - cx, z = this.z(j) - cz;
      const lx = x * c + z * s, lz = -x * s + z * c;
      if ((lx * lx) / (rx * rx) + (lz * lz) / (rz * rz) < 1) {
        const k = j * this.nx + i;
        this.top[k] = -9; this.bot[k] = 9; this.piece[k] = -1;
      }
    }
  }

  /** 書き終わり：mask を決め、骨の外側 3 セルに上面・下面を延ばす（シェーダーで縁を補間するため）、距離場を作る。 */
  finish() {
    const { nx, nz, top, bot, mask } = this;
    let cells = 0;
    for (let k = 0; k < top.length; k++) {
      if (top[k] - bot[k] > 0.0015) { mask[k] = 1; cells++; if (this.piece[k] >= 0) this.pieces[this.piece[k]].cells++; }
      else { top[k] = -9; bot[k] = 9; this.piece[k] = -1; }
    }
    // おまけのセル
    this.extra = new Uint8Array(top.length);
    for (let k = 0; k < top.length; k++) if (mask[k] && this.piece[k] >= 0 && this.pieces[this.piece[k]].extra) { this.extra[k] = 1; cells--; }
    this.cells = cells;
    // 縁の外側：近くの骨の中央の高さで埋める
    const mid = new Float32Array(top.length);
    for (let k = 0; k < top.length; k++) mid[k] = mask[k] ? (top[k] + bot[k]) / 2 : NaN;
    this.etop = Float32Array.from(top);
    this.ebot = Float32Array.from(bot);
    for (let pass = 0; pass < 3; pass++) {
      const next = Float32Array.from(mid);
      for (let j = 1; j < nz - 1; j++) for (let i = 1; i < nx - 1; i++) {
        const k = j * nx + i;
        if (!Number.isNaN(mid[k])) continue;
        let s = 0, c = 0;
        for (const o of [-1, 1, -nx, nx]) if (!Number.isNaN(mid[k + o])) { s += mid[k + o]; c++; }
        if (c) next[k] = s / c;
      }
      mid.set(next);
    }
    for (let k = 0; k < top.length; k++) if (!mask[k]) {
      const m = Number.isNaN(mid[k]) ? -9 : mid[k];
      this.etop[k] = m; this.ebot[k] = m;
    }
    // 2D の距離場（いちばん近い骨のセルまでのメートル）と、そのセル（nearest）。chamfer で近似
    const INF = 1e9, dist = new Float32Array(top.length).fill(INF), nearest = new Int32Array(top.length).fill(-1);
    for (let k = 0; k < top.length; k++) if (mask[k]) { dist[k] = 0; nearest[k] = k; }
    const d1 = this.dx, d2 = Math.hypot(this.dx, this.dz);
    const relax = (k, nb, d) => { const v = dist[nb] + d; if (v < dist[k]) { dist[k] = v; nearest[k] = nearest[nb]; } };
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i > 0) relax(k, k - 1, d1);
      if (j > 0) { relax(k, k - nx, d1); if (i > 0) relax(k, k - nx - 1, d2); if (i < nx - 1) relax(k, k - nx + 1, d2); }
    }
    for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (i < nx - 1) relax(k, k + 1, d1);
      if (j < nz - 1) { relax(k, k + nx, d1); if (i < nx - 1) relax(k, k + nx + 1, d2); if (i > 0) relax(k, k + nx - 1, d2); }
    }
    this.nearest = nearest;
    this.dist = dist;
    // 骨のセルの一覧（集計を速くする）。list は本体だけ（おまけを除く）
    this.list = new Int32Array(cells);
    let n = 0;
    for (let k = 0; k < top.length; k++) if (mask[k] && !this.extra[k]) this.list[n++] = k;
    // 外接矩形
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const k of this.list) { const i = k % nx, j = (k / nx) | 0; x0 = Math.min(x0, this.x(i)); x1 = Math.max(x1, this.x(i)); z0 = Math.min(z0, this.z(j)); z1 = Math.max(z1, this.z(j)); }
    this.bounds = { x0, x1, z0, z1 };
    return this;
  }
}

// ---------------------------------------------------------------- 曲線の道具
const lerp = (a, b, t) => a + (b - a) * t;
/** 2 次ベジェ上の点。 */
function bez(p0, p1, p2, t) {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
}
/** 3 次ベジェ上の点と接線。 */
function bez3(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
  const z = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
  const dx = 3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]);
  const dz = 3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]);
  const l = Math.hypot(dx, dz) || 1;
  return { x, z, tx: dx / l, tz: dz / l };
}

// ---------------------------------------------------------------- 化石
// size：スラブの大きさ [W, D]（m）。cy：骨の中心の深さ。
export const FOSSILS = {
  // アンモナイト：平らに巻いた殻（進化的な巻き方で、内側の巻きも見える）。肋（リブ）が並ぶ
  ammonite: {
    size: [1.5, 1.05],
    build(bf, rng) {
      const R = 0.25, g = 2.05, lg = Math.log(g), cy = -0.17, apAngle = rng.range(0, Math.PI * 2);
      const cx = rng.range(-0.12, 0.12), cz = rng.range(-0.06, 0.06);
      const ribs = 34;
      bf.part('shell');
      bf.stamp(cx - R, cz - R, cx + R, cz + R, (x, z) => {
        const dx = x - cx, dz = z - cz, r = Math.hypot(dx, dz);
        if (r > R || r < 0.004) return r < 0.004 ? { cy, ht: 0.006 } : null;
        const th = Math.atan2(dz, dx);
        let phi = th - apAngle; // 口（殻口）から後ろへ測った角度（-2π, 0]
        phi = ((phi % (Math.PI * 2)) - Math.PI * 2) % (Math.PI * 2);
        const w = phi / (Math.PI * 2) - Math.log(r / R) / lg;
        if (w < 0) return null;
        const k = Math.floor(w), q = w - k;          // q：巻きの外縁 0 → 内縁 1
        const rk = R * Math.pow(g, phi / (Math.PI * 2) - k);
        const width = rk * (1 - 1 / g);
        let ht = width * 0.48 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, q))), 0.55);
        // 肋：角度に沿って並ぶ。外縁でわずかに前へ曲がる
        const bend = 0.18 * Math.sin(Math.PI * q) + 0.12 * (1 - q);
        const rib = Math.pow(0.5 + 0.5 * Math.cos((th + bend) * ribs), 2.5);
        ht *= 0.82 + 0.26 * rib * (0.4 + 0.6 * Math.sin(Math.PI * q));
        // 巻きと巻きの境目（縫合）は少しくぼむ
        if (k > 3) ht *= 0.7;
        return { cy, ht: Math.max(0, ht) + 0.004, under: 0.95 };
      }, { mat: MAT.shell, tol: 1.15 });
      // 周りに小さな二枚貝をいくつか
      bf.part('clam', { extra: true });
      for (let n = 0; n < 4; n++) {
        const a = rng.range(0, Math.PI * 2), d = rng.range(R + 0.08, R + 0.22);
        const x = cx + Math.cos(a) * d * 1.3, z = cz + Math.sin(a) * d * 0.8;
        if (Math.abs(x) > 0.65 || Math.abs(z) > 0.42) continue;
        const s = rng.range(0.025, 0.04), rot = rng.range(0, Math.PI);
        bf.stamp(x - s, z - s, x + s, z + s, (px, pz) => {
          const lx = (px - x) * Math.cos(rot) + (pz - z) * Math.sin(rot), lz = -(px - x) * Math.sin(rot) + (pz - z) * Math.cos(rot);
          const q = (lx * lx) / (s * s) + (lz * lz) / (s * s * 0.75);
          if (q >= 1) return null;
          const a2 = Math.atan2(lz + s * 0.9, lx);
          const ribv = 0.85 + 0.15 * Math.cos(a2 * 22);
          return { cy: cy + 0.02, ht: 0.011 * Math.sqrt(1 - q) * ribv };
        }, { mat: MAT.shell, tol: 0.8 });
      }
    },
  },

  // 三葉虫：頭（頭鞍・目・頬のトゲ）、胸の節、尾。トゲはもろい
  trilobite: {
    size: [1.35, 1.05],
    build(bf, rng) {
      const cy = -0.16, ox = rng.range(-0.1, 0.1), oz = rng.range(-0.05, 0.05), S = 1.15;
      const P = (x, z) => [ox + x * S, oz + z * S];
      const mat = MAT.carapace;
      bf.part('head');
      // 頭の盾（前半分の楕円）
      { const [x, z] = P(0, -0.12); bf.ellipse(x, z, 0.16 * S, 0.1 * S, 0.026, cy, { mat, half: 'front', pow: 0.6 }); }
      { const [x, z] = P(0, -0.12); bf.ellipse(x, z, 0.16 * S, 0.035 * S, 0.026, cy, { mat, half: 'back', pow: 0.6 }); }
      // 頭のふち（盛り上がった縁）
      for (let a = 0; a <= 16; a++) {
        const t0 = Math.PI + (a / 16) * Math.PI, t1 = Math.PI + ((a + 1) / 16) * Math.PI;
        if (a === 16) break;
        const [x0, z0] = P(Math.cos(t0) * 0.155, -0.12 + Math.sin(t0) * 0.095);
        const [x1, z1] = P(Math.cos(t1) * 0.155, -0.12 + Math.sin(t1) * 0.095);
        bf.capsule(x0, z0, x1, z1, 0.009 * S, 0.009 * S, cy + 0.012, { mat, flat: 0.9 });
      }
      // 頭鞍（真ん中のふくらみ）と溝
      { const [x, z] = P(0, -0.145); bf.ellipse(x, z, 0.042 * S, 0.068 * S, 0.034, cy + 0.008, { mat, pow: 0.7 }); }
      // 目（三日月のふくらみ）
      bf.part('eyes');
      for (const s of [-1, 1]) {
        const [x, z] = P(0.078 * s, -0.135);
        bf.ellipse(x, z, 0.022 * S, 0.034 * S, 0.036, cy + 0.006, { mat: MAT.tooth, rot: s * 0.35, pow: 0.6 });
      }
      // 頬のトゲ（もろい）
      bf.part('spines');
      for (const s of [-1, 1]) {
        const a = P(0.15 * s, -0.11), b = P(0.19 * s, -0.02), c = P(0.165 * s, 0.09);
        bf.chain([[a[0], a[1], 0.014 * S], [b[0], b[1], 0.009 * S], [c[0], c[1], 0.0035 * S]], cy + 0.004, { mat, tol: 0.45, flat: 0.85 });
      }
      // 胸の節
      bf.part('thorax');
      const segs = 11;
      for (let n = 0; n < segs; n++) {
        const z = -0.075 + n * 0.0155;
        const taper = 1 - n * 0.035;
        const [ax, az] = P(0, z);
        // 中軸の輪
        bf.capsule(ax - 0.034 * S * taper, az, ax + 0.034 * S * taper, az, 0.0085 * S, 0.0085 * S, cy + 0.016, { mat, flat: 0.95 });
        for (const s of [-1, 1]) {
          const [bx, bz] = P(0.045 * s * taper, z);
          const [cx, cz] = P(0.135 * s * taper, z + 0.012);
          const [dx, dz] = P(0.155 * s * taper, z + 0.03);
          bf.chain([[bx, bz, 0.0075 * S], [cx, cz, 0.0068 * S], [dx, dz, 0.003 * S]], cy + 0.008, { mat, tol: n > 8 ? 0.7 : 0.9, flat: 0.9 });
        }
      }
      // 胸の下地（節のすき間を埋める薄い板）
      { const [x, z] = P(0, 0.005); bf.ellipse(x, z, 0.13 * S, 0.1 * S, 0.012, cy + 0.006, { mat, pow: 0.4 }); }
      // 尾
      bf.part('tail');
      { const [x, z] = P(0, 0.11); bf.ellipse(x, z, 0.085 * S, 0.055 * S, 0.02, cy + 0.006, { mat, half: 'back', pow: 0.6 }); }
      for (let n = 0; n < 4; n++) {
        const [x, z] = P(0, 0.112 + n * 0.012);
        const w = 0.06 * (1 - n * 0.2);
        bf.capsule(x - w * S, z, x + w * S, z, 0.005 * S, 0.005 * S, cy + 0.016, { mat });
      }
      // 小さな三葉虫の殻のかけら
      bf.part('fragments', { extra: true });
      for (let n = 0; n < 3; n++) {
        const [x, z] = [rng.range(-0.55, 0.55), rng.range(-0.4, 0.4)];
        if (Math.hypot(x - ox, z - oz) < 0.32) continue;
        bf.ellipse(x, z, 0.03, 0.022, 0.01, cy + 0.02, { mat, rot: rng.range(0, 3), pow: 0.6, tol: 0.7 });
      }
    },
  },

  // 魚：頭骨・背骨・肋骨・ヒレ。体の輪郭はうろこの薄い跡。肋骨とヒレの条はもろい
  fish: {
    size: [1.7, 1.15],
    build(bf, rng) {
      const cy = -0.15, ox = rng.range(-0.06, 0.06), oz = rng.range(-0.04, 0.04);
      const len = 0.78, bodyH = 0.2;
      const spineZ = (t) => oz - 0.014 * Math.sin(t * Math.PI) + 0.022 * t * t; // 背骨のわずかな曲がり
      const X = (t) => ox - len / 2 + t * len;
      const prof = (t) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.02) / 0.86))), 0.8); // 体の高さの割合
      // うろこの跡（体の輪郭。炭化した薄い膜で、骨より低い）
      bf.part('scales');
      bf.stamp(X(0) - 0.02, oz - bodyH, X(0.9), oz + bodyH, (x, z) => {
        const t = (x - X(0)) / len;
        if (t < 0.12 || t > 0.86) return null;
        const half = bodyH * prof(t) * 0.92;
        const dz = z - spineZ(t);
        if (Math.abs(dz) > half) return null;
        const q = Math.abs(dz) / half;
        // うろこ：ずらした格子の丸いふくらみ（4 cm ほど）
        const u = x * 26, v = z * 26 + (Math.floor(x * 26) % 2) * 0.5;
        const fu = u - Math.floor(u) - 0.5, fv = v - Math.floor(v) - 0.5;
        const sc = 0.7 + 0.3 * Math.max(0, 1 - (fu * fu + fv * fv) * 3.2);
        return { cy: cy - 0.004, ht: 0.006 * Math.sqrt(1 - q * q) * sc, under: 0.5 };
      }, { tol: 0.8, mat: MAT.skin });
      // 頭骨
      bf.part('skull');
      bf.ellipse(X(0.075), spineZ(0.07), 0.095, 0.1, 0.034, cy, { pow: 0.55, rot: 0.1 });
      bf.ellipse(X(0.02), spineZ(0.03) + 0.035, 0.055, 0.026, 0.02, cy + 0.006, { rot: -0.5 }); // あご
      bf.capsule(X(0.14), spineZ(0.14) - 0.085, X(0.16), spineZ(0.16) + 0.095, 0.011, 0.008, cy + 0.012); // えらぶた
      bf.hole(X(0.06), spineZ(0.06) - 0.026, 0.022, 0.022); // 目のくぼみ
      bf.ellipse(X(0.06), spineZ(0.06) - 0.026, 0.014, 0.014, 0.014, cy + 0.006, { mat: MAT.tooth });
      // 背骨（椎体を並べる）
      bf.part('spine');
      const nv = 20;
      for (let n = 0; n < nv; n++) {
        const t = 0.18 + (n / (nv - 1)) * 0.66;
        const s = 1 - 0.35 * (n / nv);
        bf.ellipse(X(t), spineZ(t), 0.015 * s, 0.011 * s, 0.014 * s, cy + 0.008, { pow: 0.6 });
      }
      // 肋骨と神経棘（もろい）
      bf.part('ribs');
      for (let n = 0; n < nv; n++) {
        const t = 0.19 + (n / (nv - 1)) * 0.64;
        const h = bodyH * prof(t);
        const x = X(t), z = spineZ(t);
        const sweep = 0.04 + 0.025 * t;
        const r0 = 0.0062 * (1 - 0.3 * (n / nv));
        // 下へ（肋骨・血道棘）
        bf.chain([[x, z, r0], [x + sweep * 0.4, z + h * 0.45, r0 * 0.85], [x + sweep, z + h * 0.86, r0 * 0.45]], cy + 0.006, { tol: 0.6, flat: 0.8 });
        // 上へ（神経棘）
        bf.chain([[x, z, r0 * 0.9], [x + sweep * 0.5, z - h * 0.5, r0 * 0.75], [x + sweep, z - h * 0.84, r0 * 0.4]], cy + 0.006, { tol: 0.6, flat: 0.8 });
      }
      // ヒレ（条）
      bf.part('fins');
      const fan = (bx, bz, ang0, ang1, L, n, r = 0.0045) => {
        for (let k = 0; k < n; k++) {
          const a = lerp(ang0, ang1, k / (n - 1));
          const l = L * (0.75 + 0.25 * Math.sin(Math.PI * k / (n - 1)));
          const ex = bx + Math.cos(a) * l, ez = bz + Math.sin(a) * l;
          const m = [bx + Math.cos(a) * l * 0.5, bz + Math.sin(a) * l * 0.5];
          bf.chain([[bx, bz, r * 1.3], [m[0], m[1], r], [ex, ez, r * 0.55]], cy + 0.004, { tol: 0.5, flat: 0.8 });
        }
      };
      fan(X(0.88), spineZ(0.88), -0.75, 0.75, 0.16, 9);            // 尾ビレ
      fan(X(0.52), spineZ(0.52) - bodyH * 0.85, -2.3, -1.1, 0.085, 6); // 背ビレ
      fan(X(0.66), spineZ(0.66) + bodyH * 0.7, 1.2, 2.2, 0.075, 5);   // しりビレ
      fan(X(0.21), spineZ(0.21) + 0.06, 0.6, 1.5, 0.085, 4);           // 胸ビレ
      fan(X(0.45), spineZ(0.45) + bodyH * 0.8, 1.0, 1.9, 0.055, 4);   // 腹ビレ
    },
  },

  // ティラノサウルスの頭骨（横向き）：上あご・下あご・窓（穴）・歯。歯はもろい
  trex: {
    size: [2.1, 1.45],
    build(bf, rng) {
      const cy = -0.18, ox = rng.range(-0.08, 0.08) + 0.05, oz = rng.range(-0.04, 0.04) - 0.04;
      const P = (x, z) => [ox + x, oz + z];
      bf.part('skull');
      // 上あごの輪郭：吻（先）から後頭部へ、楕円を重ねる
      const skull = [
        [-0.5, 0.02, 0.07, 0.065, 0.035, -0.15],
        [-0.38, 0.0, 0.1, 0.085, 0.04, -0.12],
        [-0.22, -0.03, 0.12, 0.11, 0.045, -0.1],
        [-0.05, -0.06, 0.12, 0.14, 0.05, 0],
        [0.1, -0.06, 0.12, 0.16, 0.052, 0.1],
        [0.22, -0.03, 0.08, 0.15, 0.048, 0.2],
      ];
      for (const [x, z, rx, rz, h, rot] of skull) { const [px, pz] = P(x, z); bf.ellipse(px, pz, rx, rz, h, cy, { rot, pow: 0.45 }); }
      // 上あごのふち（歯の並ぶ線）
      bf.chain([P(-0.56, 0.06), P(-0.4, 0.08), P(-0.2, 0.08), P(0.0, 0.065), P(0.12, 0.05)].map(([x, z]) => [x, z, 0.022]), cy + 0.012, { flat: 0.8 });
      // 目の上の角・頬
      { const [x, z] = P(0.03, -0.17); bf.ellipse(x, z, 0.04, 0.025, 0.03, cy + 0.02, { rot: -0.3 }); }
      // 窓（穴）
      { const [x, z] = P(-0.2, -0.02); bf.hole(x, z, 0.1, 0.045, -0.12); }  // 前眼窩窓
      { const [x, z] = P(0.06, -0.1); bf.hole(x, z, 0.035, 0.05, 0.3); }    // 眼窩
      { const [x, z] = P(0.17, -0.07); bf.hole(x, z, 0.04, 0.06, 0.2); }    // 側頭窓
      { const [x, z] = P(-0.47, -0.005); bf.hole(x, z, 0.025, 0.015, -0.2); } // 鼻の穴
      // 下あご
      bf.part('jaw');
      bf.chain([P(-0.5, 0.15), P(-0.3, 0.17), P(-0.05, 0.17), P(0.15, 0.13), P(0.24, 0.08)].map(([x, z], k) => [x, z, 0.03 + k * 0.012]), cy - 0.005, { flat: 0.6 });
      { const [x, z] = P(0.08, 0.15); bf.hole(x, z, 0.05, 0.016, -0.2); } // 下あごの窓
      // 歯（上：下向き、下：上向き）。エナメル、もろい
      bf.part('teeth');
      const up = [P(-0.54, 0.075), P(0.08, 0.06)], lo = [P(-0.48, 0.13), P(0.04, 0.14)];
      for (let n = 0; n < 12; n++) {
        const t = n / 11;
        const bx = lerp(up[0][0], up[1][0], t), bz = lerp(up[0][1], up[1][1], t) + 0.012 * Math.sin(t * Math.PI);
        const L = 0.05 + 0.03 * Math.sin(Math.PI * Math.min(1, t * 1.3));
        bf.chain([[bx, bz, 0.013], [bx + 0.008, bz + L * 0.6, 0.009], [bx + 0.014, bz + L, 0.002]], cy + 0.004, { mat: MAT.tooth, tol: 0.6, flat: 0.85 });
      }
      for (let n = 0; n < 10; n++) {
        const t = n / 9;
        const bx = lerp(lo[0][0], lo[1][0], t), bz = lerp(lo[0][1], lo[1][1], t);
        const L = 0.035 + 0.02 * Math.sin(Math.PI * t);
        bf.chain([[bx, bz, 0.011], [bx + 0.006, bz - L * 0.6, 0.007], [bx + 0.01, bz - L, 0.002]], cy + 0.002, { mat: MAT.tooth, tol: 0.6, flat: 0.85 });
      }
      // 首の骨（椎骨 3 つ）
      bf.part('neck');
      for (let n = 0; n < 3; n++) {
        const [x, z] = P(0.36 + n * 0.11, 0.0 + n * 0.035);
        bf.ellipse(x, z, 0.045, 0.06, 0.04, cy, { rot: 0.3, pow: 0.5 });
        bf.capsule(x, z - 0.05, x + 0.02, z - 0.11, 0.016, 0.01, cy + 0.01);
      }
    },
  },

  // ラプトルの全身骨格（反り返った「死のポーズ」）：頭骨・首・背骨・肋骨・骨盤・脚・かぎ爪・尾
  raptor: {
    size: [2.7, 1.85],
    build(bf, rng) {
      bf.S = 0.88;
      const cy = -0.19, ox = rng.range(-0.06, 0.06), oz = rng.range(-0.05, 0.05);
      const P = (x, z) => [ox + x, oz + z];
      // 背骨の線：首（反り返る）→ 胴 → 尾
      const neck = [P(-0.5, -0.12), P(-0.62, -0.32), P(-0.86, -0.38), P(-0.96, -0.24)];
      const back = [P(-0.5, -0.12), P(-0.3, -0.06), P(-0.1, -0.04), P(0.08, -0.07)];
      const tail = [P(0.08, -0.07), P(0.5, -0.2), P(0.95, -0.05), P(1.3, 0.25)];
      // 頭骨（首の先、下を向く）
      bf.part('skull');
      {
        const [hx, hz] = P(-0.98, -0.2);
        const ang = 1.25; // 頭の向き（吻が手前・下へ）
        const ax = Math.cos(ang), az = Math.sin(ang);
        const at = (u, v) => [hx + ax * u - az * v, hz + az * u + ax * v];
        for (const [u, v, rx, rz, h] of [[0.02, 0, 0.06, 0.05, 0.03], [0.1, 0.005, 0.07, 0.04, 0.026], [0.19, 0.01, 0.06, 0.028, 0.02]]) {
          const [x, z] = at(u, v); bf.ellipse(x, z, rx, rz, h, cy + 0.01, { rot: ang, pow: 0.5 });
        }
        { const [x, z] = at(0.03, -0.012); bf.hole(x, z, 0.022, 0.02, ang); }   // 眼窩
        { const [x, z] = at(0.11, -0.005); bf.hole(x, z, 0.035, 0.014, ang); }  // 前眼窩窓
        // 下あご
        { const a = at(-0.01, 0.035), b = at(0.22, 0.03); bf.capsule(a[0], a[1], b[0], b[1], 0.016, 0.008, cy + 0.004); }
        bf.part('teeth');
        for (let n = 0; n < 9; n++) {
          const [x, z] = at(0.06 + n * 0.018, 0.022);
          const [ex, ez] = at(0.065 + n * 0.018, 0.04);
          bf.capsule(x, z, ex, ez, 0.0055, 0.0015, cy + 0.006, { mat: MAT.tooth, tol: 0.55 });
        }
      }
      // 首の椎骨
      bf.part('neck');
      for (let n = 0; n < 9; n++) {
        const t = (n + 0.5) / 9;
        const p = bez3(...neck, 1 - t);
        bf.ellipse(p.x, p.z, 0.036, 0.022, 0.024, cy, { rot: Math.atan2(p.tz, p.tx), pow: 0.5 });
        // 神経棘（外側＝曲がりの外へ）
        bf.capsule(p.x, p.z, p.x + p.tz * 0.03, p.z - p.tx * 0.03, 0.009, 0.006, cy + 0.006);
      }
      // 胴の椎骨と肋骨
      bf.part('back');
      for (let n = 0; n < 12; n++) {
        const t = (n + 0.5) / 12;
        const p = bez3(...back, t);
        bf.ellipse(p.x, p.z, 0.034, 0.024, 0.026, cy, { rot: Math.atan2(p.tz, p.tx), pow: 0.5 });
        bf.capsule(p.x, p.z, p.x + p.tz * 0.045, p.z - p.tx * 0.045, 0.012, 0.009, cy + 0.006); // 神経棘（上）
      }
      bf.part('ribs');
      for (let n = 0; n < 11; n++) {
        const t = 0.06 + n * 0.085;
        const p = bez3(...back, t);
        const L = 0.2 + 0.12 * Math.sin(Math.PI * Math.min(1, t * 1.25));
        const sw = 0.06 + 0.05 * t;
        bf.chain([[p.x, p.z + 0.012, 0.011], [p.x + sw * 0.4 - 0.03, p.z + L * 0.55, 0.009], [p.x + sw - 0.02, p.z + L, 0.004]], cy + 0.004, { tol: 0.55, flat: 0.85 });
      }
      // 腹肋骨（細い）
      for (let n = 0; n < 8; n++) {
        const [x, z] = P(-0.34 + n * 0.055, 0.21 + 0.02 * Math.sin(n));
        bf.capsule(x - 0.03, z - 0.012, x + 0.035, z + 0.01, 0.0045, 0.003, cy + 0.008, { tol: 0.45 });
      }
      // 骨盤
      bf.part('pelvis');
      { const [x, z] = P(0.08, -0.03); bf.ellipse(x, z, 0.14, 0.06, 0.035, cy, { rot: -0.15, pow: 0.45 }); }  // 腸骨
      { const [a, b] = [P(0.06, 0.0), P(0.0, 0.25)]; bf.chain([[a[0], a[1], 0.022], [b[0], b[1], 0.016], [b[0] - 0.04, b[1] + 0.03, 0.022]], cy + 0.004); } // 恥骨
      { const [a, b] = [P(0.12, 0.0), P(0.2, 0.17)]; bf.capsule(a[0], a[1], b[0], b[1], 0.02, 0.012, cy + 0.002); } // 坐骨
      // 後ろ脚（大腿骨・すね・中足骨・指とかぎ爪）。片方は少し奥にずらす
      bf.part('legs');
      const leg = (hx, hz, k, s) => {
        const knee = [hx - 0.1 * s, hz + 0.24], ankle = [knee[0] + 0.16 * s, knee[1] + 0.2], foot = [ankle[0] - 0.02, ankle[1] + 0.14];
        bf.capsule(hx, hz, knee[0], knee[1], 0.03, 0.024, cy + k);
        bf.capsule(knee[0], knee[1], ankle[0], ankle[1], 0.022, 0.016, cy + k);
        bf.capsule(knee[0] + 0.012, knee[1], ankle[0] + 0.012, ankle[1], 0.009, 0.007, cy + k - 0.004); // 腓骨
        bf.capsule(ankle[0], ankle[1], foot[0], foot[1], 0.016, 0.013, cy + k);
        // 指（3 本）とかぎ爪（第 2 指の大きな爪）
        for (const [a, L] of [[0.4, 0.07], [0.0, 0.09], [-0.5, 0.06]]) {
          const ex = foot[0] + Math.sin(a) * L, ez = foot[1] + Math.cos(a) * L;
          bf.capsule(foot[0], foot[1], ex, ez, 0.009, 0.006, cy + k);
        }
        bf.part('claw');
        const cb = [foot[0] - 0.03, foot[1] + 0.02];
        bf.chain([[cb[0], cb[1], 0.012], [cb[0] - 0.045, cb[1] - 0.005, 0.009], [cb[0] - 0.07, cb[1] - 0.04, 0.0025]], cy + k + 0.004, { mat: MAT.tooth, tol: 0.6 });
        bf.part('legs');
      };
      { const [x, z] = P(0.1, 0.0); leg(x, z, 0.0, 1); }
      { const [x, z] = P(0.2, 0.02); leg(x, z, -0.012, -0.6); }
      // 前脚（腕・手のかぎ爪）
      bf.part('arms');
      {
        const [sx, sz] = P(-0.45, -0.02);
        const el = [sx - 0.06, sz + 0.13], wr = [el[0] - 0.12, el[1] + 0.06];
        bf.capsule(sx, sz, el[0], el[1], 0.018, 0.014, cy + 0.004);
        bf.capsule(el[0], el[1], wr[0], wr[1], 0.012, 0.01, cy + 0.004);
        for (const [a, L] of [[2.4, 0.06], [2.7, 0.075], [3.0, 0.06]]) {
          const ex = wr[0] + Math.cos(a) * L, ez = wr[1] + Math.sin(a) * L * 0.6 + 0.03;
          bf.chain([[wr[0], wr[1], 0.008], [ex, ez, 0.006], [ex - 0.015, ez + 0.02, 0.0018]], cy + 0.004, { mat: MAT.tooth, tol: 0.55 });
        }
        bf.capsule(sx + 0.02, sz - 0.04, sx - 0.06, sz - 0.08, 0.022, 0.018, cy + 0.006); // 肩甲骨
      }
      // 尾（だんだん小さく。V 字骨）
      bf.part('tail');
      for (let n = 0; n < 26; n++) {
        const t = (n + 0.5) / 26;
        const p = bez3(...tail, t);
        const s = 1 - t * 0.7;
        bf.ellipse(p.x, p.z, 0.03 * s, 0.018 * s, 0.022 * s, cy, { rot: Math.atan2(p.tz, p.tx), pow: 0.5 });
        if (n < 18) bf.capsule(p.x, p.z, p.x - p.tz * 0.04 * s, p.z + p.tx * 0.04 * s, 0.007 * s, 0.004, cy + 0.004, { tol: 0.6 }); // V 字骨
      }
      // 尾の補強の棒（細い線）
      for (const off of [-0.012, 0.012]) {
        const pts = [];
        for (let n = 4; n <= 26; n += 2) { const p = bez3(...tail, n / 26); pts.push([p.x - p.tz * off, p.z + p.tx * off, 0.0035]); }
        bf.chain(pts, cy + 0.01, { tol: 0.5 });
      }
    },
  },
};
