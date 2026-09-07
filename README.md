<div align="center">
  <img src="./public/icon/128.png" alt="PixivPulse icon" width="112" height="112" />

# PixivPulse

**让每一次真实采样，都成为可回看的创作增长轨迹。**

一个面向 Pixiv 作者的本地优先增长分析扩展。<br />
在浏览器内追踪全部作品的浏览、收藏、获赞、评论、排名与粉丝变化。

[下载最新版](https://github.com/Zenith-Angle/PixivPulse/releases/latest) · [安装指南](#安装) · [功能概览](#你会得到什么) · [数据与隐私](#数据与隐私) · [参与开发](#从源码构建) · [更新日志](./CHANGELOG.md)

[![Release](https://img.shields.io/github/v/release/Zenith-Angle/PixivPulse?display_name=tag&sort=semver&style=flat-square&color=0096fa)](https://github.com/Zenith-Angle/PixivPulse/releases/latest)
[![Chrome 120+](https://img.shields.io/badge/Chrome-120%2B-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](#安装)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-1f2937?style=flat-square)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white)](#质量与验证)
[![License](https://img.shields.io/badge/license-MIT-2ea043?style=flat-square)](./LICENSE)

</div>

> [!IMPORTANT]
> PixivPulse 使用你当前浏览器中已登录的 Pixiv 会话，只读取作品数据，不会点赞、收藏、关注、评论、投稿或修改作品，也不上传 Cookie。看板分析在本地完成；可选 Agent 功能会将对话和你允许查询的数据发送至自己配置的 API 服务。

![PixivPulse 总览演示，使用内置预览数据](./docs/assets/dashboard-overview.png)

<p align="center"><sub>内置预览数据 · 不包含真实 Pixiv 账号或作品</sub></p>

## 为什么是 PixivPulse

Pixiv 的作品管理页擅长展示当前数字，却很难回答作者更关心的连续问题：今天究竟增长了多少，哪件作品正在加速，收藏转化是否改善，一段时间后还能不能回看当时发生了什么。

PixivPulse 把每轮只读观察保存为本地时间序列，并让总览、作品库、对比、排名和洞察共享同一套北京时间口径。第一次同步建立基线，之后每一次成功采样都让趋势更清晰。

| | PixivPulse 的选择 |
| --- | --- |
| **全部作品，而非少量近期投稿** | 串行读取作者自己的插画、漫画与小说管理数据，统一进入作品库。 |
| **增长，而非只有累计值** | 记录观察批次与指标快照，区分“没有变化”和“没有采样”。 |
| **本地优先** | IndexedDB 保存作品、历史、运行记录与封面；分析不经过第三方服务。 |
| **统一时间语义** | “今日”固定为北京时间自然日，“近 24 小时”保留为独立滚动范围。 |
| **克制的自动化** | 固定北京时间刻度执行，手动同步不改变时刻表，失败后不密集重试或补跑。 |
| **可带走的数据** | JSON / CSV 导出、导入预览、账号一致性检查与 SHA-256 完整性校验。 |

## 你会得到什么

### 一眼读懂创作组合

- 浏览、收藏、获赞、评论四项总量与所选时间范围增量；
- 粉丝增长、作品集动量、Pixiv 排名和规则型洞察；
- 今日、近 24 小时、近 3 / 7 / 30 天、近 3 个月、全部与自定义范围；
- 真实时间轴、缩放、密集点降采样和范围联动。

### 找到正在变化的作品

- 宫格 / 列表双视图、关键字搜索、多维排序与正逆序切换；
- 单作详情中的完整指标曲线、采样质量与最近变化；
- 最多五件作品并排比较，可切换绝对值与增长值；
- 在 Pixiv 作品管理页直接显示当天浏览、赞、收藏与评论增长条。

![PixivPulse 作品库演示，使用内置预览数据](./docs/assets/dashboard-works.png)

### 让历史可恢复

- JSON 与防公式注入 CSV 均可导出、预览并合并导入；
- 缩略图使用独立本地缓存，导入后可按源地址重新建立；
- 历史跨过完整保留窗口前，先写出可导入备份并完成回读与哈希校验；
- 事务内复验失败、目录失权或数据竞争时，保留原始记录并暂停有损整理。

## 安装

当前发布版本是 **v0.5.8**，安装包见 [Releases](https://github.com/Zenith-Angle/PixivPulse/releases) 为准，要求 **Chrome 120 或更高版本**。项目尚未上架 Chrome Web Store，需要以已解压扩展方式安装。本次发行包已包含 Agent 功能。

1. 从 [GitHub Releases](https://github.com/Zenith-Angle/PixivPulse/releases/latest) 下载 `pixiv-pulse-v0.5.8-chrome.zip` 和 `SHA256SUMS.txt`。
2. 可选但推荐：核对 ZIP 的 SHA-256。

   ```powershell
   Get-FileHash .\pixiv-pulse-v0.5.8-chrome.zip -Algorithm SHA256
   ```

3. 将 ZIP 完整解压到一个不会被清理的目录。
4. 在 Chrome 打开 `chrome://extensions`，开启右上角的“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择刚刚解压的目录。
6. 登录 Pixiv，点击工具栏中的 PixivPulse 图标，执行第一次同步以建立本地基线。

> [!NOTE]
> 升级时先备份重要数据。解压新版本后，在扩展管理页对原扩展执行刷新；不要直接选择 ZIP，也不要把 `.output`、版本 ZIP 或临时目录当作日常安装源。

## 同步如何工作

```text
当前 Chrome 的 Pixiv 登录会话
              │
              ▼
   作者账号 / 插画 / 小说只读数据
              │  串行、限速、遇阻即停
              ▼
       完整轮次暂存与一致性检查
              │  仅完整成功后提交
              ▼
 IndexedDB 快照 ──► 本地图表、对比与洞察
              │
              └──► JSON / CSV / 抽稀前备份
```

自动同步默认每 1 小时，可调整为每 30 分钟或更长间隔。时刻表对齐北京时间固定刻度，例如 30 分钟模式依次运行于 `00:00`、`00:30`、`01:00`；手动同步不会把下一次自动同步向后推移。

后台读取失败时，扩展可以打开一个临时 Pixiv 作品管理标签页并在完成后关闭。遇到人机验证、限流、会话失效或页面结构变化时会立即停止并进入冷却；浏览器关闭或设备休眠期间不会采集，恢复后最多处理一次待执行时段，不会产生追赶式请求。

## Agent 分析（源码 0.5.10）

在完整看板左侧打开 **Agent 分析 → 连接配置**。默认使用 DeepSeek 官方 Responses API：

| 配置 | 默认值 |
| --- | --- |
| Base URL | `https://api.deepseek.com` |
| API 协议 | Responses API |
| Model name | `deepseek-v4-flash`（可自行修改或获取模型列表） |
| API key | 用户自行填写 |
| 上下文窗口 | 1,000,000 tokens |
| 最大输出 | 8,192 tokens |

1. 填写 API key，按需要勾选“允许 Agent 查询本地作品和历史数据”。
2. 点击“测试连接与工具调用”：它会执行工具请求、结果回传和最终回答两次 API 调用，不发送作品数据。
3. 保存配置并关闭配置页，提问例如“最近 7 天哪些作品增长最快？说明实际采样范围”。
4. 展开回答下方来源，核对 `[S1]` 等对应的原始查询结果与时间戳。

支持自定义 Base URL、模型、两种 API 协议、上下文窗口、最大输出、Temperature、超时、工具轮数和回答偏好。兼容模式可切换 `max_tokens` / `max_completion_tokens`。本机 HTTP 服务可不填 key；远程服务需 HTTPS。没有 `/models` 接口的服务也可以手动输入模型名。

Agent 提供 10 个本地统计工具，覆盖概览、搜索、历史、增长排行、绝对指标/收藏率排行、多作品比较、粉丝、数据质量、系列/内容类型汇总和一站式简报。排行在本地对全体作品计算，只发送有限结果；不会用逐页读取全部历史来代替聚合。

0.5.1 支持最多 3 个对话同时生成，切换对话或新建对话会退出连接配置；草稿和停止操作按会话隔离。分类预设随可用数据变化，最多 32 个问题，覆盖快速判断、转化、增长、内容结构、粉丝、数据可信度及原文采样。

自动证据记忆默认开启：只缓存确定性的工具结果，按实际作品/样本/运行/粉丝数据的 SHA-256 指纹及账号隔离，数据变化即失效，24 小时过期，全库最多 40 条 / 256 KB。可关闭或清除，不改变作品原始数据、备份、迁移和保留策略。指标分析自动提供精简概览，简单统计可一次请求完成。新配置的单次输入、单问累计预算和工具轮数默认填 0，表示不设应用额外上限；仍按模型窗口预留输出空间，无新证据时结束重复调用。可填写有限预算（保守 UTF-8 字节估算，不是账单 tokens）；用量显示请求次数、记忆命中和服务商缓存输入。

**小说原文采样**需另外勾选“允许按需采样 Pixiv 小说原文”，同时开启数据分享。`sample_novel` 工具 可按开头/中段/结尾、三段均衡或指定关键词抽样。扩展先复用本地片段缓存或已打开的作品页，否则使用现有 Pixiv 登录态请求固定的小说正文接口，不新建标签页。默认自动档按可用上下文分配，不设固定字数或比例上限，短篇可能覆盖全文。也可选择轻量（1,500 字 / 30%）、标准（3,000 字 / 50%）、深入（6,000 字 / 70%）或自定义更大字数及 1–100% 比例；上限按每问每篇累计。没有固定三篇配额，可按问题批量读取多篇。只发送实际采样文本、位置、时间及覆盖率；结果按配置缓存。

0.5.2 增加 **自动 / 正文优先 / 指标优先**。自动模式按问题及最近追问选择；用户可以覆盖判断。正文优先不自动发送统计总览，不提供粉丝及原始历史工具，统计工具证据限制约 2.4 KB，正文证据使用扣除历史、指令、工具定义和输出预留后的可用上下文。这些是工具证据预算，不是整份 API 输入的正文占比；系统指令、工具定义和历史仍占空间。普通指标问题保持原有聚合能力。

正文分析可先用 `select_reading_samples` 选择不同系列、独立作品和篇幅区间的候选，再用 `read_content_samples` 按要求批量读取已定位作品的均衡片段，多篇共享预算。候选选择不等于统计代表性；先从正文识别故事、章节、公告等文体，再讨论题材、角色目标与关系、情境规则、冲突、推进、节奏及回报。只作有来源的非露骨分析，不根据标题猜剧情，不把片段空白当作情节漏洞。

预设增加“角色与叙事”“创作决策”，要求说明具体位置、编辑建议、替代解释及验证方式。这里的“学习”是当前账号本地证据的复用与随问题选择样本，不是训练模型，也不会将某个用户的角色、作品名称或偏好固化成开源默认值。长篇与公告的字数口径以本次实际采样字符数为准，管理页报告字数仅用于选样参考。

采样缓存按账号、作品和采样方式隔离，24 小时内复用，可要求刷新；远端修改在重新采样后体现。缓存中的覆盖率仅针对已加载正文，不代表多页全文或系列覆盖率。未登录、访问限制或页面结构变化会明确返回失败，不绕过限制；不具备图片理解或跨章节完整长篇阅读保证。工具不会点赞、关注、评论、修改 Pixiv 数据，也不执行任意代码或文件写入。

对话支持流式 Markdown 与表格、多会话、连续追问、停止、重新生成、Markdown 导出与来源展开。同一对话跨标签页生成使用互斥锁；切换看板继续生成，关闭标签页则中断。请求失败、输出截断、超时、上下文超限都会显示明确状态；不会自动重试付费请求。上下文采用保守字节估算，较早对话按完整轮次省略，历史不删除；本轮工具结果超预算时返回缩小查询提示。

接入依据（2026-09-07 核对）：[DeepSeek Responses 指南](https://api-docs.deepseek.com/guides/responses_api/)、[模型参数](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[OpenAI 工具调用](https://developers.openai.com/api/docs/guides/function-calling)、[Open WebUI 协议连接设计](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/)。DeepSeek Responses 是无状态接口，因此本地回传消息及工具结果，不使用 `previous_response_id`。

开发者可运行 `node scripts/agent-acceptance-server.mjs`，在 `http://127.0.0.1:4175/dashboard.html` 使用 Base URL `http://127.0.0.1:4175/v1`、Responses 协议和模型 `acceptance-fixture` 检查本地协议链路。该服务是明确标记的确定性验收夹具，不是真实模型，不用于评估回复质量。真实 DeepSeek 验收需用户提供有效 key，并在扩展里运行连接测试及作品提问。

也可运行 `node scripts/verify-agent-live.mjs <本地密钥文件路径>`：密钥文件支持纯文本或 JSON 的 `api_key` / `apiKey` / `key` 字段。该检查直接运行生产 Agent 模块，通过真实 DeepSeek 完成连接验证、两轮工具分析和数值核对，只发送明确标记的演示数据；脱敏报告保存在 `output/agent-live-acceptance.json`。

另可运行 `node scripts/verify-agent-efficiency.mjs <本地密钥文件路径> <原生作品备份路径>` 验收真实数据的单次总览、跨会话记忆及聚合分析。此命令会将有限的真实作品证据发送至 DeepSeek，报告保存在 `output/agent-052-live.json`。

## 数据与隐私

| 数据 / 能力 | 用途 | 离开设备？ |
| --- | --- | :---: |
| 作品指标、粉丝样本、同步记录 | 生成历史、对比与洞察 | 看板不会；开启 Agent 数据分享后按需发送 |
| 原文采样片段 | 按需分析已加载的小说正文 | 需独立授权，只向所选 API 发送有限片段 |
| Agent 对话、工具查询结果 | 模型分析与连续对话 | 发送至用户配置的 API 服务 |
| API key | 访问所选模型 | 仅发送至所选 API 地址，不包含 Pixiv Cookie |
| 可选 API 域名权限 | 自定义 HTTPS 服务或本机 HTTP 服务 | 保存/测试时仅申请所选域名 |
| 作品缩略图 | 本地作品库与详情展示 | 仅从 Pixiv CDN 读取 |
| `storage` / `unlimitedStorage` | 保存本地历史与设置 | 否 |
| `alarms` | 驱动固定时刻自动同步与低频修复 | 否 |
| `www.pixiv.net` 主机权限 | 使用当前会话读取作者自己的管理数据 | 请求 Pixiv |
| `i.pximg.net` 主机权限 | 获取作品缩略图并写入本地缓存 | 请求 Pixiv CDN |

- 不含遥测、广告、第三方分析、远程脚本或 PixivPulse 云端账号。
- 设置和可恢复同步状态保存在 `chrome.storage.local`；业务数据保存在扩展自己的 IndexedDB。
- Agent 配置与对话使用独立的扩展 IndexedDB；API key 默认仅存当前标签页会话，勾选“在本机记住”后未加密保存。作品 JSON 备份、CSV 和对话 Markdown 导出均不包含 API key。对话按 Pixiv 账号隔离，单独导出、删除，不进入作品备份；清空作品数据不会删除 Agent 对话。
- 近 3 天变化点完整保留；3–7 天保留到每 30 分钟，7–30 天保留到每 1 小时，30 天以上保留到每 6 小时。
- 抽稀前备份目录由你明确授权；建议在个人文档目录中建立 `PixivPulseBackups` 文件夹。
- 导出文件是明文且不加密；SHA-256 用于发现损坏或意外修改，不等同于加密保护。
- 卸载扩展会删除浏览器保存的本地数据。需要长期保留时，请先导出 JSON 备份。

## 已知边界

1. 第一次同步只能建立基线，无法倒推出安装前的每日增长。
2. “浏览量”来自 Pixiv 作品管理页，不等同于 Pixiv Premium“流量分析”中的详情页浏览量。
3. Pixiv 没有为此用途提供稳定的公开 API；站点接口或页面结构变化后，解析器可能需要更新。
4. 浏览器关闭、设备休眠或扩展后台未运行时不会采集，因而图表只代表实际完成的观察。
5. 缩略图来自 `i.pximg.net`，网络失败时会显示本地占位图。
6. 任何自动化访问都可能受到站点规则、限流或风控调整影响；请根据自己的账号与使用环境谨慎设置频率。
7. 单轮同步设置了 10,000 件作品、200 个分页区间、单响应大小与超时等安全上限；超大作品库触及上限时会停止，而不会把不完整结果提交为成功快照。

## 从源码构建

需要 Node.js 22+、npm 与 Chrome 120+。

```powershell
git clone https://github.com/Zenith-Angle/PixivPulse.git
cd PixivPulse
npm ci
npm run verify
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 构建固定开发目录 `.extension-dev/chrome-mv3` 并校验安装产物 |
| `npm run typecheck` | 运行 TypeScript 静态检查 |
| `npm test` | 运行 Vitest 测试套件 |
| `npm run build` | 生成 Chrome MV3 生产构建 |
| `npm run zip` | 生成可发布 ZIP |
| `npm run verify` | 顺序执行类型检查、测试、生产构建、ZIP 与固定开发构建 |

开发时只把 `.extension-dev/chrome-mv3` 加载为已解压扩展。这个目录使用固定扩展身份且完全自包含，不依赖开发服务器；每次构建后在 `chrome://extensions` 刷新即可。

## 项目结构

```text
PixivPulse/
├─ entrypoints/        # MV3 后台、Dashboard、Popup 与 Pixiv 页面脚本
├─ src/
│  ├─ data/            # IndexedDB、备份、导入、帧存储与同步状态机
│  ├─ domain/          # 时间、指标、解析、策略与纯业务规则
│  ├─ media/           # 封面下载队列、缓存数据库与恢复逻辑
│  └─ ui/              # React 界面、图表、作品分析与预览数据
├─ tests/              # Pixiv 页面解析与内容脚本测试
├─ scripts/            # 图标生成、安装构建校验与本地数据维护工具
├─ public/             # 扩展图标
└─ wxt.config.ts       # WXT / Manifest V3 配置
```

## 质量与验证

项目使用 TypeScript、Vitest、Testing Library、JSDOM 与 fake-indexeddb 覆盖核心路径，包括：

- Pixiv 页面解析、账号绑定、同步分页与失败分类；
- 北京时间日界、固定时刻调度、恢复与重复时段抑制；
- 快照、观察批次、紧凑帧、时间抽稀与事务安全；
- JSON / CSV 校验、导入预览、账号冲突与合并提交；
- 封面队列、容量门禁、缓存恢复与 UI 数据流；
- 总览、作品库、比较、Popup、图表选项与响应式呈现。

发布前的标准门禁是：

```powershell
npm run verify
```

## 参与项目

欢迎通过 [Issues](https://github.com/Zenith-Angle/PixivPulse/issues) 提交可复现的问题、Pixiv 页面结构变化或改进建议。请勿在 Issue、日志或截图中附带 Cookie、授权头、完整账号导出或其他敏感信息。

提交代码前请确保 `npm run verify` 通过，并让改动保持在清晰、可审查的范围内。

## 许可证与声明

PixivPulse 以 [MIT License](./LICENSE) 开源。运行时依赖的版权与许可证见 [Third-Party Notices](./THIRD_PARTY_NOTICES.md)；构建脚本也会把相应许可证文本放入发布包。

Pixiv、pixiv 标识及相关服务归 pixiv Inc. 所有。PixivPulse 是独立开发项目，与 pixiv Inc. 无隶属、授权、背书或官方合作关系。

<div align="center">
  <sub>Built for creators who want their own data to remain useful, understandable, and local.</sub>
</div>

对话消息下方可复制原始 Markdown、重新编辑问题、引用回答追问或导出本轮。回答的“从此处重试”和“重新生成”都会创建新分支，原回答和后续历史保留。采样深度限制按每问每篇累计执行。详见 [0.5.2 验收记录](docs/agent-content-acceptance.md)。

0.5.3：新连接默认输入预算为单次 64,000、单问累计 160,000（保守估算，非承诺账单用量）。已有配置不覆盖，可点击“使用推荐输入预算”。正文提供轻量、标准、深入和自定义；自定义范围为 150–6,000 字及 10–70%，按每问每篇累计限制。默认回答偏好内置可编辑的 Pixiv 同人小说示例，回答优先以标题或已确认的系列章节称呼作品。

0.5.4：流式回答显示真实执行阶段、用时和可展开的过程记录；输入框用按钮向上展开，取消拖动缩放。正文采样先复用缓存/已打开页面，再直接 GET 原文页面，绝不自动新建标签页；直接请求全局串行、至少间隔 5 秒，限流遵守 Retry-After 并至少暂停 15 分钟，登录/权限错误暂停 1 小时。不会伪装真人、绕过挑战或保证不触发风控。

0.5.7：正文直读改为 Pixiv 小说详情 JSON 接口的 content 字段，移除失效的 HTML 解析链路；原有限频、冷却和权限约束保留。Agent 记住每个账号上次查看的对话，在重新进入分析页时恢复该对话并滚动到底部。

### 0.5.9 流式执行面板

Agent 运行时展示可折叠的执行记录，包括实际检索、逐篇采样作品标题和缓存复用。开始输出回答时自动收起，使用小方形箭头可随时展开；执行说明与回答分别保存。普通文本增量立即显示，大块文本通过短暂的有界缓冲分批显示。服务端尚未发出的内容无法提前显示，等待时继续展示真实阶段与用时。本节描述源码更新，已发布安装包仍以 Releases 为准。

### 0.5.10 对话式进展与宽松设置

进展说明像普通对话一样随模型生成显示；实际检索、读取等操作各自显示为可展开条目，详细读取队列和来源放在条目内部。最终回答独立保存、复制，完成时整个执行过程自动收起，可随时重新展开。简单问题可直接回答，多步任务按实际需要说明进展，不强制套用固定步骤或采样模板。

支持公开进展通道和普通文本兼容路径，不依赖某个模型提供专用字段。普通文本在流中持续可见，若随后出现工具调用则归入过程；因此不会把每次文字增量都误判成最终回答并反复折叠。不能提前显示服务端尚未发出的内容，也不会编造进展或展示私有推理。

已有用户在连接配置点击“使用宽松设置”并保存，即可保留模型、地址和密钥，同时将阅读深度设为自动，额外输入、累计及轮数限制设为 0。逐篇读取队列会显示排队、请求间隔、读取结果、覆盖率及缓存复用；遇到网站权限/限流错误时停止后续请求并保留已读内容。较早版本的设置说明属于历史记录，以本节和当前界面为准。
