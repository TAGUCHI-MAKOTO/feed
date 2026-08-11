# MyFeed

ブラウザ拡張として動作するローカル完結型フィードリーダーです。

## Current Version

**v0.2.1**

## v0.2.1

### 読み終わったら次へ自動移動

- 表示中フィードの未読が0件になったら、同じフォルダ内の次の未読フィードへ自動移動
- 同じフォルダ内に未読フィードがなくなったら、次の未読フォルダへ自動移動
- フォルダ表示中にそのフォルダが全既読になった場合も、次の未読フォルダへ移動
- 「表示中を既読」でも同じ自動送りが動作
- 全フィードを読み終えた場合は完了メッセージを表示

### 重複判定を本文対応へ強化

従来の URL / タイトル類似判定を高速な第1段階として維持し、その後に本文情報を使う第2段階を追加しています。

1. RSS / Atom の `description` / `content` とタイトルを複合比較
2. それでも判定が曖昧な候補だけ記事ページ本文を取得
3. 本文は保存せず、比較用の64bit SimHashシグネチャだけをIndexedDBへキャッシュ
4. 本文取得は最大10記事、3並列、候補18ペアまでに制限して更新速度を維持
5. 同一配信元の記事同士は誤判定を避けるため条件を厳しく設定
6. Google Newsは取得できる場合、外部記事ページまで追跡して本文判定

重複と判定した記事は削除せず、従来どおり代表1件を残して他の記事を自動既読にします。

## v0.2.0 クリーン構成

旧 `dashboard-1.js` ～ `dashboard-14.js` / `style-v*.css` の履歴別ファイルは廃止し、最新版コードだけを用途別ファイルへ整理しています。

### JavaScript

- `src/core-storage.js` : IndexedDB / 設定 / 共通状態
- `src/feed-parser.js` : RSS / Atom / RDF解析
- `src/dedupe.js` : 高速なURL / タイトル重複判定
- `src/dedupe-content.js` : RSS本文 / 記事本文による第2段階重複判定
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
- `src/reading-flow.js` : 全既読時の次フィード / 次フォルダ自動送り

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
- 全既読時の自動送り
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
