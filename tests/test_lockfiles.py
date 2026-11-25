"""Lockfiles stay in sync with their manifests (a stale uv.lock once failed the Railway build)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from scripts import check_lockfiles as check

ROOT = Path(__file__).resolve().parents[1]


def test_the_repository_lockfiles_are_in_sync() -> None:
    assert check.all_problems(ROOT) == []


def _copy(tmp_path: Path) -> Path:
    shutil.copy(ROOT / "pyproject.toml", tmp_path / "pyproject.toml")
    shutil.copy(ROOT / "uv.lock", tmp_path / "uv.lock")
    (tmp_path / "frontend").mkdir()
    for name in ("package.json", "package-lock.json"):
        shutil.copy(ROOT / "frontend" / name, tmp_path / "frontend" / name)
    return tmp_path


def test_a_dependency_added_without_relocking_is_caught(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    pyproject = root / "pyproject.toml"
    pyproject.write_text(pyproject.read_text(encoding="utf-8").replace(
        '"boto3>=1.34,<2",', '"boto3>=1.34,<2",\n  "left-pad-py>=1",'), encoding="utf-8")
    assert any("left-pad-py" in problem and "uv lock" in problem for problem in check.python_problems(root))


def test_a_changed_range_or_removed_dependency_is_caught(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    pyproject = root / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")
    pyproject.write_text(text.replace('"fastapi>=0.115,<1",', '"fastapi>=0.116,<1",').replace('  "boto3>=1.34,<2",\n', ""),
                         encoding="utf-8")
    problems = "\n".join(check.python_problems(root))
    assert "fastapi" in problems and "boto3" in problems


def test_frontend_package_lock_drift_is_caught(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    manifest_path = root / "frontend" / "package.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["dependencies"]["left-pad"] = "^1.3.0"
    manifest["devDependencies"]["@types/react"] = "^20.0.0"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    problems = "\n".join(check.npm_problems(root / "frontend"))
    assert "left-pad" in problems and "@types/react" in problems and "npm install" in problems
