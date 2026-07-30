# OpenRouter MCP vs aihubmix-mcp 能力对比

> **v2.0.0 更新（2026-07-30，合并版）**：本文档的对照分析成型于合并前的 v0.3.0（下方正文与
> 测试轮次均为当时记录，保留为设计依据）。v2.0.0 在此基础上并入官方包原有的**图片 / 视频生成**
> 两个工具（请求整形改由共享包 `@aihubmix/media-adapters` 提供），工具数由默认 10 / 全开 13
> 增至**默认 12 / 全开 15**。图片、视频生成是 OpenRouter MCP **没有**的能力，属 AIHubMix 独有。
>
> OpenRouter 侧信息来自其官方文档（任务 Wiki 调研，2026-07-08）；aihubmix-mcp 早期以 **v0.3.0** 实测为准（2026-07-13）。
>
> v0.3.0 增量：①models-list 全文搜索（id/名称/描述）②chat-send 多轮 + 单次成本估算（覆盖
> generation-get 核心用途）③docs-search 正文级搜索（llms-full.txt）④透出各模型协议入口 endpoints
> ⑤**账户管理工具组**（对齐官方 aihubmix CLI：account-get / keys-list / account-models 默认开，
> keys-create/update/delete 开关控制，与 CLI 共享 `~/.aihubmix/config.json` 登录态）——账户面是
> OpenRouter MCP **没有**的能力。

## 一、工具能力对照

| 能力 | OpenRouter（12 工具） | aihubmix-mcp v2.0.0（默认 12 工具） |
| --- | --- | --- |
| 模型列表搜索 `models-list` | ✅ 全文搜索；按智能指数/价格/上下文/模态过滤排序 | ✅ **全文搜索（id/名称/描述）**；按类型/模态/特性过滤，按价格/上下文/编程适配排序；**修复上游排序 bug**；价格 USD/1M tokens + 各模型协议入口。仅缺智能指数（目录无该数据） |
| 单模型详情 `model-get` | ✅ | ✅ 额外：ID 拼错自动给相近建议 |
| 多提供商端点 `model-endpoints` | ✅ 各 provider 价格/延迟/吞吐/数据政策 | ➖ 无对应数据（AIHubMix 为单网关聚合），v2 候选 |
| 测试对话 `chat-send` | ✅ | ✅ 单轮或**多轮 messages**；推理模型空回复自动附解释 note；**返回本次成本估算**；防重复计费（详见二） |
| 图片生成 `image-generate` | ❌ 无 | ✅ **独有**：23 模型 / 8 家族，文生图 + 图生图；整形复用 `@aihubmix/media-adapters` |
| 视频生成 `video-generate` | ❌ 无 | ✅ **独有**：异步提交 + 幂等轮询，鉴权下载地址；整形复用 `@aihubmix/media-adapters` |
| 余额 `credits-get` | ✅ | ✅ 总额/已用/剩余（USD）+ key 过期时间；跨站点单位自动归一化 |
| 单次生成成本 `generation-get` | ✅ 成本/token/服务商 | ◐ chat-send 内嵌 `estimated_cost_usd`（目录价×用量，含缓存价）覆盖核心用途；按历史生成 ID 查服务端账单仍需网关接口（v2） |
| 排名 `rankings-daily` / `app-rankings` | ✅ OpenRouter 自有排名数据 | ❌ 无对应数据源，明确裁剪 |
| 第三方评分 `benchmarks` | ✅ | ❌ 同上；后续可接第三方评分 |
| 提供商列表 `providers-list` | ✅ | ➖ v2 候选（可由目录 developer 字段聚合） |
| 文档搜索 `docs-search` | ✅ | ✅ 标题/摘要索引 + **正文级搜索（llms-full.txt，返回命中片段）**；站点失联时降级用缓存索引（stale-while-error） |
| 文档整页阅读 `docs-get` | ❌ 无 | ✅ **独有**：搜→读闭环，返回整页 markdown |
| 连通性 `ping` | ✅ | ✅ **增强**：逐端点健康检查（可达性+延迟+活跃端点），全挂时返回诊断而非报错 |
| 账户资料/余额 `account-get` | ❌ 无 | ✅ **独有**（Manage Key）：账户级余额/已用/分组/请求数 |
| API Key 管理 `keys-list/create/update/delete` | ❌ 无 | ✅ **独有**：列表默认开；增删改需 `AIHUBMIX_ENABLE_KEY_ADMIN=1`（防提示注入），与官方 aihubmix CLI 共享登录态 |
| 账户可用模型 `account-models` | ❌ 无 | ✅ **独有**：当前账户分组实际可用的模型 |

覆盖结论：任务期望的「模型列表/详情、余额、文档搜索」全覆盖；差距集中在 OpenRouter **自有数据生态**（排名/评分/多 provider 端点数据），这些是数据源问题而非工具实现问题。反向，AIHubMix 在**媒体生成（图片/视频）**与**账户/Key 管理**两个面上是 OpenRouter MCP 没有的净增能力。

## 二、平台与架构能力

| 维度 | OpenRouter | aihubmix-mcp v2.0.0 |
| --- | --- | --- |
| 部署形态 | ✅ 已上线托管：`https://mcp.openrouter.ai/mcp` | 本地版完成（未上托管）；HTTP 模式即托管形态，可直接容器化部署 |
| 传输 | HTTP（Streamable） | **stdio + Streamable HTTP 双模式**；stdio 让用户今天就能本地接入 Claude Code/Codex/Cursor |
| 认证 | ✅ 浏览器 OAuth（PKCE），颁发专用 key：7 天有效期、默认 $10 消费上限、控制台可撤销 | API key（stdio 用 env；HTTP 逐请求 Authorization 透传，服务端零持有）；OAuth 为 Phase C，方案已设计（网关 token 模型天然支持限期/限额 key） |
| 端点容灾 | 单域名 | ✅ **独有**：`aihubmix.com → api.inferera.com` 自动故障切换（应对国内 DNS 污染），粘住可用端点 + 每 10min 回探主端点，响应带 endpoint_note，模型/用户零操作 |
| 本地安全 | —（纯托管，无本地形态） | 回环绑定自动开 DNS-rebinding/CSRF 防护（Origin/Host 校验、CORS 精确回显） |
| 计费安全 | 未知 | chat-send / image / video 同端点零重试；仅连接期错误（请求确定未达网关）才切端点——结构性杜绝重复扣费 |
| 弹性 | 未知 | GET 瞬时故障自动重试；模型目录 5min 缓存（带上限逐出）；文档索引 stale-while-error |
| 水平扩展 | 未知 | HTTP 无状态（每请求独立 server 实例），天然可水平扩展 |
| 测试 | — | 真实环境测试：stdio 冒烟、HTTP 冒烟、确定性故障切换、地址脱敏单测 |

## 三、一句话总结（v2.0.0）

- **数量**：OpenRouter 12 工具；我们默认 12、全开 15，其中 **7 个为我们独有**（docs-get + 账户管理组 4 个 + 图片/视频生成 2 个）。
- **仍差的**：排名/评分/多 provider 端点（依赖 OpenRouter 自有数据生态，属产品决策）、按历史生成 ID 查账单（需网关接口）、providers-list（缺 developer 名称映射）、智能指数排序（目录无该数据）。
- **强在哪**：媒体生成（图片 23 模型 / 视频 9 模型）、双域名自动容灾（国内可用性）、stdio 本地即用、账户与 Key 管理（对齐官方 CLI 并共享登录态）、docs 正文级搜索 + 整页阅读、单次成本估算、逐端点 ping 诊断、防重复计费语义、key-admin 默认关闭的安全分级。
- **主要待办**：托管部署（含域名规划 `mcp.inferera.com`）+ OAuth（Phase C），追平 OpenRouter 的「一个 URL + OAuth」接入体验。
