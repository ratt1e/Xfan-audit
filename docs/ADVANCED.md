> 这份文档写给想用命令行、每天自动采集，或者想细看打分规则的朋友。要是只想看结果，回到 [README](../README.md) 用网页版就够了。

# 进阶用法：命令行与每日采集

下面是 Python 命令行用法，适合每天用 Grok Bot 自动采集、或者想把看板存到固定目录的朋友。网页版和命令行用的打分逻辑完全一样。

### 适用人群

适合开通了 **X Premium** 的创作者。推荐搭配 **Grok Bot** 一起用：Bot 负责每天用只读接口采集互动，本地脚本在电脑上算分、生成看板。没有 Bot 也能跑，只是需要手动导出互动数据，拿到的记录通常会少一些，后面会详细说。

### 数据从哪来

两份数据分开准备，最后交给 `audit.py` 合并计算。

1. **关注和粉丝**：在浏览器里用 [twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) 手动导出 `following.csv`、`followers.csv`。感谢这款开源脚本，它只记录网页原本加载出来的数据。具体怎么滚动页面和转换格式，看 [docs/DATA_EXPORT.md](DATA_EXPORT.md)。
2. **每天的互动**：Grok Bot 用 X 的只读接口抓取原始 JSON，再由 `scripts/daily_collect.py` 整理成 `interactions.csv`。接口、额度和目录说明看 [docs/DAILY_COLLECT.md](DAILY_COLLECT.md)。
3. **计算**：用 `audit.py --data-root` 合并多天的 `interactions.csv`；`--lists` 只读那两张关系表，用来判断谁互关了、谁是沉睡互关。

如果没有 Grok Bot，也可以用同一个插件把互动导出成 CSV 代替。不过插件只能记录你自己亲自滚屏浏览过的内容，通常只能拿到单向数据。只导出「用户推文」时，拿到的是你自己发出的那一半；要补别人回你的，再导出一份搜索 `to:你的用户名` 的结果。两边都可能因为没滚到底或被限流而缺记录。少了一个方向的数据，互动条数、总分和分层结果都会偏低。

### 合理使用

- **只读原则。** 不自动点赞，不自动关注或取关，不自动发帖，不发私信。看板里的「建议动作」只是参考提示，工具不会替你做任何操作。
- **注意接口额度。** Grok Bot 的公开读取额度是：每分钟 30 次、每天 1000 次、单次请求最多 25 条，每天 00:00 UTC 自动重置。平时一轮采集最多发 27 次请求（如果要补采前 48 小时的数据，最多 33 次），硬上限 40 次。要是碰到 HTTP 429 限流，等额度重置后再试 1 次就行；如果遇到 401、403 或者额度用光了，就马上停下。各接口怎么分配页数，看 [额度预算](DAILY_COLLECT.md#6-额度预算)。
- **不要交出登录凭证。** 千万别用要求导出 cookie 或 token 的工具，也不要把 API key 写进代码、提示词或截图里。

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

每次采集完，在本地跑一次 `audit.py`，把带账号名的完整版 `dashboard.html` 输出到仓库外的固定目录。用浏览器打开它、存个书签，以后每天点开书签就能看到最新的分析看板。

```bash
python3 audit.py --data-root ~/x-data/ --lists ~/x-lists/ --me 你的用户名 --tz Asia/Shanghai --out ~/x-data/_看板/ --overwrite --open
```

`--open` 用 Python 自带的浏览器模块打开刚生成的 `dashboard.html`，路径里有中文或空格也能用。也可以自己打开：

```bash
# macOS
open ~/x-data/_看板/dashboard.html
# Windows 命令提示符
start "" "%USERPROFILE%\x-data\_看板\dashboard.html"
# Windows PowerShell
Start-Process "$env:USERPROFILE\x-data\_看板\dashboard.html"
# Linux
xdg-open ~/x-data/_看板/dashboard.html
```

路径里有空格时加上引号。脚本读写文件都显式用 UTF-8。时区优先级是 `--tz`、然后 `config.json` 里的 `timezone`、最后才是这台电脑的本地时区。配置里的时区留空，不再默认洛杉矶。网页版默认用浏览器时区，页面上有「当前时区：…」，也可以改成别的 IANA 名称。生成的两份看板会写明这次用的时区；在页面里改日期时，仍按这个时区重算。Windows 上如果 Python 没有 IANA 时区数据，`--tz` 会报「时区无效，请用 IANA 名称，例如 Asia/Shanghai」，报错里不带路径。`scripts/follow_diff.py` 只对比两份名单，不按天切，所以没有 `--tz`。`scripts/daily_collect.py --tz` 只把时区写进快照，文件夹日期仍用目录名。

带真实账号名的看板、`accounts.csv`、`名单.md` 和未回关名单，全都只留在你自己的电脑上。千万别发到公网或者传上公开网盘。要是想发出来分享，请用打码版的 `dashboard_public.html` 截图。

`--overwrite` 参数只会替换这个目录下本工具生成的文件：`dashboard.html`、`dashboard_public.html`、`accounts.csv`、`名单.md`、`没回关.md` 和 `没回关.csv`。如果目录里有其他不相干的文件，命令会直接报错停下，不会乱删东西。不加 `--overwrite` 的话，发现已经有输出文件就会拒绝覆盖。另外，仓库里面和放原始数据的目录永远不会被写入。

### Python 命令行

```bash
# 1. 下载
git clone https://github.com/ratt1e/Xfan-audit.git fan-audit && cd fan-audit      # 或者下载 zip 解压

# 2. 先用假数据跑一遍（1 秒）。这组人数是 America/Los_Angeles 下的结果
python3 audit.py --data sample_data --tz America/Los_Angeles
#    打开看板：
#      macOS: open output/dashboard.html
#      Windows 命令提示符: start "" "output\dashboard.html"
#      Windows PowerShell: Start-Process "output\dashboard.html"
#      Linux: xdg-open output/dashboard.html
#    也可以在上面的命令末尾加 --open
#    请求 30 天，计分覆盖 28 天，无数据 2 天
#    金牌 3，银牌 2，他常来 2，我常去 1，沉睡 3，样本不足 3，其他有分 4，零互动 2

# 3. 换成你自己的数据：把 CSV 放进 data/，再跑
python3 audit.py
```

命令行要用的 CSV 怎么导出，看 **[docs/DATA_EXPORT.md](DATA_EXPORT.md)**（保姆级教程，插件和 X 官方数据归档两种方式都写了）。最少只要一个 `replies.csv` 就能跑，但推荐把 `following.csv` 和 `followers.csv` 一起放进去。

输出文件在 `output/` 目录下：

| 文件 | 内容 |
|---|---|
| `dashboard.html` | 看板：跟网页版一样可以自由选日期，刚打开会显示这次计算的完整时间段。每个分层都有能点击的数字卡片，点一下展开名单。用户名直接连到主页。**带真实账号名，留着自己看** |
| `dashboard_public.html` | 同款看板的打码版。选日期功能完全可用，里面全是「账号#01」这样的代号，去掉了主页链接，可以放心截图对外分享 |
| `accounts.csv` | 每个账号一行：记着分层、星级、总分和各项打分明细 |
| `没回关.md`、`没回关.csv` | 我关注了但没回关我的名单。带主页链接，**留着自己看**。打码版看板里这一块不会放链接 |

多天合并、`--data-root` 和 `--overwrite` 等进阶参数怎么用，看 [docs/TOOLS.md](TOOLS.md)。

想对比上一份关注粉丝名单、看看谁取关了谁新关注了，也可以看 [docs/TOOLS.md](TOOLS.md)，里面还附带了未回关名单的说明。

## 星级规则详解

只看选定时间段（默认最近 30 天）里**你和每个账号之间**的双向公开回复。要是选的时间里有些日子既没互动、也没点赞首次观察记录，就会当成「无数据」，不算进持续性得分的分母。拿 `sample_data` 来说，查 30 天其实有效覆盖 28 天。每个人按 0 到 100 分打分：

| 评估维度 | 权重占比 | 通俗解读 |
|---|---|---|
| 持续性 | 40% | 是不是好几天都有来往，而不是集中在某一天突击猛聊 |
| 双向性 | 35% | 你回他和对方回你，次数是不是差不多对等 |
| 往返轮数 | 25% | 有没有真正接上话：你回了他之后，他又顺着这条接着回你（严格按 `in_reply_to_status_id` 判定） |
| 点赞加分 | 最多 +5 分 | 只是辅助参考，光靠点赞可升不到高星 |

- **过滤问候和水评**：「早安」「互关」「来咯」这类简短问候（词表在 `config.json` 里）不算进双向性和往返轮数；如果一个人 80% 以上的互动都是问候，最高只能拿 2 星。
- **样本太少不硬打星**：互动少于 3 条，或者所有互动都挤在同一天，会直接标「样本不足」，免得给人家误打低分。
- 分数换算星级：≥80 ★5，≥60 ★4，≥40 ★3，≥20 ★2，剩下的是 ★1。

**金牌用户** = 总分 ≥55（差不多到 4 星）＋ 确认往返 ≥3 轮 ＋ 双方各自实质回复 ≥3 条 ＋ 问候占比不到一半 ＋ 至少 2 天有实质互动，而且对方至少回过 1 条。
**银牌** = 够不上金牌但有分，对方至少回过 1 条且确认往返至少 1 次；并且得分 ≥40 或者确认往返 ≥2 轮。要是对方从来没回过、或者确认往返是 0，都不会算进银牌。
**单向** = 一方互动达到 3 条以上，另一方几乎不回。如果我发了 ≥3 条而对方回了 0 条，不管总分有没有到银牌线，都优先算成「单向·我常去他没回」。如果对方回过只是没对上回复链、确认往返是 0，不算「他没回」。**沉睡互关** = 互相关注了，但在这段时间里没有任何回复，也没互相点赞。

列表排序时，互关、蓝V（算进 X 创作者收益的认证曝光）和粉丝多的人会稍微往前排一点，但这只影响展示顺序，不改变打分和星级。

上面的数值都是**待验证的初始参数**，想改随时可以在 [`config.json`](../config.json) 里调，改完重新跑一遍就生效。完整的计算公式看 [docs/SPEC_relationship_stars.md](SPEC_relationship_stars.md)。粉丝数和收益门槛的区别，可以看 [docs/TOOLS.md](TOOLS.md)。

> 分数只是数据线索，不代表真实的人际关系，更不代表对方好不好。没有公开互动，不等于对方没看你的推文。看板里的「建议动作」只是参考提示，工具不会替你做任何操作。

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

名单核对、数据转换和单独算星级的命令，都在 [docs/TOOLS.md](TOOLS.md)。

## 隐私与安全

- **只读原则。** 不要写脚本去搞自动关注、批量取关或者任何自动化操作，这违反 X 的规则，很容易被限流甚至封号。想清理关注的话，建议自己手动、分批慢慢来。
- **真实数据别进仓库。** `.gitignore` 已经默认排除了 `data/`、`output/`、`private/`、各种导出文件、xlsx 表格和生成的看板 HTML。
- **别交出敏感凭据。** 不要用要求导出 cookie 或 token 的工具，本项目本身也不需要任何 API key。
- **尊重别人隐私。** 发到公开场合请用打码版 `dashboard_public.html`，不要公开点名或者给别人扣「僵尸粉」的帽子。

## 目录

```
web/index.html            拖入 JSON 或 CSV 的网页（不联网）
.github/workflows/pages.yml  从 /web 发布到 GitHub Pages（手动运行）
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
