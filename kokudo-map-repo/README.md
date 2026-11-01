# 道路マップ

国道・都道府県道・高速道路を見やすく表示する地図です。
全国の道路データを事前に地図タイル（PMTiles）に変換して GitHub Pages で配信するので、開いてすぐ表示されます。

- 国道の重用区間の色分け（単独・二重用・三重用・四重用以上）、起点・終点
- 道路標識風の番号表示、色覚に配慮した配色・線種の切り替え
- 路線番号・県名・通り名での検索と強調表示
- SA・PA（敷地内の設備つき）、道の駅（設備18項目つき）
- データは毎月自動で最新の OpenStreetMap に更新

## 公開までの手順（初回だけ）

1. **リポジトリを作る**
   GitHub の右上「＋」→「New repository」。名前は例えば `kokudo-map`、公開範囲は **Public** を選んで作成します。
   （無料プランの GitHub Pages は Public リポジトリのみ使えます）

2. **ファイルをアップロード**
   作ったリポジトリの画面で「uploading an existing file」をクリックし、このフォルダの中身
   （`.github`、`scripts`、`web`、`README.md`）をまとめてドラッグ＆ドロップ →「Commit changes」。
   ※ `.github` フォルダも忘れずに入れてください（自動処理の設定が入っています）。

3. **GitHub Pages を有効にする**
   リポジトリの「Settings」→ 左の「Pages」→「Build and deployment」の Source を **GitHub Actions** にします。

4. **地図タイルを作る**
   「Actions」タブ →「道路タイルを作成して公開」→「Run workflow」→ 緑の「Run workflow」。
   全国のデータをダウンロードして変換するので、**30分〜1時間ほど**かかります。

5. **開く**
   完了すると `https://ユーザー名.github.io/リポジトリ名/` で見られます。
   例：`https://yohey-ootan.github.io/kokudo-map/`

以降は毎月2日の早朝に自動で最新データに更新されます。

## Androidでアプリとして使う

1. Android の Chrome で公開ページ（`https://ユーザー名.github.io/リポジトリ名/`）を開く
2. 右上の「︙」→「アプリをインストール」（または「ホーム画面に追加」）
3. ホーム画面に「道路マップ」のアイコンができ、アドレスバーのない全画面のアプリとして起動します

アプリ本体は端末に保存されるので、2回目以降はすぐ起動します。Webアプリを更新すると、次に開いたときに自動で新しい版になります。

## ファイル構成

| パス | 内容 |
|---|---|
| `.github/workflows/build.yml` | データのダウンロード → 変換 → 公開を自動で行う設定 |
| `scripts/build.py` | 重用区間・起点終点・都道府県・SA/PA設備・検索用索引を計算 |
| `web/index.html` | 地図アプリ本体（道の駅データも組み込み済み） |
| `web/manifest.webmanifest`・`web/sw.js`・`web/icons/` | Androidにアプリとしてインストールするための設定とアイコン |

## 処理の流れ

1. Geofabrik から日本全体の OpenStreetMap データ（約2GB）をダウンロード
2. `osmium` で道路・路線（relation）・都道府県境界・SA/PA・設備だけに絞り込み
3. `build.py` で重用区間などを計算し、GeoJSON と `index.json`（検索用）を出力
4. `tippecanoe` で地図タイル `japan-roads.pmtiles` に変換（数十〜百数十MB程度の見込み）
5. `web/` の中身と一緒に GitHub Pages に公開

地図アプリは見ている範囲のタイルだけを読み込むので、ファイル全体をダウンロードすることはありません。

## Webアプリだけ直したいとき

`web/index.html` を書き換えてコミットすると、タイルは作り直さずに公開中のものを使い回して、数分で反映されます。

## 出典・ライセンス

- 道路・SA/PA：© OpenStreetMap contributors（ODbL）
- 背景地図：地理院タイル（淡色地図）
- 道の駅の情報：全国「道の駅」連絡会 公式ホームページ（https://www.michi-no-eki.jp/）
  ※ 公式サイトの情報を集めて組み込んでいます。広く公開する場合は、同サイトの利用条件を確認してください。
