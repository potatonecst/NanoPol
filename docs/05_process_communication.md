# 05. プロセス間連携と動的ポート割り当て (Process Communication)

本アプリケーションは、フロントエンド(React/Tauri)とバックエンド(Python/FastAPI)が完全に分離したハイブリッド構成を採用しています。これらが確実かつ安全に通信を確立するための高度な連携アーキテクチャについて解説します。

## 1. 動的ポート割り当て (本番環境)

通常、Webサーバーは特定のポート番号（例: 8000番）を決め打ちで利用しますが、ユーザーのPCでそのポートが既に別のソフトで使用されていた場合、アプリケーションは起動に失敗します。
この致命的な問題を回避し、どんな環境でも確実にサーバーを起動させるため、**「OSに空きポートを探させる動的ポート割り当て」** を採用しています。

### 処理フロー (すれ違いのない確実なハンドシェイク)

1.  **【Python】空きポートの確保**:
    バックエンド(`main.py`)は起動時、`socket`ライブラリを使って「完全に空いているポート」をOSに尋ねます。
    ```python
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))  # ポート0を指定すると、OSが自動で空きポートを割り当てる
    port = sock.getsockname()
    sock.close() # 【重要】一度ソケットを閉じて席を立ち、Uvicornに席を譲る
    ```

2.  **【Python】ポートの通知**:
    確定したポート番号を特別な目印と共に通知します。
    ```python
    print(f"[PORT] {port}", flush=True)                   # 標準出力
    print(f"[PORT] {port}", file=sys.stderr, flush=True)  # 保険として標準エラー
    uvicorn.run(app, port=port)
    ```

3.  **【Rust】Sidecarの監視と共有メモリ**:
    Tauriアプリ(`src-tauri/src/lib.rs`)はPythonをSidecarとして子プロセス起動し、標準出力と標準エラーを常に監視（パイプ）しています。
    `[PORT] xxxxx` という文字列を検知すると、ポート番号を抽出し、`tauri::State`（アプリ内の共有メモリ）に保存します。
    実装では重複イベントに備え、未設定時のみ書き込みます。
    さらに、`PYTHONUNBUFFERED=1` を付与してログの遅延を減らし、ポート通知の取りこぼしを避けます。

4.  **【React】ポート番号の問い合わせと接続**:
    フロントエンド(`App.tsx`)は起動直後から、0.5秒おきにRustへ「ポート番号はもう判明した？」とポーリングを繰り返します。
    Rustから返答がない場合は、同じ試行の中で AppData の `backend_port.json` を読み、候補ポートに対して `/health` を 1 回だけ probe します。
    返事が来た瞬間、またはヒント経由の probe が成功した瞬間に APIクライアントの接続先(`client.ts` の `setApiBase`)を動的に書き換え、通信を確立します。

## 2. ハイブリッド構成 (開発時と本番時の両立)

開発中はPythonコードを修正しながら動作確認するため、毎回`.exe`等の実行ファイルをビルドするのは非効率です。そのため、ターミナルから手動で `uv run main.py` を起動する開発フローをサポートしています。
この場合、Tauri(Rust)はPythonの起動に関与しないため、動的ポートの仕組みが使えません。そこで、**起動方法に応じてポートの割り当て方を切り替える**ハイブリッド構成を実装しています。

### 起動方法の判定 (`NANOPOL_APP_DATA_DIR`)

TauriがSidecarとしてPythonを起動する際、環境変数 `NANOPOL_APP_DATA_DIR` を渡します。Python側はこの環境変数の有無で「自分がどうやって起動されたか」を判定します。

```python
is_tauri = os.getenv("NANOPOL_APP_DATA_DIR") is not None

if is_tauri:
    port = find_free_port() # Tauriからの起動: 動的ポート割り当て
else:
    port = 14201            # 手動起動: 固定ポート (開発モード)
```

Tauri 経由で起動した場合、Python は確定したポート情報を AppData に `backend_port.json` として書き出します。React 側はこのヒントを保険として使いますが、採用前に必ず `/health` を probe して、古い値や壊れたファイルを弾きます。

## 3. フロントエンドの賢いフォールバック (すれ違いバグの防止)

React側は、Rustからポート番号が一定時間返ってこない場合、自動的に固定ポート(`14201`)へ接続を試みる「フォールバック」を行います。この時の「待ち時間（タイムアウト）」は、環境によって最適化されています。

- **開発環境 (`DEV === true`)**: `get_backend_port` が返らない場合は最大10回、0.5秒間隔で再試行します。合計約5秒です。ヒント経由の復旧も毎回同じ試行の中で確認します。
- **本番環境 (`DEV === false`)**: `get_backend_port` が返らない場合は最大240回、0.5秒間隔で再試行します。合計約120秒です。PyInstaller等でビルドされた実行ファイルは、初回起動時の解凍やウイルススキャンで大きく遅延する場合があります。

また、`invoke("get_backend_port")` の例外処理は環境ごとに分岐します。

- **DEV:** Tauri未起動ブラウザ実行を想定し、固定ポートへ即フォールバック。
- **PROD:** Tauri IPC準備遅延の可能性を考慮し、即フォールバックせず、次のポーリングで IPC とヒントの両方を再試行します。

この分岐により、実機環境での「バックエンドは起動済みだが、ポート受け渡しが遅れて Offline のまま」というすれ違いを抑制します。

## 4. ログファイルの保存場所の切り替え

前述の環境変数 `NANOPOL_APP_DATA_DIR` は、ログの保存先の決定にも利用されます。
- **Tauri経由 (本番)**: OS標準の安全なアプリケーションデータディレクトリ（Windows: `AppData/Roaming/...`, macOS: `Library/Application Support/...`）
- **手動起動 (開発)**: ユーザーのホームディレクトリ直下の隠しフォルダ (`~/.nanopol/logs/`)

## 5. 接続トラブル時の最短切り分け

1. `system.log` に `[SYSTEM] Backend Starting...` が出ているか確認する。
2. `frontend_connection_trace.log` に `startHealthChecks source=... port=...` が出ているか確認する。
3. backend に `[HEALTH] GET /health origin=... host=...` が出るか確認する。

### 5.1 判定マトリクス（重要）

*   **frontend trace あり / backend `[HEALTH]` なし**:
    *   ポート不一致、またはWebView側で送信前に失敗している可能性。
*   **frontend trace あり / backend `[HEALTH]` あり / frontend は `Failed to fetch`**:
    *   リクエスト自体は到達している。
    *   失敗点は「レスポンスの受理・公開」側（CORS判定、WebView制約、fetch挙動差）である可能性が高い。
*   **両方あり / その後 success に遷移**:
    *   一時的遅延。再試行ロジックで自己修復している。

### 5.2 追加の確認ポイント

*   AppData の `backend_port.json` と `[HEALTH] ... host=127.0.0.1:<port>` が一致しているか。
*   `client.ts` の共通 `request()` で以下が有効になっているか。
    *   GET時に不要な `Content-Type` を付けない
    *   `mode: "cors"`, `credentials: "include"` を明示

上記が一致していても `Failed to fetch` が継続する場合、次段の切り分けとして health チェック経路を `XMLHttpRequest` 実装で比較し、WebView固有の `fetch` 問題を除外します。