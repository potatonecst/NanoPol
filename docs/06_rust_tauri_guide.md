# 06. Rust & Tauri 基礎ガイド (Rust & Tauri Guide)

本プロジェクトでは、デスクトップアプリのウィンドウ枠とバックエンド（Python）の自動起動を **Tauri (Rust)** が担っています。

Rustは非常に安全で高速な言語ですが、他の言語にはない独自の概念を持っています。このガイドでは、Rustの言語仕様をゼロから学ぶのではなく、**このプロジェクトの `src-tauri/src/lib.rs` を読んで修正するために必要な「最低限の知識」** に絞って解説します。

---

## 1. 変数はデフォルトで「変更不可」 (`mut`)

TypeScriptの `const` や `let` に似ていますが、Rustでは `let` で宣言した変数は**後から中身を変更できません（イミュータブル）**。変更したい場合は明示的に `mut` (mutable) をつけます。

```rust
// lib.rs の記述
let (mut rx, child) = sidecar_command.spawn().expect(...);
```

*   **なぜ `mut rx` なのか？**
    `rx` はPythonからのログを受け取る「受信機（レシーバー）」です。ログを受信するたびに「未受信のログリスト」という内部状態が変化するため、`mut` をつける必要があります。
*   **なぜ `child` は `mut` ではないのか？**
    `child` は起動したPythonプロセスの「ハンドル（識別札）」です。プロセスを維持するだけで、ハンドルの中身自体を書き換えることはないため `mut` は不要です。

---

## 2. エラーと「空っぽ」の安全な扱い (`Option`, `Result`)

Rustには `null` や `undefined`、また `try-catch` という概念が存在しません。代わりに、**「失敗するかもしれない処理」や「空かもしれない値」を専用の箱（型）に入れて扱います**。

### 2.1 `Option` 型（空かもしれない箱）
中身がある場合は `Some(値)`、空の場合は `None` になります。

```rust
// ポート番号は最初は分からないので、空の可能性がある Option<u16> の箱に入れます。
struct BackendPort(Mutex<Option<u16>>);

// アプリ起動直後は空っぽ (None) を入れておく
app.manage(BackendPort(Mutex::new(None)));

// Pythonからポート番号(例: 54321)が流れてきたら、値を入れる (Some)
*state.0.lock().unwrap() = Some(54321);
```

### 2.2 `Result` 型（失敗するかもしれない箱）
成功した場合は `Ok(値)`、失敗した場合は `Err(エラー内容)` になります。

### 2.3 箱の開け方 (`unwrap`, `expect`)
箱の中身を無理やり取り出すメソッドです。
もし中身が `None` や `Err` だった場合、**アプリはその瞬間にクラッシュ（パニック）して強制終了**します。

```rust
let app_data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
```

*   **なぜ使うのか？**
    通常は安全に取り出す処理（`match` や `if let`）を書きますが、アプリの起動時において「OSのデータフォルダが取得できない」「Pythonが起動できない」といった事態は致命的であり、そのまま進めても意味がないため、`expect("エラーメッセージ")` を使って意図的にクラッシュさせるのが定石です。

---

## 3. 共有メモリとロック (`Mutex`)

React側からいつでもポート番号を聞けるように、Rust側でデータを保持しておく必要があります。しかし、Rustは**「2つ以上のスレッド（並行処理）が同時に同じデータを触ること」をコンパイルエラーとして絶対に許しません**（データ競合の防止）。

これを解決するのが `Mutex`（ミューテックス：排他制御）です。

```rust
struct BackendPort(Mutex<Option<u16>>);
```

*   **どうやって使うのか？**
    データにアクセスする際、必ず `lock().unwrap()` を呼んで「鍵」を借ります。鍵を持っている間だけデータの読み書きができ、終わったら自動で鍵を返します。
    これにより、バックグラウンドでPythonのログを監視しているスレッドと、Reactからの問い合わせに答えるスレッドが同時にアクセスしても安全に処理されます。

---

## 4. 所有権と寿命（Rust最大の独自概念）

Rustには自動メモリ管理（ガベージコレクション）がありません。代わりに **「所有権（Ownership）」** というルールでメモリを管理します。
変数がスコープ（`{ }` の中）を抜けると、**その変数が持っていたデータやプロセスは即座にメモリから消去（Drop）されます**。

### 4.1 プロセスが勝手に死なない理由 (`_process_keep_alive`)

```rust
tauri::async_runtime::spawn(async move {
    // 【超重要】この変数に child を保持しておく
    let _process_keep_alive = child;
    
    while let Some(event) = rx.recv().await { ... }
});
```

*   `async move { ... }` の `move` は、「外側で作った変数（`rx` や `child`）の所有権を、このバックグラウンドスレッドの中に移動（引っ越し）させるよ」という宣言です。
*   `child` はPythonプロセスそのものです。もし `child` がどこにも保持されずに消滅（Drop）すると、Rustの仕様により**連動してPythonのプロセスも強制終了**されてしまいます。
*   そのため、無限に続く `while` ループと同じ部屋（スレッド）の中に `let _process_keep_alive = child;` としてわざと置きっぱなしにしています。これにより、Tauriアプリが終了してこのスレッドが終わるまで、Pythonも生き続けることができます。

---

## 5. Sidecar起動時の環境変数（実装運用ルール）

`lib.rs` では、Python sidecar 起動時に以下の環境変数を渡します。

1. `NANOPOL_APP_DATA_DIR`
    Python側で「Tauri起動かどうか」の判定、およびログ保存先の決定に使います。

2. `PYTHONUNBUFFERED=1`
    Pythonの標準出力バッファリングを抑え、`[PORT]` 通知がRustに届くまでの遅延を減らします。

この2つは、実機環境での「起動したのに接続が遅い/繋がらない」問題の再発防止に重要です。

加えて、Python 側は確定したポートを AppData に `backend_port.json` として書き出し、React 側が Rust IPC を取りこぼした場合の保険に使います。Rust 側だけでなく、ファイルヒント経由でも復旧できるようにしている点がこの実装の要です。

---

## 6. `[PORT]` 受信ループの実装ポイント

現在の実装では、Pythonからのイベント受信時に以下を守ります。

1. 標準出力（Stdout）と標準エラー（Stderr）の両方を監視する。
2. `[PORT]` が複数回来ても、共有状態が未設定の時だけ書き込む。
3. 受信ログは開発時の切り分けに使えるよう、通常ログとしても出力する。
4. 共有状態は一度採用したら `get_backend_port` で返し続け、初期化完了後は接続監視へ切り替える。

この方針により、環境差による出力先の違いや重複イベントに対して頑健になります。

---

## 7. ウィンドウイベント処理とプロセス停止

### 7.1 デュアルイベントハンドラの必要性

Tauriアプリの終了時、ウィンドウの破棄タイミングはOS（Windows/macOS）の実装差により異なります。このため、以下の**2つのイベント**を同時に監視する必要があります：

| イベント | 発火タイミング | 特性 |
|---------|---------------|------|
| `CloseRequested` | ユーザーが×ボタンを押すか、`window.close()` が呼ばれた時 | ウィンドウ閉鎖**要求**。ここで処理をブロック可能（キャンセルできる） |
| `Destroyed` | ウィンドウがOSから完全に破棄された時 | ウィンドウ破棄**確定**。ここでの処理キャンセルは不可 |

```rust
// 【実装パターン】
app.on_window_event(move |event| {
    match event.event() {
        // パターン1: CloseRequested → フォーカスウィンドウを取得して停止開始
        tauri::WindowEvent::CloseRequested => {
            if let Some(window) = app.get_webview_window("main") {
                stop_backend_sidecar(&window);
            }
        },
        // パターン2: Destroyed → 念のため再度停止を試みる（二重安全装置）
        tauri::WindowEvent::Destroyed => {
            if let Some(window) = app.get_webview_window("main") {
                stop_backend_sidecar(&window);
            }
        },
        _ => {}
    }
});
```

### 7.2 共有ハンドルと `take()` による二重停止防止

Pythonプロセスのハンドルは、Rust側の `State<BackendProcess>` に格納されます。

```rust
pub struct BackendProcess(pub Mutex<Option<Child>>);
```

**重要な設計ポイント:**
- 第1回目のイベント発火（例: `CloseRequested`）で、`take()` が `Some(child)` を取り出し、それを `kill()` します。
- 内部の `Option` は `None` に変わります。
- 第2回目のイベント発火（例: `Destroyed`）で同じ `stop_backend_sidecar()` が呼ばれても、`take()` は `None` を返すため、何も起きません（idempotent）。

```rust
pub fn stop_backend_sidecar(window: &Window) {
    if let Ok(backend_process) = window.state::<BackendProcess>().0.lock() {
        // take() で所有権を取り出す → Some(child) → kill() 実行
        // 2回目呼び出し時は None を返す（二重実行防止）
        if let Some(mut child) = backend_process.take() {
            let _ = child.kill();
        }
    }
}
```

### 7.3 なぜ両イベントが必要か（OS別動作）

**Windows:**
- `CloseRequested` と `Destroyed` がほぼ同時に発火する場合が多い
- しかし、例外的なタイミング（UI高負荷など）では遅延する可能性がある

**macOS:**
- `CloseRequested` 発火 → 若干の遅延 → `Destroyed` 発火（明確に分かれる）
- macOS特有の ウィンドウマネージャー挙動の差

**デュアルハンドラの効果:**
どちらのOS/タイミングであっても、最低1回は確実に `stop_backend_sidecar()` が実行され、Pythonプロセスは正しく停止されます。

### 7.4 実装上の注意点

1. **例外安全性:** `stop_backend_sidecar()` 内で例外が発生しても、アプリ終了フロー全体が中断しないよう、エラーハンドリングは限定的です（`let _ = child.kill()` など）。

2. **タイムアウト不要:** `kill()` は即座に完了し、プロセスの確実な終了を保証します。タイムアウトロジックは通常不要です。

3. **ログ出力のタイミング:** アプリが終了する段階ではログシステムが既にシャットダウンしている可能性があるため、ログ出力は控えめにします。

---

## まとめ

このアプリの `lib.rs` を修正する際、以下のポイントだけ押さえておけば大抵のエラーは防げます。

1. 値を変えたい変数には `mut` をつける。
2. 関数が `Result` を返す場合、とりあえず `.expect("エラー理由")` をつけて中身を取り出す。
3. 別のスレッドに変数を渡すときは `move` を使う。
4. スレッド間で共有したいデータは `Mutex` で包み、使う直前に `.lock().unwrap()` する。
5. ウィンドウイベント処理時は **`CloseRequested` と `Destroyed` の両イベント**を監視し、プロセス停止を確実にする。