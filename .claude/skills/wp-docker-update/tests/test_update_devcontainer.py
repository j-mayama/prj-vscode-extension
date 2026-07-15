from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parent.parent
SETUP_SKILL_DIR = SKILL_DIR.parent / "wp-docker-setup"
UPDATE_SCRIPT = SKILL_DIR / "scripts" / "update_devcontainer.py"


def load_update_module():
    spec = importlib.util.spec_from_file_location("wp_docker_update_test", UPDATE_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"テスト対象を読み込めません: {UPDATE_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


UPDATE = load_update_module()
SETUP = UPDATE.load_install_module(SETUP_SKILL_DIR)


class ClassifyTests(unittest.TestCase):
    def test_generated_file_deleted_after_install_is_conflict(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dest = Path(temp_dir)
            ideal = {
                "new-template-file.txt": b"new\n",
                "deleted-by-user.txt": b"generated\n",
            }
            baseline = {
                "deleted-by-user.txt": SETUP.sha256_bytes(b"generated\n"),
            }

            plan = UPDATE.classify(dest, ideal, baseline, SETUP.sha256_bytes)

            self.assertEqual(plan["added"], ["new-template-file.txt"])
            self.assertEqual(plan["conflict"], ["deleted-by-user.txt"])


class ApplyTests(unittest.TestCase):
    def test_only_selected_conflict_is_restored_and_features_are_rechecked(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            shutil.copytree(
                SETUP_SKILL_DIR / "templates" / ".devcontainer-node",
                project_root / ".devcontainer-node",
            )
            SETUP.install(
                template_type="node",
                project_root=project_root,
                output_dir=".devcontainer",
                project_name="update-review",
            )

            dest = project_root / ".devcontainer"
            deleted_path = dest / "scripts" / "pre-rebuild-cleanup.ps1"
            deleted_path.unlink()

            modified_path = dest / "devcontainer.json"
            original = modified_path.read_text(encoding="utf-8")
            modified = original.replace('"name": "update-review"', '"name": "local-edit"')
            self.assertNotEqual(original, modified)
            modified_path.write_text(modified, encoding="utf-8", newline="\n")

            completed = subprocess.run(
                [
                    sys.executable,
                    str(UPDATE_SCRIPT),
                    "--project-root",
                    str(project_root),
                    "--apply",
                    "--force-conflict",
                    "scripts/pre-rebuild-cleanup.ps1",
                ],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads(completed.stdout)

            conflicts = {item["path"]: item["reason"] for item in result["files"]["conflict"]}
            self.assertEqual(conflicts["scripts/pre-rebuild-cleanup.ps1"], "deleted")
            self.assertEqual(conflicts["devcontainer.json"], "modified")
            self.assertTrue(deleted_path.is_file())
            self.assertIn('"name": "local-edit"', modified_path.read_text(encoding="utf-8"))
            self.assertEqual(
                result["apply_result"]["written"],
                ["scripts/pre-rebuild-cleanup.ps1"],
            )
            self.assertEqual(result["apply_result"]["skipped_conflicts"], ["devcontainer.json"])

            features = {item["id"]: item["status"] for item in result["features"]}
            self.assertEqual(features["cleanup-scripts"], "ok")


if __name__ == "__main__":
    unittest.main()
