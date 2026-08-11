# MyFeed

ブラウザ拡張として動作するローカル完結型フィードリーダーです。

## Current Version

**v0.2.0**

## v0.2.0 クリーン構成

旧 `dashboard-1.js` ～ `dashboard-14.js` / `style-v*.css` を廃止し、最新版コードだけを用途別ファイルへ整理しています。

- `src/dashboard-core.js` : 基本状態・DB・フィード解析・高速更新の基盤
- `src/dashboard-health.js` : フィードヘルスチェック
- `src/dashboard-render.js` : 左カラム・記事描画
- `src/dashboard-data.js` : 画像・カテゴリ・バックアップ
- `src/dashboard-events.js` : UIイベント・D&D・初期化
- `src/dashboard-sources.js` : 1入力登録・RSS/RDF・YouTube・取得状態整合
- `src/dashboard-latest.js` : YouTube厳密検証・未読優先・Copilotページ分離
- `src/style.css` : 最新スタイルのみ

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
