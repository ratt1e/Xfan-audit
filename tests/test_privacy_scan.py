"""scripts/privacy_scan.py 的测试（全部虚构数据）。T00 时把本文件放进 tests/。"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import privacy_scan as ps  # noqa: E402


class TestPrivacyScan(unittest.TestCase):
    def make(self, files):
        d = tempfile.mkdtemp()
        for name, text in files.items():
            with open(os.path.join(d, name), "w", encoding="utf-8") as f:
                f.write(text)
        return d

    def test_clean(self):
        d = self.make({"a.md": "示例 @user_01 和 @me_demo\nGET /2/users/:id/tweets\n不要用导出 cookie 的工具\n"})
        self.assertEqual(ps.scan(d, set(), set()), [])

    def test_catches(self):
        # 敏感样例用拼接生成，避免本测试文件自己被 privacy_scan 扫出来
        text = "\n".join(["fake_person_x 来过", "/" + "Users/someone/Desktop", "ct" + "0=abcdefghijklmnop123",
                          "@" + "not_allowed", ps.AUTHOR, "1234567" + "890123456", "这是一条真实的回复内容啊啊"])
        d = self.make({"a.md": text})
        labels = {f[2] for f in ps.scan(d, {"fake_person_x"}, {"这是一条真实的回复内"})}
        self.assertEqual(len(labels), 7, labels)

    def test_author_line_allowed_only_in_readme(self):
        line = "👋 作者正在 X 上连载这个项目的迭代过程，欢迎来 X [@%s](https://x.com/%s) 找我聊！\n" % (ps.AUTHOR, ps.AUTHOR)
        self.assertEqual(ps.scan(self.make({"README.md": line}), set(), set()), [])
        self.assertTrue(ps.scan(self.make({"other.md": line}), set(), set()))

    def test_userscript_header_is_not_a_mention(self):
        at = "@"
        text = "\n".join([
            "// ==UserScript==",
            "// " + at + "name fan-audit",
            "// " + at + "author " + ps.AUTHOR,
            "// " + at + "match *://x.com/*",
            "// " + at + "grant unsafeWindow",
            "// " + at + "run-at document-start",
            "// " + at + "updateURL https://raw.githubusercontent.com/ratt1e/Xfan-audit/main/userscript/fan-audit.user.js",
            "// ==/UserScript==",
            "var kept = 1;",
        ])
        self.assertEqual(ps.scan(self.make({"fan-audit.user.js": text}), set(), set()), [])
        leaked = text + "\n// " + at + "author " + ps.AUTHOR + "\nconst x = " + at + "not_allowed;\n"
        labels = {item[2] for item in ps.scan(self.make({"fan-audit.user.js": leaked}), set(), set())}
        self.assertIn("@账号不在白名单（虚构示例请用 user_01 这种）", labels)

    def test_github_url_of_author_ok(self):
        line = "git clone https://github.com/%s/fan-audit.git\n" % ps.AUTHOR
        self.assertEqual(ps.scan(self.make({"README.md": line, "post.md": line}), set(), set()), [])

    def test_snapshot_name_is_private(self):
        d = self.make({"lists_snapshot.json": "{}\n"})
        found = ps.scan(d, set(), set())
        self.assertTrue(any(item[3] == "lists_snapshot.json" for item in found))

    def test_names_from_csv(self):
        d = self.make({"names.csv": "handle,name\n@Fake_Person_Y,Y\nuser_02,Z\n"})
        names = ps.load_names([], [os.path.join(d, "names.csv")])
        self.assertEqual(names, {"fake_person_y"})


if __name__ == "__main__":
    unittest.main()
