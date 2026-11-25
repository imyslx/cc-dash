# ADR（設計判断の記録）

| 番号 | 内容 | 状態 |
| --- | --- | --- |
| [0001](0001-transcript-as-source-hooks-for-state.md) | 本体データは会話記録から読み、フックは状態変化だけを記録する | 採用 |
| [0002](0002-status-by-whose-turn.md) | 状態の札は「誰の番か」で決める | 採用 |
| [0003](0003-two-stage-highlight-extraction.md) | 大事なことの抽出はルール → Haiku の2段構えにする | 採用 |
| [0004](0004-local-zero-deps-in-memory.md) | ローカル完結・外部ライブラリなし・状態はメモリ上に持つ | 採用（一部 0005 で置き換え） |
| [0005](0005-multi-device-pull-over-tailscale.md) | 複数端末は Tailscale 内の pull 型で集約する | 採用 |

新しい判断を足すときは、次の形で `000N-<短い名前>.md` を作る。

```markdown
# ADR-000N: <決めたこと>

- 状態: 提案 / 採用 / 置き換え（ADR-000X）
- 日付: YYYY-MM-DD

## 背景
## 検討した案
## 決定
## 理由
## 影響
```
