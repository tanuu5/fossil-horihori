// 粒子：土ぼこり（やわらかい円）、石のかけら（地面ではねる）、火花（加算）。どれも使い回しのプール。
//   fx.dust(pos, color, n, power)   fx.chips(pos, color, n, power, size)   fx.sparks(pos, n, color)
//   fx.update(dt, heightAt)   heightAt(x, z) で地面の高さ（スラブ）を引く
import * as THREE from 'three';

const DUST_MAX = 900, CHIP_MAX = 420, SPARK_MAX = 260;

export class Particles {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'particles';
    scene.add(this.group);
    this.light = new THREE.Color(1, 1, 1);

    // ---- 土ぼこり
    const dg = new THREE.BufferGeometry();
    this.dPos = new Float32Array(DUST_MAX * 3);
    this.dCol = new Float32Array(DUST_MAX * 3);
    this.dSize = new Float32Array(DUST_MAX);
    this.dAlpha = new Float32Array(DUST_MAX);
    dg.setAttribute('position', new THREE.BufferAttribute(this.dPos, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('color', new THREE.BufferAttribute(this.dCol, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('size', new THREE.BufferAttribute(this.dSize, 1).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('alpha', new THREE.BufferAttribute(this.dAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    dg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);
    this.dustMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uScale: { value: 400 }, uLight: { value: this.light } },
      vertexShader: /* glsl */ `attribute float size; attribute float alpha; attribute vec3 color; varying float vA; varying vec3 vC; uniform float uScale;
        void main() { vA = alpha; vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(size * uScale / max(0.05, -mv.z), 0.0, 400.0); }`,
      fragmentShader: /* glsl */ `varying float vA; varying vec3 vC; uniform vec3 uLight;
        void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard;
          float a = (1.0 - r); a = a * a * vA;
          float shade = 0.8 + 0.4 * (0.5 - d.y);
          gl_FragColor = vec4(vC * uLight * shade, a); }`,
    });
    this.dust = new THREE.Points(dg, this.dustMat);
    this.dust.name = 'dust';
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 5;
    this.group.add(this.dust);
    this.dP = Array.from({ length: DUST_MAX }, () => ({ life: 0, max: 1, v: new THREE.Vector3(), s0: 0, s1: 0, a: 0 }));
    this.dNext = 0;

    // ---- 石のかけら
    const cg = new THREE.IcosahedronGeometry(1, 0);
    const cp = cg.attributes.position;
    for (let k = 0; k < cp.count; k++) { const s = 0.7 + 0.6 * ((Math.sin(k * 91.7) * 43758.5) % 1 + 1) % 1; cp.setXYZ(k, cp.getX(k) * s, cp.getY(k) * s * 0.75, cp.getZ(k) * s); }
    cg.computeVertexNormals();
    this.chipMesh = new THREE.InstancedMesh(cg, new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }), CHIP_MAX);
    this.chipMesh.name = 'chips';
    this.chipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chipMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.chipMesh.castShadow = true;
    this.chipMesh.frustumCulled = false;
    this.group.add(this.chipMesh);
    this.cP = Array.from({ length: CHIP_MAX }, () => ({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), s: 0, rest: false }));
    this.cNext = 0;
    this.zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let k = 0; k < CHIP_MAX; k++) this.chipMesh.setMatrixAt(k, this.zero);

    // ---- 火花
    const sg = new THREE.BufferGeometry();
    this.sPos = new Float32Array(SPARK_MAX * 3);
    this.sCol = new Float32Array(SPARK_MAX * 3);
    sg.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('color', new THREE.BufferAttribute(this.sCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.sparkMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 400 } },
      vertexShader: /* glsl */ `attribute vec3 color; varying vec3 vC; uniform float uScale;
        void main() { vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp(0.012 * uScale / max(0.05, -mv.z), 0.0, 40.0); }`,
      fragmentShader: /* glsl */ `varying vec3 vC; void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard; gl_FragColor = vec4(vC * (1.0 - r) * 3.0, 1.0); }`,
    });
    this.sparks = new THREE.Points(sg, this.sparkMat);
    this.sparks.name = 'sparks';
    this.sparks.frustumCulled = false;
    this.group.add(this.sparks);
    this.sP = Array.from({ length: SPARK_MAX }, () => ({ life: 0, max: 1, p: new THREE.Vector3(), v: new THREE.Vector3(), c: new THREE.Color() }));
    this.sNext = 0;
    this._m = new THREE.Matrix4();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  setViewport(h, fovDeg) {
    const s = h / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.dustMat.uniforms.uScale.value = s;
    this.sparkMat.uniforms.uScale.value = s;
  }

  dustAt(pos, color, n = 10, power = 1, o = {}) {
    for (let k = 0; k < n; k++) {
      const i = this.dNext; this.dNext = (this.dNext + 1) % DUST_MAX;
      const d = this.dP[i];
      const a = Math.random() * Math.PI * 2, sp = (0.08 + Math.random() * 0.35) * power * (o.spread ?? 1);
      d.v.set(Math.cos(a) * sp, (0.12 + Math.random() * 0.4) * power * (o.rise ?? 1), Math.sin(a) * sp);
      d.max = d.life = (o.life ?? 1.4) * (0.6 + Math.random() * 0.8);
      d.s0 = (o.size ?? 0.035) * (0.5 + Math.random() * 0.7);
      d.s1 = d.s0 * (2.5 + Math.random() * 2.5);
      d.a = (o.alpha ?? 0.5) * (0.6 + Math.random() * 0.5);
      this.dPos[i * 3] = pos.x + (Math.random() - 0.5) * 0.03;
      this.dPos[i * 3 + 1] = pos.y + Math.random() * 0.02;
      this.dPos[i * 3 + 2] = pos.z + (Math.random() - 0.5) * 0.03;
      const c = this._c.set(color);
      const j = 0.9 + Math.random() * 0.2;
      this.dCol[i * 3] = c.r * j; this.dCol[i * 3 + 1] = c.g * j; this.dCol[i * 3 + 2] = c.b * j;
      this.dAlpha[i] = 0;
      this.dSize[i] = d.s0;
    }
  }

  chips(pos, color, n = 8, power = 1, size = 0.008, o = {}) {
    for (let k = 0; k < n; k++) {
      const i = this.cNext; this.cNext = (this.cNext + 1) % CHIP_MAX;
      const c = this.cP[i];
      const a = Math.random() * Math.PI * 2, sp = (0.2 + Math.random() * 0.9) * power;
      c.p.set(pos.x + (Math.random() - 0.5) * 0.02, pos.y + 0.005, pos.z + (Math.random() - 0.5) * 0.02);
      c.v.set(Math.cos(a) * sp * 0.6, (0.6 + Math.random() * 1.2) * power * (o.up ?? 1), Math.sin(a) * sp * 0.6);
      c.q.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
      c.w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(30);
      c.s = size * (0.5 + Math.random());
      c.life = o.life ?? 2.5 + Math.random();
      c.rest = false;
      const col = this._c.set(color).multiplyScalar(0.8 + Math.random() * 0.35);
      this.chipMesh.setColorAt(i, col);
    }
    this.chipMesh.instanceColor.needsUpdate = true;
  }

  sparksAt(pos, n = 12, color = 0xffb050, power = 1) {
    for (let k = 0; k < n; k++) {
      const i = this.sNext; this.sNext = (this.sNext + 1) % SPARK_MAX;
      const s = this.sP[i];
      const a = Math.random() * Math.PI * 2, sp = (0.5 + Math.random() * 1.6) * power;
      s.p.copy(pos);
      s.v.set(Math.cos(a) * sp, (0.6 + Math.random() * 1.4) * power, Math.sin(a) * sp);
      s.max = s.life = 0.25 + Math.random() * 0.35;
      s.c.set(color);
    }
  }

  update(dt, heightAt) {
    // 土ぼこり：ふわっと広がって消える
    for (let i = 0; i < DUST_MAX; i++) {
      const d = this.dP[i];
      if (d.life <= 0) { if (this.dAlpha[i] !== 0) this.dAlpha[i] = 0; continue; }
      d.life -= dt;
      const u = 1 - d.life / d.max;
      d.v.multiplyScalar(Math.exp(-2.6 * dt));
      d.v.y += 0.03 * dt;
      this.dPos[i * 3] += d.v.x * dt; this.dPos[i * 3 + 1] += d.v.y * dt; this.dPos[i * 3 + 2] += d.v.z * dt;
      this.dSize[i] = d.s0 + (d.s1 - d.s0) * Math.sqrt(u);
      this.dAlpha[i] = d.a * Math.min(1, u * 8) * (1 - u) * (1 - u);
    }
    const dg = this.dust.geometry;
    dg.attributes.position.needsUpdate = true;
    dg.attributes.size.needsUpdate = true;
    dg.attributes.alpha.needsUpdate = true;
    dg.attributes.color.needsUpdate = true;

    // かけら：重力で落ち、地面ではねて止まる
    const m = this._m, sc = this._s;
    const dq = new THREE.Quaternion();
    for (let i = 0; i < CHIP_MAX; i++) {
      const c = this.cP[i];
      if (c.life <= 0) continue;
      c.life -= dt;
      if (!c.rest) {
        c.v.y -= 9.8 * dt;
        c.p.addScaledVector(c.v, dt);
        const gy = heightAt(c.p.x, c.p.z) + c.s * 0.5;
        if (c.p.y < gy) {
          c.p.y = gy;
          if (Math.abs(c.v.y) < 0.4) { c.rest = true; c.v.set(0, 0, 0); }
          else { c.v.y = -c.v.y * 0.35; c.v.x *= 0.55; c.v.z *= 0.55; c.w.multiplyScalar(0.6); }
        }
        const wl = c.w.length();
        if (wl > 0) { dq.setFromAxisAngle(this._s.copy(c.w).divideScalar(wl), wl * dt); c.q.premultiply(dq); }
      }
      const fade = Math.min(1, c.life / 0.5);
      sc.set(c.s, c.s, c.s).multiplyScalar(fade);
      m.compose(c.p, c.q, sc);
      this.chipMesh.setMatrixAt(i, c.life > 0 ? m : this.zero);
    }
    this.chipMesh.instanceMatrix.needsUpdate = true;

    // 火花
    for (let i = 0; i < SPARK_MAX; i++) {
      const s = this.sP[i];
      if (s.life <= 0) { this.sCol[i * 3] = this.sCol[i * 3 + 1] = this.sCol[i * 3 + 2] = 0; continue; }
      s.life -= dt;
      s.v.y -= 6 * dt;
      s.p.addScaledVector(s.v, dt);
      const k = Math.max(0, s.life / s.max);
      this.sPos[i * 3] = s.p.x; this.sPos[i * 3 + 1] = s.p.y; this.sPos[i * 3 + 2] = s.p.z;
      this.sCol[i * 3] = s.c.r * k; this.sCol[i * 3 + 1] = s.c.g * k; this.sCol[i * 3 + 2] = s.c.b * k;
    }
    this.sparks.geometry.attributes.position.needsUpdate = true;
    this.sparks.geometry.attributes.color.needsUpdate = true;
  }

  clear() {
    for (const d of this.dP) d.life = 0;
    for (const c of this.cP) c.life = 0;
    for (const s of this.sP) s.life = 0;
    for (let k = 0; k < CHIP_MAX; k++) this.chipMesh.setMatrixAt(k, this.zero);
    this.chipMesh.instanceMatrix.needsUpdate = true;
    this.dAlpha.fill(0);
  }
}
