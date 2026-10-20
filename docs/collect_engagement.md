# 怎么收集互动数据（engagement.csv）

`fan_audit.py` 本身不联网。你需要自己准备 `engagement.csv`：

```csv
handle,likes,replies,quotes,reposts
user_001,3,1,0,0
```

每行一个账号，统计它在你选定的那批帖子上的公开互动次数。

## 方法一：手动统计（不需要 API）

帖子少的时候最简单：打开每条帖子的「点赞」列表和回复区，把用户名抄进表格计数。慢，但不需要任何权限。

## 方法二：X API v2（只读）

| 要什么 | 接口 | 说明 |
|---|---|---|
| 你最近的帖子 | `GET /2/users/:id/tweets`（`exclude=replies,retweets`） | 拿到帖子 id 和 `public_metrics` |
| 谁点了赞 | `GET /2/tweets/:id/liking_users` | 一般只能查你自己帖子的完整点赞名单 |
| 谁回复了 | `GET /2/tweets/search/recent` 或全量搜索，`query=conversation_id:<帖子id> -from:<你的用户名>` | 近期搜索只覆盖最近 7 天 |
| 谁引用了 | `GET /2/tweets/:id/quote_tweets` | `quote_count` 为 0 就不用查 |
| 谁转帖了 | `GET /2/tweets/:id/retweeted_by` | `retweet_count` 为 0 就不用查 |

注意：
- X API 的价格、免费额度和频率限制经常调整，以 X 开发者后台当前说明为准。先拿 1～2 条帖子试，估算好成本再批量跑。
- 先看 `public_metrics`，互动数为 0 的帖子就跳过对应接口，能省不少调用。
- 不要把 API key、token 写进仓库、CSV 或截图。用环境变量，`.gitignore` 里排除数据目录。
- 回复搜索会漏掉被隐藏、删除或受限的回复，报告里要写清楚。

## 为什么没有「拉粉丝列表」的步骤

X 没有面向普通用户的免费官方接口，可以直接导出完整粉丝列表。`following.csv` 和 `followers.csv` 只能：
- 从 x.com 的 following / followers（或 verified_followers）页面手动复制；或者
- 用你自己的读屏、浏览器工具只读导出。

请保持只读、慢速，不要写脚本自动关注、取关或批量操作。这违反 X 的自动化规则，可能导致限流甚至封号。

如果你只能导出「已认证粉丝」，跑脚本时加 `--followers-label 已认证粉丝`，并在结论里注明：未认证的粉丝不在表里，会被算成「没回关」。
