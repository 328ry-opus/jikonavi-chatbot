# LIFF相談フォーム

> **2026-08-10更新**: エンドポイントは **https://jiko-navi.jp/liff-form.html**（さくらサーバー・FTP配信）に変更済み。LIFF上部バーにjiko-navi.jpが表示される。**liff-form.htmlを変更したら `scripts/deploy-liff-form.sh` の実行が必要**（git pushだけでは本番に反映されない）。GitHub Pages側のコピーは残っているが本番導線からは未使用。
> LIFF ID: `2011041230-1Cb2lg53`／チャネルID: `2011041230`（公開済み・2026-08-10）

事故なびLINE公式アカウントのリッチメニューから開く相談フォームです。公開HTMLはGitHub Pages、送信処理はSupabase Edge Function `line-form` を使用します。

## LIFFアプリの設定

1. LINE Developersコンソールで、事故なびのLINE公式アカウントに紐づくLINE Loginチャネルを開きます。
2. 「LIFF」タブからLIFFアプリを追加します。
3. 次の内容を設定します。
   - LIFFアプリ名: `事故なび 交通事故相談`
   - サイズ: `Tall`
   - エンドポイントURL: `https://328ry-opus.github.io/jikonavi-chatbot/liff-form.html`
   - Scope: 選択なし（`profile` / `openid` / `email`は選択しない）
   - 連携するLINE公式アカウント: 事故なびの公式アカウント
4. 発行されたLIFF IDを、`liff-form.html`内の次の定数へ差し替えます。

```js
const LIFF_ID = '__LIFF_ID__';
```

差し替え箇所は1か所だけです。LIFF IDはチャネルシークレットではないため、HTML内で使用できます。

リッチメニューのアクションには、LIFFアプリのURL `https://liff.line.me/{LIFF_ID}` を設定します。エンドポイントURLを直接開いた場合やLIFF初期化に失敗した場合も、LINE User IDなしでフォームを送信できます。

## デプロイ

Supabaseプロジェクトへログイン済みの状態で、リポジトリ直下からEdge Functionを公開します。

```sh
supabase functions deploy line-form --no-verify-jwt
```

次の既存Secretsを使用します。

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`
- `CHAT_FORM_BLOCKED_PHONES`
- `GAS_NOTIFY_WEBHOOK_URL`
- `GAS_WEBHOOK_SECRET`

HTMLはGitHub Pagesの公開元ブランチへマージ後、通常どおりpushします。

```sh
git push origin main
```

公開後、次の2経路を確認します。

1. LINEのリッチメニューから開き、送信後に完了画面が表示されること
2. 通常ブラウザでエンドポイントURLを直接開き、LIFF情報なしでも送信できること

あわせて、`patients`の`channel / pref / area / address / notes`と、`line_message_log`の`status / patient_id`を確認します。
