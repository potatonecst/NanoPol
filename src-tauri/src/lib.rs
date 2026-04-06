// tauri-plugin-shellの機能（Sidecarの起動など）を使えるようにするための宣言
use tauri_plugin_shell::ShellExt;
// 起動したPythonからの出力（Printなど）を受け取るための型
use tauri_plugin_shell::process::CommandEvent;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // shellプラグインを初期化（外部プロセスの起動に必須）
        .plugin(tauri_plugin_shell::init())
        // setupは、Tauriアプリのウィンドウが立ち上がる「前」に1回だけ実行される初期化処理です
        .setup(|app| {
            // tauri.conf.json の externalBin で指定した "backend" を起動する準備
            let sidecar_command = app
                .shell()
                .sidecar("backend")
                .expect("Failed to create sidecar command"); // 万が一 "backend" の設定が見つからない場合はエラーを出して止める

            // 実際にバックグラウンドでPythonのexeを起動（spawn）する
            // rx: バックエンドからの出力（プリント）を受け取るためのパイプ（受信機）
            // _child: 起動したプロセス自体。この変数がTauriに紐付いているため、Tauri終了時に自動でキルされます
            let (mut rx, _child) = sidecar_command
                .spawn()
                .expect("Failed to spawn backend sidecar");

            // 画面の動きを止めないように、別のスレッド（裏作業）でPythonのログを監視し続ける
            tauri::async_runtime::spawn(async move {
                // Pythonから何か文字（ログ）が送られてくるたびにループが回る
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stdout(line) = event {
                        // 通常のプリント出力をMac/Windowsのターミナルに表示（バイト列を文字列に変換）
                        println!("[Backend] {}", String::from_utf8_lossy(&line));
                    } else if let CommandEvent::Stderr(line) = event {
                        // エラー出力を表示
                        eprintln!("[Backend Error] {}", String::from_utf8_lossy(&line));
                    }
                }
            });

            // 初期化がすべて無事に完了したことをTauriに伝える
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
