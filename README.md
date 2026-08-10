# MyFeed

ブラウザ拡張として動作するローカル完結型のフィードリーダーです。

## Current Version

**v0.1.10**

- WebサイトのRSS / Atom
- Google Newsの検索キーワード
- Xアカウント（Nitter RSS）
- IndexedDBへのローカル保存
- 72時間キャッシュ（お気に入りは保持）
- カスタムカテゴリ / ドラッグ移動 / フォルダ開閉
- 未読件数表示
- 重複記事のローカル類似判定と自動整理
- 画像付きカード / コンパクト表示
- ライト / ダーク / ブラウザ追従テーマ
- 上部操作エリア固定

## Edgeへの読み込み

1. このリポジトリをダウンロードまたはClone
2. Edgeで `edge://extensions/` を開く
3. 「開発者モード」をON
4. 「展開して読み込み」を選択
5. リポジトリ内の `src` フォルダを指定

## ファイル構成

- `src/manifest.json` : Edge拡張機能設定
- `src/service-worker.js` : 拡張機能アイコン押下時の画面起動
- `src/dashboard.html` : MyFeed画面
- `src/style-base.css` / `src/style-features.css` : デザイン
- `src/dashboard-1.js` ～ `src/dashboard-4.js` : フィード取得・表示・重複判定などの処理

> アイコンは検討中のため、v0.1.10では未実装です。
