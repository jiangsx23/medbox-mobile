# medbox-mobile

「家庭药箱」手机 App。**数据只在手机本地**的安卓 App（将来可加 iOS），是 `../medbox-app`（网页版）的继任者。

## 首先读这个

**`DESIGN.md`（本目录）是完整的实施依据** —— 全部已锁定决策、刻意偏离上游需求之处、风险清单、实现规格、M1 清单都在里面。动手前必读。

上游文档（在 `../medbox-app/docs/`）：
- `requirements.md` —— **产品需求，领域规则的权威来源**（平台无关，直接照做）
- `app-migration.md` —— 网页版 → App 的差异清单与迁移路径

> ⚠️ **`DESIGN.md` 与上游文档冲突时，以 `DESIGN.md` 为准**（它记录了看过实际代码与数据后刻意改掉的东西）。

## 硬约束（违反任何一条都会出事）

1. **`../medbox-app` 不改已有代码；新增只限于运行/启动类脚本或文档**（如 `start.sh`）。
   两个独立项目，不共处一个仓库。网页版只在需要重新导出数据时才跑起来。
2. **`StockEvent` 只增不改不删**（不变量 8）。纠错靠新增一条「编辑」事件，不修改历史。
3. **不预留任何同步字段。** 单机形态，一台设备。`StockEvent` 是只增的，给它加 `updated_at` 是概念错误。
4. **SQLite 必须显式关掉 WAL** —— 否则多出 `-wal`/`-shm`，破坏「备份 = 一个文件」这条产品承诺。
5. **导出的 JSON 严格保持 `version: 1` 格式**（与网页版 `/export/all.json` 双向兼容）。这是永久退路。
6. **导出/下载路径绝不触发自动扣减结算。** 下载文件不该悄悄改数据（网页版 `app/main.py:39` 刻意不挂依赖）。
7. **不做**：账号、登录、云同步、多设备、条码扫描、医疗建议、服药打卡、多药箱（`requirements.md` §5）。

## 技术栈

Expo (React Native) + TypeScript + `expo-sqlite` + **Drizzle ORM**

选 Expo 的决定性理由：iOS 那一步**只有 Expo 能从 Windows 出包**（EAS Build 云构建）。Flutter 到时候必须买 Mac。

## 关键实现规则（详细版见 DESIGN.md）

- **磁盘是真相**：`Batch.qty` 必须 == 该批次最后一条 `StockEvent.qty_after`（存量数据例外，见 DESIGN.md §6.9）。
- **插入后取新 id 一律用 `src/data/stock.ts` 的 `insertedId()`**，别写 `res.lastInsertRowId` ——
  两个驱动的键名大小写不同（测试上小写 d、App 上大写 D），写错的表现是 `NaN`。这个坑踩过两次。
- **不要在事务里再开事务。** 独立操作调 `applyPlan(db, …)`；已经在事务里就调 `applyPlanOn(exec, …)`。
  类型上已经拦住了（`Executor` 用 `Pick` 去掉了 `transaction`），但别去绕它 —— 见 DESIGN.md §8.6。
- **结算时机**：冷启动 + 每次回前台 + **任何读库存的界面渲染之前**。幂等，多跑无害。**没结算完不许渲染库存数字**，否则同一份数据在不同页面会自相矛盾。
- **日期口径**：日历日（`auto_from`/`expiry_date`/`opened_at`，JSON 里是 `'2026-09-15'`）与时刻（`created_at`，JSON 里是 **UTC naive**）**必须分开**。算天数用日历日相减，别拿时刻除以 86400。
- **导入的 7 个坑**见 DESIGN.md §7.2。最容易出事的两个：🔴 `auto_from` 要重设为导入当天（否则 6 个三高药会被一次扣爆）、🔴 `created_at`/`updated_at` 按 **UTC** 解析而 `exported_at` 要**丢弃**。
- **取用与编辑对账本的作用方向相反**（`requirements.md` §3.6）：取用 → `已核算消耗量 += k`、起算日不动；编辑数量 → 以今天为新起算日。改剂量/开关要**先用旧参数结清**再赋新值（顺序反了会一次补补扣一大笔）。

## 构建配置

| 项 | 值 |
|---|---|
| `applicationId` | `com.medbox.family`（**装到手机后不能改**） |
| 桌面名 | 家庭药箱 |
| `minSdkVersion` | 24（Android 7.0，RN 0.76+ 的下限，免费拿到） |
| `targetSdkVersion` | 36（Android 16） |
| ABI | universal APK（`armeabi-v7a` + `arm64-v8a`），32/64 位都能装 |

出包命令顺序、本机工具链路径、`prebuild` 会删掉 `android/` 的坑：见 `DESIGN.md` §8.2。

🔴 **签名密钥在 `keys/medbox-release.keystore`，别删。** 它不进 `android/`（`expo prebuild` 会把 `android/` 整个删掉重建），所以每次 prebuild 之后必须跑 `bash scripts/android-signing.sh` 把签名配置补回去。**换密钥 = 已装的 App 无法覆盖升级 = 必须卸载 = 本地数据库全丢。**

## 目标设备

**小米8**（codename `dipper`），骁龙845，6GB RAM，**arm64**，**Android 8.1（API 27）**，
**MIUI 10.0.11.0**（⚠️ 2026-09-20 实机读出来是 V10，与文档原先记的「出厂 9.5.6 从未升级」不符 —— 升过级）。

- Android 8.1 **支持**（Expo SDK 54–57 要求 Android 7+，RN `minSdk` 24）。
- 8.1 反而更省事：**不需要** `POST_NOTIFICATIONS` 运行时权限、**不需要** `SCHEDULE_EXACT_ALARM`。
- 🔴 **MIUI 会杀定时通知。** 装好后要走四步白名单（省电无限制 / 自启动 / 锁后台 / 通知设优先），App 里要做「通知自检」引导页。详细步骤见 DESIGN.md §6.6。
- ⚠️ **Android 13+ 的通知权限流程、12+ 的精确闹钟权限，在这台设备上永远测不到** —— 给新手机用户前必须真机实测。

## 数据

- 迁移源文件：**`D:\Downloads\all.json`**（33848 字节，`version: 1`，导出于 2026-09-16）
- 网页版数据：`../medbox-app/data/medbox.db`
- 实测：37 个药品 / 3 个成员（外公·妈妈·孩子）/ 44 条在库批次（全部 `in_stock`）/ 6 条变动记录 / 合计 **2118** 单位
  - ⚠️ 曾经记的是 2124。差的 6 正好是 6 条 `auto_take` 各扣 1 —— 时间戳显示，**是「导出」这个动作本身触发了惰性结算**（事件 05:23:53Z，`exported_at` 13:23:58 = +8h），5 秒后写出的文件。**以文件为准（2118），网页版界面上的数会偏大。**
  - 另有 13 条在库批次**没有效期**（44 条里），界面显示灰药丸 —— 那是源文件就没填，不是导入丢了。
- **6 个开着自动扣减的药**（全是外公的三高药，`auto_from='2026-09-15'`、`auto_accounted=1`）：缬沙坦胶囊、阿托伐他汀钙片、盐酸二甲双胍缓释片、阿司匹林肠溶片、苯磺酸氨氯地平片、格列美脲片

## 测试

把上游的领域规则逐条翻译成 TypeScript 测试（约 45 条）。**这是唯一不该省的工程投入** —— 自动扣减账本是唯一「算错了用户看不出来、还会静默改真实库存」的地方。

| 上游测试 | 行数 | 条数 | 处理 | 状态 |
|---|---|---|---|---|
| `tests/test_expiry.py` | 69 | 11 | 原样翻译 | ✅ `test/expiry.test.ts` |
| `tests/test_forecast.py` | 87 | 5 | 4 条纯函数 + 1 条集成测试重写 | ✅ `test/forecast.test.ts` |
| `tests/test_autodose.py` | 409 | 34 | 规则照搬、测试代码重写 | ✅ `test/autodose.test.ts` |
| `tests/test_migrate.py` | 180 | 9 | ❌ 网页版专用，作废 | — |

**已落地 245 条**（`npx jest`，9 个套件）。其中 **`test/golden.test.ts` 钉住 M1 的验收数字**
—— 装机后对着它核，别凭印象。

`test/data.test.ts` 与 `test/helpers.ts` 是**额外的**：上游没有对应物，测的是**落库层在真 SQLite 上**
的往返（外键、NOT NULL、事务、驱动差异）。建库方式见 `test/helpers.ts` 文件头。
`test/settings.test.ts` 与 `test/medicine.test.ts` 同理（上游那两个页面没有测试）。

> ⚠️ **测试驱动与运行驱动不是同一个**（better-sqlite3 vs expo-sqlite）。
> 两边行为有差异，所以**测试全绿不等于真机不炸** —— DESIGN.md §8.6 那个
> 嵌套事务的坑就是这样漏过去的。能靠类型排掉的，别靠纪律。

## 当前进度

- **M1 代码部分完成**（`4487a1e`）：骨架 + 本地库（关 WAL）+ JSON 导入 + 首页 + 药品列表/详情
- **M2 完成**（`0666cf2` + `22374f8`）：入库 + 五种库存操作 + 成员管理
  （含**提前并入的自动扣减结算** —— 这是刻意偏离里程碑顺序，理由见 DESIGN.md §8.4）
- **M3 完成**（`c77fec6` + `70c9bd6`）：效期分档 + 补货预测的测试全部落地
- **设置页阈值可改 + 药品档案 CRUD**（`9f41765` + `716d3de`，2026-09-18）：
  关掉了「单位没填时让用户去『编辑档案』，而那个界面不存在」这条断头路。
  顺带把 M4 的「每日用量编辑界面」那半边做完了（**刻意越界，用户已确认**）。见 DESIGN.md §8.6
- **M4 完成**（2026-09-20）：暂停服药 / 恢复服药 —— 领域 + 落库 + 界面 + 18 条测试。
  关键一处**刻意偏离上游**：上游靠请求级 `_settle` 依赖结算，本仓库的闸门只在冷启动/回前台跑，
  所以暂停**自己先结清**（否则跨午夜那一整天的量会被恢复动作一笔勾销）。
  已知瑕疵（跨单位时不结清、暂停/恢复本身不留痕）见 DESIGN.md §8.7

`tsc` 干净、**245 条测试全过**。**新 APK 已出并验签**
（`android/app/build/outputs/apk/release/app-release.apk`，61 MB，**2026-09-20 14:19**
—— 含 §8.6 + §8.7 的全部改动；指纹与 `keys/medbox-release.keystore` 一致）。

### 🟠 唯一还卡着的一件事：M1 清单第 9 项 —— 装机验收

**手机已经连上了**（`adb devices` → `bfee7f5  device  product:dipper`，实机 Android 8.1 / arm64 与
DESIGN.md §4 一致），APK 也已推送到手机的 `/sdcard/Download/`。现在卡在 **MIUI 自己的安装锁**：

```
INSTALL_FAILED_USER_RESTRICTED: Install canceled by user
```

解法是开发者选项里的「USB 调试（安全设置）」+「通过 USB 安装」，而 **MIUI 要求 SIM 卡 + 小米账号 + 联网**
才肯打开 —— 本机暂时办不到。详见 DESIGN.md §9 第 9 项（含验收要对的全部数字）。

这是唯一能证明「电脑上过 ≠ 手机上过」这一步不成立的办法 ——
而 DESIGN.md §8.4 记的那个驱动键名 bug 恰好说明了这两个环境**真的不一样**。

（曾经的 260 字符路径卡点**已解决** —— 换掉 Android SDK 自带的旧 ninja 即可，
完整步骤与「为什么网上说的挪短路径/云构建在我们这儿全都无效」见 DESIGN.md §8.3。
重装 SDK 或新增 CMake 版本后**必须重做**，否则报错原样回来。）
