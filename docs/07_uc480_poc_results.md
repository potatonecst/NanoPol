# 07. uc480 バックエンド PoC 結果報告

## 概要

カメラバックエンドを `pyueye` から `pylablib.devices.uc480` への移行を検証するための Proof of Concept (PoC) です。

## 背景・動機

- 現在のカメラ実装は IDS uEye カメラ用の `pyueye` ライブラリを使用
- Windows 本番環境には `uc480_64.dll` が利用可能
- `pyueye` が `ueye_api.dll` の不在により動作失敗 → `uc480` バックエンドが代替案として有力
- `pylablib` は複数バックエンドを統一インターフェースで提供

## PoC 実行詳細

**実施日:** 2026-04-28  
**環境:** Windows 11 (本番マシン)  
**カメラ:** Thorlabs C1285R12M (uc480 ドライバ経由)

### テスト手順

1. 最小限の PoC スクリプトを作成: `backend/tools/poc_uc480.py`
2. PyInstaller で hidden imports を指定してスタンドアロン exe を生成
3. GitHub Actions ワークフロー: `poc-uc480.yml`
4. Windows 実機で実行検証

### 実行結果

**uc480 バックエンド: 成功 ✓**
```
list_cameras result: [TCameraInfo(cam_id=1, dev_id=1, sens_id=40, model='C1285R12M', serial_number='4103451952', ...)]
キャプチャ画像型: <class 'numpy.ndarray'> サイズ: (1024, 1280)
スナップショット保存先: C:\Users\実験\Desktop\Data\髙田\制御ソフト開発\PoC\poc_snap\uc480.png
```

**ueye バックエンド: 失敗 ✗**
```
ueye バックエンドの実行時エラー:
  OSError("can't import library ueye_api_64.dll\nThe library is automatically supplied with IDS uEye or IDS Software Suite\n...")
```

### 主要な発見

1. **uc480 は完全に機能**: カメラ列挙、キャプチャ、保存すべて動作確認
2. **ueye DLL の欠如**: この Windows マシンには `ueye_api_64.dll` が存在しない
3. **カメラ仕様**: Thorlabs C1285R12M (1280×1024 ベイヤー配列センサ)
4. **スタンドアロン実行**: Windows 上で Python 環境が不要（PyInstaller exe で動作）

## 採用方針

### プライマリバックエンド: uc480 ✓
- 本番 Windows マシンで動作確認済み
- ThorCam ドライバが利用可能
- このハードウェアに対して安定・信頼性あり

### セカンダリバックエンド: ueye
- 将来の互換性のため `pyueye` コードは保持
- 診断エンドポイント (`/camera/diagnostics`) でライブラリの可用性を表示
- 当面対応不要。ハードウェア変更時に再検討可能

## 次のステップ

### フェーズ1: 実装準備
1. **新機能ブランチ作成:** `feature/camera-uc480`
2. **CameraController の書き直し:**
   - `pylablib.devices.uc480` をプライマリバックエンド化
   - `pyueye` フォールバック機能は診断用に保持
   - connect/snap/set_exposure/set_gain メソッドの更新

### フェーズ2: ビルド・依存関係更新
3. **build_exe.py の更新:**
   - `pylablib` の hidden imports 追加
4. **pyproject.toml の更新:**
   - `pylablib` をプロダクション依存に追加

### フェーズ3: 検証・ドキュメント更新
5. **スペック・ドキュメントの更新:**
   - `spec/02_architecture.md`: カメラバックエンド選択根拠の記載
   - `docs/01_backend_devices.md`: ドライバ互換性情報の追記
6. **統合テスト:**
   - 露光値・ゲインコントロール動作確認
   - プレビューストリーム検証
   - レコーディング開始/停止確認
   - 画像品質が仕様を満たしているか確認

## PoC アーティファクト

| アイテム        | パス                              | 用途                     |
| :-------------- | :-------------------------------- | :----------------------- |
| PoC スクリプト  | `backend/tools/poc_uc480.py`      | uc480 と ueye の並行検証 |
| CI ワークフロー | `.github/workflows/poc-uc480.yml` | exe ビルドと自動テスト   |
| テスト画像      | ローカル保存                      | 本リポジトリには非含有   |

## クリーンアップ

- PoC ブランチ `poc/uc480` は結果ドキュメント完成後に削除予定
- PoC スクリプトとワークフローは今後の参考・再検証用に保持

## 参考リソース

- **pylablib ドキュメント:** https://pylablib.readthedocs.io/
- **uc480 バックエンド:** pylablib.devices.uc480
- **ThorCam SDK:** Thorlabs 公式カメラソフトウェア (Windows)
