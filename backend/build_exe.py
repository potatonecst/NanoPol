import PyInstaller.__main__
import os

if __name__ == '__main__':
    # FastAPIとUvicornを1つのexeにまとめるためのPyInstaller設定
    PyInstaller.__main__.run([
        'main.py', # バックエンドのエントリーポイント
        '--name=backend', # 出力されるファイル名 (backend.exe になる)
        '--onefile', # すべての依存関係を1つのexeファイルにまとめる
        '--clean',   # ビルド前にキャッシュをクリアする
        
        # 注意: '--noconsole' は指定しません。
        # Tauri (Rust) 側で標準出力を受け取ってログを表示するため、コンソール出力は生かしておく必要があります。
        # （アプリ実行時に黒い画面が出ないようにする処理は、TauriのshellプラグインがWindows上で勝手にやってくれます）

        # Uvicornの動的インポート（exe化すると見失いやすいライブラリ）を明示的に含める
        '--hidden-import=uvicorn.logging',
        '--hidden-import=uvicorn.loops',
        '--hidden-import=uvicorn.loops.auto',
        '--hidden-import=uvicorn.protocols',
        '--hidden-import=uvicorn.protocols.http',
        '--hidden-import=uvicorn.protocols.http.auto',
        '--hidden-import=uvicorn.protocols.websockets',
        '--hidden-import=uvicorn.protocols.websockets.auto',
        '--hidden-import=uvicorn.lifespan.on',
        '--hidden-import=uvicorn.lifespan.off',
        '--hidden-import=pyueye',
        '--hidden-import=pyueye.ueye',
    ])
    print("==== Python Backend Build Completed! ====")
