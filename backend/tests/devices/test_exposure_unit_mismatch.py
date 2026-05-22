"""
フロントエンド／UI 側が露出の単位（ミリ秒 vs 秒）を誤って送信した場合の検出テスト。

目的:
 - UI が誤って秒単位の値を送ってしまったケースを想定し、
     その挙動がサーバー側で検出可能かを示すための“ヒント的”なテスト。

前提と期待:
 - `CameraController.set_exposure()` はミリ秒を受け取る設計であり、
     秒を渡すと（例えば 0.01 を渡すと 0.01ms と解釈される等）期待した挙動と異なる値がセットされる。
 - 本テストは自動で修正を行うのではなく、単位ミスが発生したときにそれを検出・ログ化するロジックを導入する
     か否かを設計決定するのに役立てるためのものです。

推奨アクション（将来的な改善案）:
 - サーバー側で受け取った値が `get_exposure_range()` の min より遥かに小さい場合に警告ログを出す。
 - API レベルでバリデーションエラーを返す（400）か、自動で ms に換算するユーティリティを用意する。
"""
import sys
from pathlib import Path

backend_path = Path(__file__).parents[2]
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))

import importlib.util


def _load_camera_controller_class():
    module_path = Path(__file__).parents[2] / "devices" / "camera_controller.py"
    spec = importlib.util.spec_from_file_location("devices.camera_controller", str(module_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.CameraController


def test_seconds_sent_instead_of_ms_is_detectable():
    CameraController = _load_camera_controller_class()
    ctrl = CameraController()
    assert ctrl.connect() is True

    min_ms, max_ms, step_ms = ctrl.get_exposure_range()

    # フロントが誤って「秒」を渡した想定: 0.01 (10ms) を秒として送るケース
    sent_as_seconds = 0.01
    ctrl.set_exposure(sent_as_seconds)
    applied = ctrl.get_exposure()

    # 現在はサーバー側でクランプするため、送信値が範囲未満であれば最小値に丸められることを確認。
    assert applied == min_ms
    assert applied >= sent_as_seconds