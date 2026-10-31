"""互惠名单：分档边界、最小投入量，以及网页和 Python 两侧同一份结果。"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import relationship_stars as rs  # noqa: E402


def find_node():
    found = shutil.which("node")
    if found:
        return found
    bundled = Path("/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node")
    if bundled.is_file():
        return str(bundled)
    return ""


def node_groups(rows, config):
    node = find_node()
    if not node:
        raise AssertionError("找不到 node，无法核对网页版的互惠名单")
    payload = json.dumps({"rows": rows, "config": config}, ensure_ascii=False)
    out = subprocess.check_output([node, str(ROOT / "tests/reciprocity_runner.mjs")],
                                  input=payload.encode("utf-8"), cwd=str(ROOT))
    return json.loads(out)


def row(account, out_n, in_n, rounds=0, tier="", score=None, mutual=False, verified=False):
    return dict(account=account, O_raw=out_n, I_raw=in_n, rounds=rounds, tier=tier,
                score=score, mutual=mutual, verified=verified)


class TestReciprocityGroups(unittest.TestCase):
    def test_min_out_filters_thin_contacts(self):
        info = rs.reciprocity_groups([row("thin", 2, 9), row("ok", 3, 3)])
        self.assertEqual([it["account"] for g in info["groups"] for it in g["items"]], ["ok"])
        self.assertEqual(info["min_out"], 3)
        self.assertTrue(info["ready"])

    def test_boundaries_are_inclusive_on_the_upper_group(self):
        info = rs.reciprocity_groups([row("exact1", 4, 4), row("exact06", 5, 3), row("below06", 10, 5)])
        by_key = {g["key"]: [it["account"] for it in g["items"]] for g in info["groups"]}
        self.assertEqual(by_key["carried"], ["exact1"])
        self.assertEqual(by_key["even"], ["exact06"])
        self.assertEqual(by_key["oneway"], ["below06"])

    def test_rate_over_100_percent_is_kept(self):
        info = rs.reciprocity_groups([row("loud", 3, 9)])
        item = info["groups"][0]["items"][0]
        self.assertEqual(item["account"], "loud")
        self.assertAlmostEqual(item["rate"], 3.0)

    def test_zero_inbound_stays_in_oneway(self):
        info = rs.reciprocity_groups([row("cold", 6, 0)])
        self.assertEqual([it["account"] for it in info["groups"][2]["items"]], ["cold"])

    def test_no_rows_is_not_ready_and_does_not_raise(self):
        info = rs.reciprocity_groups([])
        self.assertFalse(info["ready"])
        self.assertEqual(info["total"], 0)
        self.assertEqual([g["items"] for g in info["groups"]], [[], [], []])

    def test_missing_or_broken_fields_are_ignored_not_crashed(self):
        info = rs.reciprocity_groups([{"account": "no_numbers"}, dict(O_raw=9, I_raw=9), None, row("good", 4, 4)])
        self.assertEqual([it["account"] for g in info["groups"] for it in g["items"]], ["good"])

    def test_order_is_rate_then_rounds_then_volume(self):
        info = rs.reciprocity_groups([row("a", 10, 10, rounds=1), row("b", 10, 10, rounds=4),
                                      row("c", 5, 5, rounds=4), row("d", 8, 8, rounds=4)])
        self.assertEqual([it["account"] for it in info["groups"][0]["items"]], ["b", "d", "c", "a"])

    def test_config_override_moves_the_lines(self):
        info = rs.reciprocity_groups([row("x", 4, 3)], dict(min_out=5, high=0.9, fair=0.5, top=3))
        self.assertEqual(info["total"], 0)
        info = rs.reciprocity_groups([row("x", 6, 3)], dict(min_out=5, high=0.9, fair=0.5, top=3))
        self.assertEqual([it["account"] for it in info["groups"][1]["items"]], ["x"])

    def test_bad_config_falls_back_to_defaults(self):
        info = rs.reciprocity_groups([row("x", 3, 3)], dict(min_out="abc", high=None, fair=-1, top=0))
        self.assertEqual(info["min_out"], 3)
        self.assertEqual(info["high"], 1.0)
        self.assertEqual(info["fair"], 0.6)
        self.assertEqual(info["top"], 20)


class TestReciprocityParity(unittest.TestCase):
    """网页版和命令行必须给出同一份名单，否则看板和终端会互相打脸。"""

    cases = [
        [],
        [row("a", 10, 12, rounds=3, tier="金牌", score=80.0, mutual=True, verified=True),
         row("b", 5, 5, rounds=2, tier="银牌", score=60.0),
         row("c", 8, 2, rounds=0, tier="单向·我常去他没回", score=20.0),
         row("d", 2, 5, rounds=1, tier="样本不足"),
         row("e", 3, 0, rounds=0, tier="单向·我常去他没回")],
        [row("near", 7, 4, rounds=1), row("edge", 3, 2, rounds=0), row("edge2", 5, 3, rounds=2)],
    ]

    def compare(self, expected, got):
        for key in ("ready", "total", "min_out", "high", "fair", "top"):
            self.assertEqual(got[key], expected[key], key)
        self.assertEqual([g["key"] for g in got["groups"]], [g["key"] for g in expected["groups"]])
        for g_got, g_exp in zip(got["groups"], expected["groups"]):
            self.assertEqual(g_got["label"], g_exp["label"])
            self.assertEqual([it["account"] for it in g_got["items"]],
                             [it["account"] for it in g_exp["items"]])
            for it_got, it_exp in zip(g_got["items"], g_exp["items"]):
                self.assertAlmostEqual(it_got["rate"], it_exp["rate"], places=9)
                for key in ("out", "inn", "rounds", "tier"):
                    self.assertEqual(it_got[key], it_exp[key], (it_exp["account"], key))

    def test_default_config_matches(self):
        for case in self.cases:
            with self.subTest(n=len(case)):
                self.compare(rs.reciprocity_groups(case), node_groups(case, None))

    def test_tuned_config_matches(self):
        conf = dict(min_out=4, high=0.75, fair=0.4, top=2)
        for case in self.cases:
            with self.subTest(n=len(case)):
                self.compare(rs.reciprocity_groups(case, conf), node_groups(case, conf))


class TestReciprocityHtml(unittest.TestCase):
    """看板区块：打码后不能出现真实账号，编号要和上面几张表接得上。"""

    runner = ROOT / "tests/reciprocity_runner.mjs"

    def render(self, payload):
        node = find_node()
        if not node:
            raise unittest.SkipTest("找不到 node")
        script = (
            "import fs from 'fs';"
            "import path from 'path';"
            "import {createRequire} from 'module';"
            f"const require = createRequire({json.dumps(str(self.runner))});"
            f"require({json.dumps(str(ROOT / 'engine/fan_audit_engine.js'))});"
            "const F = globalThis.FanAudit;"
            "const spec = JSON.parse(fs.readFileSync(0, 'utf8'));"
            "process.stdout.write(F.reciprocityHtml(F.reciprocity(spec.rows, spec.config), spec.options));"
        )
        out = subprocess.check_output([node, "--input-type=module", "-e", script],
                                      input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                      cwd=str(ROOT))
        return out.decode("utf-8")

    def test_masked_board_hides_handles(self):
        rows = [row("secret_handle", 6, 6, tier="金牌"), row("secret_two", 8, 2)]
        html = self.render({"rows": rows, "config": None, "options": {"masked": True, "rows": rows}})
        self.assertIn('id="reciprocity"', html)
        self.assertNotIn("secret_handle", html)
        self.assertNotIn("secret_two", html)
        self.assertIn("账号#01", html)

    def test_plain_board_links_profiles(self):
        rows = [row("visible_handle", 6, 3)]
        html = self.render({"rows": rows, "config": None, "options": {"masked": False, "rows": rows}})
        self.assertIn("https://x.com/visible_handle", html)
        self.assertIn("50%", html)

    def test_empty_board_renders_nothing(self):
        html = self.render({"rows": [row("thin", 1, 1)], "config": None, "options": {"masked": False, "rows": []}})
        self.assertEqual(html, "")


class TestReciprocityInDashboard(unittest.TestCase):
    """整条命令行跑一遍：区块要出现在两个看板里，打码版不能带链接，CSV 要有 revisit 列。"""

    sample = ROOT / "sample_data"

    def run_audit(self, *args):
        return subprocess.run([sys.executable, str(ROOT / "audit.py"), *args],
                              capture_output=True, text=True, cwd=str(ROOT), timeout=180)

    def test_sample_dashboard_shows_block_and_csv_column(self):
        out = tempfile.TemporaryDirectory()
        self.addCleanup(out.cleanup)
        result = self.run_audit("--data", str(self.sample), "--out", out.name, "--tz", "America/Los_Angeles")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("互惠名单", result.stdout)

        private = Path(out.name, "dashboard.html").read_text(encoding="utf-8")
        public = Path(out.name, "dashboard_public.html").read_text(encoding="utf-8")
        self.assertIn('id="reciprocity"', private)
        self.assertIn('id="reciprocity"', public)
        self.assertIn("他回得不比我少", private)
        self.assertNotIn("https", public.split('id="reciprocity"', 1)[1])
        self.assertNotIn("x.com", public.split('id="reciprocity"', 1)[1])

        table = Path(out.name, "accounts.csv").read_text(encoding="utf-8-sig")
        reader = csv.DictReader(table.splitlines())
        self.assertIn("revisit", reader.fieldnames)
        values = list(reader)
        for row in values:
            if not row["O_raw"] or row["O_raw"] == "0":
                self.assertEqual(row["revisit"], "", row["account"])


if __name__ == "__main__":
    unittest.main()
