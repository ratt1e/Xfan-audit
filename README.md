# fan-audit：X 粉丝体检 · 互动关系星级

> 👋 作者正在 X 上连载这个项目的迭代过程，跑不通或有更好的打分建议，欢迎来 X [@ranger_escape](https://x.com/ranger_escape) 找我聊！

**试用版 v0.1 · 权重待验证**

![看板示例（假数据生成，已打码）](docs/img/dashboard.png)

用你自己账号的**公开回复**和**关注关系**，找出谁是真的在跟你来回聊天的「金牌用户」，谁是互关了但这段时间没说话的「沉睡互关」。

**数据只在你的浏览器里处理，不会上传。** 网页不联网，也没有统计代码。

## 两步上手

### 1. 装插件，导出 JSON

安装 [twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter)，在浏览器里导出这三份：

- 用户推文
- 正在关注
- 关注者

谢谢这个开源脚本，它只记录网页本来就会加载的数据。怎么滚页面，看 [docs/DATA_EXPORT.md](docs/DATA_EXPORT.md)。

### 2. 打开网页，拖进去

用浏览器打开本仓库的 `web/index.html`（双击，或把文件拖进浏览器）。再把上面的 JSON 拖进页面。`interactions.csv` 也可以直接拖。

页面上填你的用户名（不带 @）。推文文件没填时，会用主帖最多的那个账号来猜，不对就改掉。文件名看不出是「正在关注」还是「关注者」时，页面会先问你。

顶部可以选开始、结束日期，或点「最近 7 天 / 30 天 / 全部」。一切换就重算，并写出覆盖了几天。没有采集、也没有互动时间落在上面的日期按「无数据」处理，不当成零互动，也不进持续性的分母。

截图前点「打码模式」，账号名会换成账号#01。

GitHub Pages 的配置在 `.github/workflows/pages.yml`，准备从 `/web` 发布，**还没开启**。现在请直接打开本地的 `web/index.html`。

## 进阶用法

下面是 Python 命令行。适合已经用 Grok Bot 每天采集，或要把看板写到固定目录的人。网页和命令行用同一套打分。

### 适用人群

写给已经开通 **X Premium** 的人。推荐和 **Grok Bot** 一起用：Bot 负责每天用只读接口把互动采下来，这个仓库的脚本在你电脑上打分、出看板。没有 Bot 也能跑，只是互动数据要自己导出，结果通常会少一截，见下一节。

### 数据从哪来

两份数据分开准备，最后由 `audit.py` 合在一起算。

1. **关注和粉丝**：用 [twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) 在浏览器里手动导出 `following.csv`、`followers.csv`。谢谢这个开源脚本，它只记录网页本来就会加载的数据。怎么滚页面、怎么转换，看 [docs/DATA_EXPORT.md](docs/DATA_EXPORT.md)。
2. **每天的互动**：Grok Bot 用 X 的只读接口采集原始 JSON，再由 `scripts/daily_collect.py` 生成 `interactions.csv`。接口、额度和目录见 [docs/DAILY_COLLECT.md](docs/DAILY_COLLECT.md)。
3. **计算**：`audit.py --data-root` 合并多天的 `interactions.csv`；`--lists` 只读那两张关系表，用来判断互关和沉睡互关。

没有 Grok Bot 时，可以用同一款插件把互动导出成 CSV 来代替。插件只记下你自己滚过的页面，通常只有一个方向。方向缺一半时，条数、分数和分层都会偏少。

### 合理使用

- **只读。** 不自动点赞，不自动关注或取关，不自动发帖，不私信。看板里的「建议动作」只是文字，工具不会替你做。
- **遵守调用额度。** Grok Bot 内置的公开读取：每分钟 30 次、每天 1000 次、每次最多 25 条，每天 00:00 UTC 重置。平时这一轮合计不超过 27 次（补最近 48 小时不超过 33 次），硬上限 40 次。遇到 429，等到重置后再重试 1 次；401、403 或额度不足就停。页数怎么分配见 [额度预算](docs/DAILY_COLLECT.md#6-额度预算)。
- **不要交出登录凭证。** 不要用会导出 cookie / token 的工具，也不要把 API key 写进仓库、提示词或截图。

下面这段可以直接贴给 Grok Bot，当作每天的采集说明。里面没有 key，也没有具体账号名。用户名和数字 ID 用你自己的配置填，不要贴回对话里保存。

```text
你是每日采集助手。只使用 X 的只读接口。不要点赞，不要关注或取关，不要发帖，不要私信，不要自动滚动页面。

额度：每分钟不超过 30 次，每天不超过 1000 次，每次最多 25 条。平时这一轮 posts 不超过 12 页、mentions 不超过 8 页，加上资料 1 次和少量引用或转帖，合计不超过 27 次。第一次或断档后补 48 小时时不超过 33 次。硬上限 40 次。遇到 429，等到重置后只重试 1 次。401、403 或额度不足就停，不要反复重试。

步骤：
1. GET /2/users/by/username/<我的用户名>，拿到数字 ID。用户名和 ID 只留在本机，不要写进会提交的文件。
2. 读 private/daily/state.json 里的 since_id。没有的话，start_time 用现在减去 48 小时（UTC）。两个方向用同一个时间窗。
3. GET /2/users/<ME_ID>/tweets，不要加 exclude=replies。字段和翻页方式按本仓库 docs/DAILY_COLLECT.md。每页原样存成 posts_p01.json、posts_p02.json …
4. GET /2/users/<ME_ID>/mentions，同样存成 mentions_p01.json …。别人回复我的帖子会 @ 我，所以「他回我」主要在这里。
5. 哪个方向的最早时间更晚，就先翻哪个方向，直到两边最早时间相差小于 1 小时。到了页数上限还有下一页，就停下，第二天从断点补。
6. 原始 JSON 只放在 private/。然后在本机运行：
   python3 scripts/daily_collect.py --raw-dir private/daily/<采集日期> --me-id <ME_ID> --me <我的用户名> --snapshot-dir daily/<采集日期> --window-hours 48
7. 不要把 cookie、token、API key，或任何具体账号名，写进仓库、日志或这段提示词的回执里。
```

### 每天看看板

每次采集完成，在本机用同一条命令再跑 `audit.py`，把含账号名的 `dashboard.html` 写到仓库外的固定目录。用浏览器打开这个文件，收藏成书签。以后每天还是点这个书签，看到的就是最新一份。

```bash
python3 audit.py --data-root ~/x-data/ --lists ~/x-lists/ --me 你的用户名 --out ~/x-data/_看板/ --overwrite
```

含账号名的看板、`accounts.csv` 和 `名单.md` 只留在你的电脑上。不要部署到公网，也不要放到网盘的公开链接里。要给别人看，用打码的 `dashboard_public.html` 自己截一张图。

`--overwrite` 只替换这个目录里本工具生成的四份结果：`dashboard.html`、`dashboard_public.html`、`accounts.csv`、`名单.md`。目录里如果还有别的文件，命令会报错停下，不会删除。不加 `--overwrite` 时，已有结果仍然拒绝覆盖。仓库内和日期输入目录始终不能写。

### Python 命令行

```bash
# 1. 下载
git clone https://github.com/ratt1e/Xfan-audit.git fan-audit && cd fan-audit      # 或者下载 zip 解压

# 2. 先用假数据跑一遍（1 秒）
python3 audit.py --data sample_data
#    打开 output/dashboard.html 看效果

# 3. 换成你自己的数据：把 CSV 放进 data/，再跑
python3 audit.py
```

命令行需要的 CSV 怎么导出，看 **[docs/DATA_EXPORT.md](docs/DATA_EXPORT.md)**（保姆级，写了浏览器插件和 X 官方归档两种办法）。最少只要一个 `replies.csv`，最好再加 `following.csv`、`followers.csv`。

输出在 `output/`：

| 文件 | 内容 |
|---|---|
| `dashboard.html` | 看板：星级分布、分层、金牌和银牌名单、建议动作。**含真实账号名，只给自己看** |
| `dashboard_public.html` | 同一个看板的打码版，账号名换成「账号#01」，不列单向和沉睡名单，可以截图分享 |
| `accounts.csv` | 每个账号一行：分层、星级、分数、各项明细 |

多天合并、`--data-root`、`--overwrite` 这些参数见 [docs/TOOLS.md](docs/TOOLS.md)。

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

以上所有数字都是**初始值、待验证**，都在 [`config.json`](config.json) 里，改完重跑就行。完整公式见 [docs/SPEC_relationship_stars.md](docs/SPEC_relationship_stars.md)。粉丝数为什么不等于收益门槛，见 [docs/TOOLS.md](docs/TOOLS.md)。

> 分数只是线索，不代表真实关系，也不代表对方好不好。零公开互动 ≠ 没看过你的帖子。看板里的「建议动作」只是建议，工具不会执行任何操作。

## Roadmap

- [x] 网页拖拽版：打开 `web/index.html`，拖入 JSON 或 CSV，在浏览器里算星级和分层
- [x] v0.1 CSV → 星级 → 金牌/银牌/单向/沉睡互关分层 → HTML 看板（含打码版）
- [x] v0.1 配置文件 `config.json`（词表、权重、星级线、门槛）
- [x] v0.2 对话往返轮数（严格回复链：`in_reply_to_status_id` 指向对方那条才算）——已实现；没有父帖 ID 的回复会提示「无法确认往返」
- [ ] v0.2 和上一个区间比的趋势（↑↓），7 天 / 30 天切换写进看板
- [ ] v0.3 用大模型识别走心评论 vs 水评，替代现在的关键词词表
- [ ] v0.4 一键生成打码版月度铁粉报告
- [ ] 权重校准：用户标约 10 个「朋友」后按 SPEC 第 11 节调参
- [ ] 补导出截图

名单核对、采集转换和只打星的命令也在 [docs/TOOLS.md](docs/TOOLS.md)。

## 隐私和安全

- **只读。** 不要写脚本自动关注、取关或批量操作，这违反 X 的自动化规则，可能被限流或封号。清理关注也请手动、分批、慢慢来。
- **不要提交真实数据。** `.gitignore` 已经排除 `data/`、`output/`、`private/`、导出文件、xlsx 和看板 HTML。
- **不要用会导出 cookie / token 的工具**，这个仓库也不需要任何 API key。
- **不要挂人。** 对外分享只用 `dashboard_public.html`，别公开点名说谁是「僵尸粉」。

## 目录

```
web/index.html            拖入 JSON 或 CSV 的网页（不联网）
.github/workflows/pages.yml  从 /web 发布的配置，还没开启
audit.py                  一行命令出看板（进阶用法）
config.json               词表、权重、星级线、时间窗口、金牌/银牌定义
sample_data/              20 个虚构账号的假数据和生成脚本
templates/                空的 CSV 模板（列名和脚本一致）
scripts/                  relationship_stars.py（打星）、daily_collect.py（每日采集转换）
adapters/                 twitter-web-exporter / X 官方归档 / 通用 CSV 转换
fan_audit.py, keywords.txt  名单核对（v0 功能）
docs/                     DATA_EXPORT（数据准备）、TOOLS（多天参数和有效曝光）、SPEC、DAILY_COLLECT
examples/                 名单核对和打分公式的虚构示例
tests/                    python3 -m unittest discover -s tests
LICENSE                   MIT
```

## English (brief)

**fan-audit** scores two-way public conversations on X (Twitter). Open `web/index.html` and drop in a twitter-web-exporter JSON export (your tweets, following, followers) or `interactions.csv`. The page calculates stars and tiers in the browser and does not upload anything. A mask button replaces account names before you take a screenshot. The Python command line remains for daily collection: a read-only collector such as Grok Bot can write `interactions.csv`, and `python3 audit.py --data sample_data` runs the same scoring offline. Standard library only, Python 3.9+. Weights are initial values, not yet validated. No automatic likes, follows, or posts. The named dashboard stays on your machine. MIT License.

---

👋 作者正在 X 上连载这个项目的迭代过程，跑不通或有更好的打分建议，欢迎来 X [@ranger_escape](https://x.com/ranger_escape) 找我聊！
