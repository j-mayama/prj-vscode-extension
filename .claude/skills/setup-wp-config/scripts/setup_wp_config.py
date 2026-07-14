#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def detect_name(project_root: Path, output_dir: str) -> str:
    devcontainer_json = project_root / output_dir / "devcontainer.json"
    if devcontainer_json.is_file():
        try:
            data = json.loads(devcontainer_json.read_text(encoding="utf-8"))
            name = data.get("name")
            if isinstance(name, str) and name.strip():
                return name.strip()
        except Exception:
            pass
    return project_root.name


def main() -> int:
    p = argparse.ArgumentParser(description="wp-config.php を .devcontainer の値で復旧")
    p.add_argument("--project-root", default="/workspace")
    p.add_argument("--output", default=".devcontainer")
    p.add_argument("--wp-root", default="wordpress")
    p.add_argument("--name", default=None)
    p.add_argument("--wp-table-prefix", default=None)
    args = p.parse_args()

    project_root = Path(args.project_root).resolve()
    script_path = project_root / ".claude" / "skills" / "wp-docker-setup" / "scripts" / "install_devcontainer.py"
    if not script_path.is_file():
        print(f"ERROR: install_devcontainer.py が見つかりません: {script_path}", file=sys.stderr)
        return 1

    name = args.name or detect_name(project_root, args.output)

    cmd = [
        "python3",
        str(script_path),
        "--type",
        "wp",
        "--project-root",
        str(project_root),
        "--name",
        name,
        "--output",
        args.output,
        "--wp-root",
        args.wp_root,
        "--repair-wp-config-only",
    ]

    if args.wp_table_prefix:
        cmd.extend(["--wp-table-prefix", args.wp_table_prefix])

    result = subprocess.run(cmd)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
