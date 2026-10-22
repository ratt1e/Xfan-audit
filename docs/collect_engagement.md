# 怎么收集互动数据（engagement.csv）

`fan_audit.py` 本身不联网。你需要自己准备 `engagement.csv`：

```csv
handle,likes,replies,quotes,reposts
user_001,3,1,0,0
```

每行记录一个账号，统计该账号在你选定的一批推文下的公开互动次数。

## 方法一：手动统计（不需要 API）

推文数量较少时操作最简单：直接打开每条推文的点赞列表和回复区，将用户名逐一录入表格计数。速度稍慢，但无需任何额外接口权限。

## 方法二：X API v2（只读）

| 要什么 | 接口 | 说明 |
|---|---|---|
| 你最近的帖子 | `GET /2/users/:id/tweets`（`exclude=replies,retweets`） | 拿到帖子 id 和 `public_metrics` |
| 谁点了赞 | `GET /2/tweets/:id/liking_users` | 一般只能查你自己帖子的完整点赞名单 |
| 谁回复了 | `GET /2/tweets/search/recent` 或全量搜索，`query=conversation_id:<帖子id> -from:<你的用户名>` | 近期搜索只覆盖最近 7 天 |
| 谁引用了 | `GET /2/tweets/:id/quote_tweets` | `quote_count` 为 0 就不用查 |
| 谁转帖了 | `GET /2/tweets/:id/retweeted_by` | `retweet_count` 为 0 就不用查 |

注意：
- X API 的定价、免费额度与调用频率限制时有调整，请以 X 开发者后台的最新说明为准。建议先拿 1～2 条推文测试，预估好调用成本后再批量运行。
- 建议先查阅 `public_metrics`，若推文互动数为 0 则直接跳过对应接口，可以节省大量 API 调用。
- 切勿将 API key 或 token 写入仓库代码、CSV 文件或截图中。请使用环境变量存储，并在 `.gitignore` 中排除数据目录。
- 回复搜索接口可能会遗漏被作者隐藏、已被删除或受限的回复，在最终分析报告中应当予以说明。

## 为什么没有「拉粉丝列表」的步骤

X 未向普通用户提供可直接导出完整粉丝列表的免费官方接口。`following.csv` 与 `followers.csv` 仅能通过以下途径获取：
- 从 x.com 的 following / followers（或 verified_followers）页面手动复制；或者
- 用你自己的读屏、浏览器工具只读导出。

操作请务必保持只读与慢速，切勿编写自动化脚本进行批量关注、取关等操作。此类行为违反 X 自动化规则，极易导致限流乃至封号。

若你仅能导出「已认证粉丝」，运行脚本时请加上 `--followers-label 已认证粉丝`，并在分析结论中注明：未认证的普通粉丝未纳入统计表，会被判定为「未回关」。
