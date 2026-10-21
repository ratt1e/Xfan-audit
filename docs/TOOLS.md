# 工具和进阶用法

README 只留三步。多天参数、仓库里的其他命令，以及有效曝光规则，放在这里。

## 多天参数

单目录还是三步里的用法：CSV 放进 `data/`，运行 `python3 audit.py`。已经有每天一份采集时，用下面这些参数。

常用参数：`--data 目录`、`--out 目录`、`--overwrite`（只覆盖本工具自己的旧结果）、`--days 30`、`--all-days`（全部互动日期）、`--end 2026-10-19`、`--me 你的用户名`（排除自己回自己）、`--config config.json`。

```bash
python3 audit.py --data-root ~/x-data/ --lists ~/x-lists/ --me 你的用户名 --out ~/x-data/_看板/ --overwrite
```

`--data-root` 合并多天的 `interactions.csv`。`--lists` 只读 `following.csv` 和 `followers.csv`，不读该目录里的回复。环境变量 `FAN_AUDIT_DATA_ROOT` 等效于 `--data-root`；显式写了 `--data` 就回到单目录，不受这个变量影响。

每日结果必须写在仓库外，并多一份私有的 `名单.md`。不加 `--overwrite` 时，已有同名结果会拒绝覆盖。`--overwrite` 只替换本工具生成的 `dashboard.html`、`dashboard_public.html`、`accounts.csv`、`名单.md`。目录里还有别的文件就停下，不删除。仓库内和日期输入目录始终不能写。

采集目录、额度和覆盖天数的说明见 [DAILY_COLLECT.md](DAILY_COLLECT.md#多天一起分析)。

## 仓库里的其他工具

- `fan_audit.py`：名单核对（v0 功能）。用关注表、粉丝表和互动汇总，看互关比例、零互动率、简介含「互关」关键词的账号。用法：

```bash
python3 fan_audit.py --following examples/following.csv --followers examples/followers.csv \
  --engagement examples/engagement.csv --requests examples/requests.csv --keywords keywords.txt \
  --posts 10 --out output/name_check
```

  装了 openpyxl（`pip install -r requirements.txt`）会多输出 `report.xlsx`，不装也能跑。
- `scripts/daily_collect.py`：把 X 官方只读接口的原始 JSON 转成 `interactions.csv`，见 [DAILY_COLLECT.md](DAILY_COLLECT.md)。
- `scripts/relationship_stars.py`：只打星的命令行版本。
- `adapters/`：twitter-web-exporter、X 官方归档、通用 CSV 的转换脚本。

## 有效曝光规则

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

详细的指标定义和公式见 [methodology.md](methodology.md)。
