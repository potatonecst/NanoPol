use std::sync::Mutex;
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
            if matches!(event, WindowEvent::Destroyed) {
                let app_handle = window.app_handle();
                let child_state = app_handle.state::<BackendChildState>();
                let mut guard = child_state.0.lock().unwrap();

                if let Some(child) = guard.take() {
                    if let Err(e) = child.kill() {
                        eprintln!("[SYSTEM] Failed to kill backend sidecar on close: {e}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![greet, get_backend_port])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
