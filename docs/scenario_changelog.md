# シナリオ変更履歴

> チャットボットのA/Bテストシナリオの変更を記録する。
> 変更時は `scenario.json` / `scenario_b.json` の `_meta.scenario_version` も更新すること。

---

## 2026-04-07 — A/Bテスト管理基盤導入

### 変更内容
- experiment_id / scenario_version によるバージョン管理を導入
- widget.js の振り分けを配列ベースに汎用化（weight正規化付き）
- CRM患者詳細に「シナリオ」表示欄を追加

### 現在のシナリオ構成
| variant | ファイル | 概要 |
|---|---|---|
| A案 | `scenario.json` | 選択肢ベース（radio/checkbox）の厳密フロー |
| B案 | `scenario_b.json` | 自由記述ベース（textarea）の柔軟フロー |

### 運用方針
- 同時テストは2案まで（勝ち案 vs 新案の順次テスト）
- experiment_id: `intake_flow`
- scenario_version: `2026-04-07`

---

## 2026-03-31 — A/Bテスト初回リリース

### 変更内容
- A案（選択肢ベース）とB案（自由記述ベース）を本番リリース
- widget.js で 50:50 ランダム振り分け
- chat_sessions.variant に記録開始

### 背景・目的
- 問合せフォームの入力方式で離脱率に差が出るか検証するため
- A案: 選択肢で迷わず進められる → 入力ハードルが低い
- B案: 自由記述で詳細を聞ける → ヒアリング精度が上がる
