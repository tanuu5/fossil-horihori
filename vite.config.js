import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { devShot } from './dev/vite-plugin-dev-shot.js';

// タイトル画面の版表記（v1.0.0 · 2026.10.10）。版は package.json、日付は最後のコミットから取る。
// ビルドした日ではなくコミットの日にするのは、Pages で同じコミットを建て直しても日付がずれないようにするため。
// 日時は日本時間で書く（GitHub の Squash マージは UTC で記録されるので、そのままだと日付がずれることがある）。
function buildInfo() {
  const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const git = (args) => { try { return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const sec = Number(git('log -1 --format=%ct')) || Math.floor(Date.now() / 1000);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(sec * 1000)).map((x) => [x.type, x.value]));
  return { version, date: `${p.year}.${p.month}.${p.day}`, time: `${p.hour}:${p.minute}`, hash: git('rev-parse --short HEAD') };
}

// base: './' にしておくと、GitHub Pages のサブパス（/<repo>/）でもそのまま動く。
// devShot：開発サーバーだけで使う画像の保存口（window.__dev.shot() → shots/）。公開ビルドには入らない。
export default defineConfig({
  base: './',
  plugins: [devShot()],
  define: { __BUILD__: JSON.stringify(buildInfo()) },
  server: { host: '127.0.0.1', port: 5181, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
