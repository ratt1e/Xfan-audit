# 不用付费 API，怎么收集数据：工具调研

调研时间：2026-10-19。GitHub 星标数及最后提交时间均取自当天 GitHub API 的返回结果。由于 X 平台前端经常更新，相关工具可能会随时失效或发生行为变动，使用前请务必自行复核。

> **风险提示**：X 的服务条款明确禁止未经许可的数据抓取，严禁任何自动化的关注、取关、点赞等操作。
> - **低风险方案**：仅在浏览器中「被动记录你正常浏览加载的数据」，不向平台发送额外请求，不点击任何操作按钮。
> - **中风险方案**：借助已登录会话，主动调用 X 网页版的内部 GraphQL 接口。
> - **高风险方案**：将 `auth_token`、`ct0` 等身份凭据导出给脚本或第三方服务，采用多账号轮换或代理批量抓取。开发者社区中已有大量封号和验证锁定的案例。
>
> 无论选用哪种方案，切勿使用重要个人账号进行任何批量自动化操作。

## 推荐方案

### 方案 A：twitter-web-exporter + 手动（或 AI 代理）慢慢滚动　★ 首选

- 仓库：https://github.com/prinsss/twitter-web-exporter
- 状态：2758★，MIT 许可。最新版本 v1.4.3 发布于 2026-08-31，近几个月持续在适配 X 的接口变化。
- 形式：油猴脚本，需要先装 Tampermonkey 或 Violentmonkey。
- 工作原理：上游 README 明确指出该脚本「does not send any request to Twitter API」。它通过拦截网页前端自身发起的 GraphQL 响应来实现数据提取，因此只能导出你实际滚动加载过的内容。原作者在 FAQ 中针对「账号是否会被封禁」的回复为「Not likely」，原因在于整个过程没有发起额外的自动化请求，其行为特征与手动复制网页文本基本无异。
- 能导出：
  - 关注列表、粉丝列表、认证粉丝（源码里 `BlueVerifiedFollowers` 和 Followers 共用一个模块，请分开采集，见下文）
  - 转帖者（Retweeters）
  - 帖子详情页的回复（TweetDetail）
  - 用户的帖子、回复、点赞过的帖子，书签，搜索结果，List 成员
- 点赞者：截至调研时还**不支持**。有一个未合并的 PR #150「feat: add support for tweet likers」（2026-08-26，https://github.com/prinsss/twitter-web-exporter/pull/150 ），作者说明只对当前登录账号自己的帖子有效。
- 输出格式：JSON、CSV（带 BOM，换行写成字面量 `\n`）、HTML。
  - 用户的字段：`screen_name`、`name`、`description`、`followers_count`、`friends_count`、`is_blue_verified`、`verified_type`、`following`、`followed_by` 等。
  - 推文的字段：`id`、`screen_name`、`in_reply_to`（被回复帖子的 id）等。
- 自动化：README 说不能自动导出，自动滚动需要第三方工具，社区方案在 issue #120（https://github.com/prinsss/twitter-web-exporter/issues/120 ）。
- 接入本仓库：用 `adapters/twitter_web_exporter.py` 转换，用法见下文。

**补充优势：**导出的每条用户记录均附带 `followed_by`（对方是否关注了你）字段。在导出「正在关注」列表时，便能直接获知其中哪些人回关了你（涵盖未认证的普通粉丝）。这在一定程度上弥补了「仅能导出认证粉丝」带来的样本口径局限。关于该字段在各种场景下是否始终准确，建议使用自身数据进行小范围抽查（**待核实**）。

### 方案 B：点赞者用官方免费接口，或者手动、AI 代理读页面

- 点赞列表目前仅推文作者本人可在网页端查看完整名单。
- 在实测中，作者使用经本人账号授权的 X 官方接口查询自己推文的点赞用户（`GET /2/tweets/:id/liking_users`），当时并未扣费（账户余额为 $0.00 时亦可成功调用）。这仅代表单次观察结果，X 的计费政策时有调整，实际使用前请以开发者后台的最新说明为准。
- 若不希望调用 API，可选用以下替代方式：
  - 打开 `x.com/<你>/status/<帖子id>/likes` 手动记录用户名；
  - 或使用 AI 电脑代理（ChatGPT / Codex Computer Use、Claude in Chrome、Gemini、Antigravity 等）只读滚动该页面并记录用户名；
  - 等待 twitter-web-exporter 合并 PR #150 后，亦可直接使用该脚本捕获。

## 其他调研过的选项

| 工具 | 地址 | ★ / 最近更新 | 能导出 | 方式 | 许可 | 结论 |
|---|---|---|---|---|---|---|
| XPorter（Chrome 扩展） | https://github.com/Lemelson/xporter-extension | 9★ / 2026-09-29 | 帖子、书签、关注、粉丝、**认证粉丝**；CSV / JSON / XLSX / TXT | 用你已登录的会话**主动**调内部 GraphQL（README：「piggybacks on the cookies you already have」），有限速档位 | GitHub 显示 NOASSERTION | 可用，但风险高于方案 A，项目很新、用户少。导出后用 `adapters/generic_csv.py` 映射列名 |
| XTract（Chrome 扩展） | https://postcopilot.ai/xtract | 未找到源码仓库 | 关注、粉丝；CSV / JSON | 用登录态主动请求，默认每 10 秒 20 个 | 未知 | 不开源，权限和数据去向无法审查，不推荐 |
| twscrape | https://github.com/vladkens/twscrape | 2875★ / 2026-10-05 | followers、following、verified_followers、retweeters、tweet_replies 等 | 需要导出 `auth_token` 和 `ct0` cookie；支持多账号轮换、代理 | MIT | 功能全、维护活跃，但属于高风险用法。README 里有购买现成账号和代理的推广链接；issue 有「Session expired or banned」（#251）、「Ban detected: 429」（#274） |
| twikit | https://github.com/d60/twikit | 4739★ / 2026-03-10 | 关注、粉丝、认证粉丝、点赞者（`get_favoriters`）、转帖者等 | 用账号登录或 cookies 调内部接口 | MIT | 高风险。issue 有多条封号报告（#310、#314、#359），2026-07 还有人报告登录时被要求掌纹活体验证（#430） |
| the-convocation/twitter-scraper | https://github.com/the-convocation/twitter-scraper | 640★ / 2026-04-01 | 未逐项核实 | Node.js 版爬虫库 | MIT | 待核实 |
| XActions | https://github.com/nirholas/XActions | 604★ / 2026-10（最后提交 2026-10-11） | CLI、MCP 服务、批量脚本，含批量点赞、取关等自动化 | 从浏览器读取 cookie | Apache-2.0 | 带写操作和批量自动化，和本项目「只读」的原则冲突，不推荐 |
| x-browser-mcp | https://github.com/SohrabZ/x-browser-mcp | 2★ / 2026-09-24 | 读帖子和回复；写操作默认关闭（要加 `-allow-writes`） | 本地登录浏览器 + DOM 解析，通过 MCP 给 AI 用 | MIT | 适合让 AI 读回复；没确认能否导出完整粉丝列表（待核实） |
| twitter-bridge-mcp | https://github.com/replica882/twitter-bridge-mcp | 131★ / 2026-03-29 | 读帖子及回复（最多 20 条）、提及；也能发帖 | 浏览器自动化 + DOM 解析 | MIT | 有写能力，使用时要关掉或不授权写操作 |
| claude-code-x-browser-skill | https://github.com/zszxzzc/claude-code-x-browser-skill | 1★ / 2026-02-06 | 只读浏览、搜索、看主页 | Chrome DevTools MCP | 未标注 | 思路可参考，项目很小 |
| Nitter | https://github.com/zedeus/nitter | 14469★，仓库已归档 | — | 第三方前端 | AGPL-3.0 | README 说 2026-08-24 收到 X Corp. 的停止侵权函，**不可用** |
| snscrape | https://github.com/JustAnotherArchivist/snscrape | 最后推送 2023-11 | — | — | GPL-3.0 | 已长期不更新，对 X 基本失效 |
| n0madic/twitter-scraper | https://github.com/n0madic/twitter-scraper | 已归档（2023） | — | — | MIT | 不可用 |
| twitter-api-client | https://github.com/trevorhobenshield/twitter-api-client | 最后推送 2024-05 | — | — | MIT | 不再维护 |

**官方数据归档（设置 → 下载数据归档）**：根据 twitter-web-exporter README 说明，官方归档中的关注列表与粉丝列表通常仅包含数字 ID 而无用户名，需二次查询转换后方可使用。此外社区中有用户反馈，若账号遭遇封禁，归档中的关注和粉丝列表可能为空。

**社区反馈（X 平台公开讨论，仅供参考）**：
- 部分中文创作者建议「先导出官方归档作为基础，再使用 twitter-web-exporter 补充近期数据」，并特别提醒像 twikit 这种需要非官方登录态的工具存在封号及违反服务条款的风险（来源：社区公开推文，链接略）。
- 另有开发者反馈 twikit 容易遭遇 Cloudflare 403 拦截，甚至引发账号封禁（来源：社区公开推文，链接略）。

## 用 AI 电脑代理配合方案 A 的做法

让代理仅负责两项操作：打开页面与缓慢向下滚动。数据导出依然交由油猴脚本完成。

1. 在本地浏览器中安装好 Tampermonkey 与 twitter-web-exporter，并保持 X 账号登录状态。
2. 每类数据独立进行一次采集：
   - 采集开始前在脚本面板中清空已捕获的数据；
   - 打开对应的目标页面（`x.com/<你>/following`、`/followers`、`/verified_followers`、各推文详情页、`/retweets`）；
   - 让代理匀速滚动到底部；
   - 在脚本面板中点击导出。

   注意：`followers` 与 `verified_followers` 会进入同一个功能模块，**切勿在同一次采集过程中同时打开这两个页面**，以免数据混杂。
3. 供代理使用的提示词示例：

   > 你只能执行只读操作。在当前标签页 x.com/<我的用户名>/followers 上，每次向下滚动一屏，停顿 3～5 秒，直到页面不再加载新内容，或累计滚动达到 300 次为止。不要点击任何按钮、链接、关注、点赞或输入框。若遇到人机验证、重新登录提示或「速率限制」提示，请立即停止操作并通知我。

4. 把导出文件放进 `data/`（已在 `.gitignore` 中排除），用适配器转换。

## 适配器用法

```bash
# 用户列表（JSON 或 CSV 都行）
python3 adapters/twitter_web_exporter.py users exports/following.json -o data/following.csv
python3 adapters/twitter_web_exporter.py users exports/verified_followers.csv -o data/followers.csv
# 只想保留认证账号时加 --only-blue-verified

# 互动：回复来自帖子详情页的推文导出；转帖者、点赞者每个文件对应一条帖子
python3 adapters/twitter_web_exporter.py engagement --owner 你的用户名 \
  --replies exports/tweets_*.json --post-ids 帖子id1,帖子id2 \
  --retweeters exports/rt_post1.json exports/rt_post2.json \
  --likers exports/likers_post1.json \
  -o data/engagement.csv

# 其他工具导出的 CSV：先看列名，再映射
python3 adapters/generic_csv.py export.csv --show-columns
python3 adapters/generic_csv.py export.csv -o data/followers.csv --handle-col username --name-col name --bio-col description

python3 fan_audit.py --following data/following.csv --followers data/followers.csv --engagement data/engagement.csv --keywords keywords.txt --out output --anonymize
```

关于回复统计的口径说明：
- 指定 `--post-ids` 时，仅统计**直接**回复这些指定推文的内容；
- 未指定时，导出文件中所有携带 `in_reply_to` 的推文均会纳入统计（包含楼中楼回复）；
- 作者本人的自回复均会自动剔除；同一推文 ID 若重复捕获仅计入一次。

`examples/adapters/` 里有按 twitter-web-exporter 字段格式**虚构**的示例文件，可以直接试跑。

字段名依据上游源码中的 exportKey（`src/components/table/columns-user.tsx`、`columns-tweet.tsx`，核对于 2026-10-19）。若上游版本迭代导致适配器报错，请先核对导出文件的列名是否发生变动。
