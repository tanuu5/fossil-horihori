// iOS Safari で、ゲーム中のピンチやダブルタップで画面が拡大されてしまうのを止める
// （viewport の user-scalable=no は iOS では効かない）。設定画面のつまみなどは普通に動く。
// ボタンの上のダブルタップも止める（シグナル・ジレンマで、ボタンを素早く 2 回押すとページが拡大され、ピンチも止めてあるので戻せなくなった）。
// 止めるのは 2 回目のタップだけなので、1 回目の click は届く。
export function preventZoom() {
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  let last = 0;
  document.addEventListener('touchend', (e) => {
    const now = performance.now();
    if (now - last < 320 && !e.target.closest?.('input, select, textarea')) e.preventDefault();
    last = now;
  }, { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  // それでも拡大されてしまったら（ほかの経路で）、元の大きさに戻す。ピンチを止めてあるので、自分では戻せないため。
  // viewport に一度だけ maximum-scale=1 を足すと、iOS Safari は拡大を戻す
  const vv = window.visualViewport;
  const meta = document.querySelector('meta[name="viewport"]');
  if (vv && meta) {
    const base = meta.content;
    let busy = false;
    vv.addEventListener('resize', () => {
      if (busy || !(vv.scale > 1.02)) return;
      busy = true;
      meta.content = `${base}, maximum-scale=1`;
      setTimeout(() => { meta.content = base; busy = false; }, 400);
    });
  }
}
