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

感谢这款开源脚本，它只记录网页原本就会加载的数据。页面怎么滚动，请看 [docs/DATA_EXPORT.md](docs/DATA_EXPORT.md)。

### 2. 打开网页，拖进去

用浏览器打开本仓库的 `web/index.html`（双击，或把文件拖进浏览器）。再把上面的 JSON 拖进页面，一次可以拖多个，文件名不用改。`interactions.csv` 也可以直接拖。

在页面上填好你的用户名（不带 @）。如果推文文件里没写，页面会按发主帖最多的账号先猜一个，不对随时改。如果文件名看不出是「正在关注」还是「关注者」，页面会先弹出来让你选。

顶部可以选择开始与结束日期，或者直接点「最近 7 天 / 30 天 / 全部」。每次切换都会自动重算，并标明覆盖了几天。凡是没有采集记录、也没有互动落在那天的日期，都会按「无数据」处理，既不当成零互动，也不计入持续性得分的分母。

截图前点一下「打码模式」，账号名就会换成「账号#01」。

GitHub Pages 的配置在 `.github/workflows/pages.yml`，准备从 `/web` 发布，**还没开启**。现在请直接打开本地的 `web/index.html`。

## 进阶用法

以下是 Python 命令行用法，适合每天用 Grok Bot 采集、或者想把看板保存到固定目录的人。网页版和命令行使用完全同一套打分逻辑。

### 适用人群

适合已经开通 **X Premium** 的创作者。推荐搭配 **Grok Bot** 使用：Bot 负责每天通过只读接口采集互动，仓库脚本在本地电脑上计算打分、生成看板。没有 Bot 也能跑，只是需要手动导出互动数据，结果通常会少一部分，详见下一节。

### 数据从哪来

两份数据分开准备，最后由 `audit.py` 合在一起算。

1. **关注和粉丝**：用 [twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) 在浏览器里手动导出 `following.csv`、`followers.csv`。感谢这款开源脚本，它只记录网页原本加载的数据。页面滚动与格式转换的方法，请看 [docs/DATA_EXPORT.md](docs/DATA_EXPORT.md)。
2. **每天的互动**：Grok Bot 用 X 的只读接口采集原始 JSON，再由 `scripts/daily_collect.py` 生成 `interactions.csv`。接口、额度和目录见 [docs/DAILY_COLLECT.md](docs/DAILY_COLLECT.md)。
3. **计算**：`audit.py --data-root` 合并多天的 `interactions.csv`；`--lists` 只读那两张关系表，用来判断互关和沉睡互关。

如果没有 Grok Bot，也可以用同一款插件把互动导出为 CSV 代替。插件只能记录你亲自滚动浏览过的页面，通常只能拿到一个方向。缺少另一个方向的数据时，互动条数、最终得分和分层结果都会偏低。

### 合理使用

- **只读原则。** 不自动点赞，不自动关注或取关，不自动发帖，不发私信。看板里的「建议动作」仅供参考，工具不会代你执行。
- **遵守调用额度。** Grok Bot 内置的公开读取额度为：每分钟 30 次、每天 1000 次、单次请求最多 25 条，每日 00:00 UTC 自动重置。日常单轮采集累计请求不超过 27 次（若需补采最近 48 小时数据则不超过 33 次），严格上限 40 次。若遇到 HTTP 429 限流，等待额度重置后仅重试 1 次；若遇到 401、403 或额度耗尽请立即终止。各接口页数分配方案详见 [额度预算](docs/DAILY_COLLECT.md#6-额度预算)。
- **切勿交出登录凭证。** 切勿使用要求导出 cookie / token 的工具，亦切勿将 API key 写入仓库代码、提示词或截图中。

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

每次采集完成后，在本地运行同一条命令执行 `audit.py`，将包含账号名的完整 `dashboard.html` 输出至仓库外的固定目录。用浏览器打开该文件并保存为书签，后续每日点击该书签即可直接查阅最新分析看板。

```bash
python3 audit.py --data-root ~/x-data/ --lists ~/x-lists/ --me 你的用户名 --out ~/x-data/_看板/ --overwrite
```

包含真实账号名的看板、`accounts.csv`、`名单.md` 与未回关名单仅保存在本地设备上。切勿部署至公网或上传到网盘公开分享。如需对外分享，请使用脱敏版的 `dashboard_public.html` 并自行截图。

`--overwrite` 参数仅会替换该目录下由本工具生成的分析结果：`dashboard.html`、`dashboard_public.html`、`accounts.csv`、`名单.md`、`没回关.md` 和 `没回关.csv`。若检测到目录下存在其他无关文件，命令将报错终止，绝不随意删除文件。未添加 `--overwrite` 时，遇到已存在的输出结果将直接拒绝覆盖。此外，仓库内部以及日期输入目录始终禁止写入。

### Python 命令行

```bash
# 1. 下载
git clone https://github.com/ratt1e/Xfan-audit.git fan-audit && cd fan-audit      # 或者下载 zip 解压

# 2. 先用假数据跑一遍（1 秒）
python3 audit.py --data sample_data
#    打开 output/dashboard.html 看效果
#    请求 30 天，计分覆盖 28 天，无数据 2 天
#    金牌 3，银牌 2，他常来 2，我常去 1，沉睡 3，样本不足 3，其他有分 4，零互动 2

# 3. 换成你自己的数据：把 CSV 放进 data/，再跑
python3 audit.py
```

命令行所需的 CSV 导出方法，请参阅 **[docs/DATA_EXPORT.md](docs/DATA_EXPORT.md)**（保姆级教程，包含浏览器插件与 X 官方数据归档两种方式）。运行最少仅需一个 `replies.csv`，推荐一并提供 `following.csv` 与 `followers.csv`。

输出文件位于 `output/`：

| 文件 | 内容 |
|---|---|
| `dashboard.html` | 看板：与网页版一样支持自由筛选日期，初次打开展示本次计算的完整区间。每个层级均有可点击的数字卡片，点击即可展开该层名单。用户名直链到个人主页。**包含真实账号名，仅供个人查阅** |
| `dashboard_public.html` | 同款看板的脱敏打码版。日期筛选功能完全可用，文件内仅包含账号代号，已去除主页链接，可安心截图对外分享 |
| `accounts.csv` | 每个账号独立一行：记录分层、星级、综合评分及各项明细指标 |
| `没回关.md`、`没回关.csv` | 我关注但对方未回关的账号名单。包含主页链接，**仅供个人查阅**。脱敏版看板的对应板块不展示链接 |

关于多天合并、`--data-root` 及 `--overwrite` 等进阶参数，请参见 [docs/TOOLS.md](docs/TOOLS.md)。

如需对比上一份关注与粉丝名单以追踪取关和新粉变动，请参见 [docs/TOOLS.md](docs/TOOLS.md)。我关注但对方未回关的名单说明亦收录于该文档。

## 星级怎么算（大白话）

仅统计选定时间区间（默认最近 30 天）内**你与各个账号之间**的双向公开回复。若查询区间内某些日期既无互动时间戳、亦无点赞首次观察记录，将判定为「无数据」，不计入持续性得分的分母。以 `sample_data` 为例，查询的 30 天实际有效覆盖 28 天。每个账号按 0–100 分量化评分：

| 评估维度 | 权重占比 | 通俗解读 |
|---|---|---|
| 持续性 | 40% | 是否在多天内保持交流，而非集中在某一天突击互动 |
| 双向性 | 35% | 你回复对方与对方回复你的频次是否大致对等 |
| 往返轮数 | 25% | 是否形成真实对话接龙：你回复他之后，他又针对该条推文进行了回复（严格依据 `in_reply_to_status_id` 判定） |
| 点赞加分 | 最多 +5 分 | 仅作为辅助参考项，绝不能将极少交流的用户抬升至高星级 |

- **过滤问候与敷衍水评**：「早安」「互关」「来咯」等简短用语（词表定义于 `config.json`）不计入双向性与往返轮数；若某用户 80% 以上互动均为问候，最高封顶 2 星。
- **样本不足时不评星**：互动少于 3 条，或全部互动均发生在同一天，系统将标明「样本不足」，避免强行给出低评分。
- 评分换算星级：≥80 ★5，≥60 ★4，≥40 ★3，≥20 ★2，其余 ★1。

**金牌用户** = 综合评分 ≥55（达到或接近 4 星）＋ 真实往返 ≥3 轮 ＋ 双方各自实质回复 ≥3 条 ＋ 问候占比低于一半 ＋ 至少 2 天有实质互动，且对方至少回复过 1 条。
**银牌** = 有评分但未达到金牌标准，对方至少回复过 1 条且确认往返至少 1 次；在此基础上得分 ≥40 或真实往返 ≥2 轮。若对方从未回复，或确认往返次数为 0，则不会列入银牌。
**单向** = 一方达到 3 条及以上，另一方几乎没有。若我方发出 ≥3 条而对方回复为 0，无论总分是否达到银牌线，均优先归为「单向·我常去他没回」。若对方回复过但未能匹配到回复链、导致确认往返为 0，则不属于「他没回」。**沉睡互关** = 双方互关，但在这段时间内没有任何回复与点赞。

名单排序会为互关、蓝V（对 X 创作者收益的认证曝光有效）以及对方粉丝数较多的账号赋予少量优先权重，仅影响列表先后顺序，不改变星级评定。

以上各项数值均为**待验证的初始参数**，均可在 [`config.json`](config.json) 中调整，修改后重新运行即可生效。完整计算公式请参见 [docs/SPEC_relationship_stars.md](docs/SPEC_relationship_stars.md)。关于粉丝数与收益门槛的区别，请参见 [docs/TOOLS.md](docs/TOOLS.md)。

> 评分仅为数据线索，并不代表真实的社交关系，更不代表对方的好坏。零公开互动并不等于对方没看过你的推文。看板中的「建议动作」仅供参考，工具不会代为执行任何操作。

## Roadmap

- [x] 网页拖拽版：打开 `web/index.html`，拖入 JSON 或 CSV，在浏览器里算星级和分层
- [x] v0.1 CSV → 星级 → 金牌/银牌/单向/沉睡互关分层 → HTML 看板（含打码版）
- [x] v0.1 配置文件 `config.json`（词表、权重、星级线、门槛）
- [x] v0.2 对话往返轮数（严格回复链：`in_reply_to_status_id` 指向对方那条才算）：已实现；缺少父帖 ID 的回复会提示「无法确认往返」
- [ ] v0.2 环比上一区间的互动趋势（↑↓），并在看板中支持 7 天 / 30 天视图切换
- [ ] v0.3 引入大模型识别深度评论与敷衍水评，替代现有的关键词词表
- [ ] v0.4 一键生成脱敏版月度铁粉报告图
- [ ] 权重校准：由用户标注约 10 位好友后，按 SPEC 第 11 节优化参数
- [ ] 补充数据导出教程截图

名单核对、采集转换以及仅计算星级的命令，请参见 [docs/TOOLS.md](docs/TOOLS.md)。

## 隐私与安全

- **只读原则。** 切勿编写脚本进行自动关注、批量取关或任何自动化操作，此类行为违反 X 的自动化规则，极易触发限流甚至封号。清理关注建议手动、分批次轻量处理。
- **切勿提交真实数据。** `.gitignore` 已默认忽略 `data/`、`output/`、`private/`、各类导出文件、xlsx 表格以及生成的看板 HTML。
- **拒绝敏感凭据。** 切勿使用要求导出 cookie / token 的工具，本项目本身亦不需要任何 API key。
- **尊重他人隐私。** 对外分享请使用脱敏版 `dashboard_public.html`，切勿公开点名或将他人标为「僵尸粉」。

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
