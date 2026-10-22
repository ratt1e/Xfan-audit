"""没回关：虚构账号，只读，打码版不带主页。"""
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import audit  # noqa: E402
import not_followed_back as nfb  # noqa: E402
from daily_root import OUTPUT_NAMES, own_output_entries  # noqa: E402

SAMPLE = ROOT / "sample_data"
FULL_PARTS = [
    {"name": "replies.csv", "file": "sample_data/replies.csv"},
    {"name": "following.csv", "file": "sample_data/following.csv"},
    {"name": "followers.csv", "file": "sample_data/followers.csv"},
    {"name": "likes.csv", "file": "sample_data/likes.csv"},
    {"name": "profiles.csv", "file": "sample_data/profiles.csv"},
]
LIST_PARTS = [
    {"name": "following.csv", "file": "sample_data/following.csv"},
    {"name": "followers.csv", "file": "sample_data/followers.csv"},
]
FOLLOWING_JSON = json.dumps([
    {"id": "8800601", "screen_name": "user_71"},
    {"id": "8800602", "screen_name": "user_72"},
    {"screen_name": "user_73"},
], ensure_ascii=False)
FOLLOWERS_JSON = json.dumps([
    {"id": "8800601", "screen_name": "user_71b"},
    {"id": "8800699", "screen_name": "user_72"},
    {"id": "8800700", "screen_name": "user_73"},
], ensure_ascii=False)


def find_node():
    found = shutil.which("node")
    if found:
        return found
    bundled = Path("/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node")
    return str(bundled) if bundled.is_file() else ""


def pack(items):
    out = []
    for item in items:
        score = item["score"]
        out.append({
            "id": item["id"] or "",
            "handle": item["handle"] or "",
            "interactions": item["interactions"],
            "score": None if score is None else float(score),
            "tier": item["tier"] or "",
        })
    return out


def scored(empty_talk=False):
    conf, cfg = audit.rs.load_config(str(ROOT / "config.json"))
    data = audit.load_inputs(str(SAMPLE))
    if empty_talk:
        data = dict(data, rows=[])
    res, _meta = audit.analyze(data, conf, cfg, "2026-10-19", 30, False)
    return res


class TestNotFollowedBack(unittest.TestCase):
    def web(self, parts, **spec):
        node = find_node()
        if not node:
            raise AssertionError("找不到 node，无法核对网页没回关")
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        plan = Path(folder.name) / "notback.json"
        body = {"parts": parts}
        body.update(spec)
        plan.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
        return json.loads(subprocess.check_output(
            [node, str(ROOT / "tests/web_score_runner.mjs"), "notback", str(plan)], cwd=str(ROOT)))

    def test_sample_order_keep_list_and_web_match(self):
        rows = scored()
        info = nfb.build(SAMPLE, rows)
        self.assertTrue(info["ready"])
        handles = [item["handle"] for item in info["items"]]
        self.assertEqual(handles[0], "user_17")
        self.assertEqual(set(handles), {"user_09", "user_16", "user_17", "user_19"})
        self.assertEqual(info["items"][0]["interactions"], 0)
        self.assertIsNone(info["items"][0]["score"])
        keys = [nfb.sort_key(item) for item in info["items"]]
        self.assertEqual(keys, sorted(keys))
        self.assertTrue(all(item["profile"] == "https://x.com/" + item["handle"] for item in info["items"]))
        web = self.web(FULL_PARTS)
        self.assertEqual(pack(web["info"]["items"]), pack(info["items"]))
        lists = nfb.build(SAMPLE, scored(empty_talk=True))
        self.assertEqual([item["handle"] for item in lists["items"]], ["user_09", "user_16", "user_17", "user_19"])
        self.assertTrue(all(item["interactions"] == 0 and item["score"] is None for item in lists["items"]))
        web_lists = self.web(LIST_PARTS)
        self.assertEqual(pack(web_lists["info"]["items"]), pack(lists["items"]))

    def test_keep_list_skips_comments_headers_and_ids(self):
        text = "# 故意关注\nhandle\n@user_17\nuser_09\n"
        ids, handles = nfb.parse_keep_text(text)
        self.assertEqual(ids, set())
        self.assertEqual(handles, {"user_17", "user_09"})
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / "keep.txt"
        path.write_text(text, encoding="utf-8")
        info = nfb.build(SAMPLE, scored(), path)
        self.assertEqual({item["handle"] for item in info["items"]}, {"user_16", "user_19"})
        self.assertEqual([nfb.sort_key(item) for item in info["items"]],
                         sorted(nfb.sort_key(item) for item in info["items"]))
        web = self.web(LIST_PARTS + [
            {"name": "保留名单.txt", "text": text},
            {"name": "keep.txt", "text": "# only a comment\n"},
            {"name": "people.csv", "text": "@user_16\n", "kind": "keep"},
        ])
        self.assertEqual(web["kinds"][-3:], ["keep", "keep", "keep"])
        self.assertEqual([item["handle"] for item in web["info"]["items"]], ["user_19"])

    def test_id_match_and_keep_id(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        base = Path(folder.name)
        (base / "following.json").write_text(FOLLOWING_JSON, encoding="utf-8")
        (base / "followers.json").write_text(FOLLOWERS_JSON, encoding="utf-8")
        info = nfb.build(base, [])
        self.assertEqual([(item["id"], item["handle"]) for item in info["items"]], [("8800602", "user_72")])
        keep = base / "keep.txt"
        keep.write_text("# id\n8800602\n", encoding="utf-8")
        self.assertEqual(nfb.build(base, [], keep)["items"], [])
        web = self.web([
            {"name": "following.json", "text": FOLLOWING_JSON},
            {"name": "followers.json", "text": FOLLOWERS_JSON},
            {"name": "keep.txt", "text": "8800602\n"},
        ], skipAnalyze=True, rows=[])
        self.assertEqual(web["kinds"][:2], ["following", "followers"])
        self.assertEqual(web["info"]["items"], [])
        web_open = self.web([
            {"name": "following.json", "text": FOLLOWING_JSON},
            {"name": "followers.json", "text": FOLLOWERS_JSON},
        ], skipAnalyze=True, rows=[])
        self.assertEqual([(item["id"], item["handle"]) for item in web_open["info"]["items"]], [("8800602", "user_72")])

    def test_missing_one_list_is_not_everyone(self):
        self.assertFalse(nfb.build(None, [])["ready"])
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        base = Path(folder.name)
        (base / "following.csv").write_text("handle,name\nuser_17,示例\n", encoding="utf-8")
        info = nfb.build(base, [])
        self.assertFalse(info["ready"])
        self.assertIsNone(info["items"])
        self.assertIn("先不算", info["note"])
        web = self.web([{"name": "following.csv", "file": "sample_data/following.csv"}])
        self.assertFalse(web["info"]["ready"])
        self.assertIsNone(web["info"]["items"])
        self.assertEqual(web["info"]["note"], nfb.MISSING)
        self.assertNotIn("user_", web["masked"])
        self.assertNotIn("x.com", web["masked"])
        hidden = self.web([{"name": "replies.csv", "file": "sample_data/replies.csv"}])
        self.assertIsNone(hidden["info"])
        self.assertEqual(hidden["masked"], "")

    def test_mask_reuses_row_alias_and_drops_links(self):
        web = self.web(FULL_PARTS)
        masked, opened = web["masked"], web["open"]
        self.assertNotIn("user_", masked)
        self.assertNotIn("https", masked)
        self.assertNotIn("x.com", masked)
        self.assertNotIn("href", masked)
        self.assertNotIn("<button", masked)
        self.assertIn(nfb.SAFETY, masked)
        idx = web["accounts"].index("user_17")
        alias = "账号#%02d" % (idx + 1)
        cells = re.findall(r"<tr><td>(账号#\d+)</td>", masked)
        self.assertEqual(cells[0], alias)
        self.assertEqual(len(cells), 4)
        links = re.findall(r'href="([^"]+)"', opened)
        self.assertEqual(links, ["https://x.com/" + item["handle"] for item in web["info"]["items"]])
        self.assertNotIn("<button", opened)
        page = (ROOT / "web/index.html").read_text(encoding="utf-8")
        self.assertNotIn("https://", page)
        self.assertIn('"https:" + "//x.com/"', page)
        self.assertIn('["keep", "保留名单"]', page)
        chunk = page.split("function notFollowedBackHtml", 1)[1].split("root.FanAudit", 1)[0]
        self.assertNotIn("<button", chunk)
        self.assertNotIn("取关选中", page)
        self.assertNotIn("批量取关", page)

    def test_alias_continues_and_public_has_no_link(self):
        info = {"ready": True, "items": [{
            "id": "", "handle": "user_17", "interactions": 0, "score": None,
            "tier": "零互动", "profile": "https://x.com/user_17",
        }], "note": ""}
        alias = {"user_01": "账号#01", "user_17": "账号#08"}
        public = audit.not_back_block(info, alias, public=True)
        self.assertIn("<td>账号#08</td>", public)
        self.assertNotIn("user_", public)
        self.assertNotIn("https", public)
        self.assertNotIn("x.com", public)
        self.assertEqual(alias["user_01"], "账号#01")
        private = audit.not_back_block(info, {}, public=False)
        self.assertIn("https://x.com/user_17", private)
        self.assertIn("@user_17", private)
        self.assertNotIn("<button", private)

    def test_collision_shows_id_only_in_private_file(self):
        following = follow_index([
            {"id": "8800602", "screen_name": "user_72"},
            {"id": "8800699", "screen_name": "user_72"},
        ])
        info = nfb.assemble(following, follow_index([]), [])
        self.assertEqual(len(info["items"]), 2)
        text = nfb.render_markdown(info)
        self.assertIn("user_72（id 8800602）", text)
        self.assertIn("user_72（id 8800699）", text)
        public = audit.not_back_block(info, {}, public=True)
        self.assertNotIn("user_", public)
        self.assertNotIn("8800", public)
        self.assertEqual(len(re.findall(r"账号#\d+", public)), 2)

    def test_cli_writes_private_files_and_masks_dashboard(self):
        out = tempfile.TemporaryDirectory()
        self.addCleanup(out.cleanup)
        kept = tempfile.TemporaryDirectory()
        self.addCleanup(kept.cleanup)
        result = self.run_audit("--data", SAMPLE, "--out", out.name)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("没回关 4", result.stdout)
        self.assertNotIn("user_", result.stdout)
        self.assertNotIn("user_", result.stderr)
        names = sorted(os.listdir(out.name))
        self.assertEqual(names, sorted(name for name in OUTPUT_NAMES if name != "名单.md"))
        private = Path(out.name, "dashboard.html").read_text(encoding="utf-8")
        public = Path(out.name, "dashboard_public.html").read_text(encoding="utf-8")
        report = Path(out.name, "没回关.md").read_text(encoding="utf-8")
        table = Path(out.name, "没回关.csv").read_text(encoding="utf-8-sig")
        self.assertIn("https://x.com/user_17", private)
        self.assertIn("https://x.com/user_17", report)
        self.assertIn(nfb.SAFETY, report)
        self.assertNotIn("<button", private)
        self.assertNotIn("user_", public)
        self.assertNotIn("https", public)
        self.assertNotIn("x.com", public)
        self.assertIn("没回关", public.split('id="not-followed-back"', 1)[1])
        self.assertIn(nfb.SAFETY, public)
        reader = csv.DictReader(table.splitlines())
        self.assertEqual(reader.fieldnames, ["handle", "user_id", "interactions", "score", "tier", "profile"])
        csv_rows = list(reader)
        self.assertEqual(csv_rows[0]["handle"], "user_17")
        self.assertEqual(csv_rows[0]["profile"], "https://x.com/user_17")
        keep = Path(kept.name) / "keep.txt"
        keep.write_text("@user_17\n", encoding="utf-8")
        again = tempfile.TemporaryDirectory()
        self.addCleanup(again.cleanup)
        second = self.run_audit("--data", SAMPLE, "--keep-list", keep, "--out", again.name)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("没回关 3", second.stdout)
        self.assertNotIn("user_", second.stdout)
        self.assertNotIn("user_17", Path(again.name, "没回关.md").read_text(encoding="utf-8"))
        self.assertEqual(Path(out.name, "accounts.csv").read_bytes(), Path(again.name, "accounts.csv").read_bytes())

    def test_bad_keep_list_and_symlink_do_not_write(self):
        out = tempfile.TemporaryDirectory()
        self.addCleanup(out.cleanup)
        missing = Path(out.name) / "keep-missing-token.txt"
        result = self.run_audit("--data", SAMPLE, "--keep-list", missing, "--out", out.name)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("保留名单读不了", result.stderr)
        self.assertNotIn("keep-missing-token", result.stderr)
        self.assertNotIn("user_", result.stderr)
        self.assertFalse((Path(out.name) / "dashboard.html").exists())
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        base = Path(folder.name)
        real = base / "real.md"
        real.write_text("keep-me", encoding="utf-8")
        link = base / "没回关.md"
        link.symlink_to(real)
        blocked = self.run_audit("--data", SAMPLE, "--out", base)
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn("不是普通文件", blocked.stderr)
        self.assertEqual(real.read_text(encoding="utf-8"), "keep-me")
        self.assertTrue(link.is_symlink())
        self.assertFalse((base / "dashboard.html").exists())
        guard = Path(folder.name) / "guard"
        guard.mkdir()
        (guard / "没回关.md").symlink_to(real)
        with self.assertRaises(ValueError):
            own_output_entries(guard)
        self.assertTrue((guard / "没回关.md").is_symlink())

    def run_audit(self, *args):
        return subprocess.run([sys.executable, str(ROOT / "audit.py"), *map(str, args)],
                              capture_output=True, text=True)


def follow_index(records):
    import follow_diff
    return follow_diff.index_accounts(records)


if __name__ == "__main__":
    unittest.main()
