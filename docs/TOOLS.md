# 工具与进阶用法指南

为保持主 README 简洁，关于多天参数、仓库内置其他工具以及 X 平台有效曝光规则的详细说明均归纳于此。

## 多天参数

单目录模式：将 CSV 文件放入 `data/` 目录，执行 `python3 audit.py`。该模式与 `--data-root` 及网页拖拽版遵循完全一致的规则：凡是没有互动时间戳、亦无点赞首次观察记录的日期均视为「无数据」，不计入持续性得分的分母，最终分析结果中会明确注明计分覆盖的有效天数。以 `sample_data` 查询最近 30 天（2026-09-20 ~ 2026-10-19）为例，实际计分覆盖 28 天，判定为无数据 2 天；分层结果依然保持：金牌 3、银牌 2、他常来 2、我常去 1、沉睡 3、样本不足 3、其他有分 4、零互动 2。当选定区间内每日均有数据记录时，分母与自然日历天数完全一致。若已经搭建了每日采集归档，可使用下述进阶参数。

常用参数：`--data 目录`、`--out 目录`、`--overwrite`（只覆盖本工具自己的旧结果）、`--days 30`、`--all-days`（全部互动日期）、`--end 2026-10-19`、`--me 你的用户名`（排除自己回自己）、`--config config.json`、`--prev-lists 旧名单目录`（增加「关注变化」章节，不指定则看板与此前保持一致）、`--keep-list 保留名单.txt`（在未回关名单中排除主动关注的人）。

`dashboard.html` 与 `dashboard_public.html` 顶部支持自定义开始、结束日期，或快捷点击「最近 7 天 / 30 天 / 全部」。初次打开时展示本次计算的完整区间，各项数值与终端输出完全一致。切换日期后将调用与 `web/index.html` 相同的本地脚本实时重算，无数据日期不计入持续性得分分母。两份看板均为独立的单文件 HTML，不向外部网络发起任何请求。私有版嵌入真实用户名；脱敏打码版仅嵌入代号，不包含真实用户名、用户 ID、推文正文及主页链接。未回关名单的成员不随日期变更，但其互动次数、综合评分与分层结果会按新区间动态重算。「关注变化」始终呈现两份名单的差异对比，成员名单固定。

```bash
python3 audit.py --data-root ~/x-data/ --lists ~/x-lists/ --me 你的用户名 --out ~/x-data/_看板/ --overwrite
```

`--data-root` 用于合并多天的 `interactions.csv` 文件。`--lists` 仅读取 `following.csv` 和 `followers.csv`，不会读取该目录中的回复数据。环境变量 `FAN_AUDIT_DATA_ROOT` 等效于 `--data-root`；若显式指定了 `--data` 则切换回单目录模式，不再受该环境变量影响。

每日分析结果必须输出至仓库外部目录，并会额外生成一份仅供个人查阅的 `名单.md`。若未添加 `--overwrite` 参数，遇到已存在的同名输出将直接拒绝覆盖。`--overwrite` 参数仅会替换本工具生成的 `dashboard.html`、`dashboard_public.html`、`accounts.csv`、`名单.md`、`没回关.md` 和 `没回关.csv`；若目录下存在其他文件，程序将立即报错终止，不会删除任何文件。此外，仓库内部以及日期输入目录始终禁止写入。

采集目录、额度和覆盖天数的说明见 [DAILY_COLLECT.md](DAILY_COLLECT.md#多天一起分析)。

## 关注变化

只读对比两份关注与粉丝名单，绝不执行任何关注或取关操作。若数据中包含用户 ID（`user_id`、`id_str`、`rest_id` 或 `id`），将优先按 ID 对齐，即使对方中途更改用户名亦能准确识别为同一人。若缺少 ID 则退回按用户名对齐。两份名单均有 ID 且不一致时，即便用户名偶然相同，也会判定为两个不同账号。

```bash
python3 scripts/follow_diff.py --old ~/x-lists-old/ --new ~/x-lists/ --out ~/x-data/_关注变化/
```

`--old` 与 `--new` 目录下放置 `following.csv`、`followers.csv`，或 twitter-web-exporter 导出的原始 JSON 文件（文件名包含「正在关注 / Following」「关注者 / Followers」即可自动识别）。也可以使用 `--old-following`、`--old-followers`、`--new-following`、`--new-followers` 分别指定文件路径。具体账号名仅写入 `--out` 目录下的 `关注变化.md`，终端控制台仅打印四组统计人数：取关我的、新粉丝、我取关的、我新关注的。

`audit.py` 在指定 `--prev-lists 旧名单目录` 参数后，看板末尾会自动增加「关注变化」板块，展示上述四组数据。新名单直接采用本次的 `--lists` 目录，或单目录模式下的 `following.csv` 与 `followers.csv`。若未指定该参数，看板中不会出现该板块。脱敏版 `dashboard_public.html` 会将这些账号统一转换为「账号#01」格式，与主名单共享同一套编号体系。该板块仅展示于看板中，不单独生成文件。

网页版只需将旧名单一并拖入浏览器，在对应文件的「识别为」下拉框中选择「旧·关注者」或「旧·正在关注」即可。若文件名中包含「旧」或 `old` / `prev`，页面会自动预选。打码模式同样对该板块生效，所有计算均在本地浏览器内完成。

## 没回关

根据当前的正在关注和关注者名单，筛选出「我已关注但对方未回关」的账号，无需旧名单对比。存在用户 ID 时按 ID 对齐，缺少 ID 时按用户名对齐。零互动的账号排在最前，其余账号按评分由低到高排列。列表每行包含用户名、主页链接、互动次数、综合评分及当前分层。

```bash
python3 audit.py --data sample_data --keep-list ~/keep.txt
```

`--keep-list` 为可选参数。该文本文件每行记录一个用户名或用户 ID，以 `#` 开头的行为注释，用于排除你主动关注、无需回关的账号。私有的 `没回关.md` 与 `没回关.csv` 输出于 `--out` 目录中，附带真实用户名与主页链接。脱敏版看板则统一采用「账号#01」编号体系，与上方名单保持一致，且不附带主页链接。`--overwrite` 参数会连同这两份文件一并更新替换。

工具不会自动取关或屏蔽。要取关请手动、慢慢来。

网页版只要载入当前的关注者与正在关注文件即可显示该板块；打码模式同样支持，所有运算均在浏览器本地执行。若有需要保留持续关注的账号名单，直接拖入并选择「保留名单」即可。

## 仓库里的其他工具

- `fan_audit.py`：名单核对（v0 功能）。结合关注表、粉丝表和互动汇总，分析互关比例、零互动率以及个人简介包含「互关」等关键词的账号。用法：

```bash
python3 fan_audit.py --following examples/following.csv --followers examples/followers.csv \
  --engagement examples/engagement.csv --requests examples/requests.csv --keywords keywords.txt \
  --posts 10 --out output/name_check
```

  若已安装 openpyxl（`pip install -r requirements.txt`），会额外输出 `report.xlsx` 报表；未安装亦不影响基础功能运行。
- `scripts/daily_collect.py`：将 X 官方只读接口返回的原始 JSON 整理为 `interactions.csv`，详见 [DAILY_COLLECT.md](DAILY_COLLECT.md)。
- `scripts/relationship_stars.py`：仅执行关系打星计算的命令行工具。
- `scripts/follow_diff.py`：对比两份关注与粉丝名单，统计取关与新关注动态，详见上文「关注变化」章节。
- 没回关名单由 `audit.py` 原生生成，详见上文「没回关」章节。工具不会自动执行取关或屏蔽。
- `adapters/`：针对 twitter-web-exporter、X 官方归档及通用 CSV 的格式转换适配脚本。

## 有效曝光规则

X 现行的创作者收益计划为 Original Content Rewards（自 2026 年 9 月 8 日起正式替代原有的 Creator Revenue Sharing）。根据官方帮助文档，申请创作者收益需同时满足以下条件：

- 拥有有效的 Premium、Premium+ 或 Premium Business 订阅
- 拥有至少 **500 位认证粉丝**
- 最近 90 天内，来自**认证用户**的**首页时间线**曝光至少达到 **500,000** 次，**推文回复的曝光不计入**
- 年满 18 周岁，且所在国家或地区位于支持列表中

实际收益按「合格曝光」进行结算：即来自 Premium 用户、出现在首页时间线中、推文在屏幕上至少 50% 可见的去重曝光，排除了付费推广和欺诈流量。

因此，粉丝总数仅是申请门槛之一；互关后不再回访主页或浏览推文的粉丝，对有效曝光门槛的贡献微乎其微。本工具所度量的是「双向公开互动」，可作为评估粉丝粘性的一项替代参考指标，但并不等同于官方口径下的有效曝光。平台激励规则可能随时间调整，具体请以官方当前政策为准。

参考：
1. X Help Center, Original Content Rewards: https://help.x.com/en/using-x/original-content-rewards （Wayback 2026-10-05 快照：https://web.archive.org/web/20261005131543/https://help.x.com/en/using-x/original-content-rewards ）
2. X Help Center, Creator Revenue Sharing: https://help.x.com/en/using-x/creator-revenue-sharing
3. X Original Content Rewards Program Terms: https://legal.x.com/en/original-content-rewards-terms.html
