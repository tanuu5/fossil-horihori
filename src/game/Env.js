// 発掘現場のまわり：空、地面（スラブの穴あき）、崖、木枠、道具や小物、光。
// スラブの大きさはステージで変わるので、地面と木枠は build(slab) で作り直す。
import * as THREE from 'three';
import { Rng } from '../core/rng.js';

const NOISE = /* glsl */ `
float eh12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float eh13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float en2(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(eh12(i), eh12(i + vec2(1, 0)), u.x), mix(eh12(i + vec2(0, 1)), eh12(i + vec2(1, 1)), u.x), u.y); }
float en3(vec3 p) { vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(eh13(i), eh13(i + vec3(1,0,0)), u.x), mix(eh13(i + vec3(0,1,0)), eh13(i + vec3(1,1,0)), u.x), u.y);
  float b = mix(mix(eh13(i + vec3(0,0,1)), eh13(i + vec3(1,0,1)), u.x), mix(eh13(i + vec3(0,1,1)), eh13(i + vec3(1,1,1)), u.x), u.y);
  return mix(a, b, u.z); }
float efbm(vec2 p) { float s = 0.0, a = 0.5; for (int k = 0; k < 5; k++) { s += a * en2(p); p *= 2.07; a *= 0.5; } return s; }
`;

// 光の当たり方（ステージごと）
export const LIGHTS = {
  morning: { sunDir: [-0.55, 0.52, 0.45], sun: 0xffe6c8, sunI: 3.1, skyTop: 0x7fb4ec, skyHor: 0xf3dcc2, hemiSky: 0xdde4ee, hemiGround: 0x8a6f55, hemiI: 0.7, fog: 0xe6d6c4, exposure: 0.95, env: 0.45 },
  noon: { sunDir: [0.3, 0.85, 0.35], sun: 0xfff7ea, sunI: 3.0, skyTop: 0x5d9fea, skyHor: 0xd7e8f4, hemiSky: 0xe0e8f2, hemiGround: 0x7d7368, hemiI: 0.8, fog: 0xd3dde4, exposure: 0.95, env: 0.6 },
  afternoon: { sunDir: [0.6, 0.55, 0.35], sun: 0xffe0b0, sunI: 2.9, skyTop: 0x6aa6e6, skyHor: 0xf2dfc2, hemiSky: 0xe2e4ea, hemiGround: 0x8c7356, hemiI: 0.75, fog: 0xe9dbc4, exposure: 1.0, env: 0.55 },
  sunset: { sunDir: [-0.7, 0.36, 0.25], sun: 0xffb070, sunI: 3.6, skyTop: 0x41558f, skyHor: 0xffa264, hemiSky: 0xa8b0d0, hemiGround: 0x7a5640, hemiI: 0.9, fog: 0xe0a47a, exposure: 1.18, env: 0.5 },
  dusk: { sunDir: [0.75, 0.2, -0.3], sun: 0xff8a58, sunI: 2.4, skyTop: 0x283a6e, skyHor: 0xff8f63, hemiSky: 0x7181b8, hemiGround: 0x5a3a2c, hemiI: 0.8, fog: 0xc98a72, exposure: 1.1, env: 0.4, lanterns: true },
};

export class Env {
  constructor(scene, renderer) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'env';
    scene.add(this.group);
    this.site = new THREE.Group();   // スラブに合わせて作り直すもの
    this.site.name = 'site';
    scene.add(this.site);

    // 映り込み用の環境（部屋の照明を焼いたもの）。ロボットや化石のつやに使う
    const pm = new THREE.PMREMGenerator(renderer);
    this.envTex = pm.fromScene(roomScene(), 0.04).texture;
    pm.dispose();
    scene.environment = this.envTex;

    // 光
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x806040, 1);
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 3));
    sun.castShadow = true;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.012;
    sun.shadow.radius = 3;
    scene.add(this.hemi, sun, sun.target);

    // 空
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uTop: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() } },
      vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w * 0.9999; }`,
      fragmentShader: /* glsl */ `uniform vec3 uTop, uHor, uSun, uSunCol; varying vec3 vDir;
        void main() { vec3 d = normalize(vDir); float y = max(d.y, -0.2);
          vec3 c = mix(uHor, uTop, pow(clamp(y, 0.0, 1.0), 0.55));
          float s = max(dot(d, normalize(uSun)), 0.0);
          c += uSunCol * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.25);
          c = mix(c, uHor * 0.9, smoothstep(0.0, -0.2, d.y));
          gl_FragColor = vec4(c, 1.0); }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 16), this.skyMat);
    sky.name = 'sky';
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.group.add(sky);

    this.groundCol = new THREE.Color(0x9a7b58);
    this.buildCliffs();
    this.lanterns = [];
  }

  /** スラブに合わせて地面（穴あき）・木枠・小物を作り直す。 */
  build(slab, stage) {
    for (const c of [...this.site.children]) { this.site.remove(c); c.traverse?.((o) => { o.geometry?.dispose?.(); }); }
    this.lanterns = [];
    const W = slab.W, D = slab.D;
    const col = new THREE.Color(stage.layers[0].col);
    this.groundCol.copy(col);
    this.site.add(this.makeGround(W, D, col, stage.seed));
    this.site.add(this.makeFrame(W, D));
    this.site.add(this.makeProps(W, D, stage));
    if (this.cliffMat) this.cliffMat.uniforms.uCols.value = stage.layers.map((l) => new THREE.Color(l.col)).concat(Array(8).fill(new THREE.Color(0x888888))).slice(0, 6);
    // 影の範囲
    const R = Math.max(W, D) * 0.5 + 1.2;
    Object.assign(this.sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 0.5, far: 30 });
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  setLight(name, quality) {
    const L = LIGHTS[name] || LIGHTS.morning;
    this.light = L;
    const d = new THREE.Vector3(...L.sunDir).normalize();
    this.sunDir = d;
    this.sun.color.set(L.sun);
    this.sun.intensity = L.sunI;
    this.sun.position.copy(d).multiplyScalar(12);
    this.sun.target.position.set(0, 0, 0);
    this.hemi.color.set(L.hemiSky);
    this.hemi.groundColor.set(L.hemiGround);
    this.hemi.intensity = L.hemiI;
    this.skyMat.uniforms.uTop.value.set(L.skyTop);
    this.skyMat.uniforms.uHor.value.set(L.skyHor);
    this.skyMat.uniforms.uSun.value.copy(d);
    this.skyMat.uniforms.uSunCol.value.set(L.sun);
    this.scene.fog = new THREE.Fog(L.fog, 9, 46);
    this.scene.environmentIntensity = L.env;
    for (const l of this.lanterns) l.visible = !!L.lanterns;
    return L;
  }

  // ---------------------------------------------------------------- 地面
  makeGround(W, D, col, seed) {
    // 格子の線をスラブの縁に合わせ、スラブの内側の四角だけ抜く
    const span = 26;
    const axis = (half) => {
      const out = [];
      const outer = (from, to, n) => { for (let k = 0; k <= n; k++) { const t = k / n; out.push(from + (to - from) * Math.pow(t, 1.8)); } };
      // 外側は縁から遠ざかるほど粗く
      const left = []; outer(half, span, 40); const right = out.splice(0);
      for (let k = right.length - 1; k >= 1; k--) left.push(-right[k]);
      const inner = []; const ni = 16; for (let k = 0; k <= ni; k++) inner.push(-half + (2 * half * k) / ni);
      return [...left, ...inner.slice(0, -1), ...right];
    };
    const xs = axis(W / 2), zs = axis(D / 2);
    const pos = [], idx = [];
    const rng = new Rng(seed * 7 + 3);
    const bumps = [];
    for (let k = 0; k < 7; k++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(Math.max(W, D) * 0.9 + 0.8, 7);
      bumps.push([Math.cos(a) * r, Math.sin(a) * r * 0.8, rng.range(0.6, 1.6), rng.range(0.12, 0.45)]);
    }
    const height = (x, z) => {
      const dx = Math.max(0, Math.abs(x) - W / 2), dz = Math.max(0, Math.abs(z) - D / 2);
      const e = Math.hypot(dx, dz);
      const near = Math.min(1, Math.max(0, (e - 0.25) / 1.2));
      let y = 0;
      for (const [bx, bz, br, bh] of bumps) { const q = ((x - bx) ** 2 + (z - bz) ** 2) / (br * br); if (q < 1) y += bh * (1 - q) * (1 - q); }
      y += 0.05 * Math.sin(x * 0.7 + seed) * Math.sin(z * 0.6 - seed) + 0.025 * Math.sin(x * 2.1 + z * 1.7);
      // 遠くは少し上がる（採掘場のくぼみの底）
      y += Math.max(0, Math.hypot(x, z) - 8) * 0.12;
      return y * near;
    };
    for (let j = 0; j < zs.length; j++) for (let i = 0; i < xs.length; i++) pos.push(xs[i], height(xs[i], zs[j]), zs[j]);
    const NXg = xs.length;
    for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
      if (Math.abs(cx) < W / 2 && Math.abs(cz) < D / 2) continue;
      const a = j * NXg + i, b = a + 1, c = a + NXg, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.96, envMapIntensity: 0.3 });
    const u = { uSeed: { value: seed * 0.37 } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGW = (modelMatrix * vec4(position, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vGW;\nuniform float uSeed;\n${NOISE}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec2 q = vGW.xz;
          float n1 = efbm(q * 0.45 + uSeed), n2 = efbm(q * 2.3 - uSeed), n3 = en2(q * 55.0), n4 = en2(q * 140.0);
          vec3 c = diffuseColor.rgb;
          c *= 0.82 + 0.3 * n1;
          c = mix(c, c * vec3(1.06, 1.04, 1.0) + 0.02, smoothstep(0.45, 0.85, n2) * 0.4);
          c *= 0.9 + 0.12 * n3 + 0.08 * n4;
          float peb = smoothstep(0.8, 0.86, en2(q * 90.0 + 7.0));
          c = mix(c, c * 0.8, peb * 0.6);
          float peb2 = smoothstep(0.84, 0.9, en2(q * 120.0 - 3.0));
          c = mix(c, c * 1.1 + 0.02, peb2 * 0.5);
          diffuseColor.rgb = c;`);
    };
    const m = new THREE.Mesh(g, mat);
    m.name = 'ground';
    m.receiveShadow = true;
    return m;
  }

  // 穴の縁の木枠
  makeFrame(W, D) {
    const grp = new THREE.Group();
    grp.name = 'frame';
    const wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.82, color: 0xd9c2a0 });
    const t = 0.05, h = 0.05;
    const boards = [
      [0, -D / 2 - t / 2 + 0.006, W + 2 * t, t], [0, D / 2 + t / 2 - 0.006, W + 2 * t, t],
      [-W / 2 - t / 2 + 0.006, 0, t, D], [W / 2 + t / 2 - 0.006, 0, t, D],
    ];
    for (const [x, z, w, d] of boards) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wood);
      b.position.set(x, h / 2 - 0.012, z);
      b.castShadow = b.receiveShadow = true;
      grp.add(b);
    }
    // 角の杭と、オレンジの目印テープ
    const stake = new THREE.MeshStandardMaterial({ color: 0xb08a5c, roughness: 0.85 });
    const tape = new THREE.MeshStandardMaterial({ color: 0xff6a1f, roughness: 0.6, side: THREE.DoubleSide });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.012, 0.32, 8), stake);
      s.position.set(sx * (W / 2 + t + 0.03), 0.14, sz * (D / 2 + t + 0.03));
      s.castShadow = true;
      grp.add(s);
      const f = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.03, 4, 1), tape);
      f.position.set(s.position.x + 0.05 * sx, 0.27, s.position.z);
      f.rotation.y = sx * 0.4;
      f.castShadow = true;
      grp.add(f);
    }
    // 調査用の糸（枠の上を一周）
    const line = new THREE.MeshStandardMaterial({ color: 0xf5f0e0, roughness: 0.7 });
    const y = 0.255;
    const P = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([sx, sz]) => new THREE.Vector3(sx * (W / 2 + t + 0.03), y, sz * (D / 2 + t + 0.03)));
    for (let k = 0; k < 4; k++) {
      const a = P[k], b = P[k + 1];
      const L = a.distanceTo(b);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.0018, 0.0018, L, 4), line);
      c.position.copy(a).add(b).multiplyScalar(0.5);
      c.lookAt(b); c.rotateX(Math.PI / 2);
      grp.add(c);
    }
    return grp;
  }

  // 小物：道具箱、バケツとふるい、木箱、ランタン、充電台、石、草
  makeProps(W, D, stage) {
    const grp = new THREE.Group();
    grp.name = 'props';
    const rng = new Rng(stage.seed * 13 + 1);
    const std = (c, r = 0.6, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
    const add = (mesh, x, y, z, ry = 0) => { mesh.position.set(x, y, z); mesh.rotation.y = ry; mesh.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); grp.add(mesh); return mesh; };
    const L = -W / 2 - 0.45, R = W / 2 + 0.45, F = D / 2 + 0.4, B = -D / 2 - 0.45;

    // 道具箱（赤い金属）
    {
      const g = new THREE.Group();
      const red = std(0xc23b2a, 0.38, 0.55);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.2), red); body.position.y = 0.08; g.add(body);
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.04, 0.21), red); lid.position.y = 0.18; g.add(lid);
      const hdl = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.008, 6, 16, Math.PI), std(0x222222, 0.4, 0.8)); hdl.position.y = 0.2; g.add(hdl);
      const latch = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.01), std(0xd0d0d0, 0.3, 0.9)); latch.position.set(0, 0.16, 0.106); g.add(latch);
      add(g, L - 0.05, 0, F - 0.1, 0.35);
    }
    // バケツとふるい
    {
      const g = new THREE.Group();
      const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.24, 20, 1, true), std(0x2f6fb5, 0.5));
      bucket.material.side = THREE.DoubleSide; bucket.position.y = 0.12; g.add(bucket);
      const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.1, 20), std(0x2f6fb5, 0.5)); bottom.rotation.x = -Math.PI / 2; bottom.position.y = 0.005; g.add(bottom);
      const soil = new THREE.Mesh(new THREE.CircleGeometry(0.125, 20), std(stage.layers[1].col, 0.95)); soil.rotation.x = -Math.PI / 2; soil.position.y = 0.2; g.add(soil);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.006, 6, 24), std(0x2a5f9c, 0.4)); rim.rotation.x = Math.PI / 2; rim.position.y = 0.24; g.add(rim);
      add(g, R + 0.1, 0, B + 0.05, 0);
      const sieve = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 24, 1, true), std(0xc9a678, 0.8));
      ring.material.side = THREE.DoubleSide; ring.position.y = 0.025; sieve.add(ring);
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.168, 24), new THREE.MeshStandardMaterial({ map: meshTexture(), transparent: true, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide }));
      mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.01; sieve.add(mesh);
      add(sieve, R + 0.42, 0.0, B + 0.2, 0.2).rotation.z = 0.12;
    }
    // 木箱とランタン
    {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.3, 0.3), new THREE.MeshStandardMaterial({ map: woodTexture(true), roughness: 0.85, color: 0xc9a77c }));
      crate.position.y = 0.15;
      const g = new THREE.Group(); g.add(crate);
      const lantern = makeLantern();
      lantern.position.set(0.05, 0.3, 0.02);
      g.add(lantern);
      this.lanterns.push(lantern.userData.light);
      add(g, L - 0.1, 0, B + 0.15, -0.25);
    }
    // 野帳とペン（枠の手前）
    {
      const g = new THREE.Group();
      const book = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.015, 0.2), std(0x3d6b4a, 0.7)); book.position.y = 0.0075; g.add(book);
      const page = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.004, 0.19), std(0xd9cfb8, 0.9)); page.position.y = 0.017; g.add(page);
      const pen = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.14, 6), std(0xffc21a, 0.4)); pen.rotation.z = Math.PI / 2; pen.rotation.y = 0.5; pen.position.set(0.02, 0.024, 0.0); g.add(pen);
      add(g, -W * 0.2, 0.0, F + 0.05, 0.25);
    }
    // ロボットの充電台
    {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.04, 32), std(0x3b4048, 0.35, 0.6)); base.position.y = 0.02; g.add(base);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.01, 32), std(0x8d939a, 0.35, 0.5)); top.position.y = 0.045; g.add(top);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.006, 8, 48), new THREE.MeshStandardMaterial({ color: 0x0a2a30, emissive: 0x45e0ff, emissiveIntensity: 0.9 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.045; g.add(ring);
      add(g, R + 0.05, 0, F - 0.05, 0);
      this.pad = g;
    }
    // 石と草（穴から離して散らす）
    const rockG = new THREE.IcosahedronGeometry(1, 1);
    const rp = rockG.attributes.position;
    for (let k = 0; k < rp.count; k++) { const s = 0.75 + 0.5 * Math.abs(Math.sin(k * 12.9898) * 43758.5453 % 1); rp.setXYZ(k, rp.getX(k) * s, rp.getY(k) * s * 0.7, rp.getZ(k) * s); }
    rockG.computeVertexNormals();
    const rocks = new THREE.InstancedMesh(rockG, std(0xffffff, 0.92), 90);
    rocks.name = 'rocks';
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
    let n = 0;
    for (let k = 0; k < 400 && n < 90; k++) {
      const x = rng.range(-9, 9), z = rng.range(-7, 5);
      if (Math.abs(x) < W / 2 + 0.7 && Math.abs(z) < D / 2 + 0.7) continue;
      const sc = rng.range(0.02, 0.09) * (rng.next() < 0.1 ? 3 : 1);
      p.set(x, sc * 0.2, z); e.set(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)); q.setFromEuler(e); s.set(sc, sc, sc);
      rocks.setMatrixAt(n, m4.compose(p, q, s));
      c.set(stage.layers[rng.int(0, 3)].col).multiplyScalar(rng.range(0.7, 1.05));
      rocks.setColorAt(n, c);
      n++;
    }
    rocks.count = n;
    rocks.castShadow = rocks.receiveShadow = true;
    grp.add(rocks);
    // 枯れ草の株
    const tuft = tuftGeometry();
    const grass = new THREE.InstancedMesh(tuft, std(0xffffff, 0.9), 40);
    grass.name = 'grass';
    n = 0;
    for (let k = 0; k < 300 && n < 40; k++) {
      const x = rng.range(-8, 8), z = rng.range(-6, 4);
      if (Math.abs(x) < W / 2 + 0.9 && Math.abs(z) < D / 2 + 0.9) continue;
      const sc = rng.range(0.12, 0.28);
      p.set(x, 0, z); e.set(0, rng.range(0, 6), 0); q.setFromEuler(e); s.set(sc, sc * rng.range(0.8, 1.3), sc);
      grass.setMatrixAt(n, m4.compose(p, q, s));
      c.setHSL(rng.range(0.1, 0.16), rng.range(0.25, 0.45), rng.range(0.32, 0.5));
      grass.setColorAt(n, c);
      n++;
    }
    grass.count = n;
    grass.castShadow = true;
    grp.add(grass);
    return grp;
  }

  // 採掘場の崖（地層の縞）
  buildCliffs() {
    const g = new THREE.CylinderGeometry(15, 17, 7, 160, 24, true);
    const pa = g.attributes.position;
    const v = new THREE.Vector3();
    for (let k = 0; k < pa.count; k++) {
      v.fromBufferAttribute(pa, k);
      const a = Math.atan2(v.z, v.x), y = v.y;
      const n = Math.sin(a * 7 + y * 0.8) * 0.5 + Math.sin(a * 23 + y * 2.1) * 0.25 + Math.sin(a * 61) * 0.12 + Math.sin(y * 3.3 + a * 3) * 0.2;
      const r = Math.hypot(v.x, v.z) + n * 0.6 - Math.max(0, y - 2) * 0.35 + (Math.round(y * 1.3) % 2) * 0.12;
      pa.setXYZ(k, Math.cos(a) * r, y, Math.sin(a) * r);
    }
    g.computeVertexNormals();
    const mat = (this.cliffMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, THREE.UniformsLib.lights, {
        uCols: { value: Array(6).fill(0).map(() => new THREE.Color(0xa08060)) },
      }]),
      lights: true,
      vertexShader: /* glsl */ `#include <common>
        #include <fog_pars_vertex>
        varying vec3 vW; varying vec3 vN;
        void main() { vW = (modelMatrix * vec4(position, 1.0)).xyz; vN = normalize(mat3(modelMatrix) * -normal);
          vec4 mvPosition = viewMatrix * vec4(vW, 1.0); gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `#include <common>
        #include <fog_pars_fragment>
        #include <lights_pars_begin>
        uniform vec3 uCols[6]; varying vec3 vW; varying vec3 vN;
        ${NOISE}
        void main() {
          float y = vW.y + efbm(vW.xz * 0.3) * 0.6;
          float band = y * 1.7 + 4.0;
          int i0 = int(clamp(floor(band), 0.0, 5.0));
          vec3 c = uCols[0];
          for (int k = 0; k < 6; k++) { if (k == i0) c = uCols[5 - k]; }
          c *= 0.82 + 0.3 * efbm(vW.xz * 1.3 + vW.y * 2.0);
          c *= 0.9 + 0.1 * sin(y * 40.0 + efbm(vW.xz) * 5.0);
          vec3 n = normalize(vN);
          vec3 L = directionalLights[0].direction;
          float diff = max(dot(n, L), 0.0);
          vec3 lit = c * (directionalLights[0].color * diff * 0.6 + mix(hemisphereLights[0].groundColor, hemisphereLights[0].skyColor, n.y * 0.5 + 0.5) * 0.9);
          gl_FragColor = vec4(lit, 1.0);
          #include <fog_fragment>
        }`,
    }));
    const m = new THREE.Mesh(g, mat);
    m.name = 'cliffs';
    m.position.y = 2.2;
    this.group.add(m);
  }

  update(dt, time) {
    for (const l of this.lanterns) if (l.visible) l.intensity = 0.9 + 0.08 * Math.sin(time * 9.0) + 0.05 * Math.sin(time * 23.0);
  }
}

function makeLantern() {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.4, metalness: 0.8 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.025, 16), metal); base.position.y = 0.012; g.add(base);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.09, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0xffe2a0, emissive: 0xffa040, emissiveIntensity: 2.2, transparent: true, opacity: 0.85, roughness: 0.1 }));
  glass.position.y = 0.07; g.add(glass);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.052, 0.04, 16), metal); cap.position.y = 0.135; g.add(cap);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.004, 6, 16), metal); ring.position.y = 0.165; g.add(ring);
  const light = new THREE.PointLight(0xffa860, 1, 3.5, 1.6);
  light.position.y = 0.08;
  light.visible = false;
  g.add(light);
  g.userData.light = light;
  return g;
}

function tuftGeometry() {
  const parts = [];
  for (let k = 0; k < 9; k++) {
    const c = new THREE.ConeGeometry(0.035, 1, 3, 1);
    c.translate(0, 0.5, 0);
    const a = (k / 9) * Math.PI * 2, tilt = 0.25 + (k % 3) * 0.12;
    c.rotateZ(tilt); c.rotateY(a);
    c.scale(1, 0.7 + (k % 4) * 0.15, 1);
    parts.push(c);
  }
  return mergeGeoms(parts);
}

function mergeGeoms(list) {
  let n = 0, m = 0;
  for (const g of list) { const gi = g.index ? g : g; n += gi.attributes.position.count; m += gi.index ? gi.index.count : gi.attributes.position.count; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), idx = [];
  let off = 0;
  for (const g0 of list) {
    const g = g0.index ? g0 : g0;
    g.computeVertexNormals();
    pos.set(g.attributes.position.array, off * 3);
    nor.set(g.attributes.normal.array, off * 3);
    if (g.index) for (const i of g.index.array) idx.push(i + off);
    else for (let i = 0; i < g.attributes.position.count; i++) idx.push(i + off);
    off += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

function woodTexture(planks = false) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#b48a5a'; g.fillRect(0, 0, 256, 64);
  for (let k = 0; k < 60; k++) {
    const y = Math.random() * 64, a = 0.05 + Math.random() * 0.12;
    g.strokeStyle = `rgba(${Math.random() < 0.5 ? '70,45,25' : '230,200,160'},${a})`;
    g.lineWidth = 0.5 + Math.random() * 1.5;
    g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= 256; x += 16) g.lineTo(x, y + Math.sin(x * 0.03 + k) * 2);
    g.stroke();
  }
  for (let k = 0; k < 3; k++) { g.fillStyle = 'rgba(60,35,20,0.35)'; g.beginPath(); g.ellipse(Math.random() * 256, Math.random() * 64, 4, 2, 0, 0, 7); g.fill(); }
  if (planks) { g.fillStyle = 'rgba(40,25,10,0.55)'; for (const y of [21, 42]) g.fillRect(0, y, 256, 1.5); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function meshTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(180,180,180,1)';
  g.lineWidth = 1.2;
  for (let k = 0; k <= 128; k += 8) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k, 128); g.stroke(); g.beginPath(); g.moveTo(0, k); g.lineTo(128, k); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
}

// 映り込み用の部屋（明るい窓と暖かい壁）
function roomScene() {
  const s = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 10), new THREE.MeshBasicMaterial({ color: 0x8a8078, side: THREE.BackSide }));
  s.add(box);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ color: 0x6a5545 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -2.9; s.add(floor);
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ color: 0xcfe4ff }));
  sky.rotation.x = Math.PI / 2; sky.position.y = 2.9; s.add(sky);
  const win = (x, y, z, w, h, ry, col, k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k) })); m.position.set(x, y, z); m.rotation.y = ry; s.add(m); };
  win(0, 1.5, -4.9, 4, 1.6, 0, 0xffffff, 3);
  win(-4.9, 1.2, 0, 3, 1.2, Math.PI / 2, 0xfff0d8, 2.2);
  win(4.9, 0.8, 1, 2, 1, -Math.PI / 2, 0xffd8a8, 1.8);
  return s;
}
