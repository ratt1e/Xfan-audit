# 每日采集（DAILY_COLLECT）

> 目的：每日通过 X 官方只读接口采集「我回复他人」与「他人回复我/提及我」的公开互动，双向采用严格对齐的时间窗口，
> 整理生成 `interactions.csv`（格式遵循 SPEC_relationship_stars.md 第 5 节），用于后续的星级评定。
> 全程保持只读：不点赞、不回复、不关注、不取关、不发帖、不发私信。本文所有示例均为虚构账号（me_demo、user_001）。

流程分为两部分：

- **(a) 调用接口并保存原始 JSON**：由定时任务或 AI 代理按以下流程调用接口，将每次接口响应**原样**保存为独立的 JSON 文件。
- **(b) 本地离线转换**：由 `scripts/daily_collect.py` 读取这些原始 JSON，生成 `interactions.csv`、校验警告日志以及脱敏快照。转换脚本本身不联网。

## 目录约定

```
<工作目录>/
├── private/daily/state.json            跨天状态：每类最新 id（下一晚的 since_id）、点赞 first_observed_at
├── private/daily/YYYY-MM-DD/           原始 JSON + interactions.csv + validation.txt（含账号名，只放 private）
└── daily/YYYY-MM-DD/snapshot.json      计数、覆盖率、时间窗、警告（不含账号名）
```

日期 `YYYY-MM-DD` 用采集时区的本地日期；文件里的时间一律保留 UTC。时区优先级：`scripts/daily_collect.py --tz`、`config.json` 的 `window.timezone`、运行脚本这台电脑的本地时区。配置里的时区留空，不再默认洛杉矶。`--tz` 会写进 `snapshot.json` 的 `timezone`。不写 `--date` 时，日期标签仍是 `--raw-dir` 的目录名，请按该时区的本地日期给文件夹命名。关注变化对比不按天切，`scripts/follow_diff.py` 没有 `--tz`。
`private/`、`data/`、`output/` 已在 `.gitignore` 里，原始数据永远不进仓库。

## (a) 采集步骤

### 0. 准备

- 我的数字 ID：`<ME_ID>`（`GET /2/users/by/username/<me>` 一次拿到后固定写进配置）。
- 读 `private/daily/state.json` 的 `newest_id.posts` 和 `newest_id.mentions`，作为今晚的 `since_id`。
  第一次运行没有 state，就改用 `start_time = 现在 - 48 小时`（UTC，ISO 8601）。
- 窗口：两个方向**用同一个** `start_time`（或各自的 since_id），**同一时刻**采完，终点自然对齐。

### 1. 资料快照（1 次）

`GET /2/users/by/username/<me>`，`user.fields=created_at,description,public_metrics,verified,location`
→ 存为 `profile.json`。

### 2. 我的帖子和回复（我对他）

`GET /2/users/<ME_ID>/tweets`（MCP 里叫 `get_users_posts`），**不要** `exclude=replies`：

```
max_results=25
since_id=<state.newest_id.posts>          # 或第一次用 start_time
post.fields=created_at,public_metrics,author_id,conversation_id,in_reply_to_user_id,referenced_tweets
expansions=referenced_tweets.id,referenced_tweets.id.author_id,in_reply_to_user_id
user.fields=username
```

翻页：把 `meta.next_token` 当 `pagination_token` 传回去，参数其余保持不变；没有 `next_token` 就停。
每页存为 `posts_p01.json`、`posts_p02.json` …

### 3. 提及我（他对我）

`GET /2/users/<ME_ID>/mentions`（MCP 里叫 `get_users_mentions`），字段同上：

```
max_results=25
since_id=<state.newest_id.mentions>
post.fields=created_at,public_metrics,author_id,conversation_id,in_reply_to_user_id,referenced_tweets
expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id
user.fields=username
```

每页存为 `mentions_p01.json` …。别人回复我的帖子会自动 @ 我，所以「他回我」基本都在这里。

### 4.（可选）引用、点赞、转帖

只对前一天**互动最多的 3–5 条我的原创帖**做：

| 接口 | 文件名 | 说明 |
|---|---|---|
| `GET /2/tweets/:id/quote_tweets`（`get_posts_quoted_posts`） | `quotes_<帖子ID>_p01.json` | 字段同第 2 步；`public_metrics.quote_count = 0` 的帖子跳过 |
| `GET /2/tweets/:id/liking_users` | `likers_<帖子ID>.json` | 只能用用户自己授权的连接，可能计费，**默认不做**；内置公开读取拿不到 |
| `GET /2/tweets/:id/retweeted_by`（`get_posts_reposted_by`） | `reposters_<帖子ID>.json` | 只计数，不进 interactions；`retweet_count = 0` 的跳过 |

点赞没有时间字段。脚本会把同一个赞的 `first_observed_at` 跨天保留最早一次，`post_created_at` 取被赞帖子的发布时间（SPEC 5.4）。

### 5. 停止条件

- 某个方向翻到 `next_token` 消失，或者这一页最早一条已经早于 `start_time` → 这个方向结束。
- 返回 429 / Rate limit：等到重置时间后**只重试 1 次**；还失败就停，记下停在哪一页。
- 401/403、额度不足：立即停，不重试。
- 空页但还有 `next_token`：不是结尾，继续翻（脚本会报警提醒）。

### 6. 额度预算

Grok Bot 内置的公开读取：每分钟 30 次、每天 1000 次、每次最多 25 条，每天 00:00 UTC 重置。
`get_users_posts` 和 `get_users_mentions` 的翻页上限是：

| 情况 | posts 页数 | mentions 页数 | 其他 | 合计 |
|---|---|---|---|---|
| 平时每日（since_id 接上一晚） | ≤ 12 | ≤ 8 | 资料 1 + 引用/转帖 ≤ 6 | **≤ 27** |
| 补 48 小时（第一次或断档后） | ≤ 20 | ≤ 12 | 资料 1 | **≤ 33** |
| 硬上限 | | | | **40** |

参考：活跃的一天，「我回别人」约 25 条/页 ≈ 20–60 分钟；48 小时实测 posts 19 页、mentions 11 页。
如果到了上限还有 `next_token`，就停下，在 `validation.txt` 里会看到「对齐窗口只有 N 小时」，第二天从断点补。
**两个方向翻页数要「按时间」对齐**：哪个方向的最早时间更晚，就先翻哪个方向，直到两边最早时间相差 < 1 小时。

## (b) 离线转换

```bash
python3 scripts/daily_collect.py \
  --raw-dir private/daily/2026-10-19 \
  --me-id <ME_ID> --me <我的用户名> \
  --snapshot-dir daily/2026-10-19 \
  --window-hours 48
```

规则（对应 SPEC 5.2 / 5.3）：

- **去重**：按 tweet_id。内容相同就合并（缺的字段互相补），内容不同保留第一条并报警。同一份数据跑两次结果不变。
- **方向**：
  - 作者是我、回复别人 → `out/reply`；作者是我、引用别人 → `out/quote`；我回自己（串推）→ 丢弃；我的原创帖不进表，只计数。
  - 别人回我（`in_reply_to_user_id == 我`）→ `in/reply`；别人引用我 → `in/quote`；别人只 @ 我、不是回复 → `in/mention`。
  - 别人之间的楼中楼、转推、排除名单（默认 `grok`）→ 丢弃。
- **父帖 ID**：`in_reply_to_status_id` = `referenced_tweets` 里 `type=replied_to` 的 `id`。v2 接口没有叫 `in_reply_to_status_id` 的字段。
- **对话 ID**：有就用。缺的时候用同一条回复链的另一侧补：先看父帖，再看子帖，原创帖用自己的 id，反复传播；补不上写 `待核实`。
  （实测：`get_users_posts` 有时整页都不返回 `conversation_id`，`get_users_mentions` 一直有。）
- **parent_kind**：父帖在表里 → 空；父帖就是对话起点（或是一条原创帖）→ `root`；父帖采到了但不是我和对方之间的互动 → `other`；没采到 → `unknown`。
- **问候**：按 `greetings.txt`，规则见 SPEC 第 7 节；以 `^` 开头的词只在开头匹配。

### 校验警告（`validation.txt` 和 `snapshot.json` 里都有）

| 警告 | 含义 |
|---|---|
| `<类型> 原始数据缺 <字段>：N%` | 字段缺失率（created_at、author_id、conversation_id、回复里的 replied_to） |
| `重复 tweet_id N 条` / `重复且内容不同` | 翻页重叠或同一页存了两次 |
| `空页：…` / `空页但还有 next_token` | 正常结束 / 还没翻到底 |
| `两个方向起点（终点）相差 N 小时` | 时间窗没对齐，对比时只用 `aligned` 窗口 |
| `对齐窗口只有 N 小时，目标 M 小时` | 翻页上限到了，没覆盖满 |
| `N 条回复缺少 in_reply_to_status_id` | 这些回复无法确认往返 |
| `N 条互动的 conversation_id 补不上` | 标了 `待核实` |
| `N 条回复的父帖没采集到` | parent_kind=unknown |
| `N 条别人回我的推文只在父帖展开里出现` | mentions 可能漏收 |
| `N 个点赞时间信息不全` | 严格模式下这些赞不计分 |

### 快照（`daily/YYYY-MM-DD/snapshot.json`，不含账号名）

资料公开计数、各类页数、互动条数（按方向和类型）、问候条数、两个方向的账号数、丢弃原因计数、字段缺失率、
父帖和对话 ID 覆盖率、能连上的往返链数（`links_reply_to_other_side`：回复的父帖在表里且是对方方向；
`substantive_rounds`：其中两边都不是问候的）、两个方向的时间窗和对齐窗口、全部警告。

## 多天一起分析

当采集文件已整理为如下目录结构时，可直接针对整个数据根目录进行合并分析：

```text
~/x-data/
  YYYY-MM-DD/private/interactions.csv
  YYYY-MM-DD/daily/snapshot.json
```

程序仅读取各日期目录下的主 `private/interactions.csv`。若某日期目录下缺少 `private/`，才会回退读取该日期根目录下的 `interactions.csv`。不会递归读取补采子目录，亦不读取快照或原始 JSON；快照文件无论存放于日期根目录还是 `daily/` 均不影响分析。`notes/`、`bad-name/`、`_分析结果/` 以及不合规的日期目录都会自动跳过。

```bash
# 默认按 config 的窗口（30 天）分析
python3 audit.py --data-root ~/x-data/ --lists ~/x-lists/ --me me_demo

# 指定窗口和一个新的输出目录
python3 audit.py --data-root ~/x-data/ --days 30 --out ~/x-reports/month/

# 用全部互动；与上一次输出分开，避免覆盖
python3 audit.py --data-root ~/x-data/ --all-days --out ~/x-reports/all/

# 也可以用环境变量；显式 --data 改回单目录输入，无数据日同样不进分母
FAN_AUDIT_DATA_ROOT=~/x-data/ python3 audit.py --lists ~/x-lists/
```

- `--data-root` 与 `--data` 互斥。每日采集模式下使用 `--lists` 指定可选关系表所在目录，**且仅读取 `following.csv` 和 `followers.csv`**，不会读取该目录下的 `replies.csv`、`interactions.csv`、`profiles.csv` 或 `likes.csv`。每日数据表内的点赞记录仍沿用原有规则计分。
- 关系表用于判定互关状态与沉睡互关。若关系表的导出日期与每日采集数据的时间未能完全对齐，程序将统一提示“待核实”；文件的修改日期无法证明实际导出日期。若缺少其中一张表，将明确提示当前无法计算互关，不会凭空编造名单。
- 数据合并时优先按 `id` 去重，若 `id` 为空则回退使用 `tweet_id`；点赞数据若缺少上述标识，则依据 `account + post_id` 判定。跨日期重复时一律采信**较晚日期的整行记录**，同日内重复则保留最后一行，切勿拼接不同版本的数据字段。缺少可靠唯一标识的记录将单独保留，并提示待核实。
- 默认分析窗口与此前保持一致，但持续性得分的分母中已剔除无数据日。无论是 `--data` 还是 `--data-root` 模式，凡是既无采集文件、又无互动时间或点赞观察记录的日期，均不计入分母。`--all-days` 按 `--tz`、否则 `config.json` 的 `timezone`、再否则系统本地时区，把 UTC 时间换成该时区的日期，再统计从最早互动（含点赞对应推文的发布时间与首次观察时间）到最晚互动的跨度；若无互动时间戳则以采集日期为准。`--all-days` 与 `--days`、`--end` 互斥。网页版和这里用同一个时区时，逐项结果一致。
- 默认输出在 `数据根目录/_分析结果/截止日期/`，包含 `accounts.csv`、两份看板 HTML、`名单.md`、`没回关.md` 和 `没回关.csv`。名单中包含具体账号与建议动作，仅供本地查看；终端控制台仅打印时间覆盖概况与各层级人数统计。建议动作仅作为参考文本，工具不会代为执行任何操作。
- 输出路径会自动解析符号链接；为防止误操作，程序严禁向仓库内部、日期输入目录以及已存在的同名输出路径写入数据。多次运行或切换分析窗口时，请指定不同的 `--out` 目录。若希望每日通过同一个浏览器书签查看含账号名的完整看板，可将 `--out` 路径固定在仓库外的特定目录，并搭配 `--overwrite` 参数。该参数只会替换本工具生成的 `dashboard.html`、`dashboard_public.html`、`accounts.csv`、`名单.md`、`没回关.md`、`没回关.csv`；若检测到目录下存在其他文件，程序会立即报错终止，不会删除任何文件。切勿将包含真实账号的看板部署至公网。相关说明请参考 [进阶用法「每天看看板」](ADVANCED.md#每天看看板)。打开看板：macOS `open`，Windows 命令提示符 `start "" "路径"`，PowerShell `Start-Process`，Linux `xdg-open`；或给 `audit.py` 加 `--open`。原有的 `--data sample_data` 用法仍允许写入仓库内的默认 `output/` 目录。
- 终端会清晰展示读取到的采集日期、区间内缺失文件的日期、有数据天数、无数据天数、实际计分天数、每日数据合并前后的行数变化，以及去重后回复缺少父帖 ID 的比例。**缺少单日采集文件并不等同于没有互动**：某单日的文件亦可能涵盖前期的历史补采记录。既无采集文件也无互动记录的日期均归入「无数据」，不按零互动统计，亦不计入持续性得分的分母。实际计分严格按有数据的有效天数计算。
- 若 `conversation_id` 或 `parent_kind` 缺失或尚未确认，程序将如实提示“待核实”，严禁凭空臆造。合并处理时会将 `conversation_id` 中标注的“待核实”等占位符视为空值，避免将其误当作所有记录共享的同一个对话会话；对话往返轮数依然严格依据 `in_reply_to_status_id` 所指向的对方实质回复进行校验。评分公式与星级门槛均保持不变。

## 测试

```bash
python3 -m unittest discover -s tests
```

测试数据全部虚构（me_demo、user_001、user_002）。
