// 描画の土台：WebGLRenderer ＋ ポストエフェクト（RenderPass → Bloom → OutputPass → 仕上げ）＋ 画質。
//
// 画質（settings.quality）：high / medium / low は固定、auto は重いときに解像度を下げ、軽ければ戻す。
// 撮影（readme-showcase / motion-reel）では ?quality=high で固定する（auto のままだと撮るたびに解像度が変わる）。
//
// 仕上げのパス（FinishShader）：色調（暗部の持ち上げ・色味・彩度・コントラスト）、明るさの設定、周辺減光、色収差、
// フィルムの粒子、閃光・暗転・シネマの黒帯。NaN / Inf は黒に置き換える。
//   setLook({...})  場面ごとの見た目（変わったときだけ）　setFx({...})  毎フレーム変わる演出の値（暗転・閃光など）
//   before.push((renderer, scene, camera) => …)  本番の前にもう 1 回描くもの（鏡・水面の映り込みなど）
// 影は 1 フレームに 1 回だけ描く（before で描いても描き直さない）。統計（renderer.info）はフレームの頭でだけ戻すので、
// __dev.info() にシーン全体の三角形数・draw call が出る（自動で戻すと、最後の全画面パスの 1 枚ぶんしか残らない）。
// NaN が Bloom に入ると画面全体に広がって真っ黒になるので、その手前のシェーダーでも入力を守ること
// （pow の底は max(x, 0.0)、sqrt / log の引数は非負に、normalize は長さ 0 を避ける、割り算の分母に小さい値）。
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export const PRESETS = {
  high: { pixelRatio: 2, bloom: true, shadows: true, shadowSize: 2048, msaa: 4 },
  medium: { pixelRatio: 1.5, bloom: true, shadows: true, shadowSize: 1024, msaa: 2 },
  low: { pixelRatio: 1, bloom: false, shadows: false, shadowSize: 512, msaa: 0 },
};

const FinishShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.3 },
    uSaturation: { value: 1.05 },
    uContrast: { value: 1.03 },
    uGamma: { value: 1 },                              // 明るさの設定（1 が標準。小さいほど明るい）
    uLift: { value: new THREE.Color(0, 0, 0) },        // 暗部の持ち上げ（色つき）
    uGain: { value: new THREE.Color(1, 1, 1) },        // 全体の色味
    uGrain: { value: 0 },                              // フィルムの粒子
    uCA: { value: 0 },                                 // 色収差（画面の端ほど強い）
    uFlash: { value: 0 },                              // 閃光（0〜1）
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uFade: { value: 0 },                               // 暗転（1 で真っ黒）
    uFadeColor: { value: new THREE.Color(0, 0, 0) },
    uBars: { value: 0 },                               // シネマの黒帯（0〜1）
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uSaturation, uContrast, uGamma, uGrain, uCA, uFlash, uFade, uBars;
    uniform vec3 uLift, uGain, uFlashColor, uFadeColor;
    varying vec2 vUv;
    float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    vec3 safe(vec3 c) { return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : c; }   // NaN よけ（これ以上広げない）
    void main() {
      vec2 dc = vUv - 0.5;
      vec3 col;
      if (uCA > 0.0) {
        vec2 off = dc * dot(dc, dc) * uCA * 0.03;
        col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      } else col = texture2D(tDiffuse, vUv).rgb;
      col = clamp(safe(col), 0.0, 1.0);
      col = pow(max(col, vec3(0.0)), vec3(max(uGamma, 0.2)));
      col = uLift + col * (1.0 - uLift);
      col *= uGain;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;
      float r = length(dc * vec2(1.0, 0.85));
      col *= 1.0 - uVignette * smoothstep(0.35, 0.95, r);
      col = mix(col, uFlashColor, clamp(uFlash, 0.0, 1.0));
      col = mix(col, uFadeColor, clamp(uFade, 0.0, 1.0));
      if (uGrain > 0.0) {
        float seed = floor(uTime * 24.0);
        float g = hash12(gl_FragCoord.xy + seed * 17.13) + hash12(gl_FragCoord.xy * 1.37 + seed * 3.7) - 1.0;
        col += g * uGrain * (1.0 - smoothstep(0.0, 0.85, dot(col, vec3(0.3333))) * 0.6);   // 暗部と中間で強く
      }
      float bar = uBars * 0.11;
      if (vUv.y < bar || vUv.y > 1.0 - bar) col = vec3(0.0);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

export class Renderer {
  constructor(container, { quality = 'auto' } = {}) {
    const r = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false; // 影は render() で 1 フレームに 1 回だけ描く
    r.info.autoReset = false;       // EffectComposer は何回も描くので、info はフレームの頭で戻す
    container.appendChild(r.domElement);
    this.renderer = r;
    this.scene = null;
    this.camera = null;
    this.before = [];   // 本番の描画の前に呼ぶもの：(renderer, scene, camera) => void
    this.fx = {};       // setFx で渡した値（画質を変えても引き継ぐ）

    this.maxPixelRatio = Math.min(devicePixelRatio || 1, 2);
    this.composer = null;
    this._times = [];
    this._sinceAdjust = 0;
    this.setQuality(quality);
    addEventListener('resize', () => this.resize());
  }

  get domElement() { return this.renderer.domElement; }

  setScene(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    this.resize();
  }

  setQuality(q) {
    this.quality = q;
    const p = PRESETS[q === 'auto' ? 'high' : q] || PRESETS.high;
    this.preset = p;
    this.adaptive = q === 'auto';
    this.pixelRatio = Math.min(this.maxPixelRatio, q === 'auto' ? 1.5 : p.pixelRatio);
    this.minPixelRatio = 0.7;
    this.renderer.shadowMap.enabled = p.shadows;
    this._build(p);
    this.onQuality?.(p);
    this.resize();
  }

  /** 見た目の調整（露出・Bloom・仕上げ）。場面や時間帯が変わったときに呼ぶ。渡さなかった項目は既定値。 */
  setLook(look = {}) {
    const d = { exposure: 1, bloomStrength: 0.4, bloomRadius: 0.5, bloomThreshold: 0.9, vignette: 0.3, saturation: 1.05, contrast: 1.03,
      grain: 0, ca: 0, lift: [0, 0, 0], gain: [1, 1, 1] };
    const L = (this.look = { ...d, ...look });
    this.renderer.toneMappingExposure = L.exposure;
    if (this.bloom) Object.assign(this.bloom, { strength: L.bloomStrength, radius: L.bloomRadius, threshold: L.bloomThreshold });
    const u = this.finish.uniforms;
    u.uVignette.value = L.vignette;
    u.uSaturation.value = L.saturation;
    u.uContrast.value = L.contrast;
    u.uGrain.value = L.grain;
    u.uCA.value = L.ca;
    u.uLift.value.setRGB(...L.lift);
    u.uGain.value.setRGB(...L.gain);
  }

  /** 毎フレーム変わる演出の値：{ time, flash, flashColor, fade, fadeColor, bars, gamma }（渡したものだけ変わる）。 */
  setFx(v) {
    Object.assign(this.fx, v);
    const u = this.finish.uniforms;
    const num = { time: 'uTime', flash: 'uFlash', fade: 'uFade', bars: 'uBars', gamma: 'uGamma' };
    for (const [k, name] of Object.entries(num)) if (v[k] !== undefined && Number.isFinite(v[k])) u[name].value = v[k];
    if (v.flashColor) u.uFlashColor.value.set(v.flashColor);
    if (v.fadeColor) u.uFadeColor.value.set(v.fadeColor);
  }

  _build(p) {
    this.composer?.dispose();
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: p.msaa });
    this.composer = new EffectComposer(this.renderer, target);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloom = p.bloom ? new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.5, 0.9) : null;
    if (this.bloom) this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.finish = new ShaderPass(FinishShader);
    this.composer.addPass(this.finish);
    this.setLook(this.look);
    this.setFx(this.fx);
  }

  resize(w = innerWidth, h = innerHeight) {
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, true);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(w, h);
    if (this.camera?.isPerspectiveCamera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.onResize?.(w, h);
  }

  // 画質 auto：直近のフレーム時間の中央値で解像度を上げ下げする。
  // 裏に回ったときや、ブラウザ枠が隠れて rAF が間引かれたときの長いフレームは数えない（そこで下げると戻らない）。
  _adapt(dt) {
    if (!this.adaptive || document.hidden || !(dt > 0) || dt > 0.1) return;
    this._times.push(dt);
    this._sinceAdjust += dt;
    if (this._times.length > 90) this._times.shift();
    if (this._sinceAdjust < 2.5 || this._times.length < 60) return;
    const med = [...this._times].sort((a, b) => a - b)[this._times.length >> 1];
    let next = this.pixelRatio;
    if (med > 1 / 50) next = Math.max(this.minPixelRatio, this.pixelRatio - 0.15);
    else if (med < 1 / 70) next = Math.min(this.maxPixelRatio, this.pixelRatio + 0.1);
    if (Math.abs(next - this.pixelRatio) > 0.01) {
      this.pixelRatio = next;
      this._sinceAdjust = 0;
      this._times.length = 0;
      this.resize();
    }
  }

  render(dt = 1 / 60) {
    if (!this.scene || !this.camera) return;
    const r = this.renderer;
    r.info.reset();
    r.shadowMap.needsUpdate = true;
    for (const fn of this.before) fn(r, this.scene, this.camera);
    this.composer.render(dt);
    this._adapt(dt);
  }
}
