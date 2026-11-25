// ピン留め：押したセッションを一覧とサイドメニューの先頭に留めておく。いくつでも留められる。
// どのブラウザから見ても同じになり、再起動しても消えないよう、ファイルに持つ。
// 形：{ "<一覧のキー>": <留めた時刻>, ... }。別端末のセッションのキーは "<端末名>::<セッションID>"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Pins {
  constructor(file) {
    this.file = file;
    this.map = {};
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (j && typeof j === "object" && !Array.isArray(j)) {
        for (const [k, v] of Object.entries(j)) if (typeof v === "number") this.map[k] = v;
      }
    } catch {}
  }

  at(key) {
    return this.map[key] ?? null;
  }

  // 留める（on=true）／外す（on=false）。変わったときだけ書き込んで true を返す
  set(key, on, now = Date.now()) {
    if (on ? key in this.map : !(key in this.map)) return false;
    if (on) this.map[key] = now;
    else delete this.map[key];
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.map, null, 2) + "\n");
    return true;
  }
}
