"""油猴脚本：夹具解析、打包引擎和网页引擎算出同样的分层。"""
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def find_node():
    found = shutil.which("node")
    if found:
        return found
    bundled = Path("/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node")
    if bundled.is_file():
        return str(bundled)
    return ""


class TestUserscript(unittest.TestCase):
    def test_capture_bundle_and_tiers(self):
        node = find_node()
        self.assertTrue(node, "找不到 node")
        built = subprocess.run([node, str(ROOT / "userscript/build.mjs")], cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(built.returncode, 0, built.stderr)
        checked = subprocess.run([node, str(ROOT / "tests/userscript_runner.mjs")], cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        self.assertIn("userscript checks ok", checked.stdout)
        text = (ROOT / "userscript/fan-audit.user.js").read_text(encoding="utf-8")
        self.assertIn("document-start", text)
        self.assertIn("fan-audit（油猴版）· GitHub 开源", text)
