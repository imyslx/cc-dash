// 追記されていく JSONL を差分だけ読む。前回の読み取り位置と、行の途中で切れた残りを覚えておく。
import { open, stat } from "node:fs/promises";

export class JsonlTail {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    this.mtimeMs = 0;
  }

  async readNew() {
    let st;
    try {
      st = await stat(this.file);
    } catch {
      return [];
    }
    this.mtimeMs = st.mtimeMs;
    if (st.size < this.offset) {
      // 切り詰められた／作り直された → 最初から
      this.offset = 0;
      this.rest = Buffer.alloc(0);
    }
    if (st.size === this.offset) return [];

    const fh = await open(this.file, "r");
    try {
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, this.offset);
      this.offset = st.size;
      // 改行のバイト位置で切る（マルチバイト文字の途中で切らないため、残りは Buffer のまま持つ）
      const all = this.rest.length ? Buffer.concat([this.rest, buf]) : buf;
      const nl = all.lastIndexOf(0x0a);
      if (nl < 0) {
        this.rest = all;
        return [];
      }
      this.rest = all.subarray(nl + 1); // 最後の行は書き込み途中かもしれない
      const lines = all.subarray(0, nl).toString("utf8").split("\n");
      const out = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // 壊れた行は捨てる
        }
      }
      return out;
    } finally {
      await fh.close();
    }
  }
}
