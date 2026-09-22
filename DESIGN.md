# medbox 手机 App · 设计共识与实施交接

> **这份文档是什么**：2026-09-16 一轮完整需求拷问的结论。它把两份上游需求文档**收敛成可执行的决策**。
>
> | 上游文档 | 作用 |
> |---|---|
> | [`../medbox-app/docs/requirements.md`](../medbox-app/docs/requirements.md) | **产品需求**，平台无关。领域规则、数据模型、交互决策的权威来源 |
> | [`../medbox-app/docs/app-migration.md`](../medbox-app/docs/app-migration.md) | 网页版 → App 的差异清单、数据迁移路径、6 个坑 |
>
> ⚠️ **冲突时以本文档为准**。上游文档是在「网页版 + 宽屏 + 手动打开」的前提下写的；本文档记录了看过实际代码与数据后**刻意改掉**的地方，理由见 [§5](#5-刻意偏离上游需求文档之处)。不要以为上游文档就是最终答案。

---

## 0. 怎么用这份文档

- **新会话开始时**：先读本文档，再读 `../medbox-app/docs/requirements.md`（领域规则的权威来源）。
- **不要读**：`../medbox-app/app/routes/`、`templates/`、`static/` —— 那是要被丢弃的网页界面层。**但要看**其中一个：见 §7.2 关于「UI 行为契约只存在于模板里」的警告。
- **动手前先看** [§7 实现规格](#7-实现规格实测得来的硬事实) 和 [§6 风险清单](#6-风险清单按爆炸半径排序)。

---

## 1. 可行性结论

**可行。** 这个项目砍掉了「网页转 App」真正烧钱的所有部分：没有账号、没有服务器、没有云同步、没有多人协作、没有后台任务。剩下的是体力活，不是风险。

**但有一句预期需要纠正**：`app-migration.md` 读起来像「领域逻辑直接搬、只是换个界面」。核对代码后实际是：

```
medbox-app/app/ 共 3432 行

可留用           354 行   services/（其中真正纯的约 80 行）    ~10%
整体重写        2649 行   routes/ + templates/ + static/       ~77%
重写             429 行   config/db/deps/migrate/models 等      ~13%
medbox-app/tests/ 745 行
```

**实际要重写约 85%。** 真正可原样移植的只有一个 **5 个函数的小内核**：

| 可原样搬的纯函数 | 位置 |
|---|---|
| `effective_expiry(batch) -> date \| None` | `app/services/expiry.py:24` |
| `classify(batch, today, near_days) -> str` | `app/services/expiry.py:34` |
| `days_of_supply(total_qty, daily_dose) -> float \| None` | `app/services/forecast.py:19` |
| `needs_restock(dos, restock_days) -> bool` | `app/services/forecast.py:26` |
| `pending_deduction(days, daily_dose, accounted) -> int` | `app/services/autodose.py:37` |

其余（`dashboard_stats`、`in_stock_rows`、`settle_medicine`、`settle_all`、`rebaseline`、`after_take`）都是 ORM/Session 形状的——**规则能搬，代码不能搬**。

**数据侧的好消息**：整份真实数据只有一个 **72KB** 的文件，小到可以当附件发。

---

## 2. 技术路线（一句话）

> 在 `D:\Documents\medbox\medbox-mobile`（本目录）新建一个独立项目，用 **Expo (React Native) + TypeScript + expo-sqlite + Drizzle ORM** 写一个**数据只在手机本地**的安卓 App，在 Windows 本机编译出 apk 装到小米8 上；用**系统文件选择器**导入网页版导出的 `all.json`，一次性冷切换；推送用**本地通知**（纯离线，不需要服务器）；代码一套保留，将来加 iOS 只是多一个构建目标。

**选 Expo 的决定性理由**（不是「RN 更流行」）：需求是「先安卓、iOS 留门」，而将来那一步 iOS **只有 Expo 能从 Windows 出包**（EAS Build 云构建 + 2026 年的 EAS 云 iOS 模拟器）；Flutter 到时候必须买一台 Mac。

**实测确认的一条红利**：Expo SDK 53 只是把**远程推送**从 Expo Go 的 Android 端移除，**本地通知仍可用**。这个产品需要的全是本地调度通知——不需要服务器、不需要 APNs。

---

## 3. 已锁定的全部决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | **数据放哪** | **手机本地**，各记各的。离线可用是硬要求（出门在外查药是最高频场景，网页版在此直接失效） |
| 2 | **设备数** | **一台**（家庭里固定一个人买药）。**不预留任何同步字段**——`StockEvent` 只增不改不删，给它加 `updated_at` 是概念错误 |
| 3 | **平台顺序** | **先安卓**（本机编译、免开发者账号、免审核、1 分钟一版），iOS 留门（将来 EAS 云构建 + $99/年） |
| 4 | **技术栈** | Expo (RN) + TypeScript + `expo-sqlite` + **Drizzle ORM**（用它自带的 schema 迁移生成，治「用户手机上已装着 App、我要加字段」） |
| 5 | **备份纪律** | **显式关闭 WAL**（否则多出 `-wal`/`-shm`，破坏「备份 = 一个文件」）。导出 JSON **严格保持 `version: 1` 格式**——那是永久退路 |
| 6 | **迁移方式** | **一次性冷切换**。`../medbox-app` **不改已有代码**（新增只限于运行/启动类脚本、配置文件或文档，如 `start.sh`、`.gitattributes`），两个独立项目。导入可重入（清空后全量写入，**不做增量合并**——批次没有天然业务键） |
| 7 | **结算时机** | 冷启动 / 每次回前台 / **任何读库存的界面渲染之前**，三条都做（结算幂等，多跑无害） |
| 8 | **6 个自动扣减药** | 导入时 `auto_from` = 导入当天、`auto_accounted` = 0；**保持开着**，但在导入结果页显式列出「已重新起算」 |
| 9 | **推送节奏** | 事件驱动、**有事才排**、早 9:00 汇总一条、每事件只推一次、锁屏**不显示药名** |
| 10 | **推送触发** | 只取：今天到期 / 已过期 / 需补货 / 已用完。**不推「快进入快过期窗口」** |
| 11 | **测试** | **把上游的规则逐条翻译成 App 侧测试**（约 45 条）。唯一不该省的工程投入 |
| 12 | **导出** | 全量 JSON + 一个「在库清单」可读分享（系统分享面板，PDF/纯文本）。**砍掉三个 Excel** |
| 13 | **首页** | 搜索框置顶 → 在库药品列表 → 统计压缩成一行小数字 → 需补货 → 按成员 |
| 14 | **导航** | 底部 4 tab：**首页 / 药品 / 成员 / 设置**。「家庭共用」是成员页里的并列入口 |
| 15 | **首次启动** | 给「导入网页版数据 / 从零开始」两个选择 |
| 16 | **导入入口** | 系统文件选择器选 JSON（不搭内置 HTTP 上传） |
| 17 | **视觉** | 延续**暖居风格 + 无障碍对比度**（见 `medbox-app` 的 commit `aab6f92`），但移动端布局**重新设计** |
| 18 | **命名** | 路径 `D:\Documents\medbox\medbox-mobile`，包名 `com.medbox.family`，桌面名「**家庭药箱**」，图标用 AI 生成（**药箱**样式，待做） |

---

## 4. 环境与设备事实

| 项 | 值 |
|---|---|
| 开发机 | Windows 11 Pro（26200），bash |
| 目标设备 | **小米8（codename `dipper`）**，骁龙845，**6GB RAM**，**arm64**，**Android 8.1（API 27）** |
| 设备系统现状 | **MIUI 10.0.11.0（`V10.0.11.0.OEACNFH`，stable，基于 Android 8.1 / `OPM1.171019.026`）**。⚠️ 2026-09-20 实机读出来的是 V10，与原先记录的「出厂 9.5.6、从未升级」**不符** —— 这台机器升过级。官方最后能到 Android 10 / MIUI 12.5.2 |
| 是否升级系统 | **不建议为了这个 App 去升级**。MIUI 12 的自启动管控反而更严，且跨版本升级本身有风险。停在 8.1 完全能用 |
| 网页版数据 | `../medbox-app/data/medbox.db`（73728 字节） |
| 迁移源文件 | **`D:\Downloads\all.json`**（33848 字节，`version: 1`，导出于 `2026-09-16T13:23:58`） |
| 源文件指纹 | **MD5 `c4e150cb9c796b3581f615dff9441827`** —— 与 `test/fixtures/all.json`、手机上的 `/sdcard/all.json`、`/sdcard/Download/all.json` 四处一致 |
| **装机状态** | 🟢 **已装机、已导入、数量已核**（2026-09-21 09:53:38 装 v0.1.0，10:04:50 导入）。详见 §9 第 6 / 9 项 |

**2026-09-21 实机读出来的（写代码前该知道的）**：

| 属性 | 值 | 后果 |
|---|---|---|
| `ro.debuggable` / `ro.secure` / `ro.build.type` | **0 / 1 / user** | `run-as`、`adb root` 全不可用，**读不到 `/data/data/com.medbox.family/`** |
| `persist.sys.timezone` | **`Asia/Shanghai`** | 与开发机同区，「今天」两边一致 —— 但这是环境巧合，不是保证 |
| `bmgr enabled` | **disabled** | ⚠️ 但 `adb backup` **照样能用**（实测拿到 76312 字节的包）。别因为这句话放弃这条路 |
| `ro.product.model` | MI 8 | 与上面一致 |

**「拿到手机上那份原始数据」的办法是 `adb backup`**（user 版 + `ro.debuggable=0` 断了其它所有路）。
完整命令、三个必踩的坑（要后台起 / 屏幕上遗留的旧对话框会让按钮变灰 / **退出码 0 但产物 0 字节**）、
以及解包方法见 `AGENTS.md`「怎么读手机上的库」。🔴 **永远不要 `adb restore`。**

> ⚠️ **2026-09-22 订正：上句原先写的是「唯一办法」，条件是「M6 的导出功能还没做」。那个条件没有了。**
> 现在 App 能自己导出 `all.json`（§7.6）⇒ 日常备份不用插线。
> **但 `adb backup` 仍然是「读原始库」的唯一办法** —— 它读的是 `medbox.db` 本身，
> 而导出功能读的也是这个库：**导出报表上的数不对时，必须有个不经过导出功能自己的办法去核**，
> 那就是它。另外它**拿不到 App 的缓存目录**（导出文件写在 `Paths.cache`），这一点 §8.8 记着。

### 4.1 Android 8.1 的判定

| 项 | 数值 |
|---|---|
| 设备 | Android 8.1 = **API 27** |
| Expo SDK 54–57 官方支持 | **Android 7+** |
| React Native 0.76+ 的 `minSdkVersion` | **API 24**（Android 7.0） |
| 结论 | **API 27 > 24 → 支持，能装能跑** |

**8.1 在两个地方比新系统更省事**（意外红利）：
- **不需要 `POST_NOTIFICATIONS` 运行时权限**（Android 13+ 才要）→ 没有「弹窗求授权 → 用户拒绝 → 功能全废」这条最烦的路径。
- **不需要 `SCHEDULE_EXACT_ALARM`**（Android 12+ 才要）→ 定时通知直接就能精确排。

---

## 5. 刻意偏离上游需求文档之处

**这些不是遗漏，是看过文档与实测数据后刻意改的。**

### 5.1 §3.8 首页顺序重排 + 新增搜索框

上游要求「四张统计卡 + 按成员 + 需补货 + 在库列表」全部首屏不折叠。**在手机上这个顺序会让最高频的问题排到最后**——场景 1（每天要吃药时问「这药还有吗」）的答案在**在库列表**里，而它排在统计卡、成员 chips、补货列表**之后**。

**改为**：搜索框置顶 → 在库列表 → 统计压缩成一行小数字 → 需补货 → 按成员。

这不是违背 §3.8，而是在小屏上更忠实地执行它「一眼看到结果」的**意图**（手机上「一眼」= 首屏那 600 像素）。**搜索框是新增需求**（网页版只在药品列表页有搜索）。

### 5.2 §3.2 推送改为「有事才排、当天汇总一条」

上游建议「每批到期推一次 + 补货每种药每 7 天最多一次」，**但它自己又担心 iOS 约 64 条的待处理通知上限**——按批次排会迅速烧光槽位（44 条批次很快就满），于是不得不引入「只排最近 N 条 + 复杂重排」的机制。

**改为**：只为**真的有事的日期**排通知，每个这样的日期最多一条（早 9:00，可设置）。这样「不想每天被推」自动成立，**64 条上限问题也自然消解**。

触发事件只取：今天到期 / 已过期 / 需补货 / 已用完。**不推「首次进入快过期窗口」**——那是不紧急的噪音，会让人关掉通知权限，连带把重要的也关掉。

### 5.3 §3.4 砍掉三个 Excel

上游导出三个 `.xlsx`（在库清单 / 全量记录 / 变动记录）。手机上生成 xlsx 要引重型依赖，产出的还是一个在小屏上打不开的文件。

**改为**：只保留**全量 JSON** + 一个「在库清单」的可读分享（系统分享面板发 PDF 或纯文本）。

§3.4 的原文要求是「适合**打印或发给别人**的形态」——它要的是**结果**，不是 Excel 这个**格式**。

#### ✅ 2026-09-21 定稿（M6 做完，两个选择都拍板了）

| 出口 | 形态 | 怎么到用户手里 |
|---|---|---|
| 完整备份 | **`all.json`**，严格 `version: 1`（与网页版逐字段相同） | App 私有缓存 → **安卓系统分享面板**（`expo-sharing`） |
| 在库清单 | **纯文本 `.txt`**，UTF-8 无 BOM | **同一条分享面板** |

**为什么是纯文本，不是 PDF**：`requirements.md:358` 把格式明确降级为**实现选择**
（「Excel / CSV / PDF / 分享面板」都不是需求）。纯文本在微信里能直接打开、能复制、能打印，
而且**不需要第二个原生依赖**（PDF 要 `expo-print`）。少一个原生依赖 = 少一次出包风险，
而这次出包已经证明了原生依赖确实要整跑一遍 prebuild（§8.2）。

**为什么是分享面板，不是存到「下载」目录**：Android 10+ 的分区存储下，
写公共目录要走 SAF（`MediaStore`/`ACTION_CREATE_DOCUMENT`），而 `WRITE_EXTERNAL_STORAGE`
在新系统上已被 `maxSdkVersion=32` 挡死。分享面板把「存哪里/发给谁」交给用户和系统去决定，
我们不碰那条最容易踩空的权限路。规格见 §7.6。

### 5.4 §4.2 不理「事后加同步字段会非常痛」这个警告

上游警告多设备方案要在模型里预留 `updated_at` / 设备标识 / 软删除，「事后加会非常痛」。**这个判断要打折**：加列不痛，痛的是**冲突合并逻辑**——而那是同步方案自身带来的成本，不是字段带来的。而且 `StockEvent` 是**只增不改不删**的（不变量 8），给它加 `updated_at` 在概念上就是错的。

**结论：什么都不预留。** 真要同步时它属于新增需求（`requirements.md` §5 明确不做），会连模型带迁移重做一遍，预留的字段救不了任何东西。

### 5.5「59 项测试可以一起搬」要打折

| 测试文件 | 行数 | 条数 | 可搬性 |
|---|---|---|---|
| `tests/test_expiry.py` | 69 | 11 | ✅ **纯净，可原样翻译** |
| `tests/test_forecast.py` | 87 | 5 | ⚠️ 2 条纯函数可搬 + 1 条 `dashboard_stats` 集成测试要重写 |
| `tests/test_autodose.py` | 409 | 34 | ⚠️ **规则是金子、测试代码要重写**（挂在 SQLAlchemy session fixture 上） |
| `tests/test_migrate.py` | 180 | 9 | ❌ 网页版专用（`PRAGMA table_info` + `ALTER TABLE`），**直接作废** |

**决定：把规则逐条翻译成 App 侧的 TypeScript 测试**（约 45 条）。理由见 §6.3。

> **落地情况**（本节只是当初的搬迁计划，别当进度看）：
> 上表 16 条（expiry 11 + forecast 5）**2026-09-17 全部落地**，见 §8.5；
> autodose 34 条见 `test/autodose.test.ts`。实际总数 **245 条**（含导入、验收数字、
> 设置、药品档案、暂停/恢复、以及上游没有对应物的落库层测试），以 `npx jest` 的输出为准 ——
> **这里和 AGENTS.md 里的条数都可能过期，跑一遍才知道。**

### 5.6 上游没料到的一条红利

`app-migration.md` §3.2 担心 iOS 通知数量上限、担心推送需要授权。实际上**本地通知在 Expo Go 里就是可用的**（Expo 官方文档：「Local notifications (in-app notifications) remain available in Expo Go」），SDK 53 只移除了**远程推送**的 Android 端支持。这个产品需要的全是本地调度通知。

---

## 6. 风险清单（按爆炸半径排序）

### 6.1 🔴 导入时照搬 `auto_from` 会把库存一次扣爆（坑 1）

**实测数据（2026-09-16）**：库里有 **6 个药开着自动扣减**，全部是外公的三高药：

| 药品 | 剩余 | 每日用量 | 约可用 | 涉及批次 |
|---|---|---|---|---|
| 缬沙坦胶囊 | 34 片 | 1.0 | 34 天 | #2 (qty 4, 效期 2026-12-31)、#14 (qty 30, 2027-10-06) |
| 阿托伐他汀钙片 | 6 片 | 1.0 | **6 天** | #3 (qty 6, 2027-10-08) |
| 盐酸二甲双胍缓释片 | 66 片 | 1.0 | 66 天 | #15/#16/#17（效期均空） |
| 阿司匹林肠溶片 | 89 片 | 1.0 | 89 天 | #18（效期空） |
| 苯磺酸氨氯地平片 | 26 片 | 1.0 | 26 天 | #19（效期空） |
| 格列美脲片 | 25 片 | 1.0 | 25 天 | #20（效期空） |

这 6 个药的 `auto_from` 全是 `'2026-09-15'`、`auto_accounted` 全是 `1`。

**爆炸演算**：若在 **2026-12-01** 才导入，`floor(77 天 × 1.0) − 1 = 76` 单位待扣，**每个药都是 76**。而缬沙坦的 batch#2 只有 4 片 → **扣到 0，作废 72**。六个药一起爆。

> **规则：导入时把 `auto_from` 重设为导入当天、`auto_accounted` 归零，`auto_deduct` / `auto_paused` 保持原值。**
> 理由和 3.6 的「起算日不追溯历史」是同一条 —— 换设备不该被当成「这段时间没结算」。

### 6.2 🔴 导出的 JSON 里混了两种时区口径，且没有任何标记（上游文档没有这条）

实测 `all.json`：

```
created_at  : '2026-09-16T05:23:53'            ← UTC    （SQLite func.now()）
updated_at  : '2026-09-16T05:23:53'            ← UTC
exported_at : '2026-09-16T13:23:58.411989'     ← 本地时间（export.py:190 的 datetime.now()）
```

同一个文件里，05:23 那个是 UTC、13:23 那个是本地，**差 8 小时（UTC+8），而文件里没有任何东西告诉你哪个是哪个**。

**危害是不对称的**：
- 导入端若假定「全是 UTC」→ `exported_at` 差 8 小时（无害，它只是元数据）。
- 导入端若假定「全是本地」→ `created_at` 差 8 小时——**而 8 小时正好能把一条事件推过日期边界**，于是时间线上「今天取用的药」显示成昨天或明天。

这正是 `requirements.md` §2.6 说网页版踩过的那个坑，**但导入路径上是一颗全新的雷**。

> **兜底：导入端硬编码规则 —— `created_at` / `updated_at` 按 UTC 解析；`exported_at` 直接丢弃**（App 不需要这个字段）。

**2026-09-21 补（导出端也守同一条）**：M6 的导出端按**原样**重现这两个口径 ——
`created_at` / `updated_at` 写 **UTC naive**（`toNaiveUtcString`），
`exported_at` 写**本地 naive**（`toLocalNaiveString`，为这一个字段新加的函数）。
往 `exported_at` 那个格子里塞 UTC，等于**故意**在导出方向重现同一颗雷 ——
而文件里没有时区标记，读的人分不出来。`src/exporter/build.ts` 全体不许内联手写时间格式化。

### 6.3 🟠 这个项目没有任何路由级测试（上游文档未提，被低估最狠的一块）

UI 的行为契约——「再入库预填上次的数量/备注/位置」、「必填项一次列全」、「效期与拆封信息不预填」、「药 → 逐盒下钻」、「按成员 chip 数字可点」——**只存在于 804 行 Jinja 模板和 574 行手写 CSS 里**，而这两样正是要整个扔掉的。

**所以搬界面的真实工作是「先读懂旧模板在做什么，再在新框架里重新表达一遍」，不是「照着文档写新界面」。**

> **兜底：写界面前先逐个读 `../medbox-app/app/templates/` 下的模板，把行为列成清单。**

### 6.4 🟠 自动扣减账本翻译成 TypeScript 时的语义错误

规则微妙，而且**方向相反**（`requirements.md` §3.6 的表格）：

| 操作 | 对账本的影响 |
|---|---|
| **取用 k 片** | `已核算消耗量 += k`，**起算日不动**（取用是*报告消耗*；重置起算日会让同一片算两次） |
| **编辑数量为 n** | 先按旧数量结清，再以**今天为新起算日**（编辑是*纠正账本*） |
| **入库 / 恢复在库** | 先用手上现有库存结清，再以今天为新起算日 |
| **改每日用量 / 改开关** | 先按**旧参数**结清 → 再赋新值 → 再重设起算日（**顺序反了会拿新用量重算过去 N 天，一次补扣一大笔**） |

> **兜底：§5.5 的测试翻译就是这条的护栏，不要省。**

### 6.5 🟡 SQLite 的 WAL 必须显式关闭

网页版**刻意不开 WAL**（会多出 `-wal`/`-shm` 两个文件，破坏「备份 = 一个文件」这条产品承诺）。expo-sqlite / Drizzle 的默认行为要核对，**必须在 App 上守住同一条纪律**。

### 6.6 🔴 MIUI 会杀定时通知（设备特异性，最大实际风险）

小米是国产 ROM 里后台管控最激进的。**装好后必须手动做四步**（App 里应做一个「通知自检」引导页）：

1. **省电策略**：设置 → 电池与性能 → 应用智能省电 → 家庭药箱 → **无限制**
2. **自启动**：安全中心 → 权限 → **自启动** → 家庭药箱 → 开启
3. **锁定后台**：最近任务界面 → 在家庭药箱卡片上**下拉** → 出现锁头图标
4. **通知优先级**：设置 → 通知与状态栏 → 应用通知 → 家庭药箱 → 设为「**优先**」

> MIUI 各版本菜单名有出入，找不到就用设置里的**搜索框**搜「省电」「自启动」「通知」。
> **这件事没有 100% 的代码解**——唯一的兜底是「通知没按时来就回来做一遍这四步」。App 的其他功能不受影响。

### 6.7 🟠「兼容新版本」是代码便宜、验证昂贵

构建上要打宽（`minSdk 24` / `targetSdk 36` / universal APK，见 §7.4），但：

- **Android 13+ 的 `POST_NOTIFICATIONS` 运行时权限**
- **Android 12+ 的 `SCHEDULE_EXACT_ALARM`**
- **Android 10+ 的分区存储**

这些代码路径**在小米8（8.1）上永远不会被执行到**，因此**无法在目标设备上验证**。

> **兜底：第一版在小米8 上跑通后，找一台新安卓手机实测一次「推送是否按时到达」。** 在那之前，给别人用要提醒对方区分「是这台机器的问题还是 App 的问题」——因为这两者在我这边看起来是一样的。

### 6.8 🟡 日期口径（`requirements.md` §2.6）

**两类值必须分开**：
- **日历日**（`auto_from` / `expiry_date` / `opened_at`）→ 无时区、无时刻的日期，只做日历日加减，按**设备本地时区**解释。JSON 里是 `'2026-09-15'`。
- **时刻**（`created_at` / `updated_at`）→ 具体瞬间，只用来排序和展示，**绝不参与日历日计算**。JSON 里是 UTC naive。

算「起算日距今几天」用**日历日相减**，不要拿时刻相减再除以 86400。

### 6.9 🟢 存量数据的不变量 1 不成立（已知且接受）

实测：**44 条在库批次中，38 条没有变动记录、6 条有**。那 6 条是 2026-09-16 13:23 打开网页版时惰性结算写下的 `auto_take`。

其余 38 条的时间线是空的，直到下一次操作。**这是已知且接受的状态——不要试图补一条假的「入库」记录来伪造对账关系**，那条记录不是真实发生过的操作。

### 6.10 🟢 单位混用（历史上出现过，现在干净）

实测当前 44 条在库批次的单位**无混用**。但历史上真实出现过（创可贴的批次同时有 `ml` 和 `片`）。

**导入时逐条原样导入，不要按单位合并批次**；药品档案的单位以档案为准。结算时如果发现某药在库批次单位不唯一 → **跳过扣减**（`requirements.md` 3.6 已有这条规则）。

---

## 7. 实现规格（实测得来的硬事实）

### 7.1 数据源与实测数据

**源文件：`D:\Downloads\all.json`**（33848 字节，`version: 1`，`exported_at: '2026-09-16T13:23:58.411989'`）

```jsonc
{
  "version": 1,
  "exported_at": "2026-09-16T13:23:58.411989",   // 本地时间 naive
  "settings":     { "near_expiry_days": "90", "restock_days": "15",
                    "migrate_medicine_unit_owner_v1": "1",     // ← 丢弃
                    "migrate_auto_deduct_v1": "1" },           // ← 丢弃
  "members":      [ ... ],   // 3 条
  "medicines":    [ ... ],   // 37 条
  "batches":      [ ... ],   // 44 条，全部 in_stock
  "stock_events": [ ... ]    // 6 条
}
```

**实测统计（2026-09-16）**

| 项 | 值 |
|---|---|
| 药品档案 | **37**（id 1,2,3,5…38，**id 4 缺失**）（上游文档写「38」，是错的） |
| 成员 | **3**：外公（高血压，高血糖，高血脂）、妈妈（无）、孩子（无） |
| 在库批次 | **44**，**全部 `status='in_stock'`** |
| 效期分档（以 2026-09-16 为今天、90 天窗口） | 快过期 **1**（最早提醒日 2026-11-30）/ 已过期 **0** / 正常 30 / **未填效期 13** |
| 变动记录 | **6**（全部是 `auto_take`） |
| 库存合计 | **2118** 单位（⚠️ 原文写 2124，见下方更正） |
| 设置 | 4 条（2 条有效 + 2 条网页版内部迁移标记） |
| 归属分布 | 药品：外公 6 / 妈妈 1 / 孩子 14 / 共用 16；批次：外公 9 / 妈妈 1 / 孩子 14 / 共用 20 |
| 单位混用 | **无** |
| 字段名 | 与 `app-migration.md` §2.1 **完全一致** |

> **更正（实现 M1 时发现）：库存合计是 2118，不是 2124。**
> 原本写的 2124 是**结算前**的数。差的 6 正好是那 6 条 `auto_take`（每条 `delta_qty: -1`）——
> 6 个三高药各扣了 1。看时间戳就清楚了：那 6 条是 `2026-09-16T05:23:53Z`，
> 而 `exported_at` 是 `2026-09-16T13:23:58`（本地时间 = 05:23:53Z + 8 小时 = 13:23:53）
> —— **「导出」这个动作本身触发了惰性结算，5 秒后才写出文件**。
> 所以 App 必须显示 **2118**；显示 2124 才是错的。
> 这条已经用 `test/golden.test.ts` 钉住了，别把正确的代码「修」回去。

**各表字段（实测确认）**

```
members      : created_at, id, name, notes
medicines    : auto_accounted, auto_deduct, auto_from, auto_paused, brand, category,
               created_at, daily_dose, form, generic, id, owner_id, purpose_notes, spec, unit
batches      : created_at, expiry_date, id, location, medicine_id, notes, open_life_days,
               opened_at, owner_id, qty, status, unit, updated_at
stock_events : batch_id, created_at, delta_qty, id, qty_after, reason, type
```

> 注意：`medicines` **没有** `updated_at`；`batches` **有** `updated_at`。

### 7.2 导入规格

**必须处理的坑（按严重程度）**

| | 坑 | 处理 |
|---|---|---|
| 🔴 | 照搬 `auto_from` 扣爆库存 | `auto_from` = 导入当天、`auto_accounted` = 0（详见 §6.1） |
| 🔴 | 时区口径混用 | `created_at`/`updated_at` 按 **UTC** 解析；`exported_at` **丢弃**（详见 §6.2） |
| 🟠 | `settings` 里有网页版内部迁移标记 | **只取 `near_expiry_days` 和 `restock_days`**，丢掉 `migrate_*` 两条。（`app-migration.md` 说「不认识的字段要保留」指的是**模型字段**，这两条是网页版内部状态） |
| 🟡 | 布尔值：JSON 是 `true/false`，库里是 `0/1` | 别当整数解析（`"0"` 和 `false` 的转换很容易写反） |
| 🟡 | id 是自增整数，跨库无意义 | **导入时重建 id** + 建旧 id → 新 id 映射表，用它翻译 `batches.medicine_id`、`batches.owner_id`、`stock_events.batch_id`。比「强行保留原 id 并调整自增起点」稳 |
| 🟢 | 单位可能混用 | 逐条原样导入，**不要按单位合并批次**（当前库已干净，但逻辑要留着） |
| 🟢 | 存量数据无变动记录 | **不要补假记录**（详见 §6.9） |
| 🔴 | **`delta_qty = 0` 的类型白名单写窄了** | **只有 `edit` / `mark_expired` / `restock` 允许为 0**，见下。**2026-09-22 修** |

#### 🔴 `delta_qty = 0` 只允许三种类型（2026-09-22 修，M6 真机验收扫出来）

`requirements.md` §2.3 的原话是「**仅「编辑」类型可以是 0**」。**照它写是错的**，而且错在两个方向：

1. **网页版自己就不遵守它。** `../medbox-app/app/routes/batches.py:307,322` 给「标记过期」「恢复在库」
   记的正是 `delta 0` —— §2.4 里这两件事本来就只改状态、不动数量（App 侧 `planMarkExpired` /
   `planRestock` 也是 `deltaQty: 0`，见 `src/domain/stock.ts:390,426`）。
   ⇒ 照 §2.3 写，**导入端会拒收网页版自己导出的文件**，硬约束 5 的第一向当场破掉。
2. **App 自己会把路堵死。** 用户点一次「标记过期」，账本里就多一条 `delta 0` 的事件；
   而 `StockEvent` **只增不改不删**（硬约束 2），那条事件**永远在** ⇒ 导出端的运行时自检
   （§7.6）**每一次都会失败** ⇒ **「能拿走」这个能力被一次点按永久锁死**。
   这不是「导出的文件有点小瑕疵」，是**永久退路没了**。

**为什么两半各自都有测试却谁都没发现**：`test/stock.test.ts:323,346` 钉住「领域层写 0」，
`test/importer/parse.test.ts` 钉住「解析端不许 0」—— **两个测试互相矛盾，却谁也照不到对方**。
照不到的原因是分工：领域测试只看方案、导入测试只看文件，**没有一个测试把「App 造出来的数据」喂给「App 的导出」**。
M6 的往返测试（`test/exporter/roundtrip.test.ts`）补上了这个位置，真机验收又在真实数据上碰了一次。

现修法：`src/importer/parse.ts` 里 `ZERO_DELTA_TYPES = [edit, mark_expired, restock]`，
其余类型为 0 仍然拒绝（「自动扣减扣 0 片」是坏数据）。
`test/exporter/roundtrip.test.ts` 里有一组「八种界面操作之后自检都不挡路」的测试钉住这件事。

**实现要求**（`app-migration.md` §2.3）

- **先校验再写**：检查 `version == 1`、外键能对上、必填字段非空。任何一条不合法就**整体拒绝**，不要写一半。
- **幂等 / 可重入**：要么全成要么全不成（一个事务）；重复导入同一份文件**不能产生重复数据**（导入到空库，或先清空）。
- **给用户看结果**：导入后显示「37 个药品 / 44 条在库 / 3 个成员」，让用户能对着 `test/golden.test.ts` 核一遍。**并显式列出那 6 个自动扣减药已重新起算**（决策 8）。
- **保留原始文件**：导入前把 JSON 原文件留在用户能看到的位置——它是最后的退路。
- **不要丢字段**：遇到不认识的**模型字段**保留而不是丢弃。

> ⚠️ **预览页 / 结果页上那四个数 + 「库存合计 2118 单位」全部来自 `parseExport`，不读库**
> （`src/importer/apply.ts:150-159`，`outcome.totalQty` 直接抄 `data.stats`）。
> 它证明的是「**这个文件能解析**」，**证明不了「库里是 2118」**。两者要分开看 ——
> **库侧读数只有一处：设置页「库里现在有什么」**（`app/(tabs)/settings.tsx`，四个数取自
> `db.select().from(schema.*).all().length`，是整表行数回读）。
> 2026-09-21 的装机验收是**绕过界面**做的：`adb backup` 把库拉下来直接查 SQL（见 §4）。

### 7.3 结算触发（App 上「什么算打开」）

网页版用 FastAPI 的**路由级依赖**精确解决了这件事——`app/main.py:27-39` 把 `settle_auto_deduct` 挂在 **6 个页面 router** 上（members 含 shared_router、medicines、batches、dashboard、settings），**故意不挂**在 `export.router` 上（下载文件不该悄悄改数据）。

App 没有这个统一入口，因此：

> **冷启动 + 每次从后台回到前台 + 每个读取库存的界面渲染之前，都跑一次结算。**

结算本身**幂等**（同一天多次跑结果一样），所以多跑无害。

> ⚠️ **硬要求**：结算必须在**任何读取库存的界面渲染之前**完成。否则首页显示「剩 34 片」而详情页显示「剩 32 片」，同一份数据自相矛盾——网页版专门用路由依赖解决了这个问题，App 上别丢掉。

### 7.4 构建配置

| 配置 | 值 | 理由 |
|---|---|---|
| `minSdkVersion` | **24**（Android 7.0） | 正好是 RN 0.76+ 自己的下限，「支持到 Android 7.0」是免费拿到的 |
| `targetSdkVersion` | **36**（Android 16） | 当前标准，Expo SDK 57 默认；新手机上也表现正常 |
| ABI | **universal APK**（`armeabi-v7a` + `arm64-v8a`） | 32 位老机器和 64 位新机器都能装；文件大一些但省事 |
| `applicationId` | **`com.medbox.family`** | 装上手机后不能改 |
| 桌面名 | **家庭药箱** | 图标下只能显示 4–6 个字 |
| 图标 | **药箱**样式，用 AI 生成 | 待做 |

### 7.5 推送规格

**触发事件**（只这四类）：

| 触发 | 条件 |
|---|---|
| 今天到期 | 某盒的**提醒日 == 今天** |
| 已过期 | 提醒日 **<** 今天，且用户还没处理 |
| 需补货 | `预计可用天数 ≤ 补货阈值`（默认 15 天），**0 库存也算** |
| 已用完 / 无库存 | 预计可用天数为 0 |

**不推**：首次进入快过期窗口（默认 90 天内）。

**节奏**：只为**真的有事的日期**排通知，每个这样的日期**最多一条**，时间 **早 9:00（可设置）**。内容形如「药箱：今天到期 2 盒，需补货 1 种」。每事件**只推一次**（不重复轰炸）。

**锁屏内容**：只显示「药箱：N 件事待处理」，**不显示药名**——符合 §1.3「不越界给医疗建议」的调性，也不用担心手机被别人瞟到。

**实现注意**：
- 用户拒绝通知授权时要能**降级到「打开 App 时在首页看到」**——首页本来就是这个设计，不存在「不授权就什么都不知道」。
- **数据一变（取用、入库、改效期）就要重算待推送队列**，否则会推已经处理过的事。用**稳定的通知标识符**，以便取消重排。
- 提醒日算法见 `requirements.md` §3.4（`min(印刷效期, 拆封日期 + 开封天数)`，候选为空则「未填效期」）。注意分档边界是 `<` 还是 `≤`。
- **App 内要做一个「通知自检」引导页**（见 §6.6 的四步）。

---

### 7.6 导出规格（M6，2026-09-21）

代码：`src/exporter/build.ts`（JSON）、`src/exporter/report.ts`（清单）、`app/export.tsx`（写文件 + 分享）。

#### 为什么分成「纯模块 + 薄界面」

`jest.config.js` 是 `testEnvironment: 'node'`，**故意不用 `jest-expo`** ⇒
`expo-sharing` / `expo-file-system` **在测试里 import 不了**。所以两个纯模块
（吃 drizzle 句柄 + 时刻，吐字符串）承载全部判断，界面只负责写文件和拉分享面板。
**能测的部分尽量厚，不能测的部分尽量薄。**

#### JSON 的四条保命规则（硬约束 5 的落点）

1. **键严格等于导入端的白名单**（`src/importer/parse.ts` 的 `MEMBER_KEYS` / `MEDICINE_KEYS` /
   `BATCH_KEYS` / `EVENT_KEYS`，这四处已 `export` 出来给导出端和测试共用）。
   **顺序也照抄**网页版 `app/routes/export.py` —— 顺序一致时两份文件能逐行 diff，
   是免费的调试资产。多一个键 = 将来导入时多一条「不认识的字段」警告。
2. **四张表都按 `id` 升序，`stock_events` 尤其必须** —— 不变量 1 的平局判定是 `>=`
   （`parse.ts:541`），同 `createdAt` 时**数组里靠后的赢**，而「靠后 = 写入更晚」的
   唯一可靠依据是 `id`。
3. **`settings` 只写两个阈值键**，**绝不 spread settings 表** —— `last_import_at` /
   `last_import_file` / `migrate_*` 结构上不可能泄漏出去（有测试拿真库塞了这些键来验）。
4. **自检**：生成完立刻用导入端那把尺子（`parseExport`）量自己一遍，不过就**不出文件**。
   这把硬约束 5 从「测试里钉住」升级成**运行时自证** —— 将来任何改动破坏了双向兼容，
   导出**当场**失败，而不是等到用户真的要恢复备份时才发现。代价是个位数毫秒。

自检用的导入日是常量 `'2000-01-01'`：它只影响「自动扣减药的起算日被重设成哪天」，
既不进 `errors` 也不进 `warnings`。

> ✅ **这条自检不是摆设，它在真机验收里挡下了一次真实故障**（2026-09-22）：
> 「标记过期 / 恢复在库」记的 `delta_qty = 0` 被导入端判为非法（§7.2）⇒
> 导出的文件**自己过不了自己那一关**，而这个拒绝对用户是**永久**的。
> 没有这条自检，故障会推迟到「用户真要恢复备份的那一天」才暴露 —— 那时已经太晚了。

失败结果带 `reason`（`'preflight'` / `'self_check'`），界面据此换文案 ——
**不是靠匹配错误文本里的某个字**。预检 = 用户在界面里改得动（指路到具体界面）；
自检 = 界面里改不动的东西坏了（只能说「这份数据本身有问题」）。

#### 三条归一化 / 拒绝规则

| 库里的状态 | 可达吗 | 导入端 | 导出怎么办 |
|---|---|---|---|
| `in_stock` + `qty === 0` | ✅ 可达 —— 取用把一盒取空后 `planTake` **不转状态**（`src/domain/stock.ts:305-307` 只 push 了 `{qty: qtyAfter}`，网页版 `take_from_batch` 同样不转） | ❌ 报错（不变量 4） | **归一化成 `used_up`**，并**显示给用户**（橙色提示卡，列出每一盒） |
| `used_up` / `discarded` + `qty !== 0` | ✅ 可达（`planEdit` 对所有状态的盒都渲染「编辑」，编辑一个已用完的盒并填上数量即可） | ❌ 报错（不变量 3） | **拒绝导出**，点名药与盒 |
| `medicines.unit` 空 | 正常路径不可达（建档校验拦住了），但 schema 可空 | ❌ 报错 | **拒绝导出**，点名药 |
| `open_life_days ≤ 0` | ✅ 可达 —— `planEdit` 用 `parseOptionalInt`（正则 `^-?\d+$`）**漏了 > 0 的校验**，而 `planIntake` 有 | ❌ 报错 | **拒绝导出**，点名药与盒 |

**归一化不是发明**：`planEdit` 把 `qty === 0` 的在库盒写成 `used_up`，结算自己扣到 0 时
留下的也是 `used_up` —— 是 `planTake` 那一处不一致，导出端在替它兜。
**归一化必须显示**（与导入页「这 6 种药的起算日会改成今天」同一条原则）：不许静默改语义。

**规则 2 为什么只能拒绝**：要满足不变量 3 就得把 `qty` 改 0，但那会同时打破不变量 1
（最后一条 `edit` 事件的 `qtyAfter` 是那个非 0 值）；改事件更不行（不变量 8）。
**没有合法表达**，所以拒绝，并且错误文案要指到 UI 里的正确修法。

#### 时间戳

`created_at` / `updated_at` → **UTC naive**（`toNaiveUtcString`）；
`exported_at` → **本地 naive**（`toLocalNaiveString`）。
全模块不许内联手写时间格式化。理由与实测见 §6.2。

#### 在库清单的格式

复用现成的 `getThresholds` / `inStockRows` / `aggregateByMedicine` / `buildGroups`（`src/data/queries.ts`）
—— **零新领域逻辑**，所以**清单里组的顺序和首页完全一致**（`buildGroups` 那套组间排序）。

- UTF-8 **无 BOM**、`\n` 换行（不是 `\r\n`）、结尾恰好一个换行
- 文件名 `在库清单-YYYY-MM-DD.txt`（一天一版，发出去不会互相盖掉）
- 日期一律 `YYYY-MM-DD` 不加工；组之间一个空行（不用横线）
- 位置为空印 `—`；归属为空印「家庭共用」（与首页同一个标签）
- 范围：**只有 `in_stock` 且 `qty > 0` 的盒**（与 build.ts 的归一化同一口径）。
  ⚠️ **「在库」是状态，不是「没过期」** —— 已过期但仍在库的盒**在**清单里，有测试钉住这条

**「约剩 N 天」的五条限制**：只在药品级打印一次；只在该药 `dailyDose > 0` 时打印；
`unitConflict` 为真时**绝不打印数字**（改印「有不止一种单位，无法估算天数」）；
头部单列一行「需补货：…」；说明里写清「约剩 = 在库合计 ÷ 每日用量，只是估算」。

🔴 **一处刻意与首页不同**：「需补货」名单里，单位混用的药**保留在名单里**（`需补货 N 种`
的个数必须和首页对得上），但**天数抹掉**，改印「（单位不统一，天数算不准）」。
首页与 `dashboard` 是照印那个数的（网页版 `autodose.units_conflict` 只挡自动扣减、
**不挡补货预测**），而那个数来自「4 片 + 6 粒」这种没有意义的相加。清单是要脱离 App
单独发给家人看的文档：里面一处说「无法估算天数」、另一处给出「约剩 10 天」，
读的人只会信那个数字。见 §9 第 11 项。

#### 只读保证（硬约束 6）

`src/exporter/` 两个模块**只有 `db.select`**：不 import `settleAll`、不调 `reload()`、不写库。
`app/export.tsx` 从 `useDb()` **只解构 `{ db, today, hasData }`，不把 `reload` 拿出来** ——
让「想调用」在代码里根本写不出来。测试里有一条**静态守卫**读源码断言这一点
（`test/exporter/roundtrip.test.ts`），比行为守卫更早拦住「未来有人好心加一句结算」。

#### 原生侧：`expo-sharing` 自带了需要的东西（2026-09-21 实测）

**`app.json` 只多了一行 `"expo-sharing"` 插件声明**（`npx expo install` 自己加的），
`AndroidManifest.xml` **一行都不用动** —— 这很重要，因为 `android/` 是 gitignore 的、每次 prebuild 都被删，
**手改 manifest 等于没改**。实测 `node_modules/expo-sharing/android/src/main/AndroidManifest.xml`：

```xml
<queries><intent><action android:name="android.intent.action.SEND" /><data android:mimeType="*/*" /></intent></queries>
```

Android 11+ 的包可见性要靠这个 `<queries>`，没有它 `isAvailableAsync()` 会返回 false（看不到任何可分享的目标）。
它自带的 `SharingFileProvider` 也覆盖了 `cache-path`（`res/xml/sharing_provider_paths.xml` 里有
`<cache-path name="cached_expo_files" path="." />`）—— 所以**文件写 `Paths.cache` 是对的**，写别的目录 FileProvider 会拒。

> 📌 **这条是「先证伪『工具做不到』再绕」的实例**（`AGENTS.md` 里那条纪律）：
> 计划阶段我没法读它的源码（没装），那个说法**来自上游文档而不是本机代码**。
> 处理办法是先装再读，而不是先设计一个绕过它的方案 —— 结果是一行 manifest 都不用碰。

#### 界面侧的三条纪律（`app/export.tsx`）

1. 🔴 **不写「已发送」**：`shareAsync` 的 resolve 只代表**面板关掉了**（取消也 resolve）。
   文案只能是「分享面板已关闭」。
2. 🔴 **预览过什么，就分享什么**：分享用内存里那段字符串，**不是重新查库** ——
   回前台会跑结算闸门，重查一遍可能得到与刚才预览不一样的数字。
3. **每次分享都重写文件**，不看 `file.exists`：同名文件可能是**上一次启动**留在缓存里的，
   「存在」≠「内容是这一份」。写进 `Paths.cache`（中转物，被系统清理是正确行为），
   不是 `Paths.document`（那会在读不到的 `/data/data` 里永久堆积）。

---

## 8. 实施顺序

| # | 里程碑 | 内容 | 为什么排这里 |
|---|---|---|---|
| **M1** | **能查药** | 项目骨架 + 本地库（**关 WAL**）+ **JSON 导入** + 首页 + 药品列表/详情 | **第一个验收点**。做完这一刻你出门就能查药了，而且它把最容易出错的导入逻辑**第一个暴露出来** |
| M2 | 能记药 | 入库 + 五种库存操作（取用/用完/丢弃/标记过期/恢复在库）+ 成员管理 | 覆盖场景 3（唯一需要大量输入的场景） |
| M3 | 会算 | 效期分档 + 补货预测（纯函数，**测试一起翻译**）—— ✅ **2026-09-17 完成**（§8.5），代码 M1 时已写、这轮补的是测试 | 复用 M1 的基础设施 |
| M4 | 会扣 | 自动扣减结算 —— ⚠️ **规则层已提前并入 M2**（原因见 §8.4），**每日用量编辑界面**与**设置页阈值**已在 §8.6 做完，**暂停服药 / 恢复服药**在 §8.7 —— ✅ **2026-09-20 完成，无剩余项** | 依赖 M3 |
| M5 | 会提醒 | **本地通知推送** | 增量最大，但必须等数据都对——**先做会推出错的数据** |
| M6 | 能拿走 | 导出 JSON + 在库清单分享 —— ✅ **2026-09-21 编码、2026-09-22 真机验收**（§7.6 规格 / §8.8 记录） | 收尾 |
| M7 | 上 iOS | EAS 云构建 + $99/年 Apple 开发者账号（**决策可推迟到这一步**） | 将来 |

> **M1 完成时应该能**：在小米8 上装好 App，导入数据，出门用流量也能查药，且看到的数量和网页版对得上。
> **M1 做完不停下来**，立刻接着 M2。

### 8.1 M1 具体清单

1. 在 `D:\Documents\medbox\medbox-mobile` 初始化 Expo + TypeScript
2. 配 `app.json`：`applicationId com.medbox.family`、桌面名「家庭药箱」、`minSdk 24` / `targetSdk 36`
3. 装 `expo-sqlite` + `drizzle-orm` + `drizzle-kit`，**建库时显式关掉 WAL**
4. 建四张表（`Medicine` / `Batch` / `StockEvent` / `Member`）+ 一个 `Setting` 表，字段照 `requirements.md` §2
5. 实现导入：读 `all.json`，含 §7.2 的 7 个坑兜底（**尤其 `auto_from` 重设 + 时区硬编码规则 + 丢弃 `migrate_*`**）
6. 首页（搜索置顶 + 在库列表 + 统计一行 + 需补货 + 按成员）
7. 药品列表页 + 药品详情页（含逐盒展开）
8. 底部 4 tab 骨架（成员页 / 设置页可先占位）
9. 编译 apk，装到小米8 上，导入 `D:\Downloads\all.json`，**对着 `test/golden.test.ts` 核数量**

> 🔴 **不要起网页版来对数量。** 网页版界面上的数**本来就比文件大 6**（§7.1：是「导出」这个动作
> 自己触发了惰性结算，那 6 条 `auto_take` 已经写进了文件），再开一次还会**再触发一次惰性结算**、
> 并且**改掉 `../medbox-app/data/medbox.db`**（硬约束 1 的对象）。
> `test/golden.test.ts` 已经把验收数字钉死了，`npx jest test/golden.test.ts` 随时可复现基准值。
> 装机验收的实测结果见 §9 第 6 / 9 项。

### 8.2 出包流程（实测）

本机工具链已在位，但**每次开新终端都要重设**（没写进系统 PATH）：

```bash
export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot"
export ANDROID_HOME="/d/Android/Sdk"
export ANDROID_SDK_ROOT="/d/Android/Sdk"
```

四步，**一步都不能少**：

```bash
cd /d/Documents/medbox/medbox-mobile
npx expo prebuild --platform android   # ⚠️ 会整个删掉重建 android/
bash scripts/android-signing.sh        # ⚠️ 必须紧跟其后（见下）
cd android && ./gradlew assembleRelease
```

产物：`android/app/build/outputs/apk/release/app-release.apk`

**为什么第 3 步不能漏**：`prebuild` 会先打印 "Clearing android"，**静默删掉整个 `android/` 目录** —— 里面的签名配置一起没。漏了这一步，出来的是 debug 密钥签名的包，**装到手机上无法覆盖升级**，只能卸载重装 = 本地数据库全丢。

签名密钥放在 `keys/medbox-release.keystore`（**已进 git，别删**），不在 `android/` 里 —— 因为 `android/` 是 gitignore 的，且每次 prebuild 都被删。`scripts/android-signing.sh` 是幂等的补丁脚本，负责把签名配置重新插回去。

**首次构建极慢**（实测 **6 小时 56 分**）：要下载 Android NDK（约 1 GB，落到 `D:\Android\Sdk\ndk\`）并从源码编译全部原生模块。之后是增量构建，快得多。

#### 只改了 JS 时：**不要跑 `prebuild`**（2026-09-20 实测）

原生侧一行没动时（`app.json` / `app.config.*` / `package.json` 全是干净），第 1、2 步是**纯风险** ——
`prebuild` 会把 `android/` 整个删掉、连带签名配置一起丢，然后触发一次全量编译。
直接增量：

```bash
cd android && ./gradlew assembleRelease   # 实测 1m 23s
```

判断依据是一条命令：`git log --since=<上次出包日期> --name-only -- app.json app.config.* package.json` ——
**空的就跳过 prebuild**。

⚠️ **`packageRelease` 的增量状态会坏**（实测 2026-09-20）：报
`PackageAndroidArtifact$IncrementalSplitterRunnable` 失败，而且**会把上一版 APK 一起清掉**。
**原样重跑一次就好**（1m40s 失败 → 1m23s 成功），**不用 `clean`**（那会退化成全量编译）。

#### 🔴 新增/升级**任何带原生代码的依赖**之后，必须整跑四步（2026-09-21 实测）

上面那条「只改 JS 就跳过 prebuild」的判据是 `package.json` 有没有动。
**动了就必须走完整的四步** —— M6 加 `expo-sharing` 就是这种情况：它带 Android 模块和自己的 manifest，
不 prebuild 的话原生侧根本没有它，JS 里 `import` 得到、跑起来直接崩。

⚠️ **而 `prebuild` 删掉的不止 `android/` 里的签名配置**：它把整个目录删了重建，
`android/local.properties` 一起没（这个文件是 gitignore 的，重新生成时不带）。
症状是 gradle **当场失败**：

```
SDK location not found. Define a valid SDK location with an ANDROID_HOME
environment variable or by setting the sdk.dir path in your project's
local properties file at '…/android/local.properties'.
```

**2026-09-21 就是这么卡的**：`bash scripts/android-signing.sh` 跑过了（签名配置补回去了），
但脚本当时不管 `local.properties`，于是 gradle 在配置阶段就挂。

✅ **已修**：`scripts/android-signing.sh` 现在**顺带写 `android/local.properties`**
（`sdk.dir` 取自 `ANDROID_HOME` / `ANDROID_SDK_ROOT`，都没有就退回本机默认的 `/d/Android/Sdk`）。
所以第 2 步的语义从「补签名」扩成「**把 prebuild 删掉的东西补回去**」。
写文件比靠环境变量可靠：环境变量**每开一个新终端都要重设**，漏掉就复现这个错。

#### ⚠️ 后台任务报的「退出码 0」不可信（两次都栽在这）

`bash -c '...; echo "EXIT=$?"'` 这种写法，**外层 shell 的退出码来自最后那条 `echo`**，
所以无论里面的命令成功还是失败，任务通知都会说「completed (exit code 0)」。
2026-09-21 的 gradle 构建就报了 `exited with code 0`，日志末尾却写着 `GRADLE_EXIT=1`。

**规矩**：后台跑构建时，把真实退出码**写进日志文件**（`... > log 2>&1; echo "EXIT=$?" >> log`），
然后**读日志**判断成败，不要看任务通知里的那个码。

⚠️ **构建日志不要接 `| tail`** —— 管道的退出码会掩盖 gradle 的真实退出码，失败的构建会显示成 `exited with code 0`。把日志写文件，再单独 `echo $?`。
（同一天还踩了它的变体：后台任务报「退出码 0」，日志里却是 `EXIT=1` —— 因为命令末尾还有个 `echo`。
**真实退出码必须自己写进日志**。）

#### 出包后必做：验签

跳过 `prebuild` 时尤其要验 —— **别信 `build.gradle` 里的配置，直接问 APK**：

```bash
"$ANDROID_HOME/build-tools/36.0.0/apksigner.bat" verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk
# 正式密钥 → CN=medbox, OU=family, O=medbox, C=CN（debug 密钥会写 CN=Android Debug）
```

更硬的核法是与密钥库对指纹（`storepass` 见 `android/app/build.gradle`，**不是** `medbox2026`）：

```bash
"$JAVA_HOME/bin/keytool" -list -v -keystore keys/medbox-release.keystore \
  -storepass REDACTED -alias medbox | grep SHA256
```

2026-09-20 核过：APK 与密钥库都是 `4C:CF:B4:79…F6:D0`。**这一条不能省** —— 签名不对的包
装上去，将来无法覆盖升级，只能卸载重装 = 本地数据库全丢。

#### 用 adb 往手机里放文件：**Git Bash 会偷偷改写路径**

```bash
adb push x.apk /sdcard/Download/          # ❌ /sdcard 被 MSYS 改写成 C:/Program Files/Git/sdcard/
```

更坏的是它会打印 **`1 file pushed`** —— 看着像成功，其实写到了别的地方。
（2026-09-20 实测：`adb shell ls -l /sdcard/Download/` 里两个文件都不在。）

正确写法：**源路径用 `D:/…` 形式，目标路径保持 `/sdcard/…`，并禁掉路径转换**：

```bash
export MSYS_NO_PATHCONV=1
adb push D:/Downloads/all.json /sdcard/Download/all.json
```

推完**必须 `adb shell ls -l` 核一遍**，别信那句 `pushed`。

### 8.3 🔴 已知卡点：Windows 260 字符路径上限

M1 第 9 项卡在这里。报错：

```
ninja: error: Stat(...RNGestureHandlerDetectorShadowNode.cpp.o): Filename longer than 260 characters
```

实测该路径 **367 字符**，构成：

| 段 | 长度 |
|---|---|
| 项目路径 `D:\Documents\medbox\medbox-mobile` | 33 |
| 编译中间目录（`.cxx` + CMake 目标目录 + 随机哈希） | 151 |
| **镜像出来的第二遍项目路径** + 依赖源文件 | 183 |

**不可变部分 303 已经单独超过 260**，所以**挪项目位置、用虚拟盘符、用目录链接全都无效** —— 不要浪费时间试。根因是 `react-native-gesture-handler` 的 Fabric codegen 目录层级（`shared/shadowNodes/react/renderer/components/` 一段就 44 字符）+ CMake 把源文件绝对路径镜像成目录的固有做法，两者叠在一起。

#### 2026-09-17 实测：本地无解（三条路都堵死，别再试）

**① 开长路径注册表开关 —— 已试，无效。**
`LongPathsEnabled` 确认已是 `0x1`，重启后重跑 `assembleRelease`，**同一个错，1 分 05 秒照样失败**。

原因是 Windows 的规矩是**两边都要**：系统允许 **＋** 程序自己声明 `longPathAware`。实测本机三个工具**都没声明**（在 exe 里搜不到这个标记）：

| 工具 | 版本 | 声明 longPathAware |
|---|---|---|
| `ninja.exe` | 1.10.2 | ❌ |
| `cmake.exe` | 3.22.1 | ❌ |
| `clang.exe` | 18.0.2（NDK 27.1） | ❌ |

**② 换新版 CMake（自带新版 ninja）—— 也没用。**
ninja 官方 issue [#2359](https://github.com/ninja-build/ninja/issues/2359) 里用户实测**最新的 `1.12.0.git` 仍不解决**；修复补丁 [PR #2552](https://github.com/ninja-build/ninja/pull/2552) **至今仍是 open**，维护者明确表示 MAX_PATH 是微软的 bug、**拒绝合入这个绕开方案**。所以装 CMake 4.1.2 拿到的还是修不好的 ninja。

**③ 挪短路径 —— 数学上不可能。**
把一切压到极致（`subst` 出单字母虚拟盘符 + `buildStagingDirectory` 指到盘根）后，**理论最短仍是 274 字符**，比 260 还多 14：

| 段 | 最短 |
|---|---|
| 构建目录 `C:\b\<hash>\arm64-v8a\` | 24 |
| 目标目录 `rngesturehandler_codegen_autolinked_build\CMakeFiles\react_codegen_rngesturehandler_codegen.dir\` | 96 |
| 镜像前缀 `C_\` | 3 |
| 依赖固有路径 + 文件名 | 151 |
| **合计** | **274** ❌ |

那 151 字符是依赖包自己的路径，谁也改不了 —— 它加上 CMake 的目录命名就 247。**所以网上到处在说的「挪到 `C:\P\` 就好了」在本项目不成立**（那些人的报错路径落在 Gradle 缓存里，成因不同）。社区同类 issue（react-native-screens [#3471](https://github.com/software-mansion/react-native-screens/issues/3471)）确认这是 **NDK 27.x 的已知问题，截至 2025-12 仍未修复**。

#### ✅ 2026-09-17 已解决：换掉 ninja

**根因不是路径太长，是构建工具太老。** `longPathAware` 这个声明 ninja 在
**2022-12-13** 才加进源码（提交信息：「Add longPathAware manifest to enable long paths on Windows — Fixes: #1900」，
文件在 `windows/ninja.manifest`）。而 Android SDK 的 CMake 3.22.1 里带的 ninja 是
**1.10.2（2021 年）**，早于这个修复一年多 —— 所以注册表开关对它无效。

**做法：只把 ninja 换掉，CMake 保持 3.22.1 不动。**

```bash
# 1. 从 Google 安卓官方源下载新版 CMake（只是拿它里面的 ninja）
curl -L -o cmake.zip https://dl.google.com/android/repository/cmake-4.1.2-windows.zip

# 2. 取出 ninja.exe（它在压缩包的 bin/ 下）
unzip -o -j cmake.zip 'bin/ninja.exe'

# 3. 先备份，再替换
NB=/d/Android/Sdk/cmake/3.22.1/bin
cp "$NB/ninja.exe" "$NB/ninja.exe.1.10.2.bak"
cp ninja.exe "$NB/ninja.exe"
```

**为什么只换 ninja、不整个换成 CMake 4.1.2**：CMake 4.x 不再兼容
`cmake_minimum_required(VERSION < 3.5)`，而 RN 的原生模块里还有这种老写法，
整个换会让 configure 阶段直接失败。ninja 是独立可执行文件，新 ninja 读 CMake 3.22
生成的 `build.ninja` 没有问题。**只换 ninja 是风险最小的做法。**

**验证是否换对了**（不用运行它，直接搜二进制里的标记）：

```bash
grep -c longPathAware /d/Android/Sdk/cmake/3.22.1/bin/ninja.exe   # 必须是 1，0 就是没换成功
```

| | `longPathAware` | 版本 |
|---|---|---|
| 旧（SDK 自带） | 0 ❌ | 1.10.2（2021） |
| 新（CMake 4.1.2 自带） | 1 ✅ | 1.12.1（2025-10） |

**换完必须重跑构建才生效**（`build.ninja` 不用删，ninja 自己会重读）。

⚠️ **如果哪天重装 Android SDK 或装了别的 CMake 版本，这一步要重做** —— SDK 更新会把
`ninja.exe` 换回旧版，报错会一模一样地回来。

#### 其余出路（已不需要，留作备选）

- **A** 改用 **EAS 云构建**（Linux，无路径长度限制）。§1 已认定 iOS 那一步**必须**走 EAS，所以早晚要做，不算浪费。代价：Expo 账号、源码上传、签名密钥要么交云端管要么上传一份（**必须用同一把 `keys/medbox-release.keystore`**，否则将来本地产的包无法覆盖安装）。
- **B** 装 **WSL2 + Ubuntu** 在本地 Linux 环境编译。全程不外传，但要装 WSL2（需管理员）、Ubuntu、JDK、Android SDK（数 GB），首次编译从头再来（数小时）。

### 8.4 M2 实施记录（2026-09-17，commit `0666cf2`）

M2 = 入库 + 五种库存操作 + 成员管理。全部做完，`tsc` 干净，**151 条测试全过**。

#### 🔴 刻意偏离里程碑顺序：自动扣减结算（原定 M4）提前到 M2

理由不是「顺便做了」，而是**不做的话 M2 会写出悄悄错的数据**：

| M2 的操作 | 不接结算会怎样 |
|---|---|
| 取用 | 不更新 `auto_accounted` → M4 第一次结算把那几天**重复扣一遍** |
| 入库（补货） | 不重设起算日 → 断货期攒下的天数在下次结算时**一次性扣爆**，正是 §6.1 那颗雷 |

也就是说「先做 M2 再做 M4」不是「少个功能」，是「做出来的数会悄悄错」。
所以规则层一次做全（`src/domain/autodose.ts` + `src/domain/stock.ts`）。
**M4 剩下的范围缩小为**：暂停服药 / 每日用量的编辑界面。

#### 🔴 新发现的坑：drizzle 两个驱动返回的自增 id 键名不一样

| 驱动 | 键名 |
|---|---|
| `drizzle-orm/expo-sqlite`（App 上跑的） | `lastInsertRowId`（**大写 D**） |
| `drizzle-orm/better-sqlite3`（测试上跑的） | `lastInsertRowid`（小写 d） |

`applyPlan` 里「入库事件要绑到刚插入那一行」全靠这个 id。写错的后果是
`createdId` 变成 `NaN`，用户看到的是一句 `NOT NULL constraint failed:
stock_events.batch_id` —— 完全指不到病根。现在 `insertedId()` 两个都认，
取不到就立刻用中文报错。

**这个坑是被 §8.4 下面的测试逼出来的**，不是读文档读出来的。

#### ✅ 落库层终于有测试了（`test/data.test.ts`，24 条）

此前 `src/data/` 是唯一没有测试覆盖的一层，而它恰恰是把数据改坏的地方。
做法：装 **`better-sqlite3`**（devDependency，不进 APK），用**与 App 同一份**
`drizzle/*.sql` 建内存库，只把驱动换掉。

- 为什么不是 `drizzle-orm/sqlite-proxy`：它是**异步**的，而 `applyPlan` 依赖
  **同步事务**（`db.transaction((tx) => { tx.insert().run() })`）。better-sqlite3
  的同步 API 与 expo-sqlite 形状一致，这是唯一能覆盖到这条路径的选择。
- 覆盖到：**不变量 1 在真 SQL 上逐盒核**（同时是「事件有没有绑对批次」的判据）、
  入库事件绑定、结算幂等、断货补货不补扣、账本成对更新、成员删除守卫。
- 没覆盖到：expo-sqlite 自身的驱动行为、关 WAL 那个 PRAGMA。

#### 🟡 发现的缺口：药品档案 CRUD 不在任何里程碑里

**`requirements.md` 场景 3 是「买药回来时 —— 新买的这盒记一下」，而里程碑表里
没有任何一项包含「新建/编辑/删除药品档案」。** 现状是所有 37 个药都来自导入，
所以今天不阻塞；但用户买回一种**药箱里没有的药**时，只能建档却无处可建
（入库页的单位是从档案继承的，档案不存在就没法入库）。

`src/domain/stock.ts` 里已经留了一处指向它的死路：档案没填单位时报
「请先到「编辑档案」补上」，而那个界面不存在。

**待用户决定**：是否把档案 CRUD 补进 M2 的尾巴，还是排在 M3 之前单独做。
（不擅自加进来的原因：里程碑顺序是锁定的，且「删除档案」要处理已有批次，
是个需要定规则的决定。）

#### 其他

- 新增依赖 `@react-native-community/datetimepicker`（含 config plugin）。
  「印刷效期」是入库时每次都要填、且刻意不预填的字段，手打 11 个字符太容易错，
  所以走系统日期选择器。代价是 APK 必须重新构建。
- `Alert.prompt` **只有 iOS 有**，在小米8 上会静默地什么都不弹 ——
  取用数量、丢弃原因一律用自制的底部弹层。
- 界面上的两处刻意偏离网页版，都为了守住不变量 4（不存在「在库且 0 片」）：
  编辑在库批次数量改为 0 时同时转状态；恢复在库拒绝数量为 0 的批次。
  网页版两处都漏。

### 8.5 M3 实施记录（2026-09-17，commit `c77fec6`）

#### 发现：M3 的代码早在 M1 就写完了，测试却一条都没有

`src/domain/expiry.ts` 和 `src/domain/forecast.ts` 是 M1 做首页时才写的，
所以 M1 结束时这两个模块**已经在算用户看到的数字**（灰色/黄色/红色的药丸、
「约剩 6 天」、需补货区块），而 `npx jest` 里没有一条测它们 ——
`test/expiry.test.ts` / `test/forecast.test.ts` **根本不存在**。

M1 记的「55 条」是 `parse.test.ts`(42) + `golden.test.ts`(13)，全是导入与验收数字。

**所以 M3 这轮实际做的是补测试，不是写功能。** 里程碑描述里
「纯函数，**测试一起翻译**」这半句一直悬着 —— 代码在跑、测试没写，
是比「功能没做」更糟的一种状态：**已经跑到用户眼前却没验证过**。

#### ✅ 上游 16 条全部落地，共新增 24 条（151 → 175）

| 上游文件 | 条数 | 落地位置 | 处理 |
|---|---|---|---|
| `tests/test_expiry.py` | 11 | `test/expiry.test.ts` | 原样翻译，11 条一一对应 |
| `tests/test_forecast.py` | 5 | `test/forecast.test.ts` | 4 条纯函数（`needs_restock` 拆成 3 条）+ 1 条集成测试重写 |

集成测试那条：上游用 pytest 的 `session` fixture 建库、断言
`forecast.dashboard_stats`；这里换成 `freshDb()` 建真 SQLite、断言
`src/data/queries.ts` 的 `dashboard`（聚合查询在我们这边归数据层）。

新增的 8 条是上游没有的，都标了「补充」：

- **只填开封天数、没填开封日期** —— 上游只测了反过来的那一半。这半边更危险：
  开封日期缺失时若仍按天数算，就得**凭空假设一个起算点**。
- **印刷效期还很远、开封把提醒日拉到眼前 → `classify` 分档必须跟着走**。
  防的是「`classify` 绕过 `effectiveExpiry` 直接看印刷效期」——
  那种写法能把前面 11 条全放过去，因为那些用例里两个日期恰好是同一个。
- **阈值设成 0 天时「今天到期」仍算快过期**（阈值 0 ≠ 关掉快过期，
  因为下界是「今天」而不是阈值）。
- **`isExpiredOrUnknown` 3 条**（见下）。

#### 🔴 顺手补上一个真空白：`isExpiredOrUnknown` 上线前 0 条测试

它是 `autodose._fefo_key` 里「过期盒排到最后」那一半规则的提取，
**决定自动扣减先从哪一盒扣** —— 正是 §6.4 说的那一类「算错了用户看不出来」。
上游不是独立函数，所以它不在移植清单里，于是谁也没想起给它写测试。

补的 3 条：已过期/未填效期同档排最后、今天到期**不算**（严格 `<`，否则当天
吃的药会被整个跳过、账不扣）、按提醒日而非印刷效期判定。

#### ✅ 针对「测试是照实现写的」这个风险，做了变异检验

这套测试有个先天弱点：**代码先写好、测试后补**，很容易写成「复述实现」——
断言跟着实现一起错，测试照样全绿。所以把 6 处实现逐个改坏，看新测试响不响：

| 改坏的地方 | 新测试的反应 |
|---|---|
| `effectiveExpiry` 取 min 改成取 max | 4 failed ✅ |
| `classify` 已过期改成 `<=`（今天到期也算过期） | 2 failed ✅ |
| `isExpiredOrUnknown` 改成 `<=` | 1 failed ✅ |
| `needsRestock` 的 `<=` 改成 `<` | 1 failed ✅ |
| `daysOfSupply` 去掉「用量 ≤0 不参与」的护栏 | 1 failed ✅ |
| `dashboard` 需补货只看有在库批次的药（漏掉 0 库存） | 1 failed ✅ |

6/6 都被抓住，改动已全部还原（`git checkout`），恢复后 175 条依旧全过。
**这一栏才是「这些测试有没有用」的真正答案**，别只看条数。

#### 搭台代码抽成了 `test/helpers.ts`

`freshDb` / `insertId` / `addMedicine` / `addBatch` 从 `test/data.test.ts` 抽出来共用
—— 新的集成测试也要建真库，不抽就是第二份会各自漂移的副本。
`data.test.ts` 的调用点一处没动（`med`/`box` 改成绑上本文件基准时刻的薄包装），
抽取后它那 22 条照过、`tsc` 干净，**没有改变行为**。

`insertId` 刻意在测试里**另写一份**、不 import `src/data/stock.ts` 里那个：
共用的话只能证明「它和自己一致」，证不了落库层自己处理了驱动差异（§8.4）。

#### ⚠️ 口径差异：上游数「批次行数」，我们数「药品种数」

上游 `test_dashboard_stats` 断言 `sum(per_member.count) == 5`，口径是**批次行数**；
我们 `dashboard().perMember` 数的是**名下有在库的药品种数**（§3.7）。
新集成测试的 fixture 里每种药恰好只有 1 盒，**两种算法都得 5，这条用例分不出两者**。
真正钉住「品种数」口径的是 `test/golden.test.ts` 那串验收数字
（家庭共用 16 / 孩子 14 / 外公 6 / 妈妈 1）。已在用例里写明，免得日后有人
以为这条测试管着口径。

#### 🟡 发现最后一个 M3 尾巴没做：设置页的两个阈值不能改

`app/(tabs)/settings.tsx` 的文件头写着「阈值（90 天 / 15 天）这一版只读不写……
**等 M3 做完预测再放开编辑**」。现在预测有测试了，但**那个编辑界面仍然没做** ——
上游 `routes/settings.py` 的 POST 就是干这个的。

现状不阻塞（`getThresholds` 读不到设置行就用默认 90/15，集成测试已覆盖这条路径），
但用户改不了这两个阈值。**待用户决定是否现在补。**

### 8.6 M3 尾巴 + 药品档案 CRUD 实施记录（2026-09-18，commit `9f41765` + `716d3de`）

两件事，都不是新功能，而是**把已经指出去的路补齐**。`tsc` 干净，**227 条测试全过**。

| 提交 | 内容 |
|---|---|
| `9f41765` | 设置页的两个阈值可编辑（§9 第 7 项）—— 纯 UI + 一个 `setSetting` upsert |
| `716d3de` | 药品档案 CRUD（§9 第 5 项）—— 新建 / 编辑 / 删除（表单含自动扣减与每日用量） |

#### ✅ 关掉的断头路：档案不能改也不能删

37 种药原先只能看。而代码里已经**指路了三次**，全都是写给这个还不存在的页面：

```
src/domain/stock.ts:235          「该药品档案还没填单位，请先到「编辑档案」补上」
app/member/[id]/index.tsx:128    「药的归属在「药品档案 → 编辑」里改」
src/ui/batchform.tsx:63          「要改请到「药品档案 → 编辑」」
```

也就是说：用户一旦遇到「单位没填」这个状态就被卡死 —— 界面上告诉他去哪修，
而那个地方不存在。**这不是缺功能，是断头路。** 现在它存在了。

#### 🔴 最大的发现：一个「本地全绿、真机必炸」的写法

编辑档案要求「结算落库」和「档案行 UPDATE」在**同一个事务**里 —— 结算落了库而
档案行没更新的话，账本是照着旧剂量算的，而系统以为已经按新剂量算过了（不变量 1）。
但 `applyPlan` 自己就开了事务，不能再套一层。

⚠️ **而这个坑测试测不出来。** 实测确认：

| 环境 | 嵌套事务的行为 |
|---|---|
| better-sqlite3（`npm test`） | 内部降级成 SAVEPOINT → **静默成功，全绿** |
| expo-sqlite（真机） | 裸 `begin` / `commit` → `cannot start a transaction within a transaction` |

所以「在 `medicines.ts` 里开事务、然后直接调 `applyPlan(db, …)`」这个写法
**本地全过、装到手机上必炸**。这是本项目最怕的那类错误 —— §8.3 那条卡点、
§8.4 那个驱动键名 bug 都属同一族。

**处理方式不是加注释提醒，是让它写不出来：**

```ts
// src/db/client.ts
export type Executor = Pick<MedboxDb, 'insert' | 'update' | 'delete'>;
```

`Pick` 把 `transaction` 排除在外，于是拿到 `Executor` 的代码**写不出**
`exec.transaction(…)`，也就不可能再套一层 `BEGIN`。配套把 `applyPlan` 拆成两半：

```
applyPlanOn(exec: Executor, plan, now)   ← 原函数体，不含事务
applyPlan(db, plan, now)                 ← 独立操作用这个（内部开事务）
```

> **教训**：这个坑能存在，是因为「测试驱动」和「运行驱动」不是同一个。
> 只要两边行为有差异，**测试全绿就不是证据**。能靠类型排掉的，别靠纪律。

#### 顺序陷阱：从「靠纪律」变成「没有『赋新值』这个动作可做」

上游是三步：`settle_medicine()` → 逐字段赋新值 → `rebaseline(settle_first=False)`，
代码里还留着一句警告「顺序不能反，settle_medicine 读的就是 `med.daily_dose`」。

这里**塌缩成一次调用**：`planRebaseline` 拿到的是 **`prev`（更新前的快照）**，
而新值只存在于 `res.fields` 里 —— `MedicineFields` 这个类型里**根本没有账本字段**
（刻意不含 `autoFrom` / `autoAccounted`）。于是：

- 「档案行的 UPDATE 把账本覆盖掉」在类型上写不出来
- 「先赋新值再结算」也就写不出来（没有第二份账本可写）

改每日 1 片 → 2 片时，系统按**旧的** 1 片/天结清过去 10 天（扣 10 片），
再以今天重新起算。反序会扣 20。

#### 🔴 刻意越过 M4 的边界（用户已确认）

编辑表单包含「自动扣减开关」和「每日用量」，**这就是 M4 锁定的那半边**
（「每日用量编辑界面」）。用户 2026-09-17 的选择是「包含，照上游原样」。
当时 M4 只剩「暂停服药 / 恢复服药」—— **那最后一项已在 §8.7 做完（2026-09-20）**。

代价是上面那条顺序陷阱必须处理 —— 而且它**比自动扣减本身更危险**：
自动扣减是幂等的每日一扣（多跑无害），改剂量却可能一次性补扣一大笔。
**「暂停服药 / 恢复服药」刻意留给 M4**，这次不做。

另有一处 parity 是照抄上游而不是漏了：**关掉自动扣减时仍然先按旧参数结清**。
那几天的药是真吃过的。代价是「关开关」这个动作会产生一条自动扣减事件，
所以界面上必须解释 —— 编辑页那句提示就是为它写的。

#### 用户看得见的那个决定：提示块由**落库的判断**驱动

改完用量看到库存少了一截，用户的第一反应会是「App 算错了」。所以编辑页必须写明
「会先结清」。但这句话**只在真的会结算时才对**，于是新增：

```ts
autoWouldChange(prev, form)   // planMedicineUpdate（跑不跑结算）与提示块共用
```

界面自己另判一次的话，迟早会和落库漂移 —— 那时用户看到的解释就是假的，
而他会因为一句假话去翻账本。四种情况里**有一种刻意不提示**：
没开自动扣减时改每日用量，库存一动不动（每日用量只影响「可用天数」），
此时说「会先结清」纯属吓唬人。

#### 🔴 顺手修的既有缺陷：`createMember` 返回 `id: NaN`

`src/data/members.ts` 用的是 `Number(res.lastInsertRowId)`（小写 d），
**绕开了 `stock.ts` 里那个守门人 `insertedId`**。实测确认过：改之前返回
`{ ok: true, id: NaN }`。

它和 §8.4 那个坑**是同一个根因的两个方向**：

| | App（expo-sqlite） | 测试（better-sqlite3） |
|---|---|---|
| §8.4 的 `applyPlan` | 好的 | **坏的** → 被测试逼出来 |
| 这次的 `createMember` | 好的 | **坏的** → 但没测试，一直没暴露 |

所以「守门人已经存在」不等于「大家都从门走」。**新的写入路径一律用 `insertedId`，
而且它必须有自己的测试**（`createMedicine` 有了，`createMember` 现在也有了）。

#### 测试 175 → 227

| 文件 | 条数 | 测什么 |
|---|---|---|
| `test/settings.test.ts` | 7 | `parseThresholds` 的两条规则（文案照抄上游） |
| `test/medicine.test.ts` | 28 | 四条校验、每日用量的形状、`autoPaused` 时机、`autoWouldChange`、`doseOf`、`formOf` 往返 |
| `test/data.test.ts` 的 `describe('药品档案')` | 13 | 真 SQLite：先按**旧**用量结清（10 天只扣 10）、改成自动扣减不追溯、关掉开关仍然结清、改单位/归属不改写已有批次、删除守卫 |

三条最有价值的断言做了**变异检验**，各自只被对应的一条测试抓住：用新剂量结旧账
（1 条红）、`settleFirst=false`（2 条红）、删除守卫误用 `inStockBatchesOf`（1 条红）。
全部还原后 227 条依旧全过。

其中 5 条钉的是 **`formOf` + 保存的往返**：「打开编辑页，碰都没碰，按保存」
不该改变任何东西。`formOf` 是 10 个字段的**手工映射**，搬错一个（例如把 `spec`
写进 `purposeNotes`）就会让那次保存悄悄搬走数据且不报任何错。同样做了变异检验。
`formOf` 本来写在 `.tsx` 里（测不到），是为了这条才挪进 domain 的。

#### 删除守卫是**终局**的，文案必须说透

判据是 `batchCountOf`（**全部**状态），**不是** `inStockBatchesOf`。用后者的话，
「药早就吃完了、只剩历史」的药会被放行，然后外键抛一句
`FOREIGN KEY constraint failed` —— 指不到病根的原始报错。

批次永远不删（不变量 8），所以一旦有过批次，删除就**永远**不会成功，哪怕那盒药
早就丢弃了。危险区文案写明了这一点，否则用户会反复试「我先把药全丢弃了再来删」。
按钮**永远可点**（与成员编辑页同一决定）：点了看到一句说清「还差什么」的话，
比一个灰按钮有用。

#### ⚠️ 诚实交代：界面层仍然没有自动化测试

项目现状如此，但这次新增的三张界面里，**编辑页恰恰是「一次误操作能悄悄改真实库存」
的地方**，是本项目最该有界面测试的一页。我把能纯函数化的部分（`formOf`、
`autoWouldChange`）都挪进了 domain 让它们测得到，但**「提示块在正确的时机出现」
这一条至今没有自动化保障**，只能靠人过一遍。

**真机验证做不了**（手机没插，M1 第 9 项还卡着），所以这次**不出包**，
改动留到下一轮装机验收一起验。

---

### 8.7 M4 收尾：暂停服药 / 恢复服药（2026-09-20，commit `3c0abd4`）

**M4 到此没有剩余项了。** `tsc` 干净，**245 条测试全过**（227 → 245，+18）。

这一项原先的状态很别扭：领域规则**早就写好了**（`planRebaseline(…, settleFirst = false)`
那一支，`test/autodose.test.ts` 里也有一条「暂停 10 天再恢复」钉着它），
但**生产代码 0 个调用点**，落库层不存在，界面上只有一个只读药丸。
于是 `autoPaused` 可以被「编辑档案」的关→开清掉，却**没有任何办法把它置上** ——
用户想让一个药停扣，只能把自动扣减整个关掉，而那会先结清、再把起算日推到今天，
语义完全不同。**这是半截功能，不是缺功能。**

| 层 | 文件 | 内容 |
|---|---|---|
| 领域 | `src/domain/medicine.ts` | `transitionError` + `planPause` + `planResume` |
| 落库 | `src/data/medicines.ts` | `pauseMedicine` + `resumeMedicine` |
| 界面 | `app/medicine/[id]/index.tsx` | 自动扣减块里的按钮（开着才显示，按状态换文案） |
| 共用 | `src/ui/components.tsx` | `MiniButton` / `confirm` 从 `stockops.tsx` 提上来 |

#### 🔴 刻意偏离上游：**暂停必须自己先结清**

上游的暂停 handler 只有一句 `med.auto_paused = True`，一行账本都不碰。
它是对的 —— 因为结算来自**请求级的 `_settle` 依赖**（`deps.py:11-20`），
每个请求之前都先把这个药结清到今天。

**本仓库没有那个依赖。** 对应的闸门（`DbProvider` → `settleAll`）只在
**冷启动 / 每次回前台**跑，不是每次操作前跑。照抄上游会漏掉这一段：

> 9/19 上午开门（闸门结算到 9/19）→ App 一直留在前台 → 跨过午夜 →
> 9/20 00:30 用户点「暂停」→ 9/20 那一整天的量**从没被核算过** →
> 恢复时把它一笔勾销

所以暂停自己先结清。关键性质：它与闸门**完全等价、且幂等** ——
闸门今天已经跑过时 `pendingDeduction` 得 0，方案是空的、什么都不写。
换言之这一步**在绝大多数情况下是空操作**，只在上面那种缝隙里才真的扣。
不这么做的代价是**暂停会变成一条抹账的路径**，而 §8.6 已经把这条原则写死了：
旧账是真实发生过的，一笔勾销等于白送用户几天的药。

#### `settleFirst` 那个布尔参数删掉了，改成两个函数

```ts
planRebaseline(med, batches, today)      // 先结清，再重设基线
rebaselineNoSettle(today)                // 只重设，**不收 batches**
```

三点理由：

1. **布尔量在调用点上不携带信息**：6 个生产调用点**全都传 `true`**。
   一个永远为真的参数是噪音，留着只会招人来传 `false`。
2. **`planResume` 收 `inStock` 曾是死参数** —— `false` 那一支的执行体是
   `untouched(med)`，`batches` 从头到尾没被读过。去掉之后，「只重设不结清」
   这条路径**根本没有库存可扣**：误用从「靠纪律」变成「写不出来」。
   与 `Executor` 的 `Pick`、`MedicineFields` 不含账本字段是同一手法。
3. 上游 `rebaseline(db, med, today, *, settle_first)` 是关键字必填无默认 ——
   语义照搬，**接口形状按 TypeScript 的习惯走**。这是接口差异，不是行为差异。

#### 守卫是新增的：两个方向**都**拒绝

上游一行守卫都没有（只判「药不存在」），靠模板 `{% if med.auto_deduct %}` 隐藏按钮。
这里加，是因为两个方向**不对称**：

- 「已经暂停了再暂停」= 无害空操作（`planSettlement` 见到 `autoPaused` 会返回 `untouched`）
- 「**没暂停就恢复**」= 起算日推到今天、账本归零，**而欠账没结清** —— 静默抹账

一条规则管两边（「这是状态转换，不是 setter」）比两条容易记住。

⚠️ **判据顺序是先看目标状态、再看开关**，反了会说假话：一个「先暂停 → 再进编辑档案
关掉自动扣减」留下的行（`autoDeduct=false` 且 `autoPaused=true`）会让 resume 报出
「这个药没有在暂停中」—— 而那一行上 `autoPaused` 明明是 1。**报错可以，说假话不行。**

顺带一句实话：`!autoDeduct` 那一条守卫换来的账本安全性是**零**（那个 flag 本来就不生效，
`planSettlement` 第一个分支就短路了）。它买的是**语义清楚**，不是安全措施。

#### 🔴 `today` 必须取**当场**日期，不能用 `useDb().today`

`DbProvider` 的 `today` 是 `useState(() => todayDay())`，只在冷启动 / 回前台 /
手动 reload 时更新。App 一直留在前台跨过午夜时它停在昨天。

对「取用 / 编辑数量」，后果只是晚一天扣，下一次闸门会补上 —— **自愈**。
对这两个动作是**终局**的：

- **暂停用昨天结算**：今天那片不扣 → 紧接着 `autoPaused = true` → 闸门从今往后
  跳过它 → 恢复时账本又被覆盖成 `(今天, 0)` → **那一片永久消失**
- **恢复用昨天写 `autoFrom`**：下一次闸门按今天算出 days = 1，把停药期的最后一天
  当成吃药的日子扣掉 —— 会真扣药，用户看得见

所以这两个函数的 `today` 默认值是 `todayDay()`，**界面不许传**。这是全项目唯一一处
「日期取错不会自愈」的操作。有一条测试专门钉住这个默认值真的生效
（拿文件顶部那个固定夹具 `TODAY` 去算是错的 —— 默认值取的是**真实当天**）。

#### 已知瑕疵（记录不修）

| 事项 | 说明 |
|---|---|
| **跨单位时暂停不结清** | `planSettlement` 遇单位不统一返回 `untouched(med, true)`，而 `mergeSettlement` **不看** `skippedByUnitConflict` → 方案是空的，**只有标志位落库**。不暂停的话那笔账只是**延迟**（用户统一单位后下次闸门就扣）；暂停之后变成**删除**。**不堵** —— 数据质量问题让用户停不掉药，比少扣几片糟得多。改为**写进确认文案**：「单位不统一时算不出，会跳过」 |
| `queries.ts` 与 domain 各写一份「单位冲突」判据 | `aggregateByMedicine`（`queries.ts:113`）只筛 `status = in_stock`，`inStockBatchesOf`（`stock.ts:60`）多一个 `qty > 0`。当前数据上结果一致，但**不是可证明的同一条规则**。没拿 `d.unitConflict` 去分支文案，正是因为它俩不等价 —— 把一句提示的诚实性建在那上面，是本项目最反对的做法。**没动它** |
| `short` 分支会让暂停一次扣光库存 | `planSettlement` 扣不够时会把盒子转「已用完」。与已经上线的「关掉自动扣减」是同一种暴露，不为它单独加文案 |
| 「先暂停再补货」与「先补货再暂停」当天扣的量不同 | 断货期不计消耗这条规则在新触发点上的显影，不是新问题 |
| **暂停/恢复本身不留痕** | 不写 `stock_events`，`medicines` 表也没有 `updated_at`（硬约束 3 不允许加）。只有产生扣减的暂停能靠 `auto_take` 事件反推。用户问「我上周就暂停了怎么还扣了」时，**数据回答不了** |
| 暂停状态只在详情页可见 | 列表页和首页不标「已暂停」。上游也是（模板只在 `detail.html` 显示），但手机上用户更容易忘 |
| `autoDeduct=true` 且 `dailyDose=null` 的行连暂停按钮都看不见 | 整个自动扣减块包在 `{m.dailyDose ? …}` 里。导入器不校验「勾了自动扣减就得填每日用量」（那条规则只在表单侧的 `validate` 里）。当前数据 **0 例** |

#### 测试（227 → 245）

| 文件 | 条数 | 测什么 |
|---|---|---|
| `test/medicine.test.ts` 的 `describe('暂停 / 恢复')` | 10 | 纯规则：结清但**起算日不动**、幂等空操作、库存 0、**跨单位时方案是空的**（把缺口钉成行为）、恢复一片不扣、已归零时不写账本、暂停期手动取用不被算两次、三条守卫 + 判据顺序 |
| `test/data.test.ts` 的 `describe('暂停 / 恢复')` | 8 | 真 SQLite：扣天+写 `auto_take`+置标志位且账本不动、恢复库存不动、**暂停 → 隔 5 天 → 恢复**走整圈、闸门跳过暂停中的药、`todayDay()` 默认值、守卫失败一行不写、药品不存在、暂停中的药改名后仍暂停 |

**变异检验**（全部还原后 245 条依旧全过）。实际结果与预期不完全一样，如实记：

| 变异 | 结果 |
|---|---|
| `planPause` 不结清 | **6 条红**（预期 1 条 —— 结清被多条独立断言覆盖，比预想的更稳） |
| `planResume` 改用会结算的实现 | ⚠️ **0 条红**，见下 |
| `pauseMedicine` 默认日期写死成过去的某天 | 1 条红 |
| 去掉两条守卫 | 4 条红（预期 3 条） |

⚠️ 第二条**没测出东西来**，值得写下来而不是含糊过去。两个原因：

1. **纯函数层已经写不出来**了 —— 「恢复会结算」这个 bug 在 domain 里**没有载体**
   （`planResume` 拿不到 `batches`），这正是签名改动的目的。
2. 在落库层硬造这个 bug（把 `planRebaseline` 塞进去）**也是空操作** ——
   那一行 `autoPaused` 还是 1，`planSettlement` 第一个分支就返回 `untouched` 了。

也就是说「恢复不补扣」这条性质**被三重机制各自独立地保着**，只改坏一层看不出动静。
（把这个变异改成**像样的错误实现** —— 先解除暂停、再 rebaseline —— 才有反应：
2 条红，正好是断言「库存一片不动」的那两条。）这不算坏事，但**不能因此说
「变异检验证明恢复路径有测试保护」** —— 那句话在这里是假的。

#### 真机验证

手机这几天能插上，所以**这次做完紧接着重新出包**（`bash scripts/android-signing.sh`
+ gradle，见 §8.2），让 M1 第 9 项的装机验收**一次覆盖 §8.6 与 §8.7**。
要手工过一遍的（外公的缬沙坦）：

1. ✅ **2026-09-21 通过** —— 点「暂停服药」→ 确认 → 药丸变「自动扣减已暂停」，按钮变「恢复服药」。
   确认框文案与本文档逐字一致。库侧佐证：`medicines.auto_paused = 1`。
2. ✅ **2026-09-22 早上通过** —— 判据是设置页「变动记录」从 `6` 变成 **`11`**，实测就是 11。
   （**必须先在最近任务里把 App 划掉再打开**：闸门只在冷启动 / 回前台跑（`DbProvider.tsx:100-109`），
   App 整夜留在前台就一次都不扣，那不是 bug。）
   > 🔴 **判据是一个数字，不是「隔天再看库存不再变」。** 后者太软 —— 要同时看 6 个药，
   > 还分不清「没扣」和「闸门没跑」。
   >
   > | 看到 | 结论 |
   > |---|---|
   > | **11** | ✅ 通过 —— 其余 5 个药各扣 1，缬沙坦没扣 |
   > | **12** | ❌ 暂停没生效 → 查 `planSettlement` 第一个分支 |
   > | 仍是 6 | 闸门没跑 → 回上面那句「划掉再打开」 |
   >
   > **2026-09-22 拉库复核（`backup-m6-final.ab`）**：`stock_events` 里 `type='auto_take'` 共 **11** 条
   > = 导入时的 6 条 + 当天结算的 5 条，**缬沙坦那一条不存在** ⇒ 暂停确实生效了。
   > 这一条比「界面上显示 11」硬：它看的是落库的事件本身。
3. ✅ **2026-09-22 早上做过** —— 回详情 → 「恢复服药」→ `起算日` 变**今天**、`已核算消耗` 归 0 → 第二天重新扣。
   这就是 `planResume` 的全部产出，**不必再等一个午夜**。
   > ⚠️ 过了这一步，库里的数就**合法地**小于文件了（停药期作废，`planResume → rebaselineNoSettle`）——
   > **不要再回头核 2118。**
4. ✅ **2026-09-21 通过** —— 暂停中进编辑页改每日用量 1 → 2 → 保存 → **仍是「自动扣减已暂停」**，
   剩余量仍 34 片（`planSettlement` 在暂停分支直接返回，没借机补扣）。改回 1 之后
   首页四格与需补货**一个数字都没动**。
   > ⚠️ **别改成 ≥3**：缬沙坦 34 片，`34/3 = 11.33 ≤ 15` → 首页「库存不足」会变 2 种、
   > 需补货多一行，**打掉两条 golden**。而暂停中的药在首页**仍然**参与需补货判定
   > （`queries.ts` 只看 `dailyDose > 0`，不看 `autoPaused`）。
5. ❌ **2026-09-21 查明：当前数据集够不到。** 这一步要求「有每日用量、但没开自动扣减」的药，
   而全库（和文件里）**一个都没有**：`daily_dose IS NOT NULL AND auto_deduct = 0` 查出来 0 行，
   反过来的组合也是 0 行 —— 两个字段在源数据里永远同进同出。
   所以「整块自动扣减卡片不出现」这条分支**要么等真实数据出现，要么专门造一条测试数据**（一次写操作）。
   记在这里，别误以为它验过了。

---

### 8.8 M6 实施记录：导出 JSON + 在库清单（2026-09-21）

**目标**（§8 里程碑表）：能拿走 —— 用户自己把数据导出成文件。规格见 §7.6。

#### 做了什么

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/exporter/build.ts` | 新增 | 生成 `all.json`。**不 import 任何 expo 模块**，只吃 drizzle 句柄 + 时刻 |
| `src/exporter/report.ts` | 新增 | 生成在库清单纯文本。复用 `src/data/queries.ts` 的现成函数，**零新领域逻辑** |
| `app/export.tsx` | 新增 | **本模块唯一 import expo 的地方**（写文件 + 拉起分享面板） |
| `app/_layout.tsx` | 改 1 行 | 注册 `export` 路由 |
| `app/(tabs)/settings.tsx` | 改 1 处 | 「数据」卡片加「导出 / 备份」入口 |
| `src/importer/parse.ts` | 改 4 行 | 四个 `XXX_KEYS` 加 `export`（**零行为变化**，只为让导出端和测试能比对白名单） |
| `src/importer/apply.ts` | 改 1 处 | 见下「顺带修的一个真 bug」 |
| `src/domain/instant.ts` | 新增 1 个函数 | `toLocalNaiveString` —— `exported_at` 用（§6.2） |
| `test/exporter/` | 新增 4 个文件 | `fixture.ts`（共用落库）、`build.test.ts`、`report.test.ts`、`roundtrip.test.ts` |
| `package.json` | +1 依赖 | `expo-sharing`（用户已拍板，**只加这一个**） |

**测试从 245 / 9 套件涨到 309 / 12 套件**（真机验收时修了那个 `delta_qty = 0` 的 bug，又补了 13 条，最终 **322 / 12 套件** —— 见下），
`npx tsc --noEmit` 与 `npx tsc --noEmit -p tsconfig.test.json` 都干净。

#### 用户拍板的两个选择（不要再动摇）

1. **JSON 怎么到用户手里** = `expo-sharing` 的系统分享面板（不是写进 Downloads 目录）。
2. **在库清单的形态** = **纯文本 `.txt`**，走**同一条**面板。**不加第二个依赖** —— 不做 PDF、不装 `expo-print`、不做 xlsx。
   `requirements.md:358` 明确把格式降级为「实现选择，不是需求」，纯文本在微信里可读、可复制、可打印。

#### 为什么这么分模块

`jest.config.js` 是 `testEnvironment: 'node'`、**故意不用 `jest-expo`** ⇒
`expo-sharing`/`expo-file-system` **在测试里 import 不了**。
于是把全部判断塞进两个纯模块（有 64 条测试盯着），界面只剩「写文件 + 拉面板」这一个不可测的动作。
**能测的部分尽量厚，不能测的部分尽量薄** —— 这条是 M6 架构上的全部要点。

#### 顺带修的一个真 bug（⚠️ 计划外，用户未事先确认）

`src/importer/apply.ts` 里取新 id 用的是 `res.lastInsertRowId`（大写 D），
而**测试驱动 better-sqlite3 给的是 `lastInsertRowid`**（小写 d），运行驱动 expo-sqlite 才是大写 D。
写错的后果是 `NaN` 悄悄混进外键 —— 这个坑 M2 时踩过两次，`src/data/stock.ts` 已经有 `insertedId()` 专门治它，
**但 `apply.ts` 漏网了**（它走的是导入路径，测试覆盖面比库存操作薄）。

**为什么现在才发现**：M6 的往返测试会**真的调 `applyImport`**（前面 245 条都没走到这条路径的真实插入），
于是它第一次被真跑起来。已改成走 `insertedId()`。

#### 实现中发现、已修的三处

1. **`render()` 提前 return，导致「需补货」的药被计数却没被点名。**
   一个库存为 0 的药会进 `需补货 N 种` 的计数，但清单正文里找不到它 —— 家人拿到清单会以为漏印了。
   已把「需补货」块**挪到空库 early-return 之前**。
2. **自相矛盾的数字**：单位混用的药在头部印「约剩 10 天」，而它自己那一组写着「无法估算天数」。
   清单是要**脱离 App 单独发给家人**的文档，里面一处说算不准、另一处给个数字，读的人只会信数字。
   已改成**天数印 `null`**（`需补货 N 种` 的计数不变，与首页对得上）。
   🔴 **这是刻意与首页 / 网页版不同**：`units_conflict` 只挡自动扣减，**不挡补货预测**，
   所以首页和 dashboard 是照印那个数的（那是「4 片 + 6 粒」相加得来的，本就没有意义）。
3. **静态守卫自己漏检**（测试代码的 bug，记下来因为很容易再犯）：
   正则 `/\bdb\.(\w+)/g` 抓不到项目里主流的多行写法 `db\n  .select()` —— 第一版在 `build.ts` 的 5 处查询里只抓到 2 处。改成 `/\bdb\s*\.\s*(\w+)/g`，并加了「至少得抓到一次 `select`」的非空转断言。
   同理，守卫必须打在**去掉注释的源码**上：`build.ts` 文件头那句「不调 `settleAll`」自己就把第一版守卫绊红了 —— 守卫要抓的是**代码**，不是散文。

#### 出包踩的坑

`npx expo prebuild` 之后 `bash scripts/android-signing.sh` 跑过了，gradle 仍然失败 ——
**`prebuild` 把 `android/local.properties` 一起删了**（gitignore 文件，重新生成时不带），
报 `SDK location not found`。已把 `local.properties` 的生成并进签名脚本（它本来就是「补回 prebuild 删掉的东西」），
详见 §8.2。

#### 出包结果

✅ 四步走完（prebuild → `android-signing.sh` → gradle → 验签）：

| 项 | 值 |
|---|---|
| 产物 | `android/app/build/outputs/apk/release/app-release.apk`，**61347642 字节** |
| 时间 | **2026-09-21 13:55** |
| 证书 DN | `CN=medbox, OU=family, O=medbox, C=CN`（**不是** `CN=Android Debug`） |
| SHA-256 | `4CCFB479A2DD77CF…55FEF6D0` —— 与 `keys/medbox-release.keystore` **逐位一致** |
| gradle | `BUILD SUCCESSFUL in 4m 35s`，退出码 0 |

**签名一致 ⇒ 能覆盖安装 ⇒ 数据不丢。** 这是整条链上唯一不能出错的一环（换密钥 = 必须卸载 = 本地库全没了）。

⚠️ 构建日志里出现了 §8.3 那条 CMake 250 字符警告（`cannot be safely placed under this directory`）——
**是警告不是错误**，构建照常 `BUILD SUCCESSFUL`。它只在 `armeabi-v7a` 那半边出现，
`D_/…` 那个前缀说明 §8.3 的 ninja 替换仍然在位。

#### 真机验收（2026-09-22 执行）

装的是**重新出包的版本**（61347726 字节 / 2026-09-22 10:25，`CN=medbox` 指纹与 keystore 逐位一致），
用 **`adb install -r` 覆盖安装**（`firstInstallTime` 不变 ⇒ 库完好）。**为什么重新出包见下「验收扫出的真 bug」。**

| # | 验什么 | 结果 |
|---|---|---|
| 1 | 分享能到微信 + 邮件 + 文件管理器 | ✅（09-21 验过） |
| 2 | **导出的文件真的导得回来** | 🟠 **只能算部分通过** —— 见下 |
| 3 | `exported_at` 是**本地**时间 | ✅ 预览里是 `"2026-09-22T10:32:07"`，状态栏同时刻显示 **上午10:32**（不是差 8 小时） |
| 4 | **导出不改数据** | ✅ 导出前后各拉一次库：**逐字节相同**；`journal_mode` 仍 `delete` |
| 5 | 归一化提示**真的出现且只读** | ✅ 取空阿奇霉素第 #34 盒 → 橙色卡「有 1 盒的状态被改写了 / • 阿奇霉素 · 第 #34 盒」→ 拉库确认那行**还是** `in_stock` + `qty 0` |
| 6 | 取消分享后能再分享一次 | ✅（09-21 验过） |
| 7 | **自检不挡路** | ✅ **（先失败后通过，见下）** |

**验收用的真实数据读数**（三处互相对上，这是第 1/7 项的真正判据）：

| 来源 | 读数 |
|---|---|
| 导出页 JSON 统计 | 成员 3 / 档案 37 / 批次 44 / 变动记录 15 / **库存合计 2113** |
| 在库清单头部 | 在库 **44 盒 / 37 种 · 合计 2113 单位**；需补货 1 种 · 快过期 1 盒 · 已过期 0 盒 · 未填效期 13 盒 |
| `adb backup` 拉库直接查 SQL | `batches` **44** / `medicines` **37** / `members` **3** / `stock_events` **15**；`SUM(qty) WHERE status='in_stock'` = **2113** |

⚠️ **不能对着 golden 核**（基准日 09-16 ≠ 今天，§9.1）。核的是**三者互相一致**。
`2113 = 2118 − 5`（09-22 结算，缬沙坦当日在暂停中，§9.1）。

#### 🔴 验收扫出的真 bug：「标记过期」一次，备份能力就永久没了

**症状**：点「标记过期」之后生成 `all.json`，被 App **自己的运行时自检**拒掉。

**成因**：`planMarkExpired` / `planRestock` 记的是 `delta_qty = 0`（§2.4：这两件事只改状态、不动数量），
而 `parse.ts` 按 `requirements.md` §2.3 的原文**只允许「编辑」为 0**。
于是**App 生成的文件自己解析不过**，自检正确地拦下了它 —— 自检没错，是白名单错了。

**为什么这是「永久」**：`StockEvent` 只增不改不删（硬约束 2），那条 `delta 0` 的事件永远留在库里
⇒ **之后每一次导出都会失败**。用户侧的表现是「点了一下标记过期，以后再也备份不了了」，
而且**卸载重装也修不好**（重装要重新导入，但导出的入口一直是坏的）。
**「能拿走」是 M6 的全部意义**，这个 bug 恰好把它锁死在一次日常点按上。

**修法**（`src/importer/parse.ts`）：`ZERO_DELTA_TYPES = [edit, mark_expired, restock]`，其余类型为 0 仍拒绝。
详细的来龙去脉、以及「为什么两半各自都有测试却谁都没发现」见 §7.2。

**修完重跑**：`npx tsc --noEmit` 与 `tsconfig.test.json` 都干净，`npx jest` → **322 通过 / 12 套件**（原 309），
然后按 §8.2 四步重新出包（`prebuild` → `android-signing.sh` → gradle → 验签）。

**设备上复验**（这一轮的收官动作，也是第 7 项的核心）：

1. 蒙脱石散（在库 1 盒 10 袋）→「标记过期」→ 在库 0，进入「已过期」
2. **导出 → ✅ 成功**（这正是修之前会永久失败的那一步）
3. →「恢复在库」→ 在库 1 盒 10 袋
4. **再导出 → ✅ 仍然成功**
5. 拉库核对账本：`id=14 mark_expired delta=0 after=10`、`id=15 restock delta=0 after=10`，
   该盒最终 `status='in_stock', qty=10` —— **净效果为零，正如对话框自己写的那样「数量不变」**

> ⚠️ **这两步给用户的真实账本留了 2 条永久记录**（`stock_events` 15 条里有 2 条是验收产生的）。
> 盒子的状态和数量**没有变化**，所以只是审计日志多了两行 —— 但这是**动到了真实数据**，不是模拟。

#### 第 2 项为什么只能算部分通过

判据是「把导出的 `all.json` 拉回电脑，用同一份 `parseExport` 再解析一次」。
**这一步没能真的做到**，两个独立的原因各堵死一半：

1. **`adb backup` 拿不到缓存目录。** 实测包里只有 `f/SQLite/medbox.db`、`f/profileinstaller…`、`sp/…`
   —— **没有任何 `c/`（cache）项**，而导出文件正写在 `Paths.cache`（§7.6 界面侧纪律第 3 条）。
2. **MIUI 的分享面板里没有「存到本机文件管理器」这个目标**（只有微信 / 邮件 / 蓝牙 / 小米云盘之类）。
   我的操作纪律是**绝不点任何一个分享目标**（那等于把家里的用药数据发给第三方），
   所以也不能借分享把文件落到可 `pull` 的位置。

**替代证据**（都不等于原判据，但合起来覆盖了它的意图）：运行时自检**已经在真机上拿真实数据跑过**
（导出成功 ⟺ `parseExport` 接受了这份文件）；`test/exporter/roundtrip.test.ts` 用**同一份 fixture**
把「导出 → 解析 → 落库 → 再导出」整条路走通并断言逐字节相等。
**留作下次能验的时候补做**：插一张 SD 卡或换一台非 MIUI 的手机，用文件管理器的「保存到本地」。

#### 已知限制（不改，记下来）

- 🟠 **手机时钟被调早会让导出失败。** `parse.ts` 的不变量 1 检查按**最大 `createdAt`** 挑最后一条事件
  （`>=` 平局判定，§7.6 保命规则 2），而导出端写的是**库里每条事件自己的 `created_at`**。
  如果设备时钟被调到**早于库里已有事件**的时刻再操作，新事件的 `createdAt` 会比旧的小，
  它就不是「最后一条」了，不变量 1 检查会失败 ⇒ 自检拦下导出。
  **要走到的前提**：手动把手机时间往回拨。正常使用不会遇到。
  **为什么不改**：改「挑最后一条」的口径等于改**导入契约**，而 §7.6 的平局判定是文档化的既定行为；
  为了一个要调时钟才触发的场景去动硬约束 5 的判据，风险大于收益。真要改的话应当单独走一轮。
- 🟢 **「恢复在库」会给药品账本重新起算**（`auto_from` = 今天、`auto_accounted` = 0），
  即使这个药**没有每日用量**（`daily_dose` 为 null）。这是 `planRestock` 刻意的顺序
  （`src/domain/stock.ts:420`：**先结清再改状态**，否则恢复的货会被当成旧货一起扣）。
  对没有每日用量的药是空操作。**记在这里是因为**：拉库会看到「一个没设用量的药，起算日却是今天」，
  看着像数据错乱 —— 2026-09-22 我自己就先怀疑了一遍，查了代码才确认是设计。别再去查。

#### 还没做的

- ⏳ **代码尚未提交**（M6 的全部改动都还在工作区）。验收期间**又改了 `parse.ts`**，
  提交前值得单独看一眼 `git diff` 里这一处。

#### M6 真机验收清单（原始判据，留作下次复用的脚本）

⚠️ **不能对着 golden 的数字核** —— golden 基准日是 `2026-09-16`，App 用「今天」（§9.1）。
要核的是**「清单 / JSON 与 App 界面上的数字一致」**，不是某一组固定值。

| # | 验什么 | 判据 |
|---|---|---|
| 1 | 分享能到**微信 + 邮件 + 文件管理器** | 收到的 `all.json` 能被 `jq .` 解析；`.txt` 中文不乱码 |
| 2 | **导出的文件真的导得回来** | 把 `all.json` 拉回 PC，用 `test/fixtures` 那条同一份 `parseExport` 跑解析 |
| 3 | `exported_at` 是**本地**时间 | 与手机状态栏**同一小时**（不是差 8 小时） |
| 4 | **导出不改数据** | 导出前后 `adb backup` 拉库比行数；`journal_mode` 仍 `delete` |
| 5 | 归一化提示**真的出现且只读** | 先取空一盒 → 导出页显示橙色提示 → 拉库确认那行**还是** `in_stock` + `qty 0` |
| 6 | 取消分享后能再分享一次 | 连点两次都能拉起面板 |
| 7 | **自检不挡路** | 取用/用完/丢弃/标记过期/恢复在库/编辑/暂停恢复各走一遍，每步导一次 —— 被挡住时的文案必须指向该去哪改 |

---

## 9. 未决 / 需要澄清

| # | 事项 | 状态 |
|---|---|---|
| 1 | **「给别人用」的语义** | 按 **A**（别人也用药箱管理自己家的药，各自独立数据）理解并设计。若实际意思是 **B**（别人也能看「我家」的药箱），那属于云端同步（`requirements.md` §5 明确不做），需要重新讨论 |
| 2 | **App 图标** | 未做。方向：药箱样式，AI 生成 |
| 3 | **首次切换的时机** | 未定。原则：App 成熟后导一次 JSON 冷切换，之后网页版**封存不再写入** |
| 4 | **git 初始化** | ✅ **已做**（2026-09-16，commit `4487a1e`）。身份已设为 `jiangsx23 <jiangsx23@163.com>`（global），提交时不必再问 |
| 5 | **药品档案 CRUD（新建/编辑/删除）** | ✅ **已完成**（2026-09-18，`716d3de`），见 §8.6。顺带关掉了一条断头路（「单位没填」时界面让用户去「编辑档案」，而那个界面原先不存在） |
| 6 | **M1 第 9 项**（装到小米8 核数量） | 🟢 **2026-09-21 结清** —— 已装机（v0.1.0，`firstInstallTime` 2026-09-21 09:53:38）、已导入（10:04:50）、数字已核。核法是 `adb backup` 把库拉下来直接查 SQL，不是对界面观感。**全部 golden 对上**：3/37/44/6、`SUM(qty)` = **2118**、按成员 16/14/6/1、需补货只有阿托伐他汀 6 天、未填效期 13、无单位混用、**不变量 1 零违例**、`auto_from` 全被重设成导入当天、`journal_mode = delete`、备份包里只有 `medbox.db` 一个文件没有 `-wal`/`-shm`。安装过程记在第 9 项 |
| 7 | **设置页的两个阈值不能改**（90 天 / 15 天） | ✅ **已完成**（2026-09-18，`9f41765`），见 §8.6 |
| 8 | **暂停服药 / 恢复服药**（M4 最后一项） | ✅ **已完成**（2026-09-20），见 §8.7。**M4 到此无剩余项**。已知瑕疵（跨单位时不结清、暂停/恢复本身不留痕）记在该节，不修 |
| 9 | **MIUI 拦住 adb 安装** | 🟢 **2026-09-21 已绕过**（不是「已解决」—— 那道锁还在）。`adb install` 报 `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`，是 MIUI 自己加的锁，**不是我们的包有问题**：开发者选项里的「**USB 调试（安全设置）**」与「**通过 USB 安装**」需要登录小米账号 + 插 SIM 卡 + 联网才肯打开（症状：开关打开后自己弹回关闭）。<br>✅ **绕法：用手机自带的文件管理器点 `/sdcard/Download/app-release.apk` 装。**<br>🔴 **2026-09-22 订正：锁的只是「全新安装」，覆盖安装 `adb install -r` 是好的。** 当天用 `adb install -r app-release.apk` 覆盖装了 M6 的修复版，一次成功（`Success`），`firstInstallTime` 保持 2026-09-21 09:53:38 不变 ⇒ 库里数据完好。<br>⇒ **出包后推手机的正确顺序是：先试 `adb install -r`**（一条命令、不用动手），**只有换签名 / 换 `applicationId` / 首次装机才必须回退到文件管理器那条路**。别再一上来就手点。<br>⚠️ 顺带记一条：**装机后 `applicationId` / 签名就锁死了**。覆盖安装必须是同一把 `keys/medbox-release.keystore`，否则只能先卸载，**卸载会删掉本地库**（没有云端）。 |
| 10 | **App 里没有任何导出 / 备份入口** | 🟢 **2026-09-21 结清（M6），2026-09-22 真机验收完成**，见 §7.6 与 §8.8。设置页 →「导出 / 备份」→ 生成 `all.json` 或「在库清单」→ 系统分享面板发出去（微信 / 邮件 / 文件管理器）。<br>**为什么这条当初值得单列**：后果比看上去大 ——「核一遍数量」这件事**原本只能靠推导**（设置页那四个整表行数 + 首页「在库批次」+ 变动记录条数），因为库在 `/data/data` 里、`ro.debuggable=0` 读不到。2026-09-21 找到的 `adb backup`（见 §4）能读，但它**要求插着电脑**。<br>**现在 `adb backup` 从「唯一的路」降级成「诊断手段」**：日常备份用户自己点两下就行；只在「导出功能本身坏了、要先看看库里到底有什么」时才需要它。**别删掉那段文档。**<br>⚠️ **验收第 2 项只算部分通过**（`Paths.cache` 不在 `adb backup` 范围内、MIUI 面板没有「存到本机」目标）—— 理由与替代证据见 §8.8。**这条限制是真的缺口，别当成已完成。** |
| 11 | 🟠 **取用把一盒取空后，状态仍是「在库」** | 2026-09-21（M6 实现时）发现。`planTake` 只校验 `amount ≤ batch.qty`，**取空之后不转状态**（`src/domain/stock.ts` 只 push `{qty: qtyAfter}`；网页版 `take_from_batch` 同样不转）。于是库里会出现 `in_stock` + `qty = 0`，而 `parse.ts` 的不变量 4 **拒绝**这种行 —— 也就是说**这份数据自己导不出去**。<br>**M6 的处理：导出时归一化成 `used_up` + 在界面上显示（橙色提示卡列出每一盒）**，不改 `planTake`。理由有两条：① 存量数据里可能已经有了，改了 `planTake` 也去不掉导出端的归一化；② 状态机是领域层的事，不该由导出端倒逼着改。<br>**⚠️ 不变量 4 原本拦的是「网页版的老数据」，M6 之前没人发现 App 自己能造出这种行。**<br>**建议后续在 `planTake` 补约 3 行**（`qtyAfter === 0` 时把状态写成 `used_up`，与 `planEdit` / 结算的行为对齐），本轮**不改**。<br>**同源的第二处**：`planEdit` 对「开封后有效期」用的是 `parseOptionalInt`（正则 `^-?\d+$`），**漏了 `> 0` 的校验**，而 `planIntake` 有 —— 所以 `open_life_days = 0` 可以落库，同样导不出去（预检拦下并点名）。也建议后续补。 |
| 12 | 🟠 **手机时钟被调早 ⇒ 导出会被自检拒掉** | 2026-09-22（M6 真机验收）发现。`parse.ts` 的不变量 1 检查按**最大 `createdAt`** 挑「该批次的最后一条事件」（`>=` 平局判定），而导出端写的是库里每条事件**自己的** `created_at`。若设备时钟被调到早于已有事件的时刻，新事件的 `createdAt` 反而更小 ⇒ 它不被认作最后一条 ⇒ 自检失败 ⇒ 导出被拦。<br>**前提是要手动改手机时间**，正常使用碰不到。**本轮不改**：改「挑最后一条」的口径等于改**导入契约**（§7.6 保命规则 2 的平局判定是文档化的既定行为），为一个要调时钟才触发的场景去动硬约束 5 的判据，风险大于收益。<br>真要修的话有两条路（都单独走一轮）：① 不变量 1 改按 `id` 挑最后一条（更符合「写入顺序」的本意，但改的是契约）；② 导出端把 `created_at` 夹到 `max(库内最大 createdAt, 现在)`（不动契约，但会让导出的时间戳不忠实）。**倾向 ①**。 |
| 13 | 🟢 **`delta_qty = 0` 的类型白名单原先写窄了** | 2026-09-22 修，详见 §7.2 与 §8.8。`requirements.md` §2.3 的原文是「**仅「编辑」类型可以是 0**」，**照它写是错的** —— 网页版自己就给「标记过期」「恢复在库」记 0，而 App 侧那两条事件**只增不删**，一次点按就能让导出**永久**被自检拒掉。<br>🔴 **别照 §2.3 的原文改回去。** 正确规则是 `ZERO_DELTA_TYPES = [edit, mark_expired, restock]`。<br>**这条值得单列的理由不是 bug 本身，而是它的形状**：`test/stock.test.ts` 钉住「领域层写 0」、`test/importer/parse.test.ts` 钉住「解析端不许 0」—— **两个测试互相矛盾，却谁也照不到对方**（一个只看方案、一个只看文件）。**中间那条缝就是「App 造的数据喂给 App 的导出」**，M6 的 `roundtrip.test.ts` 现在钉住了它。以后新增领域操作时，**先问一句「它写出来的事件，导出端认不认」**。 |

---

### 9.1 装机验收的「时间窗口」（唯一一次能对上 golden 的机会）

`test/golden.test.ts` 的基准日是 `EXPORT_DAY = '2026-09-16'`（`test/golden.test.ts:31`），
而 App 用的是**今天**。两者**只在导入当天重合**，之后每天三高药各扣 1
（**09-22 例外，只扣 5 个** —— 缬沙坦那天在暂停中，理由见下表）：

| 日期 | 变化 | 打掉哪条 golden |
|---|---|---|
| **09-21（导入当天）** | 全套精确成立 —— **验收只有这一天** | — |
| 09-22 | 2118 → **2113**（见下）；阿托伐他汀「约剩 6 天」→ 5 天 | 「约剩 6 天」 |
| **09-27** | 阿托伐他汀唯一那盒扣空 → 转「已用完」→ 在库批次 **44 → 43**、外公 6 → 5 种、按成员合计 37 → 36 | 在库批次 / 按成员 |
| 10-01 | 格列美脲 25 − 10 = **15 ≤ 15** → 库存不足 **1 种 → 2 种** | 库存不足 |
| 10-02 | 两盒 12-31 进 90 天窗口 | 快过期 **1 → 3** |

> 🔴 **09-22 是 2113 不是 2112。** 那条按「6 个药各扣 1」推出的 2112 是错的，
> 因为那天**缬沙坦胶囊正被暂停着**（M4 真机验收要的跨午夜观察），只该扣 5 个。
> 恢复服药（09-22 早上）之后，从 **09-23 起**才回到每天 6 个。
> **2026-09-22 真机实测 = 2113**（导出页统计 / 在库清单头部 / 拉库查 SQL，三处一致），**这一行已验证**。

⚠️ **09-27 那条不是线性的「每天少 6」，是一盒药被扣空、状态转「已用完」的结构性变化。**
那天看见「在库批次 43」不是 bug，别去查。

**不受时间影响的只有导入预览 / 结果页那 5 个数** —— 它们读文件（§7.2），不读库。

> 🔴 **验收前先确认「今天 = 导入日」。** 设置页「上次导入 · 时间」不是今天，就别再对着
> §9 第 6 项里那串数字核了 —— 你看到的差异是时间在走，不是代码坏了。

---

## 10. 上游文件与工具位置

| 资源 | 路径 |
|---|---|
| 产品需求（权威） | `D:\Documents\medbox\medbox-app\docs\requirements.md` |
| 差异清单 | `D:\Documents\medbox\medbox-app\docs\app-migration.md` |
| 网页版数据 | `D:\Documents\medbox\medbox-app\data\medbox.db` |
| **迁移源文件** | **`D:\Downloads\all.json`** |
| 可搬的纯函数 | `medbox-app/app/services/{expiry,forecast,autodose}.py` |
| 可翻译的测试 | `medbox-app/tests/test_{expiry,forecast,autodose}.py` |
| **要读但不能搬的** | **`medbox-app/app/templates/`**（UI 行为契约只在这里，见 §6.3） |
| 暖居风格参考 | `medbox-app` commit `aab6f92` |

**网页版跑起来的方式**（只在需要重新导出数据时用）：

```bash
cd D:/Documents/medbox/medbox-app
.venv/Scripts/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000
# 导出：浏览器打开 http://127.0.0.1:8000 → 设置 → 导出全量 JSON
```

> ⚠️ **`../medbox-app` 一行都不能改**（用户明确要求：两个独立项目，混在一起太混乱）。
> 导出功能网页版**已经有**（`/export/all.json`，`version: 1`），所以这条约束完全成立，不需要任何妥协。
