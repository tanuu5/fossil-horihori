// localStorage への保存。プライベートモードや容量切れで例外が出ても、ゲームは止めない。
// 版（version）が変わったら古いデータは捨てて既定値に戻す（形を変えたときの事故よけ）。
//   const store = createStore('fossil-horihori.save', { best: 0 }, 1);
//   store.data.best = 10; store.save();

export function createStore(key, defaults, version = 1) {
  let data = structuredClone(defaults);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === version && parsed.data && typeof parsed.data === 'object') data = merge(data, parsed.data);
    }
  } catch { /* 読めなければ既定値 */ }
  return {
    data,
    save() {
      try { localStorage.setItem(key, JSON.stringify({ v: version, data: this.data })); return true; } catch { return false; }
    },
    reset() {
      this.data = structuredClone(defaults);
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    },
  };
}

// 既定値の形を保ったまま、保存されていた値を重ねる（増えた項目は既定値、型の違う値は捨てる）
function merge(base, over) {
  for (const k of Object.keys(base)) {
    if (!(k in over)) continue;
    const b = base[k];
    const o = over[k];
    if (b && typeof b === 'object' && !Array.isArray(b)) base[k] = merge(b, o && typeof o === 'object' ? o : {});
    else if (typeof o === typeof b || b === null) base[k] = o;
  }
  return base;
}
