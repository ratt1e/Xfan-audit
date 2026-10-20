# 不用付费 API，怎么收集数据：工具调研

调研时间：2026-10-19。星标数、最后提交时间来自 GitHub API 当天的返回值。这些工具都会随 X 改版失效或变化，用之前请自己再确认一次。

> **先说风险。** X 的服务条款不允许未经授权的抓取，也不允许自动化的关注、取关、点赞等操作。
> - **风险最低：**只在浏览器里「记录你自己刷到的页面」，不额外发请求、不点任何按钮。
> - **风险中等：**用你的登录态，主动调用 X 网页版内部接口（GraphQL）。
> - **风险最高：**把 `auth_token`、`ct0` 等 cookie 导出给脚本或第三方服务，用多账号、代理批量抓取。社区里有不少锁号、封号的报告。
>
> 无论用哪种，都不要拿重要账号去做批量操作。

## 推荐方案

### 方案 A：twitter-web-exporter + 手动（或 AI 代理）慢慢滚动　★ 首选

- 仓库：https://github.com/prinsss/twitter-web-exporter
- 状态：2758★，MIT 许可。最新版本 v1.4.3 发布于 2026-08-31，近几个月持续在适配 X 的接口变化。
- 形式：油猴脚本，需要先装 Tampermonkey 或 Violentmonkey。
- 原理：README 原话是脚本「does not send any request to Twitter API」。它拦截网页版自己发出的 GraphQL 请求的响应，所以只能导出你滚动加载过的数据。作者在 FAQ 里对「会不会被封」的回答是「Not likely」，理由是没有自动化操作，行为和手动复制差不多。
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

**一个额外的好处：**每条用户记录带 `followed_by`（对方是否关注你）字段。导出「正在关注」列表时，就能直接知道这些人里谁关注了你，包括没认证的粉丝。这能部分弥补「只能导出认证粉丝」的口径问题。这个字段是否始终准确，请用自己的数据抽查（待核实）。

### 方案 B：点赞者用官方免费接口，或者手动、AI 代理读页面

- 点赞列表现在只有帖子作者自己能看到完整名单。
- 在我们的实测里，作者用自己账号授权的 X 官方接口查自己帖子的点赞用户（`GET /2/tweets/:id/liking_users`），当时没有扣费（账户余额 $0.00 也能调用）。这只是一次观察，X 的计费规则会变，用之前请先看开发者后台。
- 不想用 API 的话：
  - 打开 `x.com/<你>/status/<帖子id>/likes` 手动抄；
  - 或者让 AI 电脑代理（ChatGPT / Codex Computer Use、Claude in Chrome、Gemini、Antigravity 等）只读滚动这个页面并记录用户名；
  - 等 twitter-web-exporter 合并 PR #150 后，也可以用它捕获。

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

**官方数据归档（设置 → 下载数据归档）：**按 twitter-web-exporter README 的说法，归档里的关注和粉丝只有数字 ID，没有用户名，需要再查一次才能用。社区还有人反映，账号被封后归档里的关注、粉丝是空的。

**社区口碑（X 上的公开讨论，仅供参考）：**
- 有中文用户建议「先走官方归档，再用 twitter-web-exporter 补」，并提醒 twikit 这类非官方登录要评估封号和 TOS 风险（来源：社区公开帖子，链接略）。
- 也有人提到 twikit 被 Cloudflare 403 拦截，还被封号（来源：社区公开帖子，链接略）。

## 用 AI 电脑代理配合方案 A 的做法

让代理只做两件事：打开页面、慢慢往下滚。导出由油猴脚本完成。

1. 在你自己的浏览器里装好 Tampermonkey 和 twitter-web-exporter，保持 X 登录状态。
2. 每类数据开一次采集：
   - 采集前在脚本面板里清空已捕获的数据；
   - 打开对应页面（`x.com/<你>/following`、`/followers`、`/verified_followers`、每条帖子详情页、`/retweets`）；
   - 让代理滚到底；
   - 在脚本面板里导出。

   注意：`followers` 和 `verified_followers` 进的是同一个模块，**两个页面不要在同一次采集里都打开**，否则会混在一起。
3. 给代理的提示词示例：

   > 你只能做只读操作。在当前标签页 x.com/<我的用户名>/followers 上，每次向下滚动一屏，停 3～5 秒，直到页面不再加载新内容，或者滚动 300 次为止。不要点击任何按钮、链接、关注、点赞或输入框。看到验证码、登录提示或「速率限制」提示时立即停下来告诉我。

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

关于回复统计的口径：
- 给了 `--post-ids` 时，只统计**直接**回复这些帖子的推文；
- 不给时，导出文件里所有带 `in_reply_to` 的推文都算，包括楼中楼；
- 作者自己的回复都会被排除；同一个推文 id 重复捕获只算一次。

`examples/adapters/` 里有按 twitter-web-exporter 字段格式**虚构**的示例文件，可以直接试跑。

字段名依据上游源码中的 exportKey（`src/components/table/columns-user.tsx`、`columns-tweet.tsx`，核对于 2026-10-19）。上游改版后，如果适配器报错，先检查导出文件的列名。
