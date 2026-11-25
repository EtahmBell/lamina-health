"""Fail when a lockfile is out of sync with its manifest (run in the gates).

* Python: `uv.lock` must record exactly the dependencies (and extras) declared in `pyproject.toml`
  and the same `requires-python`. Railway builds with the lockfile, so a stale `uv.lock` fails the
  deploy (this happened once); this catches it before the push.
* Frontend: `frontend/package-lock.json` must record exactly the dependencies and devDependencies of
  `frontend/package.json` (the same ranges), and lock an installed version for each of them.

The structural checks are offline and deterministic (also run as a test:
tests/test_lockfiles.py). `--with-tools` additionally runs `uv lock --check --offline` when uv is
installed (uv's own staleness check). After changing dependencies: `uv lock` and/or `npm install`
(in frontend/), and commit the lockfile with the manifest.

Usage: python -m scripts.check_lockfiles [--with-tools]
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet

ROOT = Path(__file__).resolve().parents[1]


def _canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _requirement_key(name: str, extras: list[str] | tuple[str, ...], specifier: str, marker: str | None) -> tuple:
    return (_canonical(name), tuple(sorted(extras)), str(SpecifierSet(specifier or "")),
            (marker or "").replace('"', "'").strip())


def python_problems(root: Path = ROOT) -> list[str]:
    pyproject = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    lock_path = root / "uv.lock"
    if not lock_path.exists():
        return ["uv.lock is missing: run `uv lock` and commit it"]
    lock = tomllib.loads(lock_path.read_text(encoding="utf-8"))
    project = pyproject["project"]
    declared: set[tuple] = set()
    for line in project.get("dependencies", []):
        requirement = Requirement(line)
        declared.add(_requirement_key(requirement.name, list(requirement.extras), str(requirement.specifier),
                                      str(requirement.marker) if requirement.marker else None))
    for extra, lines in project.get("optional-dependencies", {}).items():
        for line in lines:
            requirement = Requirement(line)
            marker = f"extra == '{extra}'"
            if requirement.marker:
                marker = f"{requirement.marker} and {marker}"
            declared.add(_requirement_key(requirement.name, list(requirement.extras), str(requirement.specifier), marker))
    me = _canonical(project["name"])
    entry = next((package for package in lock.get("package", []) if _canonical(package.get("name", "")) == me), None)
    if entry is None:
        return [f"uv.lock has no entry for {project['name']}: run `uv lock`"]
    locked = {_requirement_key(item["name"], item.get("extras", []), item.get("specifier", ""), item.get("marker"))
              for item in entry.get("metadata", {}).get("requires-dist", [])}
    problems = [f"pyproject.toml declares {name}{list(extras) or ''} {spec} {marker}".rstrip() +
                " but uv.lock does not: run `uv lock`" for name, extras, spec, marker in sorted(declared - locked)]
    problems += [f"uv.lock records {name}{list(extras) or ''} {spec} {marker}".rstrip() +
                 " which pyproject.toml no longer declares: run `uv lock`" for name, extras, spec, marker in sorted(locked - declared)]
    if SpecifierSet(project.get("requires-python", "")) != SpecifierSet(lock.get("requires-python", "")):
        problems.append("requires-python differs between pyproject.toml and uv.lock: run `uv lock`")
    extras_locked = set(entry.get("metadata", {}).get("provides-extras", []) or [])
    extras_declared = set(project.get("optional-dependencies", {}))
    if extras_locked and extras_locked != extras_declared:
        problems.append("the optional-dependency groups differ between pyproject.toml and uv.lock: run `uv lock`")
    return problems


def npm_problems(directory: Path) -> list[str]:
    manifest_path, lock_path = directory / "package.json", directory / "package-lock.json"
    name = directory.relative_to(ROOT).as_posix() if directory.is_relative_to(ROOT) else str(directory)
    if not manifest_path.exists():
        return [f"{name}/package-lock.json has no package.json next to it"] if lock_path.exists() else []
    if not lock_path.exists():
        return [f"{name}/package-lock.json is missing: run `npm install` in {name}"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    root_entry = lock.get("packages", {}).get("", {})
    problems: list[str] = []
    for field in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        declared, locked = manifest.get(field, {}) or {}, root_entry.get(field, {}) or {}
        for dependency in sorted(set(declared) | set(locked)):
            if declared.get(dependency) != locked.get(dependency):
                problems.append(f"{name}: {field}.{dependency} is {declared.get(dependency)!r} in package.json but "
                                f"{locked.get(dependency)!r} in package-lock.json: run `npm install` in {name}")
            elif f"node_modules/{dependency}" not in lock.get("packages", {}):
                problems.append(f"{name}: package-lock.json locks no version of {dependency}: run `npm install` in {name}")
    return problems


def tool_problems(root: Path = ROOT) -> list[str]:
    if shutil.which("uv") is None:
        return []
    result = subprocess.run(["uv", "lock", "--check", "--offline"], cwd=root, capture_output=True, text=True, check=False)
    return [] if result.returncode == 0 else ["`uv lock --check` reports uv.lock is out of date: run `uv lock`"]


def all_problems(root: Path = ROOT, *, with_tools: bool = False) -> list[str]:
    problems = python_problems(root) + npm_problems(root / "frontend")
    if with_tools:
        problems += tool_problems(root)
    return problems


def warnings(root: Path = ROOT) -> list[str]:
    """Not failures: things a person should decide about."""
    found = []
    stray = root / "package-lock.json"
    if stray.exists() and not (root / "package.json").exists():
        found.append("package-lock.json at the repository root has no package.json next to it (an empty, "
                     "stray lockfile since the first commit; the frontend's is frontend/package-lock.json)")
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--with-tools", action="store_true", help="also run `uv lock --check --offline`")
    args = parser.parse_args(argv)
    problems = all_problems(with_tools=args.with_tools)
    for warning in warnings():
        print(f"lockfile warning: {warning}")
    for problem in problems:
        print(f"lockfile: {problem}")
    if not problems:
        print("lockfiles: in sync")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
