use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::Duration;
// tauri-plugin-shellの機能（Sidecarの起動など）を使えるようにするための宣言
use tauri_plugin_shell::ShellExt;
// 起動したPythonからの出力（Printなど）を受け取るための型
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
// app.path() などのTauriの機能を使うための宣言
use tauri::Manager;
use tauri::WindowEvent;

/// React側から参照するバックエンド待受ポートを保持する共有状態です。
///
/// - `None`: まだPython側の動的ポート通知を受信していない状態
/// - `Some(port)`: `[PORT]` ログから取得済みの状態
///
/// `Mutex` により、非同期ログ監視タスク（書き込み）と
/// Tauri command（読み取り）の同時アクセスを安全に直列化します。
struct BackendPort(Mutex<Option<u16>>);

/// 起動した backend sidecar プロセスのハンドルを保持します。
/// アプリ終了時に明示的に kill するために使用します。
///
/// なぜ `Option<CommandChild>` なのか:
/// - 起動直後は `Some(child)` を保持し、イベントハンドラから同じハンドルへアクセスします。
/// - 終了処理で `take()` して `None` にすることで、二重 kill（多重イベント発火時）を防ぎます。
///
/// なぜ `Mutex` が必要か:
/// - setup 時（書き込み）とウィンドウ終了イベント時（読み出し+削除）が
///   別コンテキストで実行されるため、排他制御で整合性を担保します。
struct BackendChildState(Mutex<Option<CommandChild>>);

fn append_shutdown_note(app_handle: &tauri::AppHandle, message: &str) {
    if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
        let log_path = app_data_dir.join("logs").join("system.log");

        if let Some(parent) = log_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("[SYSTEM] Failed to create log directory for shutdown note: {e}");
                return;
            }
        }

        match OpenOptions::new().create(true).append(true).open(&log_path) {
            Ok(mut file) => {
                if let Err(e) = writeln!(file, "{message}") {
                    eprintln!("[SYSTEM] Failed to write shutdown note: {e}");
                }
            }
            Err(e) => {
                eprintln!("[SYSTEM] Failed to open system.log for shutdown note: {e}");
            }
        }
    }
}

/// バックエンドが使用しているポート番号を、安全かつ複数のフォールバック経路を用いて解決します。
///
/// 【設計背景】
/// フロントエンドとの接続を維持するため、以下の優先順位でポート特定を試みます。
/// 1. 共有メモリ（`BackendPort`）にすでに検知済みのポートが存在すればそれを使用。
/// 2. 未検知の場合、アプリデータ保存先（AppData）直下の `backend_port.json` からJSONを読み取って解析。
/// 3. それも存在しない場合、開発環境のデフォルトポートである `14201` をフォールバックとして使用。
/// 決定したポート番号は、次回の再利用のために共有メモリ（`BackendPort`）に書き込んで同期させます。
fn resolve_backend_port(app_handle: &tauri::AppHandle) -> u16 {
    // 共有ポート情報を保持するグローバルステート（BackendPort）を取得します。
    let state = app_handle.state::<BackendPort>();
    
    // Mutexロックを取得してスレッド間での同時書き込み/読み込みによる競合を防ぎます。
    // unwrap() は、万が一他スレッドでパニックが起きてロックが汚染（Poisoned）されていた場合に
    // プロセスを安全に終了させるRustの標準的な例外処理です。
    let mut guard = state.0.lock().unwrap();
    
    // すでに共有メモリにポートが格納されている（Some(port)）なら、その値をそのまま返します。
    if let Some(p) = *guard {
        p
    } else {
        let mut fallback_port = None;
        
        // 共有メモリにない場合、AppData ディレクトリ（例: WindowsのAppData/Local/nanopolなど）を特定します。
        if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
            let hint_path = app_data_dir.join("backend_port.json");
            
            // `backend_port.json` ファイルが存在するか確認します。
            if hint_path.exists() {
                // ファイルの内容を文字列として一括で読み込みます（UTF-8エンコード前提）。
                if let Ok(content) = std::fs::read_to_string(&hint_path) {
                    // 外部パッケージ `serde_json` を使用して文字列を汎用JSONオブジェクト（Value型）にパースします。
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                        // JSON内の "port" キーを取り出し、整数値（u64）に変換可能であれば u16 にキャストして取得します。
                        if let Some(p) = parsed.get("port").and_then(|v| v.as_u64()) {
                            fallback_port = Some(p as u16);
                        }
                    }
                }
            }
        }
        
        // 特定できたポート、あるいは最終手段のデフォルトポート `14201` を解決値とします。
        let resolved_port = fallback_port.unwrap_or(14201);
        
        // 次回の呼び出しでパース処理をスキップするため、確定したポートを共有メモリにキャッシュ（上書き保存）します。
        *guard = Some(resolved_port);
        resolved_port
    }
}

fn request_backend_shutdown(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let port = resolve_backend_port(app_handle);

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500))
        .map_err(|e| format!("failed to connect to backend shutdown endpoint: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| format!("failed to set read timeout: {e}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| format!("failed to set write timeout: {e}"))?;

    let request = format!(
        "POST /system/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("failed to send shutdown request: {e}"))?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| format!("failed to read shutdown response: {e}"))?;

    let first_line = response.lines().next().unwrap_or_default();
    if !(first_line.starts_with("HTTP/1.1 200") || first_line.starts_with("HTTP/1.0 200")) {
        return Err(format!("unexpected shutdown response: {first_line}"));
    }

    Ok(())
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// フロントエンドから現在のバックエンドポートを問い合わせるTauri commandです。
///
/// # Parameters
/// - `state`: アプリ全体で共有している `BackendPort` 状態
///
/// # Returns
/// - `Some(port)`: 受信済みの動的ポート
/// - `None`: まだポート通知を受信していない
#[tauri::command]
fn get_backend_port(state: tauri::State<'_, BackendPort>) -> Option<u16> {
    // Reactから「ポート何番？」と聞かれたら、共有メモリの中身を返す
    // Mutex の lock() は排他制御用の鍵を取る操作です。
    *state.0.lock().unwrap()
}

/// backend sidecar を明示的に停止します。
///
/// この関数を共通化しておく理由:
/// - `CloseRequested` と `Destroyed` の両方から呼び出しても、同じ処理を再利用できる
/// - `take()` により 2 回目以降は `None` になるため、kill の二重実行を自然に防げる
///
/// 実際にやっていること:
/// 1. `BackendChildState` から `CommandChild` の所有権を取り出す
/// 2. その場で `kill()` を呼んで Python sidecar を終了させる
/// 3. 失敗した場合でもアプリ終了処理自体は止めず、ログだけ残す
fn stop_backend_sidecar(app_handle: &tauri::AppHandle) {
    let child_state = app_handle.state::<BackendChildState>();
    let mut guard = child_state.0.lock().unwrap();

    if let Some(child) = guard.take() {
        // ここで `take()` 済みなので、同じ window イベントがもう一度来ても
        // `guard` の中身は `None` のままになり、二重 kill を避けられます。
        println!("[SYSTEM] Requesting graceful backend shutdown before kill...");
        if let Err(e) = request_backend_shutdown(app_handle) {
            eprintln!("[SYSTEM] Graceful backend shutdown failed: {e}");
            append_shutdown_note(
                app_handle,
                &format!("[SYSTEM] Graceful backend shutdown failed: {e}"),
            );
        } else {
            println!("[SYSTEM] Backend shutdown endpoint completed successfully.");
        }

        println!("[SYSTEM] Stopping backend sidecar before app exit...");
        if let Err(e) = child.kill() {
            eprintln!("[SYSTEM] Failed to kill backend sidecar on close: {e}");
        } else {
            println!("[SYSTEM] Backend sidecar kill requested successfully.");
        }
    } else {
        println!("[SYSTEM] Backend sidecar already stopped or never started.");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Tauri アプリの初期化と、Python sidecar の起動・監視を行います。
///
/// # Returns
/// - `()` : 正常終了時は戻り値なし。`run()` 内でエラーになった場合は panic します。
pub fn run() {
    tauri::Builder::default()
        // Tauri の各プラグインは、fs / dialog / shell など外部機能を有効化します。
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // shellプラグインを初期化（外部プロセスの起動に必須）
        .plugin(tauri_plugin_shell::init())
        // setupは、Tauriアプリのウィンドウが立ち上がる「前」に1回だけ実行される初期化処理です
        .setup(|app| {
            // 空っぽの「共有メモリ」を作成して、Tauriアプリ全体で使えるように登録（manage）する
            app.manage(BackendPort(Mutex::new(None)));
            // backend sidecar のプロセスハンドル共有領域。
            // ここに保持しておくことで、ウィンドウクローズ時に
            // 「必ず同じ子プロセス」を明示停止できます。
            app.manage(BackendChildState(Mutex::new(None)));

            // OS標準の安全なアプリデータ保存先（AppDataなど）の絶対パスを取得
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");

            // tauri.conf.json の externalBin で指定した "backend" を起動する準備
            let sidecar_command = app
                .shell()
                .sidecar("backend")
                .expect("Failed to create sidecar command") // 万が一 "backend" の設定が見つからない場合はエラーを出して止める
                // env() は子プロセスに環境変数を追加する標準的な仕組みです。
                // Python側に保存先のパスを「環境変数」として渡してあげる（超重要！）
                .env(
                    "NANOPOL_APP_DATA_DIR",
                    app_data_dir.to_string_lossy().to_string(),
                )
                // Pythonの標準出力バッファリングを完全に無効化して即座にログを流させる
                .env("PYTHONUNBUFFERED", "1");

            // 実際にバックグラウンドでPythonのexeを起動（spawn）する
            // rx: バックエンドからの出力（プリント）を受け取るためのパイプ（受信機）
            // child: 起動したプロセス自体。この変数を維持しないとプロセスが即座にキルされてしまいます
            let (mut rx, child) = sidecar_command
                .spawn()
                .expect("Failed to spawn backend sidecar");

            // 子プロセスハンドルを共有状態に保持して、終了時に kill できるようにする。
            // 以前の「ログ監視タスク側に child を持たせる」方式だと、
            // タスク終了タイミングに依存して停止が遅れたり、確実性が下がるため、
            // ここでアプリ状態へ退避してライフサイクルを明確化します。
            {
                let child_state = app.state::<BackendChildState>();
                let mut guard = child_state.0.lock().unwrap();
                *guard = Some(child);
            }

            // 別のスレッドでTauriの共有メモリを触るために、アプリの「ハンドル（操縦桿）」を複製しておく
            let app_handle = app.handle().clone();

            // 画面の動きを止めないように、別のスレッド（裏作業）でPythonのログを監視し続ける
            // 子プロセス自体は共有状態に保持し、ここではログ監視に専念します
            tauri::async_runtime::spawn(async move {
                // Pythonから何か文字（ログ）が送られてくるたびにループが回る
                while let Some(event) = rx.recv().await {
                    match event {
                        // Stdout と Stderr の両方を監視する（どちらに [PORT] が流れてきても拾えるように）
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            // from_utf8_lossy は、壊れた UTF-8 が混ざっても落ちにくい安全な変換です。
                            let log_line = String::from_utf8_lossy(&line);

                            // Python側が出力する "[PORT] 51348" 形式の通知を検出
                            if log_line.contains("[PORT]") {
                                // [PORT] の右側だけを取り出す（例: " 51348"）
                                if let Some(port_str) = log_line.split("[PORT]").nth(1) {
                                    // trim() は前後の空白を取り除き、parse::<u16>() は整数に変換します。
                                    // 変換できた場合だけ有効値として採用します。
                                    if let Ok(port) = port_str.trim().parse::<u16>() {
                                        let state = app_handle.state::<BackendPort>();
                                        // 共有状態への書き込みは1回のlockで完結させる
                                        let mut guard = state.0.lock().unwrap();

                                        // すでに取得済みでなければ書き込む（重複書き込み防止）
                                        if guard.is_none() {
                                            println!(
                                                "💡 Python Backend dynamically assigned port: {}",
                                                port
                                            );
                                            *guard = Some(port);
                                        }
                                    }
                                }
                            }

                            // Terminal出力用（Tauriの開発環境用）
                            println!("[Backend] {}", log_line);
                        }
                        _ => {}
                    }
                }
            });

            // 初期化がすべて無事に完了したことをTauriに伝える
            Ok(())
        })
        // ウィンドウ破棄時に backend sidecar を明示停止します。
        //
        // 設計意図:
        // - UIが閉じても sidecar がOS上に残留するケースを防ぐ
        // - 終了処理を Rust 側で完結させ、ユーザーがタスクマネージャーを開かずに済むようにする
        //
        // 実装ポイント:
        // - `Destroyed` 時に `Option` から `take()` して所有権を取得
        // - `kill()` を1回だけ実行（2回目以降は `None` なので何もしない）
        // - kill失敗時もアプリ終了処理を止めず、stderrへ記録のみ行う
        .on_window_event(|window, event| {
            match event {
                // Xボタンやウィンドウ終了操作の最初の入口。
                // ここで止めておくと、後続の破棄処理より先に backend を片付けやすい。
                WindowEvent::CloseRequested { .. } => {
                    // 通常の「ユーザーがウィンドウを閉じた」経路。
                    // ここで backend を止めるのが第一優先です。
                    println!("[SYSTEM] WindowEvent::CloseRequested received.");
                    stop_backend_sidecar(&window.app_handle());
                }
                // CloseRequested を通らない終了経路への保険。
                // 2段構えにしておくことで、OS側の破棄順序差異に強くする。
                WindowEvent::Destroyed => {
                    // 何らかの理由で CloseRequested を経由せずに破棄された場合の保険。
                    // 既に stop_backend_sidecar() 済みなら何も起きません。
                    println!("[SYSTEM] WindowEvent::Destroyed received.");
                    stop_backend_sidecar(&window.app_handle());
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![greet, get_backend_port, force_restart_backend])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// バックエンド（Python sidecar）プロセスをOSレベルで強制再起動するTauriコマンドです。
///
/// 【解説】
/// 通信障害やバックエンドのフリーズなどで操作が不可能になった際、
/// 既存の安定した終了処理（stop_backend_sidecar）を用いて現在のプロセスを安全かつ確実に終了し、
/// 初回起動時に決定したポート番号を維持したまま、同じ設定でバックエンドプロセスを再起動（OSレベルで再生成）します。
/// 再起動された子プロセスは再び `BackendChildState` に格納されるため、アプリ終了時の自動クリーンアップ（Kill）も継続して保証されます。
#[tauri::command]
async fn force_restart_backend(app_handle: tauri::AppHandle) -> Result<(), String> {
    println!("[SYSTEM] force_restart_backend command received.");

    // 1. 既存の安定した終了シーケンス（シャットダウン要求＆Kill）をそのまま呼び出してプロセスを安全に消去
    stop_backend_sidecar(&app_handle);

    // 2. OSがポート等のシステムリソースを完全に解放するまで少し待機（500ms）
    std::thread::sleep(Duration::from_millis(500));

    // 3. 現在設定されているポート番号を共有状態（またはヒントファイル/デフォルト値）から解決
    let port = resolve_backend_port(&app_handle);

    // 4. 初回起動時と全く同じアプリデータディレクトリのパスを取得
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;

    // 5. 初回起動時と同一のSidecarコマンドを組み立て、ポートのみ環境変数で固定指定して起動（spawn）
    let sidecar_command = app_handle
        .shell()
        .sidecar("backend")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .env("NANOPOL_APP_DATA_DIR", app_data_dir.to_string_lossy().to_string())
        .env("PYTHONUNBUFFERED", "1")
        .env("NANOPOL_BACKEND_PORT", port.to_string()); // ポートを初回と同じ値に固定

    println!("[SYSTEM] Spawning new backend sidecar on port {port}...");
    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|e| format!("Failed to spawn backend sidecar: {e}"))?;

    // 6. 新しい子プロセスハンドルを共有状態（BackendChildState）に格納
    // これにより、再起動後にウィンドウを閉じても、この新しいプロセスが正しく自動Killされます。
    {
        let child_state = app_handle.state::<BackendChildState>();
        let mut guard = child_state.0.lock().unwrap();
        *guard = Some(child);
    }

    // 7. 再起動後の標準出力・標準エラーログを監視する非同期タスクを立ち上げる
    // （ポートはすでに BackendPort に格納済みのため、単純にログを標準出力に流す監視を行います）
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    let log_line = String::from_utf8_lossy(&line);
                    println!("[Backend (Restarted)] {}", log_line);
                }
                _ => {}
            }
        }
    });

    println!("[SYSTEM] Backend successfully restarted on port {port}");
    Ok(())
}
