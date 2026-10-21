# 每日采集（DAILY_COLLECT）

> 目的：每天用 X 官方只读接口采一次「我回别人」和「别人回我/提及我」，两个方向用同一个时间窗，
> 转成 `interactions.csv`（SPEC_relationship_stars.md 第 5 节的格式），供之后打星。
> 全程只读：不点赞、不回复、不关注/取关、不发帖、不私信。本文示例全部是虚构账号（me_demo、user_001）。

流程分两段：

- **(a) 调接口、存原始 JSON**：由定时任务或 AI 代理按下面的步骤调接口，把每个响应**原样**存成一个 JSON 文件。
- **(b) 离线转换**：`scripts/daily_collect.py` 读这些 JSON，生成 `interactions.csv`、校验警告和不含账号名的快照。脚本本身不联网。

## 目录约定

```
<工作目录>/
├── private/daily/state.json            跨天状态：每类最新 id（下一晚的 since_id）、点赞 first_observed_at
├── private/daily/YYYY-MM-DD/           原始 JSON + interactions.csv + validation.txt（含账号名，只放 private）
└── daily/YYYY-MM-DD/snapshot.json      计数、覆盖率、时间窗、警告（不含账号名）
```

日期 `YYYY-MM-DD` 用**用户本地时区**的采集日期；文件里的时间一律保留 UTC。
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

如果文件已经整理为下面的结构，可以直接分析整个根目录：

```text
~/x-data/
  YYYY-MM-DD/private/interactions.csv
  YYYY-MM-DD/daily/snapshot.json
```

这里只读取日期目录下的主 `private/interactions.csv`。日期目录没有 `private/` 时，才回退读取该日期根下的 `interactions.csv`。不会递归读取补采子目录，也不读取快照或原始 JSON；快照位于日期根目录还是 `daily/` 不影响分析。`notes/`、`bad-name/`、`_分析结果/` 和无效日期目录都会跳过。

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

- `--data-root` 不与 `--data` 同用。每日模式用 `--lists` 指定可选关系表，**只读 `following.csv` 和 `followers.csv`**，不会读取该目录中的 `replies.csv`、`interactions.csv`、`profiles.csv` 或 `likes.csv`。每日表内的点赞仍按原有规则计分。
- 关系表用于互关和沉睡互关判断。关系表的导出日期与每日数据是否一致，统一提示“待核实”；文件修改日期不能证明导出日期。少一张表时明确提示暂时算不出互关，不编名单。
- 合并先按 `id` 去重，空 `id` 退回 `tweet_id`；点赞没有这两项时用 `account + post_id`。不同日期重复时取**较晚日期的整行**，同一天重复取最后一行；不把多个版本的字段拼起来。没有可靠标识的行单独保留并提示待核实。
- 默认窗口与以前相同，但持续性分母不再把无数据日算进去。`--data` 和 `--data-root` 一样：没有采集文件、也没有互动时间或点赞观察时间的日期不进分母。`--all-days` 按配置时区，从全部互动时间（包括点赞的帖子时间和首次观察时间）的最早日期到最晚日期；没有互动时间时用采集日期。它不与 `--days`、`--end` 同用。
- 默认输出在 `数据根目录/_分析结果/截止日期/`，包含 `accounts.csv`、两个看板和 `名单.md`。名单含账号和建议，只供本机查看；终端只打印覆盖情况与分层人数。建议只是文字，工具不会执行任何操作。
- 输出路径会解析符号链接；仓库内、日期输入目录和已有同名输出都拒绝写入。多次运行或切换窗口请换一个 `--out`。想每天用同一个书签看含账号名的看板时，把 `--out` 固定在仓库外，并加上 `--overwrite`。它只替换本工具生成的 `dashboard.html`、`dashboard_public.html`、`accounts.csv`、`名单.md`；目录里还有别的文件就停下，不删除。不要把这份看板部署到公网。说明见 README「每天看看板」。旧的 `--data sample_data` 用法仍可写到仓库内的默认 `output/`。
- 终端会显示读到的采集日期、分析区间内缺文件的日期、有数据的日期、无数据的日期、计分天数、每日行数合并前后变化，以及全部去重回复缺父帖 ID 的比例。**缺采集文件不等于没有互动**：一天的文件也可能包含历史补采。既没有采集文件、也没有互动时间的日期是无数据，不算零互动，也不进入持续性的分母。计分只按有数据的日期。
- `conversation_id`、`parent_kind` 缺失或未确认时提示“待核实”，不从其他信息编造。合并时将 `conversation_id` 的“待核实”等占位视为空值，不把它当成所有记录共享的对话；往返仍只由 `in_reply_to_status_id` 指向的实际反向实质回复确认。打分公式和星级门槛不变。

## 测试

```bash
python3 -m unittest discover -s tests
```

测试数据全部虚构（me_demo、user_001、user_002）。
