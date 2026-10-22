# 数据准备指南（保姆级）

fan-audit 只读取你**本地电脑上**的 CSV 文件。数据来源可以自由选择，只要列名与下方的模板保持一致，使用任何工具导出的数据都能正常运行。

> 先明确三条基本原则：
> 1. **只读原则**：导出过程中不点赞、不关注、不取关、不发帖，切勿使用任何「批量自动关注/取关」工具。
> 2. **拒绝导出凭证**：切勿使用要求导出 cookie / token 的工具（例如需要手动粘贴登录 cookie 的命令行爬虫），此类工具封号风险极高，凭据一旦泄露等同于交出账号控制权。
> 3. **控制频率**：不要短时间内连续抓取几万条数据。下文为每种方式均提供了建议的调用频率。

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

[twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) 是一款遵循 MIT 协议的开源油猴脚本。它只**记录网页原本就会加载的数据**，不会向平台发送额外请求，因此风险较低。唯一的前提是需要手动在浏览器中滚动页面。

### 1. 安装

1. 在浏览器中安装 Tampermonkey（油猴）扩展。
2. 打开 twitter-web-exporter 的 GitHub 页面，按照 README 中的安装链接安装用户脚本（具体链接以该项目 README 为准）。
3. 刷新 x.com，页面边缘会出现脚本的小控制面板（位置和图标**待核实**，不同版本可能有所差异）。

### 2. 导出关注 / 粉丝 → following.csv、followers.csv

1. 打开 `x.com/<你的用户名>/following`，缓慢向下滚动页面，直到全部加载完毕。
2. 打开脚本面板，找到用户列表对应的功能模块（模块名**待核实**），导出为 JSON 或 CSV。
3. **在脚本面板中清空已捕获的数据**（按钮位置**待核实**），随后打开 `x.com/<你的用户名>/verified_followers`（或 `/followers`）重复上述步骤。
   关注列表与粉丝列表可能共用同一个模块，**切勿在同一次采集过程中同时打开两个页面**，以免数据混杂。
4. 转换成标准表头：

```bash
python3 adapters/twitter_web_exporter.py users following_export.json -o data/following.csv
python3 adapters/twitter_web_exporter.py users followers_export.json -o data/followers.csv
```

### 3. 导出回复 → replies.csv

需要两个方向：

- **他人回复我**：打开你近期每条推文的详情页（`x.com/<你>/status/<帖子id>`），滚动到底部，并展开折叠的「显示更多回复」。
- **我回复他人**：打开 `x.com/<你>/with_replies`，向下滚动至你计划统计的起始日期。

随后在脚本面板的推文模块导出 JSON（模块名**待核实**），再进行转换：

```bash
python3 adapters/twitter_web_exporter.py replies tweets_export.json --owner <你的用户名> -o data/replies.csv
```

说明：
- 转换脚本依据父推文 ID（`in_reply_to`）判定互动方向。若父推文未包含在导出文件中，且缺少 `in_reply_to_screen_name` 字段，该条记录将被跳过，并在终端提示跳过的具体条数。因此，**建议将你自己的推文与他人的回复一并导出**。
- 2026-10-20 对「正在关注」「关注者」「用户推文」三份 JSON 进行了结构抽样核对，每份抽样查看前 200 项。三份文件的根节点均为记录数组，已确认的字段详见下表。本次导出所使用的脚本版本尚未提供，暂不能推断所有版本的格式完全一致。
- 推文抽样样本中包含 `created_at`（字符串类型）；后续已使用本次真实导出的数据在本地完成转换并运行了完整分析，输出的回复时间字段均非空，现有时间解析器均能正常读取。`conversation_id`、`conversation_id_str`、`in_reply_to_screen_name` 在抽样样本中均未出现，但不排除其他记录或其他导出文件中包含这些字段。
- 「用户推文」导出无法保证包含父帖或双向的全部回复。若缺少父帖作者信息，转换器将跳过对应回复；切勿将“成功导出文件”等同于“回复已完整采集”。

本次结构核对与现有适配器的字段映射：

| 导出类型 | 样本字段 | 转换后的列 / 用途 |
|---|---|---|
| 关注 / 粉丝 | `screen_name`、`name`、`description` | `handle`、`name`、`bio` |
| 关注 / 粉丝 | `is_blue_verified`、`following`、`followed_by` | 同名保留；样本类型为布尔值 |
| 关注 / 粉丝 | `followers_count`、`friends_count` | 同名保留；样本类型为数字 |
| 关注 / 粉丝 | `verified_type` | 同名保留；本次样本均为 null，输出空值 |
| 推文 | `id`、`screen_name`、`full_text`、`created_at` | 回复 ID、作者、正文、时间 |
| 推文 | `in_reply_to` | `in_reply_to_status_id`；样本中有字符串和 null |
| 推文 | `quoted_status`、`retweeted_status` | 样本存在这两个字段；适配器不据此生成引用或转帖互动 |

其中 `direction` 和 `account` 均由回复双方推导而来，并非导出文件中的同名字段。2026-10-20 已在本地完成三份真实 JSON 的格式转换与非空检查：用户表中的 `handle`，以及输出回复中的 `tweet_id`、`created_at`、`direction`、`account`、`text`、`in_reply_to_status_id` 均非空；本次输出的 `conversation_id`、`parent_kind` 均为空。具体计数仅保存在本机验收记录中。字段非空并不代表采集完全充分，也不代表每条输入的推文都会被转换为有效回复。假数据测试已覆盖包含父帖时的双向回复判定，以及缺失父帖时的跳过逻辑。

### 4. 点赞（可选）→ likes.csv

点赞者列表目前仅推文作者本人可在 `/likes` 页面查看。上游脚本对点赞者的支持情况**待核实**（目前存在未合并的 PR）。若无法获取点赞数据留空即可，点赞本身仅作为辅助加分项。

### 建议的频率（防封号）

| 页面 | 每次最多 | 间隔 |
|---|---|---|
| 关注 / 粉丝列表 | 一次滚完即可 | 一个月一次就够 |
| 帖子详情页 | 30 个 | 每滚一屏停 2–6 秒 |
| `with_replies` | 60 屏 | 一天最多一次 |

若遇到人机验证码、「请求过多 / Rate limit exceeded」或提示重新登录，**请立即停止操作**，等待数小时后再试，切勿频繁反复重试。

---

## 方式二：X 官方账号归档（备选，最稳但不全）

1. 打开 X 的「设置 → 你的账号 → 下载数据归档」（入口名称以当前页面为准，**待核实**），完成密码验证后提交申请。
2. 申请后通常需等待一天左右（**待核实**），收到官方通知后下载 zip 压缩包并解压。
3. 把你自己发的回复转成 replies.csv：

```bash
python3 adapters/x_archive.py 解压目录/data/tweets.js -o data/replies_out.csv
```

局限性：
- 官方归档仅包含**你自己发送**的内容，因此只能覆盖「我→他」方向，「他→我」仍需通过方式一补充。`audit.py` 会读取 `data/` 目录下所有 `replies*.csv` 并自动按 `tweet_id` 合并去重。
- 归档中的 follower / following 通常只提供数字 ID、未包含用户名（**待核实**），当前版本无法直接用于判定互关状态。

---

## 方式三：用别的工具导出

只要最终的 CSV 列名符合规范即可正常运行。如果不清楚原文件包含哪些列，可以先查看表头。请注意，下面的 `--show-columns` 仅适用于 CSV 文件，不支持 JSON，亦非 twitter-web-exporter 适配器的参数：

```bash
python3 adapters/generic_csv.py 你的导出.csv --show-columns
python3 adapters/generic_csv.py 你的导出.csv -o data/followers.csv --handle-col username --name-col name --bio-col description
```

若 CSV 中的用户名列名为 `screen_name`，请将 `--handle-col username` 替换为 `--handle-col screen_name`。本次核对仅针对 JSON 格式，CSV 的实际导出字段尚未验证。

对于 `replies.csv`，也可以使用 Excel 或 Numbers 手动修改列名，并另存为 UTF-8 编码的 CSV 文件。

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

**likes.csv**：`account,post_id,post_created_at,first_observed_at`。由于点赞数据本身不带时间戳，因此分别记录「推文发布时间」与「首次观察到该点赞的时间」；在严格模式下，只有两个时间均落在统计区间内才会计分。

**profiles.csv**：`handle,followers_count,verified`（verified 填 1/0 或 true/false）

另外，`scripts/daily_collect.py` 输出的 `interactions.csv`（SPEC 格式）放进 `data/` 也能直接读，见 [DAILY_COLLECT.md](DAILY_COLLECT.md)。

---

## 需要补的截图清单

截图待补充。上述安装、导出及归档步骤当前仅包含文字指引，后续将补充 8 张完整的导出流程截图，并在 README 的 Roadmap「补导出截图」中跟进。截图时请将他人的头像、用户名及推文内容妥善打码，并裁剪去除浏览器地址栏与书签栏中的私人信息。
