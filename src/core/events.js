// 小さなイベントの受け渡し。ゲームの出来事（coin, hit, gameover …）を音や UI に知らせる。
//   const off = events.on('coin', (e) => audio.sfx('coin'));  events.emit('coin', { value: 1 });  off();

export class Emitter {
  constructor() { this.map = new Map(); }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name).add(fn);
    return () => this.map.get(name)?.delete(fn);
  }
  once(name, fn) { const off = this.on(name, (e) => { off(); fn(e); }); return off; }
  emit(name, e) {
    for (const fn of [...(this.map.get(name) || [])]) {
      try { fn(e); } catch (err) { console.error(`[events] ${name}:`, err); }
    }
  }
}

export const events = new Emitter();
