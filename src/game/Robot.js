// 主人公のロボット「ホリボ」。浮かぶ卵形の体、顔は黒いバイザーに LED の目（canvas に描く）、
// 浮いた手で道具を持つ。道具の先がいつもカーソル（掘る場所）に来るように、手の位置を毎フレーム決める。
//
//   robot.update(dt, { target, charge, tool, active, camera, surfaceY })
//   robot.swing(P)        打つ（ためた出力で振り下ろす）
//   robot.emote('happy', 1.5)  表情（秒数のあいだ）
import * as THREE from 'three';
import { damp, clamp, lerp } from '../core/math.js';

const EYE = '#5ff4ff';
const EYE_WARN = '#ffd060';
const EYE_BAD = '#ff6a5a';
const HAMMER_DROP = 0.084; // つるはしの先から柄の線までの高さ

export class Robot {
  constructor() {
    const g = (this.group = new THREE.Group());
    g.name = 'robot';
    this.root = new THREE.Group(); // 体（浮遊の揺れ・傾き）
    this.root.name = 'body';
    g.add(this.root);

    const shell = new THREE.MeshPhysicalMaterial({ color: 0xe6dfd2, roughness: 0.34, clearcoat: 0.6, clearcoatRoughness: 0.25 });
    const accent = new THREE.MeshPhysicalMaterial({ color: 0xff7a2a, roughness: 0.4, clearcoat: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x30353d, roughness: 0.35, metalness: 0.6 });
    this.mats = { shell, accent, dark };

    // 体：卵形
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), shell);
    body.name = 'shell';
    body.scale.set(0.13, 0.145, 0.122);
    body.castShadow = true;
    this.root.add(body);
    // 帯（オレンジ）
    const band = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 12, 64), accent);
    band.name = 'band';
    band.rotation.x = Math.PI / 2;
    band.scale.set(0.128, 0.122, 0.128);
    band.position.y = -0.035;
    band.castShadow = true;
    this.root.add(band);
    // 顔（黒いバイザー＋LED）
    this.face = new FaceCanvas();
    const visorMat = new THREE.MeshPhysicalMaterial({
      color: 0x06090d, roughness: 0.12, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05,
      emissive: 0xffffff, emissiveMap: this.face.tex, emissiveIntensity: 2.4,
    });
    const visor = new THREE.Mesh(new THREE.SphereGeometry(1.025, 48, 24, Math.PI / 2 - 0.95, 1.9, Math.PI / 2 - 0.62, 1.0), visorMat);
    visor.name = 'visor';
    visor.scale.copy(body.scale);
    visor.position.y = 0.022;
    this.root.add(visor);
    // 耳（横の丸いポッド）
    for (const s of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.04, 0.03, 24), shell);
      pod.name = s < 0 ? 'earL' : 'earR';
      pod.rotation.z = Math.PI / 2;
      pod.position.set(0.128 * s, 0.03, -0.005);
      pod.castShadow = true;
      this.root.add(pod);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.012, 24), accent);
      cap.rotation.z = Math.PI / 2;
      cap.position.set(0.146 * s, 0.03, -0.005);
      this.root.add(cap);
    }
    // アンテナ
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.005, 0.08, 8), dark);
    ant.position.set(0.03, 0.17, -0.02);
    ant.rotation.z = -0.25;
    this.root.add(ant);
    this.antTipMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x5ff4ff, emissiveIntensity: 2.5 });
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 12), this.antTipMat);
    tip.position.set(0.04, 0.21, -0.02);
    this.root.add(tip);
    this.antTip = tip;
    // 背中の電池（LED の目盛り 5 つ）
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.03), dark);
    pack.position.set(0, 0.0, -0.118);
    this.root.add(pack);
    this.cells = [];
    for (let k = 0; k < 5; k++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.006), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x7dff8a, emissiveIntensity: 2 }));
      m.position.set(-0.024 + k * 0.012, 0.025, -0.134);
      this.root.add(m);
      this.cells.push(m);
    }
    // 浮遊のリング（下）
    const hov = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.075, 0.03, 32), dark);
    hov.position.y = -0.14;
    this.root.add(hov);
    this.ringMat = new THREE.MeshStandardMaterial({ color: 0x0a2a30, emissive: 0x45e0ff, emissiveIntensity: 2.2 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.008, 8, 40), this.ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.156;
    this.root.add(ring);
    // 噴射の光（下向きの円錐）
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 24, 1, true), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uT: { value: 0 }, uCol: { value: new THREE.Color(0x45e0ff) } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `uniform float uT; uniform vec3 uCol; varying vec2 vUv;
        void main() { float a = pow(clamp(vUv.y, 0.0, 1.0), 2.2) * (0.55 + 0.15 * sin(uT * 40.0 + vUv.x * 30.0)); gl_FragColor = vec4(uCol * a, a); }`,
    }));
    cone.rotation.x = Math.PI;
    cone.position.y = -0.27;
    this.cone = cone;
    this.root.add(cone);
    // 足元の光（地面に置く円）
    this.spot = new THREE.Mesh(new THREE.CircleGeometry(0.16, 32), new THREE.MeshBasicMaterial({
      map: radialTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0x45e0ff, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -4,
    }));
    this.spot.rotation.x = -Math.PI / 2;
    this.spot.renderOrder = 2;
    g.add(this.spot);

    // 手（浮いている）
    const handG = new THREE.SphereGeometry(1, 24, 16);
    this.handR = new THREE.Mesh(handG, shell);
    this.handR.scale.set(0.034, 0.03, 0.038);
    this.handR.castShadow = true;
    this.handL = new THREE.Mesh(handG, shell);
    this.handL.scale.copy(this.handR.scale);
    this.handL.castShadow = true;
    g.add(this.handR, this.handL);
    for (const h of [this.handR, this.handL]) {
      const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.18, 8, 24), accent);
      cuff.rotation.x = Math.PI / 2;
      cuff.position.y = 0.55;
      h.add(cuff);
    }

    // 道具
    this.toolRig = new THREE.Group(); // 手の位置。+Z がカーソルを向く
    g.add(this.toolRig);
    this.tools = { hammer: makeHammer(), chisel: makeChisel(), brush: makeBrush() };
    for (const t of Object.values(this.tools)) { t.visible = false; this.toolRig.add(t); }
    this.tool = 'hammer';
    this.tools.hammer.visible = true;
    this.root.scale.setScalar(0.82);
    this.handR.scale.multiplyScalar(0.85);
    this.handL.scale.multiplyScalar(0.85);

    // 状態
    this.t = 0;
    this.pos = new THREE.Vector3(0, 0.6, -0.4);
    this.vel = new THREE.Vector3();
    this.hand = new THREE.Vector3(0, 0.3, 0);
    this.lean = 0;
    this.swingT = -1;
    this.swingP = 0;
    this.recoil = 0;
    this.brushPhase = 0;
    this.expr = 'normal';
    this.exprT = 0;
    this.blinkT = 2;
    this.shake = 0;
    this.yaw = 0;
    this.mood = 'normal';
    this.hop = 0;
    this.spin = 0;
    this.battery = 1;
    this.status = 'ok';
    this.tipPos = new THREE.Vector3();
    this.idle = false;
  }

  setTool(name) {
    if (this.tool === name) return;
    this.tool = name;
    for (const [k, t] of Object.entries(this.tools)) t.visible = k === name;
  }

  emote(name, dur = 1.2) { this.expr = name; this.exprT = dur; }
  setMood(name) { this.mood = name; }
  swing(P) { this.swingT = 0; this.swingP = P; this._hitDone = false; }
  celebrate() { this.spin = 1; this.hop = 1; this.emote('star', 3); }
  startle() { this.hop = 0.6; this.emote('shock', 1.4); }

  /** 打撃の衝撃の瞬間か（swing を始めてから当たるまで）。 */
  get swinging() { return this.swingT >= 0 && this.swingT < 0.07; }

  update(dt, o) {
    this.t += dt;
    const t = this.t;
    const target = o.target;
    const charge = o.charge || 0;
    const tool = this.tool;
    // 浮かぶ位置：掘る場所の上・奥（カメラから見て向こう側）、少し右
    const back = new THREE.Vector3().subVectors(target, o.camera.position).setY(0);
    if (back.lengthSq() < 1e-6) back.set(0, 0, -1);
    back.normalize();
    const right = new THREE.Vector3(-back.z, 0, back.x);
    const lift = tool === 'brush' ? 0.3 : tool === 'chisel' ? 0.36 : 0.42;
    const zk = 1 - Math.min(1, this.zoom ?? 1); // 寄るほど、ロボットは奥・上へ（カメラの前をふさがない）
    const want = new THREE.Vector3().copy(target)
      .addScaledVector(back, 0.12 + charge * 0.06 + zk * 0.16)
      .addScaledVector(right, 0.26 + zk * 0.06)
      .add(new THREE.Vector3(0, lift + charge * 0.06 + zk * 0.08, 0));
    if (o.home) want.copy(o.home);
    want.y = Math.max(want.y, (o.surfaceMax ?? 0) + 0.3);
    // ばね（少し遅れてついてくる）
    const k = o.home ? 3 : 9;
    this.vel.addScaledVector(new THREE.Vector3().subVectors(want, this.pos), k * k * dt);
    this.vel.multiplyScalar(Math.exp(-2 * k * 0.9 * dt));
    this.pos.addScaledVector(this.vel, dt);
    // 浮遊の揺れ・ためているときの震え
    const bob = Math.sin(t * 2.4) * 0.012 + Math.sin(t * 5.3) * 0.004;
    const tremble = charge > 0.55 ? (charge - 0.55) * 0.02 : 0;
    this.shake = damp(this.shake, tremble, 20, dt);
    this.hop = Math.max(0, this.hop - dt * 1.6);
    const hopY = Math.sin(this.hop * Math.PI) * 0.12;
    this.root.position.set(
      this.pos.x + (Math.random() - 0.5) * this.shake * 2,
      this.pos.y + bob + hopY + (Math.random() - 0.5) * this.shake,
      this.pos.z + (Math.random() - 0.5) * this.shake * 2,
    );
    // 向き：掘る場所とカメラの間くらいを向く
    const toT = new THREE.Vector3().subVectors(target, this.pos).setY(0);
    const toC = new THREE.Vector3().subVectors(o.camera.position, this.pos).setY(0);
    toT.normalize(); toC.normalize();
    const look = toT.multiplyScalar(0.55).add(toC.multiplyScalar(0.45));
    let yawWant = Math.atan2(look.x, look.z);
    if (this.spin > 0) { this.spin = Math.max(0, this.spin - dt * 0.9); yawWant += (1 - this.spin) * Math.PI * 4; }
    this.yaw = this.spin > 0 ? yawWant : dampAngleLocal(this.yaw, yawWant, 6, dt);
    this.lean = damp(this.lean, -charge * 0.35 + this.recoil * 0.3 + clamp(-this.vel.z * 0.3, -0.2, 0.2), 10, dt);
    this.root.rotation.set(0, 0, 0);
    this.root.rotateY(this.yaw);
    this.root.rotateX(this.lean + 0.12);
    this.root.rotateZ(clamp(-this.vel.x * 0.4, -0.25, 0.25));

    // 道具を持つ手：道具ごとの位置（掘る場所からの相対）
    let handWant;
    const up = new THREE.Vector3(0, 1, 0);
    if (tool === 'hammer') handWant = new THREE.Vector3().copy(target).addScaledVector(back, 0.1).addScaledVector(right, 0.13).addScaledVector(up, 0.13);
    else if (tool === 'chisel') handWant = new THREE.Vector3().copy(target).addScaledVector(back, 0.05).addScaledVector(right, 0.03).addScaledVector(up, 0.135 + charge * 0.05);
    else handWant = new THREE.Vector3().copy(target).addScaledVector(back, 0.06).addScaledVector(right, 0.03).addScaledVector(up, 0.1);
    if (o.home) handWant.copy(this.pos).addScaledVector(right, 0.17).add(new THREE.Vector3(0, -0.06, 0)).addScaledVector(back, -0.05);
    this.hand.x = damp(this.hand.x, handWant.x, 22, dt);
    this.hand.y = damp(this.hand.y, handWant.y, 22, dt);
    this.hand.z = damp(this.hand.z, handWant.z, 22, dt);
    this.toolRig.position.copy(this.hand);
    const aim = tool === 'hammer' ? new THREE.Vector3(target.x, target.y + HAMMER_DROP, target.z) : target;
    this.toolRig.lookAt(o.home ? new THREE.Vector3().copy(this.hand).addScaledVector(back, -0.2).add(new THREE.Vector3(0, -0.15, 0)) : aim);

    // 振り：ハンマーは柄の付け根を軸に、頭を後ろへ上げてから振り下ろす
    let ang = 0, jab = 0, sweep = 0;
    if (this.swingT >= 0) {
      this.swingT += dt;
      const s = this.swingT;
      if (s < 0.07) { const u = s / 0.07; ang = lerp(-1.75 * this.swingP - 0.3, 0, u * u); jab = lerp(0.05 * this.swingP, -0.01, u * u); }
      else if (!this._hitDone) { this._hitDone = true; this.recoil = 0.4 + this.swingP * 0.6; }
      else if (s < 0.4) { const u = (s - 0.07) / 0.33; ang = -0.25 * Math.sin(u * Math.PI) * (0.5 + this.swingP); jab = 0.02 * Math.sin(u * Math.PI); }
      else this.swingT = -1;
    } else if (!o.home) {
      ang = -0.3 - 1.75 * charge + Math.sin(t * 3) * 0.04 * (1 - charge);
      jab = 0.012 + 0.05 * charge;
    }
    if (tool === 'brush' && o.active) { this.brushPhase += dt * 16; sweep = Math.sin(this.brushPhase) * 0.5; }
    this.recoil = damp(this.recoil, 0, 6, dt);
    const T = this.tools[tool];
    const dist = this.hand.distanceTo(aim);
    if (tool === 'hammer') {
      T.rotation.set(ang, 0, 0);
      T.userData.setLength(Math.max(0.08, dist));
    } else if (tool === 'chisel') {
      T.rotation.set(0, 0, 0);
      T.position.set(0, 0, Math.max(0, dist - 0.115) - jab * 1.2);
    } else {
      T.rotation.set(0, sweep * 0.6, 0);
      T.position.set(0, 0, Math.max(0, dist - 0.1));
    }
    if (o.home) { T.rotation.set(-0.6, 0, 0); T.position.set(0, 0, 0); if (tool === 'hammer') T.userData.setLength(0.14); }
    // 道具の先（粒子を出す場所）
    this.tipPos.copy(target);

    // もう一方の手：体の横で、ためると拳を握るように近づく
    const lh = new THREE.Vector3().copy(this.pos).addScaledVector(right, -0.17).addScaledVector(back, -0.03).add(new THREE.Vector3(0, -0.04 + Math.sin(t * 2.4 + 1) * 0.012 + charge * 0.04, 0));
    if (this.expr === 'star' || this.mood === 'happy') lh.y += 0.08 + Math.sin(t * 10) * 0.03;
    this.handL.position.set(damp(this.handL.position.x, lh.x, 12, dt), damp(this.handL.position.y, lh.y, 12, dt), damp(this.handL.position.z, lh.z, 12, dt));
    this.handR.position.copy(this.hand);
    this.handR.lookAt(target);
    this.handL.rotation.y = this.yaw;

    // 足元の光
    const sy = o.surfaceAt ? o.surfaceAt(this.pos.x, this.pos.z) : 0;
    this.spot.position.set(this.pos.x, sy + 0.004, this.pos.z);
    const hgt = Math.max(0.05, this.pos.y - sy);
    this.spot.scale.setScalar(0.6 + hgt * 1.2);
    this.spot.material.opacity = clamp(0.25 / (hgt * 2.2), 0.05, 0.25);
    this.cone.material.uniforms.uT.value = t;

    // 表情
    this.exprT -= dt;
    let expr = this.exprT > 0 ? this.expr : this.mood;
    if (this.exprT <= 0 && !o.home) {
      if (charge > 0.92) expr = 'strain';
      else if (charge > 0.04) expr = o.danger ? 'worried' : 'focus';
      else if (o.danger && o.tool !== 'brush') expr = 'worried';
    }
    this.blinkT -= dt;
    if (this.blinkT < 0) { this.blinkT = 2 + Math.random() * 3; }
    const blink = this.blinkT < 0.12 && (expr === 'normal' || expr === 'focus' || expr === 'worried');
    const col = o.danger ? (charge > (o.psafe ?? 2) ? EYE_BAD : EYE_WARN) : EYE;
    this.face.draw(blink ? 'blink' : expr, t, col, charge);
    // アンテナと背中の電池
    const st = o.danger ? (charge > (o.psafe ?? 2) ? 0xff4a3a : 0xffc23a) : 0x5ff4ff;
    this.antTipMat.emissive.setHex(st);
    this.antTipMat.emissiveIntensity = 2 + Math.sin(t * (o.danger ? 18 : 4)) * 0.8;
    const lit = Math.ceil(clamp(o.battery ?? 1) * 5 - 0.001);
    this.cells.forEach((c, i) => {
      c.material.emissive.setHex(i < lit ? (lit <= 1 ? 0xff5040 : lit <= 2 ? 0xffc23a : 0x7dff8a) : 0x000000);
    });
  }
}

function dampAngleLocal(a, b, l, dt) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-l * dt));
}

// ---------------------------------------------------------------- 道具の形
// どれも toolRig の +Z 方向（カーソル）に向かって伸びる
function makeHammer() {
  const g = new THREE.Group();
  g.name = 'hammer';
  const wood = new THREE.MeshStandardMaterial({ color: 0xa8743f, roughness: 0.6 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xb9c0c8, roughness: 0.28, metalness: 0.95 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x2d6fd0, roughness: 0.6 });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, 1, 12), wood);
  handle.rotation.x = Math.PI / 2;
  handle.castShadow = true;
  const gripM = new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0125, 0.05, 12), grip);
  gripM.rotation.x = Math.PI / 2;
  gripM.position.z = 0.02;
  // 頭：柄と直角。つるはし（-Y）が下を向いて当たる
  const head = new THREE.Group();
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.05, 0.03), steel);
  block.castShadow = true;
  const pick = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.06, 4), steel);
  pick.rotation.x = Math.PI;
  pick.position.y = -0.054;
  pick.castShadow = true;
  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.026, 16), steel);
  face.position.y = 0.036;
  face.castShadow = true;
  head.add(block, pick, face);
  g.add(handle, gripM, head);
  // 柄の長さを変える（手から「掘る場所の真上」まで）。頭のつるはしの先が掘る場所に届く
  g.userData.setLength = (L) => {
    const hl = Math.max(0.05, L);
    handle.scale.y = hl;
    handle.position.z = hl / 2;
    head.position.set(0, 0, hl);
  };
  g.userData.setLength(0.2);
  return g;
}

function makeChisel() {
  const g = new THREE.Group();
  g.name = 'chisel';
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9d0d8, roughness: 0.25, metalness: 0.95 });
  const grip = new THREE.MeshStandardMaterial({ color: 0xffb21a, roughness: 0.55 });
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.07, 12), steel);
  rod.rotation.x = Math.PI / 2;
  rod.position.z = 0.06;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.006, 0.02, 12), steel);
  tip.rotation.x = Math.PI / 2;
  tip.position.z = 0.105;
  const hdl = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.01, 0.05, 12), grip);
  hdl.rotation.x = Math.PI / 2;
  hdl.position.z = 0.0;
  for (const m of [rod, tip, hdl]) { m.castShadow = true; g.add(m); }
  return g;
}

function makeBrush() {
  const g = new THREE.Group();
  g.name = 'brush';
  const wood = new THREE.MeshStandardMaterial({ color: 0xd9a066, roughness: 0.5 });
  const hair = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.9 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xb08850, roughness: 0.3, metalness: 0.9 });
  const hdl = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.009, 0.07, 12), wood);
  hdl.rotation.x = Math.PI / 2;
  hdl.position.z = 0.02;
  const ferrule = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.01, 0.018), metal);
  ferrule.position.z = 0.062;
  const bristle = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.008, 0.032), hair);
  bristle.position.z = 0.085;
  for (const m of [hdl, ferrule, bristle]) { m.castShadow = true; g.add(m); }
  return g;
}

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------- 顔（LED の目）
class FaceCanvas {
  constructor() {
    const c = (this.canvas = document.createElement('canvas'));
    c.width = 256; c.height = 128;
    this.g = c.getContext('2d');
    this.tex = new THREE.CanvasTexture(c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.key = '';
  }

  draw(expr, t, col, charge) {
    // 動きのある表情だけ毎回描く。ほかは変わったときだけ
    const anim = expr === 'scan' || expr === 'strain' || expr === 'dizzy' || expr === 'star' || expr === 'sleep';
    const key = `${expr}|${col}|${anim ? Math.floor(t * 20) : ''}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.g;
    g.clearRect(0, 0, 256, 128);
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 128);
    g.save();
    g.shadowColor = col;
    g.shadowBlur = 14;
    g.fillStyle = col;
    g.strokeStyle = col;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const L = 92, R = 164, Y = 60;
    const rrect = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x - w / 2, y - h / 2, w, h, r); g.fill(); };
    const arc = (x, y, r, a0, a1, w = 9) => { g.lineWidth = w; g.beginPath(); g.arc(x, y, r, a0, a1); g.stroke(); };
    const line = (x0, y0, x1, y1, w = 9) => { g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
    switch (expr) {
      case 'blink': line(L - 14, Y + 4, L + 14, Y + 4); line(R - 14, Y + 4, R + 14, Y + 4); break;
      case 'happy': arc(L, Y + 10, 15, Math.PI * 1.1, Math.PI * 1.9); arc(R, Y + 10, 15, Math.PI * 1.1, Math.PI * 1.9); arc(128, Y + 28, 8, 0.2, Math.PI - 0.2, 6); break;
      case 'focus': rrect(L, Y + 4, 28, 16, 8); rrect(R, Y + 4, 28, 16, 8); line(L - 16, Y - 14, L + 12, Y - 10, 6); line(R + 16, Y - 14, R - 12, Y - 10, 6); break;
      case 'strain': {
        const j = Math.sin(t * 60) * 2;
        line(L - 14 + j, Y - 14, L + 10 + j, Y, 9); line(L + 10 + j, Y, L - 14 + j, Y + 14, 9);
        line(R + 14 - j, Y - 14, R - 10 - j, Y, 9); line(R - 10 - j, Y, R + 14 - j, Y + 14, 9);
        g.lineWidth = 5; g.beginPath(); for (let x = 108; x <= 148; x += 8) g.lineTo(x, Y + 32 + ((x / 8) % 2 ? 4 : -4)); g.stroke();
        break;
      }
      case 'worried': {
        rrect(L, Y + 6, 24, 30, 12); rrect(R, Y + 6, 24, 30, 12);
        line(L - 16, Y - 12, L + 12, Y - 20, 6); line(R + 16, Y - 12, R - 12, Y - 20, 6);
        g.beginPath(); g.moveTo(206, 30); g.quadraticCurveTo(214, 46, 206, 50); g.quadraticCurveTo(198, 46, 206, 30); g.fill();
        break;
      }
      case 'shock': arc(L, Y, 15, 0, Math.PI * 2, 7); arc(R, Y, 15, 0, Math.PI * 2, 7); rrect(128, Y + 32, 14, 14, 7); break;
      case 'sad': {
        arc(L, Y + 16, 14, Math.PI * 1.15, Math.PI * 1.85); arc(R, Y + 16, 14, Math.PI * 1.15, Math.PI * 1.85);
        g.globalAlpha = 0.85; rrect(L + 8, Y + 26, 6, 18, 3); rrect(R - 8, Y + 26, 6, 18, 3); g.globalAlpha = 1;
        arc(128, Y + 44, 9, Math.PI * 1.15, Math.PI * 1.85, 6);
        break;
      }
      case 'scan': {
        const x = 128 + Math.sin(t * 6) * 70;
        g.globalAlpha = 0.35; rrect(L, Y, 26, 36, 12); rrect(R, Y, 26, 36, 12); g.globalAlpha = 1;
        line(x, 24, x, 100, 6);
        break;
      }
      case 'dizzy': {
        for (const cx of [L, R]) { g.lineWidth = 6; g.beginPath(); for (let a = 0; a < 12; a += 0.3) { const r = a * 1.4; g.lineTo(cx + Math.cos(a + t * 8) * r, Y + Math.sin(a + t * 8) * r); } g.stroke(); }
        break;
      }
      case 'star': {
        const s = 1 + Math.sin(t * 10) * 0.1;
        for (const cx of [L, R]) star(g, cx, Y, 18 * s, 8 * s);
        arc(128, Y + 26, 10, 0.2, Math.PI - 0.2, 6);
        break;
      }
      case 'sleep': line(L - 14, Y + 4, L + 14, Y + 4); line(R - 14, Y + 4, R + 14, Y + 4); g.font = 'bold 22px sans-serif'; g.fillText('z', 200, 40 - (t * 10) % 12); break;
      default: rrect(L, Y, 26, 38, 13); rrect(R, Y, 26, 38, 13);
    }
    g.restore();
    // 走査線（LED らしさ）
    g.fillStyle = 'rgba(0,0,0,0.28)';
    for (let y = 0; y < 128; y += 4) g.fillRect(0, y, 256, 1.5);
    this.tex.needsUpdate = true;
  }
}

function star(g, x, y, R, r) {
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r : R;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}
