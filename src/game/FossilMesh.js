// 取り出した化石の立体。スラブの骨の上面（top）と下面（bot）を張り合わせた殻にする。
// 色・ヒビはスラブと同じテクスチャ（tBone の材質、tDyn のダメージ）から引く。
import * as THREE from 'three';
import { NOISE_GLSL, BONE_GLSL } from './glsl.js';

export class FossilMesh {
  constructor(slab) {
    const bf = slab.bf, nx = slab.nx, nz = slab.nz;
    // 骨のまわり 2 セルまでの範囲
    let i0 = nx, i1 = 0, j0 = nz, j1 = 0;
    for (const k of bf.list) { const i = k % nx, j = (k - i) / nx; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
    i0 = Math.max(0, i0 - 2); j0 = Math.max(0, j0 - 2); i1 = Math.min(nx - 1, i1 + 2); j1 = Math.min(nz - 1, j1 + 2);
    // グリッドを F 倍に細かくして作る（骨の有無を双一次補間して 0.5 で切ると、輪郭の階段がなめらかになる）
    const F = 3;
    const w = (i1 - i0) * F + 1, h = (j1 - j0) * F + 1;
    const b = bf.bounds;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    let cy = 0, n = 0;
    for (const k of bf.list) { cy += (bf.top[k] + bf.bot[k]) / 2; n++; }
    cy /= Math.max(1, n);
    this.center = new THREE.Vector3(cx, cy, cz);
    const isBone = (k) => (bf.mask[k] && !bf.extra[k] ? 1 : 0);
    const lerp4 = (fi, fj, get) => {
      const i = Math.min(nx - 2, Math.floor(fi)), j = Math.min(nz - 2, Math.floor(fj)), u = fi - i, v = fj - j, k = j * nx + i;
      return (get(k) * (1 - u) + get(k + 1) * u) * (1 - v) + (get(k + nx) * (1 - u) + get(k + nx + 1) * u) * v;
    };
    const midOf = (k) => (bf.etop[k] > -5 ? (bf.etop[k] + bf.ebot[k]) / 2 : cy);
    const M = new Float32Array(w * h), T = new Float32Array(w * h), B = new Float32Array(w * h);
    const near = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const fi = i0 + i / F, fj = j0 + j / F, q = j * w + i;
      M[q] = lerp4(fi, fj, isBone);
      if (M[q] >= 0.5) {
        near[q] = 2;
        T[q] = lerp4(fi, fj, (k) => (bf.mask[k] ? bf.top[k] : bf.etop[k] > -5 ? bf.etop[k] : cy));
        B[q] = lerp4(fi, fj, (k) => (bf.mask[k] ? bf.bot[k] : bf.ebot[k] < 5 ? bf.ebot[k] : cy));
      } else { T[q] = B[q] = lerp4(fi, fj, midOf); }
    }
    // 骨のまわり：1〜2 つ外（1）、3 つ外（3：ここで上面と下面が出会う）
    const R = 3;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const q = j * w + i;
      if (near[q] === 2) continue;
      let dmin = 9;
      for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < w && jj < h && near[jj * w + ii] === 2) dmin = Math.min(dmin, Math.max(Math.abs(di), Math.abs(dj)));
      }
      if (dmin < R) near[q] = 1;
      else if (dmin === R) near[q] = 3;
    }
    // [1,2,1] で 2 回ぼかす（縁を丸める）
    const blur = (A) => {
      const tmp = new Float32Array(A.length);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const q = j * w + i, l = i > 0 ? q - 1 : q, r = i < w - 1 ? q + 1 : q;
        tmp[q] = (A[l] + 2 * A[q] + A[r]) / 4;
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const q = j * w + i, u = j > 0 ? q - w : q, d = j < h - 1 ? q + w : q;
        A[q] = (tmp[u] + 2 * tmp[q] + tmp[d]) / 4;
      }
    };
    for (let it = 0; it < 2; it++) { blur(T); blur(B); }
    for (let q = 0; q < w * h; q++) {
      if (near[q] === 3 || near[q] === 0 || T[q] < B[q]) { const m = (T[q] + B[q]) / 2; T[q] = m; B[q] = m; }
    }
    const pos = [], grid = [], idx = [];
    const vid = new Int32Array(w * h * 2).fill(-1);
    const vtx = (i, j, top) => {
      const sI = (j * w + i) * 2 + (top ? 0 : 1);
      if (vid[sI] >= 0) return vid[sI];
      const q = j * w + i, fi = i0 + i / F, fj = j0 + j / F;
      vid[sI] = pos.length / 3;
      pos.push(slab.x(fi) - cx, (top ? T[q] : B[q]) - cy, slab.z(fj) - cz);
      grid.push(fi, fj);
      return vid[sI];
    };
    for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
      const a = near[j * w + i], bb = near[j * w + i + 1], c = near[(j + 1) * w + i], d = near[(j + 1) * w + i + 1];
      if (!a || !bb || !c || !d) continue;
      if (a === 3 && bb === 3 && c === 3 && d === 3) continue; // 外側だけの板は作らない
      for (const top of [true, false]) {
        const A = vtx(i, j, top), Bv = vtx(i + 1, j, top), C = vtx(i, j + 1, top), D = vtx(i + 1, j + 1, top);
        if (top) idx.push(A, C, Bv, Bv, C, D);
        else idx.push(A, Bv, C, Bv, D, C);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('grid', new THREE.Float32BufferAttribute(grid, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();

    const su = slab.uniforms;
    const uniforms = {
      tDyn: su.tDyn, tBone: su.tBone, uTexel: su.uTexel,
      uBoneCol: su.uBoneCol, uBoneCol2: su.uBoneCol2, uToothCol: su.uToothCol, uShellCol: su.uShellCol, uCarapaceCol: su.uCarapaceCol,
      uIrid: su.uIrid, uCrackScale: su.uCrackScale, uOrigin: { value: new THREE.Vector3(cx, cy, cz) }, uGlow: { value: 0 },
    };
    this.uniforms = uniforms;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 grid;\nuniform vec2 uTexel;\nuniform vec3 uOrigin;\nvarying vec2 vTexUv;\nvarying vec3 vSlabPos;\nvarying vec3 vObjN;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTexUv = (grid + 0.5) * uTexel;\nvSlabPos = position + uOrigin;\nvObjN = objectNormal;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tDyn; uniform sampler2D tBone;
uniform vec3 uBoneCol, uBoneCol2, uToothCol, uShellCol, uCarapaceCol; uniform float uIrid; uniform float uCrackScale; uniform float uGlow;
varying vec2 vTexUv; varying vec3 vSlabPos; varying vec3 vObjN;
${NOISE_GLSL}
${BONE_GLSL}`)
        .replace('#include <emissivemap_fragment>', `
vec4 bone = texture2D(tBone, vTexUv);
vec4 dyn = texture2D(tDyn, vTexUv);
float ndv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
float brough, crack;
float pxw = max(fwidth(vSlabPos.x), fwidth(vSlabPos.z));
vec3 bcol = boneShade(vSlabPos, bone.b, dyn.g, ndv, pxw, brough, crack);
// 下面は土がついて暗い
float under = smoothstep(0.2, -0.4, normalize(vObjN).y);
bcol *= 1.0 - 0.15 * under;
diffuseColor.rgb = bcol;
roughnessFactor = brough + 0.25 * crack;
totalEmissiveRadiance += bcol * uGlow * 0.6;
#include <emissivemap_fragment>`);
    };
    mat.customProgramCacheKey = () => 'fossil-v1';
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'fossil';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.position.copy(this.center);
    this.size = Math.max(b.x1 - b.x0, b.z1 - b.z0);
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
