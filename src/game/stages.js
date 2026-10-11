// 発掘現場（ステージ）。地層・化石・もろさ・電池・光の当たり方。
// layers は上から順に { to: その層の下端の深さ, col, hard }。最後の層は岩盤まで続く。
// tol：化石の許容衝撃（小さいほどもろい）。crust：骨のまわりの固い層（厚さ t m、硬さ hard）。
// battery：電池の量（打つ・払う・スキャンで減る）。light：光の当たり方（Env.setLight に渡す）

export const STAGES = [
  {
    id: 'ammonite', fossil: 'ammonite', seed: 101,
    battery: 150, tol: 0.42, crust: { t: 0.004, hard: 0.24, cover: 0.3 }, nodules: 4,
    layers: [
      { to: -0.022, col: 0x9a7b58, hard: 0.1 },
      { to: -0.07, col: 0xc9aa7d, hard: 0.15 },
      { to: -0.098, col: 0x9c968a, hard: 0.24 },
      { to: -0.31, col: 0xd2c1a0, hard: 0.26 },
      { to: -1, col: 0xb4ae9f, hard: 0.8 },
    ],
    boneCol: 0x7a5636, boneCol2: 0xa98058, shellCol: 0x8c6a47, irid: 0.6, crustCol: 0x9a6a40, noduleCol: 0x77706a, dustCol: 0xd8c5a2,
    light: 'morning',
  },
  {
    id: 'trilobite', fossil: 'trilobite', seed: 202,
    battery: 150, tol: 0.34, crust: { t: 0.004, hard: 0.34, cover: 0.4 }, nodules: 6,
    layers: [
      { to: -0.02, col: 0x8b7b66, hard: 0.1 },
      { to: -0.075, col: 0xa3a19a, hard: 0.18 },
      { to: -0.13, col: 0x7a7b78, hard: 0.25 },
      { to: -0.3, col: 0x6a6c6e, hard: 0.27 },
      { to: -1, col: 0x52545a, hard: 0.85 },
    ],
    boneCol: 0x2d2b2c, boneCol2: 0x46413d, carapaceCol: 0x262426, toothCol: 0x5a5048, noduleCol: 0x5b4f45, dustCol: 0xb7b5ae,
    light: 'noon',
  },
  {
    id: 'fish', fossil: 'fish', seed: 303,
    battery: 200, tol: 0.31, crust: { t: 0.004, hard: 0.32, cover: 0.35 }, nodules: 6,
    layers: [
      { to: -0.02, col: 0x8f7552, hard: 0.1 },
      { to: -0.065, col: 0xd5c09a, hard: 0.17 },
      { to: -0.11, col: 0xe6d9bb, hard: 0.24 },
      { to: -0.3, col: 0xdccaa6, hard: 0.27 },
      { to: -1, col: 0xbcab8a, hard: 0.85 },
    ],
    boneCol: 0x5e3418, boneCol2: 0x8a5528, toothCol: 0x3a2414, noduleCol: 0x9b8566, dustCol: 0xeee2c8,
    light: 'afternoon',
  },
  {
    id: 'trex', fossil: 'trex', seed: 404,
    battery: 280, toolScale: 1.15, tol: 0.36, crust: { t: 0.005, hard: 0.36, cover: 0.45 }, nodules: 9,
    layers: [
      { to: -0.03, col: 0x6e5a45, hard: 0.1 },
      { to: -0.09, col: 0xb08d63, hard: 0.17 },
      { to: -0.14, col: 0x7c6a5c, hard: 0.26 },
      { to: -0.33, col: 0xab8c68, hard: 0.28 },
      { to: -1, col: 0x8a7660, hard: 0.85 },
    ],
    boneCol: 0x46322a, boneCol2: 0x6e4c34, toothCol: 0x2a201a, noduleCol: 0x6b4a33, dustCol: 0xcdb48e,
    light: 'sunset',
  },
  {
    id: 'raptor', fossil: 'raptor', seed: 505,
    battery: 300, toolScale: 1.22, tol: 0.33, crust: { t: 0.005, hard: 0.35, cover: 0.42 }, nodules: 12,
    layers: [
      { to: -0.03, col: 0xd08a5a, hard: 0.08 },
      { to: -0.1, col: 0xc2714a, hard: 0.16 },
      { to: -0.15, col: 0xa85a3c, hard: 0.26 },
      { to: -0.34, col: 0xb9694a, hard: 0.28 },
      { to: -1, col: 0x8e4d36, hard: 0.85 },
    ],
    boneCol: 0xd9ccb3, boneCol2: 0xb8a68a, toothCol: 0x6f5a48, noduleCol: 0x7d4a35, dustCol: 0xe3a77a,
    light: 'dusk',
  },
];

export const stageById = (id) => STAGES.find((s) => s.id === id) || STAGES[0];
