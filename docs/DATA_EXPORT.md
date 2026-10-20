# 数据准备指南（保姆级）

fan-audit 只读你**自己电脑上**的 CSV。数据怎么来，你自己选；只要列名和下面的模板对上，用什么工具导出都能跑。

> 先说三条底线：
> 1. **只读**：导出过程中不点赞、不关注、不取关、不发帖，也不要用任何「批量自动关注/取关」工具。
> 2. **不要用会导出 cookie / token 的工具**（比如要你把登录 cookie 粘过去的命令行爬虫），封号风险高，泄露了等于把账号交给别人。
> 3. **慢慢来**：别一次刷几万条。下面每种方式都写了建议的频率。

需要的文件（放进 `data/` 目录；空模板在 `templates/`）：

| 文件 | 必需？ | 作用 |
|---|---|---|
| `replies.csv` | **必需** | 你和别人之间的回复（两个方向），打星主要靠它 |
| `following.csv` | 建议 | 你关注的人，用来判断互关、找沉睡互关 |
| `followers.csv` | 建议 | 关注你的人（只有认证粉丝也行，会少算互关） |
| `likes.csv` | 可选 | 谁赞了你哪条帖子，最多加 5 分 |
| `profiles.csv` | 可选 | 对方粉丝数、是否认证，只影响排序和「蓝V」标签 |

---

## 方式一：twitter-web-exporter（推荐）

[twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) 是一个开源的油猴脚本（MIT）。它只**记录网页本来就会加载的数据**，不会额外发请求，所以风险较低。缺点是要你自己滚动页面。

### 1. 安装

1. 在浏览器里装 Tampermonkey（油猴）扩展。
   `![截图1：Tampermonkey 扩展商店页面](img/export_01_tampermonkey.png)`
2. 打开 twitter-web-exporter 的 GitHub 页面，按 README 里的安装链接安装用户脚本（具体链接以它的 README 为准）。
   `![截图2：用户脚本安装确认页](img/export_02_install.png)`
3. 刷新 x.com，页面边上会出现脚本的小面板（位置和图标**待核实**，不同版本可能不一样）。
   `![截图3：x.com 页面上的脚本面板入口](img/export_03_panel.png)`

### 2. 导出关注 / 粉丝 → following.csv、followers.csv

1. 打开 `x.com/<你的用户名>/following`，慢慢往下滚，直到滚不动。
2. 打开脚本面板，找到用户列表对应的模块（模块名**待核实**），导出 JSON 或 CSV。
   `![截图4：面板里的关注列表模块和导出按钮](img/export_04_following.png)`
3. **在面板里清空已捕获的数据**（按钮位置**待核实**），再打开 `x.com/<你的用户名>/verified_followers`（或 `/followers`）重复一遍。
   关注和粉丝两个页面可能共用一个模块，**不要在同一次采集里两个都打开**，否则会混在一起。
   `![截图5：清空已捕获数据的按钮](img/export_05_clear.png)`
4. 转换成标准表头：

```bash
python3 adapters/twitter_web_exporter.py users following_export.json -o data/following.csv
python3 adapters/twitter_web_exporter.py users followers_export.json -o data/followers.csv
```

### 3. 导出回复 → replies.csv

需要两个方向：

- **别人回我**：打开你最近每条帖子的详情页（`x.com/<你>/status/<帖子id>`），滚到底，把折叠的「显示更多回复」也点开。
- **我回别人**：打开 `x.com/<你>/with_replies`，往下滚到你想统计的起始日期。

然后在面板的推文模块导出 JSON（模块名**待核实**），再转换：

```bash
python3 adapters/twitter_web_exporter.py replies tweets_export.json --owner <你的用户名> -o data/replies.csv
```

`![截图6：帖子详情页滚动后，面板里推文模块的导出](img/export_06_tweets.png)`

说明：
- 转换脚本靠父推文 ID（`in_reply_to`）判断方向；如果父推文不在导出里，又没有 `in_reply_to_screen_name` 字段，就会跳过，并打印跳过了多少条。所以**最好把你自己的帖子和别人的回复一起导出**。
- `created_at`、`conversation_id` 等字段在上游的确切名字**待核实**，导出后用 `--show-columns` 看看（见下面「用别的工具」）。

### 4. 点赞（可选）→ likes.csv

点赞者列表只有帖子作者本人能在 `/likes` 页面看到。上游目前对点赞者的支持**待核实**（有未合并的 PR）。拿不到就不填，点赞本来只是辅助加分。

### 建议的频率（防封号）

| 页面 | 每次最多 | 间隔 |
|---|---|---|
| 关注 / 粉丝列表 | 一次滚完即可 | 一个月一次就够 |
| 帖子详情页 | 30 个 | 每滚一屏停 2–6 秒 |
| `with_replies` | 60 屏 | 一天最多一次 |

看到验证码、「请求过多 / Rate limit exceeded」、要求重新登录，**马上停**，过几个小时再来，不要反复重试。

---

## 方式二：X 官方账号归档（备选，最稳但不全）

1. 打开 X 的「设置 → 你的账号 → 下载数据归档」（入口名称以当前页面为准，**待核实**），验证密码后申请。
   `![截图7：设置里下载数据归档的入口](img/export_07_archive.png)`
2. 一般要等一段时间（通常一天左右，**待核实**），收到通知后下载 zip 并解压。
   `![截图8：归档下载完成的通知 / 下载按钮](img/export_08_download.png)`
3. 把你自己发的回复转成 replies.csv：

```bash
python3 adapters/x_archive.py 解压目录/data/tweets.js -o data/replies_out.csv
```

局限：
- 归档里只有**你自己发的**内容，所以只有「我→他」方向，「他→我」还得用方式一补。`audit.py` 会把 `data/` 里所有 `replies*.csv` 合起来读，按 tweet_id 去重。
- 归档里的 follower / following 一般只有数字 ID、没有用户名（**待核实**），这一版不能直接用来做互关判断。

---

## 方式三：用别的工具导出

只要最后的 CSV 列名对上就能跑。不知道原文件有哪些列，先看一下：

```bash
python3 adapters/generic_csv.py 你的导出.csv --show-columns
python3 adapters/generic_csv.py 你的导出.csv -o data/followers.csv --handle-col username --name-col name --bio-col description
```

`replies.csv` 可以用 Excel 或 Numbers 手动改列名，然后存成 UTF-8 CSV。

---

## 标准表头（和脚本完全一致）

**replies.csv**（必需）

| 列 | 必需 | 说明 |
|---|---|---|
| `tweet_id` | ✔ | 这条回复自己的 ID，每条唯一 |
| `created_at` | ✔ | 发布时间，ISO 8601，例如 `2026-10-19T17:00:00Z`（UTC） |
| `direction` | ✔ | `out` = 我回他，`in` = 他回我（也接受 `我→他` / `他→我`） |
| `account` | ✔ | 对方用户名，不带 @ |
| `text` | ✔ | 回复正文，用来判断是不是问候、水评 |
| `in_reply_to_status_id` | 建议 | 被回复那条推文的 ID。**没有它就确认不了往返**，往返分（25%）会是 0 |
| `conversation_id` | 可选 | 对话 ID |
| `parent_kind` | 可选 | 父推文不在表里时填：`root`（回的是对话起点帖）/ `other`（别的分支）/ `unknown` |

**following.csv / followers.csv**：`handle,name,bio`（可选再加 `verified`、`followers_count`）

**likes.csv**：`account,post_id,post_created_at,first_observed_at`。点赞没有时间字段，所以记录「帖子发布时间」和「你第一次看到这个赞的时间」；严格模式下两个时间都落在区间里才计分。

**profiles.csv**：`handle,followers_count,verified`（verified 填 1/0 或 true/false）

另外，`scripts/daily_collect.py` 输出的 `interactions.csv`（SPEC 格式）放进 `data/` 也能直接读，见 [DAILY_COLLECT.md](DAILY_COLLECT.md)。

---

## 需要补的截图清单

README 和本文里的截图位置现在都是占位符，需要补这几张（放在 `docs/img/`）：

1. `export_01_tampermonkey.png`：Tampermonkey 扩展页面
2. `export_02_install.png`：用户脚本安装确认页
3. `export_03_panel.png`：x.com 上的脚本面板入口
4. `export_04_following.png`：关注列表模块和导出按钮
5. `export_05_clear.png`：清空已捕获数据的按钮
6. `export_06_tweets.png`：推文模块导出
7. `export_07_archive.png`：设置里下载归档的入口
8. `export_08_download.png`：归档下载页面

截图里记得把别人的头像和用户名打码。
