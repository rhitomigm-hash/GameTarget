# GameTarget

黄色いチェイスカーを運転し、自動で飛ぶ気球が落とすマーカーを回収するゲームです。

- 遊び方: https://rhitomigm-hash.github.io/GameTarget/
- すぐ走る: https://rhitomigm-hash.github.io/GameTarget/prototype/
- エリア・風・出発地点を選ぶ: prototype/?setup=1
- 気球を操縦する: https://rhitomigm-hash.github.io/SORA/prototype/

白は気球を追尾、青はターゲット付近へ先行・待機する同じチームの仲間です。
着地の瞬間に黄色い車がマーカーから30m以内なら回収成功。回収1,000点＋道路100mにつき1点（仮設定）。
WASD/矢印キーで運転、Vで視点、Pで風の表。スマホは画面の矢印を長押しします。

## ローカル確認

このリポジトリで python -m http.server 8000 --bind 127.0.0.1 を実行し、http://localhost:8000/ を開きます。
SORAは別途8002番で配信します。SORAリンクはローカル・公開環境に応じて切り替わります。

通常起動・?mode=chase は回収ゲーム。?setup=1・旧?dev=1 は回収用設定です。
移行前の操縦処理は内部確認用の ?mode=flight に保存しています。
旧ホームページの気球教室は balloon-guide.html に保持しています。
街並みと車内視点のSORAへの移行は後続工程です。

検証手順は experiments/chase-mode/README.md を参照してください。
