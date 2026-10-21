# fan-audit：X 粉丝体检 · 互动关系星级

> 👋 作者正在 X 上连载这个项目的迭代过程，跑不通或有更好的打分建议，欢迎来 X [@ranger_escape](https://x.com/ranger_escape) 找我聊！

**试用版 v0.1 · 权重待验证**

![看板示例（假数据生成，已打码）](docs/img/dashboard.png)

用你自己账号的**公开回复**和**关注关系**，找出谁是真的在跟你来回聊天的「金牌用户」，谁是互关了但从来不说话的「沉睡互关」。

- 离线、只读：不联网，不调用任何 X 接口，不会点赞、关注、取关任何人。
- 只用 Python 标准库（3.9+），不用装任何依赖。
- 一行命令出两个看板：一个带账号名（只给自己看），一个自动打码（可以截图分享）。

## Quick Start（三步）

```bash
# 1. 下载
git clone <仓库地址> fan-audit && cd fan-audit      # 或者下载 zip 解压

# 2. 先用假数据跑一遍（1 秒）
python3 audit.py --data sample_data
#    打开 output/dashboard.html 看效果

# 3. 换成你自己的数据：把 CSV 放进 data/，再跑
python3 audit.py
```

第 3 步需要的 CSV 怎么导出，看 **[docs/DATA_EXPORT.md](docs/DATA_EXPORT.md)**（保姆级，写了浏览器插件和 X 官方归档两种办法）。最少只要一个 `replies.csv`，最好再加 `following.csv`、`followers.csv`。

输出在 `output/`：

| 文件 | 内容 |
|---|---|
| `dashboard.html` | 看板：星级分布、分层、金牌和银牌名单、建议动作。**含真实账号名，只给自己看** |
| `dashboard_public.html` | 同一个看板的打码版，账号名换成「账号#01」，不列单向和沉睡名单，可以截图分享 |
| `accounts.csv` | 每个账号一行：分层、星级、分数、各项明细 |

常用参数：`--data 目录`、`--out 目录`、`--days 30`、`--all-days`（全部互动日期）、`--end 2026-10-19`、`--me 你的用户名`（排除自己回自己）、`--config config.json`。

已有每日采集目录时，用 `--data-root ~/x-data/` 合并多天；可加 `--lists ~/x-lists/`，只读取关注表和粉丝表，不混入该目录的回复。也可设置环境变量 `FAN_AUDIT_DATA_ROOT`，显式 `--data` 仍保持原来的单目录用法。每日模式的结果必须在仓库外，并多输出一份私有的 `名单.md`；已有同名结果时会拒绝覆盖。用法与覆盖情况说明见 [多天一起分析](docs/DAILY_COLLECT.md#多天一起分析)。

## 星级怎么算（大白话）

只看这段时间（默认最近 30 天）里**你和每个人之间**的公开回复。每个人打 0–100 分：

| 看什么 | 占比 | 大白话 |
|---|---|---|
| 持续性 | 40% | 是不是很多天都在聊，而不是某一天突然聊很多 |
| 双向性 | 35% | 你回他和他回你的条数差不多，才算双向 |
| 往返 | 25% | 真的接上话了：你回他，他又回你那一条（靠 `in_reply_to_status_id` 判断） |
| 点赞 | 最多 +5 分 | 只是辅助，不能把几乎没说过话的人抬上去 |

- **问候和水评不算数**：「早安」「互关」「来咯」这类短句（词表在 `config.json`）不计入双向性和往返；一个人 80% 以上都是问候，最多 2 星。
- **样本不足不打星**：少于 3 条，或者都在同一天，显示「样本不足」，不硬给低分。
- 分数换星级：≥80 ★5，≥60 ★4，≥40 ★3，≥20 ★2，其余 ★1。

**金牌用户** = 分数 ≥55（4 星或接近）＋ 真往返 ≥3 轮 ＋ 双方实质回复各 ≥3 条 ＋ 问候不到一半 ＋ 至少 2 天有实质互动。对方至少要回过 1 条。
**银牌** = 有分但不够金牌，对方至少回过 1 条，而且确认往返至少 1 次；在此之上分数 ≥40 或真往返 ≥2 轮。对方一条都没回，或者一次确认往返都没有，不进银牌。
**单向** = 一边 ≥3 条、另一边几乎没有。我这边 ≥3 条、对方回复数为 0 时，优先标「我常去他没回」，分数到了银牌线也一样。对方回过但回复链对不上、确认往返是 0 的，不叫「他没回」。**沉睡互关** = 互关，但这段时间零回复、零点赞。

名单里的排序会给互关、蓝V（对 X 创作者收益的认证曝光有用）、对方粉丝多的人少量加分，只影响先后，不改星级。

以上所有数字都是**初始值、待验证**，都在 [`config.json`](config.json) 里，改完重跑就行。完整公式见 [docs/SPEC_relationship_stars.md](docs/SPEC_relationship_stars.md)。

> 分数只是线索，不代表真实关系，也不代表对方好不好。零公开互动 ≠ 没看过你的帖子。看板里的「建议动作」只是建议，工具不会执行任何操作。

## Roadmap

- [x] v0.1 CSV → 星级 → 金牌/银牌/单向/沉睡互关分层 → HTML 看板（含打码版）
- [x] v0.1 配置文件 `config.json`（词表、权重、星级线、门槛）
- [x] v0.2 对话往返轮数（严格回复链：`in_reply_to_status_id` 指向对方那条才算）——已实现；没有父帖 ID 的回复会提示「无法确认往返」
- [ ] v0.2 和上一个区间比的趋势（↑↓），7 天 / 30 天切换写进看板
- [ ] v0.3 用大模型识别走心评论 vs 水评，替代现在的关键词词表
- [ ] v0.4 一键生成打码版月度铁粉报告
- [ ] 权重校准：用户标约 10 个「朋友」后按 SPEC 第 11 节调参

## 其他工具（仓库里已有）

- `fan_audit.py`：名单核对（v0 功能）。用关注表、粉丝表和互动汇总，看互关比例、零互动率、简介含「互关」关键词的账号。用法：

```bash
python3 fan_audit.py --following examples/following.csv --followers examples/followers.csv \
  --engagement examples/engagement.csv --requests examples/requests.csv --keywords keywords.txt \
  --posts 10 --out output/name_check
```

  装了 openpyxl（`pip install -r requirements.txt`）会多输出 `report.xlsx`，不装也能跑。
- `scripts/daily_collect.py`：把 X 官方只读接口的原始 JSON 转成 `interactions.csv`，见 [docs/DAILY_COLLECT.md](docs/DAILY_COLLECT.md)。
- `scripts/relationship_stars.py`：只打星的命令行版本。
- `adapters/`：twitter-web-exporter、X 官方归档、通用 CSV 的转换脚本。

## 有效曝光规则（为什么只看粉丝数不够）

X 现行的创作者收益项目是 Original Content Rewards（2026 年 9 月 8 日起替代 Creator Revenue Sharing）。据官方帮助页，申请时要同时满足：

- 有效的 Premium、Premium+ 或 Premium Business 订阅
- 至少 **500 个认证粉丝**
- 最近 90 天内，来自**认证用户**的**首页时间线**曝光至少 **500,000** 次，**回复的曝光不计入**
- 年满 18 岁，所在地区在支持名单内

收益按「合格曝光」计算：来自 Premium 用户、出现在首页时间线、帖子至少 50% 可见的去重曝光，不含付费、推广和欺诈曝光。

所以，粉丝数只是门槛之一；不回来看帖的粉丝，对曝光门槛的贡献可能很小。这个脚本测的是「公开互动」，可以当作一个粗略的替代指标，但它不等于有效曝光。规则会变，请以官方当前页面为准。

参考：
1. X Help Center, Original Content Rewards: https://help.x.com/en/using-x/original-content-rewards （Wayback 2026-10-05 快照：https://web.archive.org/web/20261005131543/https://help.x.com/en/using-x/original-content-rewards ）
2. Original Content Rewards Program Terms (Effective Aug 7, 2026): https://legal.x.com/en/original-content-rewards-terms.html
3. The Verge, 2026-08-08: https://www.theverge.com/tech/977143/x-revenue-sharing-original-content-rewards

详细的指标定义和公式见 [docs/methodology.md](docs/methodology.md)。

## 隐私和安全

- **只读。** 不要写脚本自动关注、取关或批量操作，这违反 X 的自动化规则，可能被限流或封号。清理关注也请手动、分批、慢慢来。
- **不要提交真实数据。** `.gitignore` 已经排除 `data/`、`output/`、`private/`、导出文件、xlsx 和看板 HTML。
- **不要用会导出 cookie / token 的工具**，这个仓库也不需要任何 API key。
- **不要挂人。** 对外分享只用 `dashboard_public.html`，别公开点名说谁是「僵尸粉」。

## 目录

```
audit.py                  一行命令出看板（v0.1 主入口）
config.json               词表、权重、星级线、时间窗口、金牌/银牌定义
sample_data/              20 个虚构账号的假数据和生成脚本
templates/                空的 CSV 模板（列名和脚本一致）
scripts/                  relationship_stars.py（打星）、daily_collect.py（每日采集转换）
adapters/                 twitter-web-exporter / X 官方归档 / 通用 CSV 转换
fan_audit.py, keywords.txt  名单核对（v0 功能）
docs/                     DATA_EXPORT（数据准备）、SPEC（打分规格）、DAILY_COLLECT、方法和调研
examples/                 名单核对和打分公式的虚构示例
tests/                    python3 -m unittest discover -s tests
LICENSE                   MIT
```

## English (brief)

**fan-audit** is an offline, read-only toolkit for scoring your two-way public conversations on X (Twitter). Put `replies.csv` (+ optional `following.csv`, `followers.csv`, `likes.csv`) into `data/` and run `python3 audit.py` to get an HTML dashboard with 1–5 star scores, a "gold / silver / one-way / dormant mutual" segmentation, and a masked version for sharing. Try it with `python3 audit.py --data sample_data`. Standard library only, Python 3.9+. Weights are initial values, not yet validated. MIT License.

---

👋 作者正在 X 上连载这个项目的迭代过程，跑不通或有更好的打分建议，欢迎来 X [@ranger_escape](https://x.com/ranger_escape) 找我聊！
