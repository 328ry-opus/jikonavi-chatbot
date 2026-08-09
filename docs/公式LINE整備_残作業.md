# 公式LINE整備 残作業チェックリスト（2026-08-09時点）

フォーム構造化プロジェクトのLINE側最終工程。設計正本は `jikonavi-crm/docs/流入フォーム構造化_設計.md`。

## 済んでいるもの

- [x] `liff-form.html` GitHub Pages公開（LIFF IDはプレースホルダのまま動作可）
- [x] `line-form` EF 本番デプロイ（`--no-verify-jwt`）・E2E実送信テストパス
- [x] リッチメニュー画像 `assets/richmenu-2500x843.png`（HTML→スクショ生成。元は `assets/richmenu.html` 相当のscratch）
- [x] リッチメニュー投入用の一時EF `admin-richmenu-setup`（未デプロイ・使用時のみ）

## りゅうさん作業（LINE Developersコンソール）

1. https://developers.line.biz/console/ にsystem@のLINEビジネスIDでログイン
2. プロバイダー「株式会社Opus.net」→ 新規チャネル → **LINEログイン**
   - チャネル名: **事故なび**（同意画面に表示される。「LINE」を含む名前は不可）
   - その他の必須項目は任意（メール・説明など）
3. 作成したチャネル → **LIFFタブ → 追加**
   - LIFFアプリ名: 相談フォーム
   - サイズ: **Tall**
   - エンドポイントURL: `https://328ry-opus.github.io/jikonavi-chatbot/liff-form.html`
   - スコープ: **すべてチェックなし**（openid/profile不要。同意画面回避のため）
   - ボットリンク機能: On (Aggressive)ではなく **Off**（友だち追加は公式アカウント側で完了している前提）
4. 発行された **LIFF ID** をClaudeに伝える

## LIFF ID受領後のClaude作業

1. `liff-form.html` の `__LIFF_ID__` を差し替え → commit → push
2. 実機で `https://liff.line.me/{LIFF_ID}` を開き、**同意画面が出ないこと**を確認（出た場合は設計メモの保険案=postbackトークン方式に切替）
3. フォームから実機テスト送信 → patients に line_user_id 付きで入ることを確認 → テスト患者はゴミ箱へ
4. リッチメニュー投入: `admin-richmenu-setup/index.ts` の `__ONE_TIME_SECRET__`（ランダム生成）と `__LIFF_ID__` を差し替え → deploy → 画像をPOST → **EFを削除**
   ```bash
   supabase functions deploy admin-richmenu-setup --no-verify-jwt
   curl -X POST "https://dxbdqldfqlggsrpcjuwg.supabase.co/functions/v1/admin-richmenu-setup" \
     -H "x-admin-secret: <SECRET>" -H "Content-Type: image/png" \
     --data-binary @assets/richmenu-2500x843.png
   supabase functions delete admin-richmenu-setup
   ```
5. 旧リッチメニュー（OA Manager作成の電話のみ版）をOA Manager側で非表示化

## あいさつメッセージ差し替え案（りゅうさん承認後にOA Managerで設定）

現行の2通目（書式指定リスト）を廃止し、1通に統合:

```
友だち追加ありがとうございます😊

交通事故の無料相談を行っています。
ご紹介した治療院への通院で、お見舞金【最大50,000円🌸】を進呈します。

▼ご相談はこちらから（入力約2分）
https://liff.line.me/{LIFF_ID}

お急ぎの方は、下のメニューからお電話でもご相談いただけます📞
（24時間365日・通話無料）
```

## ステータスメッセージ案（未設定→設定する）

```
交通事故の無料相談｜24時間受付
```

## その他（このプロジェクト外だが推奨）

- アカウント認証の申請（無料・LINE内検索に出るようになる）→ OA Manager「アカウント設定」から。事業証明が要るのでりゅうさん作業
- line-webhook に「フォーム誘導の自動応答」を足す改修は、LIFF ID確定後の別タスク（設計メモ参照）
