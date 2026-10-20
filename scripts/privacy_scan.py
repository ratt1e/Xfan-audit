#!/usr/bin/env python3
"""fan-audit 脱敏自检：扫描「会进仓库的文件」，找真实账号名、真实回复、cookie/token、本机绝对路径。

只用标准库，离线运行。发现问题时退出码为 1（可以挂在提交前、发布前）。

用法：
  # 只用内置规则（路径、密钥、@账号白名单）
  python3 scripts/privacy_scan.py

  # 加上本地真名单（名单文件放在仓库外，永远不要拷进仓库）
  python3 scripts/privacy_scan.py \
      --names-from "~/x-data/*/private/*.csv" \
      --texts-from "~/x-data/*/private/interactions.csv" \
      --names "~/x-data/scan_names.txt"
  （通配符加引号，由脚本自己展开；zsh 下不加引号、又没匹配到时会直接报错）

扫描范围：git 仓库里用 `git ls-files --cached --others --exclude-standard`（= 会被提交的文件），
不是 git 仓库时扫整个目录（跳过 .git、__pycache__、二进制文件）。
"""
import argparse
import csv
import glob
import os
import re
import subprocess
import sys

BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".xlsx", ".zip", ".pyc", ".ico"}
NAME_COLS = ("handle", "account", "screen_name", "username", "对方", "账号")
TEXT_COLS = ("text", "full_text", "正文")
# 允许出现的 @账号（虚构示例、机器人、作者引流）
ALLOWED_HANDLE = re.compile(r"^(user_\d+|me_demo|demo_owner|grok|media|keyframes|import|font-face)$", re.I)
AUTHOR = "ranger" + "_escape"  # 拆开写，免得本文件自己被扫出来
AUTHOR_LINE_HINT = "作者正在 X 上连载"
RULES = [
    ("本机绝对路径", re.compile(r"(?<![\w.])(/Users/[A-Za-z0-9._-]+|/home/[a-z][a-z0-9_-]*/|[A-Za-z]:\\Users\\)")),
    ("本机路径", re.compile(r"(?<![\w.])/(workspace|cursor/stores|private/var)/")),
    ("cookie/token 值", re.compile(r"(auth_token|ct0|guest_id|twid|kdt)\s*[=:]\s*['\"]?[A-Za-z0-9%_-]{12,}", re.I)),
    ("Bearer token", re.compile(r"Bearer\s+[A-Za-z0-9%_.-]{20,}")),
    ("API key", re.compile(r"\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpa]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})")),
    ("疑似真实推文/用户 ID（15 位以上数字）", re.compile(r"(?<!\d)\d{15,20}(?!\d)")),
]


def tracked_files(repo):
    try:
        out = subprocess.run(["git", "-C", repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                             capture_output=True, check=True).stdout.decode("utf-8")
        files = [f for f in out.split("\0") if f]
        if files:
            return files
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    files = []
    for root, dirs, fs in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", "node_modules")]
        for f in fs:
            files.append(os.path.relpath(os.path.join(root, f), repo))
    return files


def expand(paths):
    out = []
    for p in paths or []:
        out += sorted(glob.glob(os.path.expanduser(p))) or [os.path.expanduser(p)]
    return [p for p in out if os.path.isfile(p)]


def load_names(name_files, csv_files):
    names = set()
    for p in name_files:
        with open(p, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip().lstrip("@").lower()
                if line and not line.startswith("#"):
                    names.add(line)
    for p in csv_files:
        with open(p, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                for c in NAME_COLS:
                    v = (r.get(c) or "").strip().lstrip("@").lower()
                    if v:
                        names.add(v)
    # 作者自己的账号单独按「只许出现在 README 引流行」处理，不当成别人的真名
    return {n for n in names if len(n) >= 4 and n != AUTHOR and not ALLOWED_HANDLE.match(n)}


def load_texts(csv_files, min_len=10):
    snippets = set()
    for p in csv_files:
        with open(p, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                for c in TEXT_COLS:
                    t = re.sub(r"@\w+|https?://\S+", "", r.get(c) or "").strip()
                    t = re.sub(r"\s+", " ", t)
                    if len(t) >= min_len:
                        snippets.add(t[:min_len])
    return snippets


def scan(repo, names, texts, allow_ids=()):
    findings = []
    name_re = None
    if names:
        name_re = re.compile(r"(?<![A-Za-z0-9_])(" + "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))
                             + r")(?![A-Za-z0-9_])", re.I)
    for rel in tracked_files(repo):
        p = os.path.join(repo, rel)
        if os.path.splitext(rel)[1].lower() in BINARY_EXT or not os.path.isfile(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                lines = f.read().splitlines()
        except UnicodeDecodeError:
            continue
        for i, line in enumerate(lines, 1):
            for label, rx in RULES:
                for m in rx.finditer(line):
                    if label.startswith("疑似") and m.group(0) in allow_ids:
                        continue
                    findings.append((rel, i, label, m.group(0)))
            # 仓库地址 github.com/<作者>/... 不算点名（GitHub 用户名可能和 X 账号相同）
            line_a = re.sub(r"github\.com/" + AUTHOR + r"\b", "github.com/", line, flags=re.I)
            for m in re.finditer(r"(?<![\w.])@([A-Za-z0-9_]{2,15})\b", line_a):
                h = m.group(1)
                if h.lower() == AUTHOR:
                    if not (rel == "README.md" and AUTHOR_LINE_HINT in line):
                        findings.append((rel, i, "作者账号出现在引流行以外", "@" + h))
                elif not ALLOWED_HANDLE.match(h):
                    findings.append((rel, i, "@账号不在白名单（虚构示例请用 user_01 这种）", "@" + h))
            if AUTHOR in line_a.lower() and "@" + AUTHOR not in line_a.lower() and not (rel == "README.md" and AUTHOR_LINE_HINT in line):
                findings.append((rel, i, "作者账号出现在引流行以外", AUTHOR))
            if name_re:
                for m in name_re.finditer(line):
                    findings.append((rel, i, "真实账号名（来自本地名单）", m.group(0)))
            for s in texts:
                if s in line:
                    findings.append((rel, i, "真实回复内容（来自本地名单）", s))
    return findings


def main(argv=None):
    ap = argparse.ArgumentParser(description="fan-audit 脱敏自检（离线）")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--names", nargs="*", default=[], help="每行一个账号名的 txt（放仓库外）")
    ap.add_argument("--names-from", nargs="*", default=[], help="从 CSV 的 handle/account 等列读账号名（放仓库外）")
    ap.add_argument("--texts-from", nargs="*", default=[], help="从 CSV 的 text 列读真实回复，取前 10 个字比对")
    ap.add_argument("--allow-id", nargs="*", default=[], help="允许出现的长数字（比如公开文档里的示例 ID）")
    ap.add_argument("--allow-name", nargs="*", default=[], help="名单里碰巧和普通词、品牌名重名的账号（比如名单里有某个品牌的官方号），确认是误报后放行")
    a = ap.parse_args(argv)
    names = load_names(expand(a.names), expand(a.names_from)) - {n.lstrip("@").lower() for n in a.allow_name}
    texts = load_texts(expand(a.texts_from))
    fs = scan(a.repo, names, texts, set(a.allow_id))
    print(f"扫描 {len(tracked_files(a.repo))} 个文件；本地名单 {len(names)} 个账号名、{len(texts)} 段回复片段")
    for rel, i, label, s in fs:
        print(f"✗ {rel}:{i}  {label}：{s[:60]}")
    print("✔ 没发现问题" if not fs else f"共 {len(fs)} 处，需要处理（名单内容不会被打印到别处，也不要提交名单文件）")
    return 1 if fs else 0


if __name__ == "__main__":
    sys.exit(main())
