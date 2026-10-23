# fan-audit：X 粉丝体检 · 互动关系星级

> 👋 作者正在 X 上连载这个项目的迭代过程，跑不通或有更好的打分建议，欢迎来 X [@ranger_escape](https://x.com/ranger_escape) 找我聊！

**试用版 v0.1 · 权重待验证**

看看谁在跟你认真聊天（金牌用户），
谁互关了却很久没说过话（沉睡互关），
谁是你一直在回、对方却基本没回过的（单向）。

所有数据只在你自己的浏览器或电脑里处理，不会上传。工具全程只读，不会替你点赞、关注、取关，也不会替你发帖。

## 最简单：油猴版（3 步）

不用导出 JSON，也不用 Grok Bot。装上脚本，打开 X，自己往下翻几屏，点页面右下角的「粉丝体检」。分层和网页版是同一套。

这次试用按 Tampermonkey + Chrome 来写。需要 Tampermonkey 5.3 及以上。开关名称按 [Tampermonkey 中文 FAQ Q209「执行用户脚本的权限」](https://www.tampermonkey.net/faq.php?locale=zh&q=Q209) 核对过：Chrome 138+ 是「允许用户脚本」，更早的 Chrome 是「开发者模式」。

### 第 1 步：安装 Tampermonkey

安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/)。

### 第 2 步：打开「允许用户脚本」

`chrome://` 开头的地址没法做成可点击的链接，请自己贴到地址栏。

**Chrome 138 及以上**

1. 地址栏打开 `chrome://extensions`。
2. 找到 Tampermonkey，点卡片上的「详细信息」。这一页和 FAQ 里写的「右键点击 Tampermonkey 图标，选择『管理扩展程序』」是同一页。
3. 打开「允许用户脚本」。FAQ 的原文是：找到并启用「允许用户脚本」切换开关。

FAQ 也写了，打开浏览器右上角的「开发者模式」同样能让脚本运行。138 及以上建议只用「允许用户脚本」，不必把整个浏览器的开发者模式打开。

**更早的 Chrome**

没有「允许用户脚本」这一项。地址栏打开 `chrome://extensions`，点右上角的开关，启用「开发者模式」。FAQ 的原文是：点击右上角的切换开关启用开发者模式。

装完脚本却完全没反应时，先回来检查这一步。

> 截图占位：`docs/img/userscript-allow.png` 还没放进仓库。要拍的内容和另外一张面板图，写在下面「请补的截图」里。这次没有附截图。

### 第 3 步：点这个链接安装

用浏览器打开：

https://raw.githubusercontent.com/ratt1e/Xfan-audit/main/userscript/fan-audit.user.js

Tampermonkey 会弹出安装页，点安装。以后脚本更新也走这个链接（文件头里的更新地址指向仓库 `main` 分支上的这份文件）。

然后打开 x.com 并登录。右下角出现「粉丝体检」。刚装好是空的，按下面的清单自己往下翻。脚本不自己发请求，也不自动滚动。

### 采集清单

面板里每一项都是普通链接，在当前页打开，标 ✓ 或「未采集」，并带上条数或天数。请依次打开，手动往下翻几屏：

1. **别人回我。** 搜索 `to:你的用户名`，选「最新」。翻到的回复算别人回你。
2. **关注。** 打开自己的关注列表。
3. **粉丝。** 打开自己的粉丝列表。
4. **认证粉丝。** 打开自己的认证粉丝列表。只翻了这一页时，普通粉丝还没记全，没回关会偏多。
5. **主页回复。** 打开自己主页的「回复」页，记下你发出的回复。
6. **通知。** 打开通知的「全部」和「提及」。清单上的按钮指向 `https://x.com/notifications/mentions`。这里只收别人回复你的帖子，和上面的搜索按帖子编号去重。赞、关注、转发那些汇总不记。打开过、但没有回复你的帖子时，写成「已打开，回复 0 条」。

别人回我是搜索页，别一次翻太久。X 会限流，被限了就停下来等一等再翻。脚本不会替你滚动，也不会自己发请求。

### 互动要够才分层

只滑了关注和粉丝、还没采到回复时，互关不会被记成沉睡互关、零互动或单向。互动天数只从回复来，名单快照不算。

分层要等两边都有数据：至少 1 天你发出的回复，并且至少 1 天别人回复你，两边合计不少于 2 个不同日期。没到这个门槛时，面板只保留互关和没回关这些名单统计。网页拖拽版只放下名单、没有回复文件时，用的是同一条规则。

### 全屏、打码、备份

- 点「全屏」把面板铺满窗口，再点「退出全屏」或按 Esc 收回。
- 截图前点「一键打码」。账号名会换成「账号#01」，主页链接也会去掉。这个开关会记住。
- 「导出 JSON 备份」和「导入 JSON 备份」只含打分用的短字段，没有 cookie。换电脑时用这两项。默认保留 90 天，要重计可以先「全部删除」，再重新往下翻。
- 「下载看板 HTML」若被 X 页面拦住，先用 JSON 备份。这一步还要在你自己的浏览器里看一次（待核实）。

### 只读、隐私、平台规则

脚本只读你正在浏览时，页面自己已经收到的内容。它不另外向 X 发请求，不自动滚动，不点赞、不关注、不取关、不发帖，也不读 cookie 或 token。数据留在脚本管理器里。

X 的服务条款禁止未经授权的自动化抓取。所以这里没有自动翻页，也没有批量操作。只被动记下你翻过的内容，记不全是正常的，尤其是「别人回我」。这不能保证账号不受平台规则影响。

### 面板是 0？

展开「诊断信息」，点「复制诊断」，把整段文字发到 [Issues](https://github.com/ratt1e/Xfan-audit/issues)。里面只有接口名和次数，没有账号名。

复制出来的诊断里 GraphQL 一直是 0 时，多半是钩子没进页面环境，或第 2 步的开关没开。这时你自己的关注页、粉丝页上已经显示出来的账号仍可能记下，帖子和回复还是要等钩子接住响应。

### 请补的截图

下面两张图都还没放进仓库。请按文件名保存，不要改名，也不要用别的图顶上。仓库里现有的 `docs/img/dashboard.png` 是网页版假数据看板，不能代替这两张。

1. `docs/img/userscript-allow.png`
   - 画面：Chrome 扩展程序详情页里，Tampermonkey 的「允许用户脚本」开关处于打开。
   - 路径：地址栏 `chrome://extensions` → Tampermonkey「详细信息」。FAQ 里的右键图标 →「管理扩展程序」是同一页。
   - 只留这一张卡片和这个开关。不要拍到其他扩展、谷歌账号或邮箱。
2. `docs/img/userscript-panel-masked.png`
   - 画面：已登录的 x.com 上，点右下角「粉丝体检」，再点「全屏」。先打开「一键打码」，账号名变成「账号#01」之后再截。
   - 画面里要能看见采集清单：别人回我、关注、粉丝、认证粉丝、主页回复、通知，以及分层卡片。
   - 不要地址栏，不要左侧真实用户名，不要通知原文。打码关着的时候不要截。

源码在 `userscript/`。安装用的单文件是构建结果 `userscript/fan-audit.user.js`，打分引擎在构建时从 `web/index.html` 抽出，公式只维护一份。

## 也可以：网页拖拽

适合已经会用导出插件、想一次丢进三份 JSON 的情况。大概 5 分钟。在线页面：[网页版](https://ratt1e.github.io/Xfan-audit/)。

![看板示例（假数据生成，已打码）](docs/img/dashboard.png)

1. **导出数据。** 电脑浏览器装 [twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter)，打开 X，导出「用户推文」「正在关注」「关注者」三份 JSON。具体怎么滚动页面，看 [数据导出教程](docs/DATA_EXPORT.md)。
2. **打开网页。** 点开 [网页版](https://ratt1e.github.io/Xfan-audit/)。不想联网的话，下载本仓库，双击 `web/index.html` 离线用。
3. **拖进去。** 把三份 JSON 一起拖进页面，不用改文件名，结果马上出来。

只导出「用户推文」时，里面主要是你自己发出的回复，对方回你的那一半不在这份文件里，金银牌和往返会偏少。可以再在 X 搜索 `to:你的用户名`，用插件导出搜索结果，补上别人回你的部分。搜索要自己往下滚，也受平台限流，仍然可能不全。想要两边都齐、而且每天自动更新，用下面的 Grok Bot 模板。

日期按你浏览器自己的时区切。页面上会写「当前时区：…」，也可以改成别的 IANA 时区，例如 `Asia/Shanghai`。

要是想截图分享，点一下页面上的「打码模式」，账号名就会自动换成「账号#01」这类代号。

## 也可以：Grok Bot 模板

适合想长期看互动变化、每晚自动更新的情况。

1. **导入机器人。** 在 Grok Bot 里导入[「粉丝体检」机器人模板](https://x.ai/bot/AYInVUfN_IOql2b7QpzDB)。
2. **回答几个问题。** 它会问你的 X 用户名、结果放哪里、每晚几点采集。
3. **每周导一次关注名单。** 互动数据它每晚会自动采集。关注关系还要用上面的插件导一下，每周发给它一次。

平时想看结果随时跟它说一声，它就会用最新数据给你出一份看板。看板页面仍是 [网页版](https://ratt1e.github.io/Xfan-audit/)。

## 星级怎么算

只看选定时间段（默认最近 30 天）里你和每个账号之间的公开回复，每人打 0 到 100 分：

| 看什么 | 占比 | 意思 |
|---|---|---|
| 持续性 | 40% | 是不是好几天都有来往，而不是某一天聊了一大串 |
| 双向性 | 35% | 你回他和他回你，次数差不多 |
| 往返轮数 | 25% | 你回了他，他又接着回你，真的聊起来了 |
| 点赞 | 最多加 5 分 | 只是参考，光点赞升不了高星 |

平时打招呼的「早安」「互关」这类客套话不算数；互动太少的人会标「样本不足」，不硬打分。金牌、银牌、单向的具体门槛，看 [规则详解](docs/ADVANCED.md#星级规则详解)。

> 分数只是一份数据参考，不代表真实关系，更不代表对方好不好。没有公开互动，也不等于对方没看你的推文。

## 隐私

- 千万不要用要求导出 cookie 或 token 的工具，这个项目也不需要任何 API key。
- 带真实账号名的看板只留在你自己的电脑里。要是想发出来分享，记得用打码版。
- 不要写脚本去搞自动关注或批量取关，这违反 X 的规则，很容易被限流甚至封号。

## 更多

命令行怎么用、每日自动采集怎么配、生成了哪些文件、Roadmap 和目录结构，都在 [进阶用法](docs/ADVANCED.md)。每晚刷新可以加上 `--auto-prev`，自动对比上一份关注和粉丝导出。私人看板有「打码模式」，只改这一页的显示，文件里仍有真实账号名；要外发请用 `dashboard_public.html`。详见 [每天看看板](docs/ADVANCED.md#每天看看板)。

## English (brief)

**fan-audit** scores two-way public conversations on X (Twitter). The easiest try is the Tampermonkey script: install Tampermonkey 5.3+, turn on Chrome’s “Allow User Scripts” (Chrome 138+: `chrome://extensions` → Tampermonkey details; earlier Chrome: Developer Mode; see [Tampermonkey FAQ Q209](https://www.tampermonkey.net/faq.php?locale=en&q=Q209)), then open `https://raw.githubusercontent.com/ratt1e/Xfan-audit/main/userscript/fan-audit.user.js`. On x.com, scroll your following, followers, replies, a `to:username` search, and notifications. The script only reads responses the page already loaded, keeps replies to you, skips like, follow, and repost bundles, stores short fields for 90 days, and does not send its own requests or scroll. Mask names before a screenshot. X's terms prohibit unauthorized automated scraping, so none is included, and this does not promise the account will be unaffected. Alternatives: drag a twitter-web-exporter JSON export into the [web version](https://ratt1e.github.io/Xfan-audit/) (or `web/index.html` offline), or import the [Grok Bot template](https://x.ai/bot/AYInVUfN_IOql2b7QpzDB) for a nightly read-only collect. A 「用户推文」 export is only the posts you sent; gold, silver, and round-trip scores stay low until replies to you are included. The page calculates stars in your browser timezone and does not upload anything. Share `dashboard_public.html` when a file still contains real names. The Python command line remains for daily files: `python3 audit.py --data sample_data --tz America/Los_Angeles`. `--tz` overrides `config.json`, which overrides the computer's local timezone. Standard library only, Python 3.9+. Weights are initial values, not yet validated. No automatic likes, follows, or posts. MIT License.

---

👋 作者正在 X 上连载这个项目的迭代过程，跑不通或有更好的打分建议，欢迎来 X [@ranger_escape](https://x.com/ranger_escape) 找我聊！
