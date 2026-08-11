# MyFeed

ブラウザ拡張として動作するローカル完結型フィードリーダーです。

## Current Version

**v0.2.0**

## v0.2.0 クリーン構成

旧 `dashboard-1.js` ～ `dashboard-14.js` / `style-v*.css` の履歴別ファイルは廃止し、**v0.1.32までの最新版機能だけ**を用途別のファイルへ整理しています。

### JavaScript

- `src/core-storage.js` : IndexedDB / 設定 / 共通状態
- `src/feed-parser.js` : RSS / Atom / RDF解析
- `src/dedupe.js` : 重複話題の判定・整理
- `src/dashboard-health.js` : 6並列フィード取得・進捗メーター・フィード状態
- `src/source-icons.js` : サイトアイコン取得
- `src/source-nav-render.js` : フォルダ / フィードの左カラム描画
- `src/article-render.js` : 記事描画
- `src/image-enrichment.js` : 記事画像の遅延補完
- `src/category-backup.js` : カテゴリ管理・JSONバックアップ
- `src/app-events.js` : UIイベント・D&D
- `src/source-input.js` : 1入力欄の自動判定
- `src/source-discovery.js` : フィード登録・設定・初期化
- `src/health-reconcile.js` : 古い読込エラー状態の整合
- `src/youtube-category-ui.js` : YouTubeチャンネル対応・カテゴリUI
- `src/youtube-validation.js` : YouTube 24文字ID検証・一時エラー再試行
- `src/unread-copilot.js` : 未読優先ソート・Copilot向け実ページ遷移

### CSS

- `src/style-base.css` : 基本レイアウト
- `src/style-theme.css` : ライト / ダーク / システムテーマ
- `src/style-ui.css` : 記事・フォルダ・サイドバーUI
- `src/style-latest.css` : 最新のフィード登録・ヘルス表示・進捗メーター

## 主な機能

- RSS / Atom / RSS 1.0 RDF
- Google Newsキーワード
- X / Nitter RSS
- YouTubeチャンネルURL登録 + 24文字チャンネルID検証 + 一時エラー再試行
- 最大6フィード並列取得
- 進捗インジケーター / ETA / 成功・失敗・処理中表示
- フィード状態・記事の一括保存
- 72時間キャッシュ（お気に入り保持）
- 重複話題の自動整理
- 未読優先ソート（記事 / フィード / フォルダ）
- カスタムカテゴリ・D&D・未分類最上部固定
- カード / コンパクト表示、ライト / ダーク / システムテーマ
- JSONバックアップ / 復元
- Edge Copilot向けフィード別実ページ遷移

## Edgeへの読み込み

1. リポジトリをCloneまたはダウンロード
2. Edgeで `edge://extensions/` を開く
3. 開発者モードをON
4. 「展開して読み込み」
5. `src` フォルダを指定

> 配布ZIP版には緑のMF PNGアイコンを同梱しています。GitHubコネクタからはバイナリ画像を書き込めないため、リポジトリ版は実行コードを優先したテキスト完結構成です。画面内のMyFeedブランドはCSSで表示します。
