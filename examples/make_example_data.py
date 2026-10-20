"""生成完全虚构的示例数据（user_001 这类假账号），只用于演示脚本。
所有账号、名字、简介、互动数都是随机生成的，与任何真实账号无关。"""
import csv, random
random.seed(42)
N = 80
bios_plain = ["示例账号：喜欢写代码", "示例账号：AI 爱好者", "示例账号：摄影和旅行", "Example account: indie dev", "示例账号：读书笔记", ""]
bios_mutual = ["示例账号：有关必回", "示例账号：诚信互关", "Example account: follow back 100%", "示例账号：浇朋友，蓝V互助"]
people = []
for i in range(1, N + 1):
    bio = random.choice(bios_mutual) if random.random() < 0.3 else random.choice(bios_plain)
    people.append({"handle": f"user_{i:03d}", "name": f"示例用户{i:03d}", "bio": bio})
following = [p for p in people if random.random() < 0.75]
followers = [p for p in people if random.random() < 0.6]
def w(path, rows, cols):
    with open(path, "w", newline="", encoding="utf-8") as f:
        wr = csv.DictWriter(f, fieldnames=cols); wr.writeheader(); wr.writerows(rows)
w("following.csv", following, ["handle", "name", "bio"])
w("followers.csv", followers, ["handle", "name", "bio"])
eng = []
for p in people + [{"handle": f"user_{i:03d}"} for i in range(81, 86)]:
    if random.random() < 0.3:
        eng.append({"handle": p["handle"], "likes": random.randint(0, 6), "replies": random.randint(0, 4), "quotes": 0, "reposts": 0})
w("engagement.csv", eng, ["handle", "likes", "replies", "quotes", "reposts"])
w("requests.csv", [{"handle": f"user_{i:03d}", "note": "示例：评论里求互关"} for i in random.sample(range(1, N + 1), 8)], ["handle", "note"])
print(len(following), len(followers), len(eng))
