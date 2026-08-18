# aihubmix-mcp 设计文档（TASK-5VDR3N）

> 任务：提供 Aihubmix 官方 MCP Server（对标 OpenRouter）。
> 期望结果（来自任务 Wiki）：用户一个 URL + OAuth 即可在主流 AI 编程工具接入；至少覆盖
> 模型列表/详情查询、余额查询、文档搜索等只读能力，工具集借鉴 OpenRouter 裁剪。

> **v2.0.0 更新（2026-07-30，合并版）**：本设计文档描述的是合并前的只读基座（7 工具）与其演进
> （账户组 → 默认 10 / 全开 13）。v2.0.0 把官方包原有的**图片生成 `image-generate`（23 模型 /
> 8 家族）**与**视频生成 `video-generate`（9 模型）**并入本基座，工具数增至**默认 12 / 全开 15**。
> 两个媒体工具的逐模型能力与请求/响应整形统一委托共享包 `@aihubmix/media-adapters`（纯函数、无
> transport）；本包只保留自有的传输层（带连接期故障切换的计费提交 + 幂等轮询），沿用下方 chat-send
> 的防重复计费语义。下方正文（测试轮次、上游问题、决策记录）保留为合并前的设计依据。

## 1. 对标裁剪表（OpenRouter 12 工具 → 本版只读基座 7 工具 → v2.0.0 默认 12 工具)

| OpenRouter | 本版 | 后端依据 | 说明 |
| --- | --- | --- | --- |
| `models-list` | ✅ `models-list` | `GET /api/v1/models`（公开） | 过滤/排序参数原样透传（type/modalities/features/sort_by/sort_order），客户端侧分页（limit/offset） |
| `model-get` | ✅ `model-get` | 同上（进程内 5min 缓存） | 精确匹配 + 拼写错误时最长公共前缀建议 |
| `model-endpoints` | ❌ 裁剪 | 无对应数据 | AIHubMix 是单网关聚合，不暴露 per-provider 价格/延迟/吞吐 |
| `chat-send` | ✅ `chat-send` | `POST /v1/chat/completions` | 非流式单条，默认 max_tokens=1024，消耗余额 |
| `rankings-daily` | ❌ 裁剪 | 无对应数据 | OpenRouter 自有排名数据源 |
| `app-rankings` | ❌ 裁剪 | 无对应数据 | 同上 |
| `benchmarks` | ❌ 裁剪 | 无对应数据 | 第三方评分集成留作后续产品决策 |
| `credits-get` | ✅ `credits-get` | `/v1/dashboard/billing/subscription` + `/dashboard/billing/usage` + `/dashboard/billing/remain`（Bearer key） | 三端点并发合并为 {total_usd, used_usd, remaining_usd, key_expires_at} |
| `generation-get` | ❌ v2 候选 | 网关 `GetUsageByKey`（session 鉴权） | 现有接口非 key 鉴权、形态未产品化；托管版可推动网关补 key 鉴权版本 |
| `providers-list` | ❌ v2 候选 | 可由目录 `developer_id/model_name` 聚合 | 需要 developer id→名称映射表，暂缓 |
| `docs-search` | ✅ `docs-search` | `docs.aihubmix.com/llms.txt`（Mintlify，公开） | 标题/描述/URL 加权关键词打分，中英文皆可，10min 缓存 |
| —（OpenRouter 无） | ✅ `docs-get` | Mintlify 每页均有 `.md` 源 | 补充读整页，配合 docs-search 形成"搜→读"闭环 |
| `ping` | ✅ `ping` | `GET /api/status`（公开） | 返回网关 system_name + 延迟 |
| —（OpenRouter 无） | ✅ `image-generate`（v2.0.0） | `POST /v1/images/...`（Bearer key） | 23 模型 / 8 家族，文生图 + 图生图；能力表与请求整形来自 `@aihubmix/media-adapters` |
| —（OpenRouter 无） | ✅ `video-generate`（v2.0.0） | `POST /v1/videos` + 轮询（Bearer key） | 9 模型，异步提交 + 幂等轮询 + 鉴权下载地址；整形来自 `@aihubmix/media-adapters` |

覆盖检查：任务 Wiki 要求的「模型列表/详情、余额、文档搜索」全部落地 ✅。v2.0.0 额外并入媒体生成。

## 2. 架构

```
src/
  config.ts    环境变量 → Config（apiBases/publicBases/docsBase/apiKey/accessToken/appCode/timeout）
  aihubmix.ts  网关 API client：models 目录（5min 缓存）/ 三合一余额 / chat / status /
               image / video（视频能力表与请求整形委托 @aihubmix/media-adapters，本文件只做传输）
               统一处理网关"HTTP 200 但 body 是 {error:{...}}"的错误形态
  docs.ts      llms.txt 解析（`- [标题](url): 描述` 行格式）+ 打分搜索 + 整页抓取（域白名单）
  server.ts    buildServer(cfg, getApiKey) → McpServer，注册 12 个工具（zod schema + annotations；
               开 AIHUBMIX_ENABLE_KEY_ADMIN 追加 3 个写工具 = 15）
  index.ts     入口：默认 stdio；--http 起 node:http 无状态 Streamable HTTP（POST /mcp）
test/
  smoke.mjs        stdio 端到端（含 SSRF 防护与 typo 建议断言）
  smoke-http.mjs   HTTP 端到端（启动时剥离 env key，证明 Authorization 头独立可用）
  redact.mjs       内网地址脱敏 + displayBase 白名单单测（离线）
```

关键决策：

- **key 获取抽象为 `getApiKey()` 闭包**：stdio 模式绑定 env，HTTP 模式绑定当前请求的
  Authorization 头。同一 buildServer 同时服务两种部署形态，托管化无需改工具代码。
- **HTTP 无状态**（`sessionIdGenerator: undefined`，每 POST 新建 server+transport）：
  单实例可服务多用户（key 随请求走，服务端零持有），水平扩展无会话粘性。
- **只依赖公开/既有接口**，网关零改动即可上线只读能力。
- **媒体整形外置**（v2.0.0）：image/video 的逐模型能力矩阵与 vendor 请求映射放进纯函数包
  `@aihubmix/media-adapters`，MCP 与其它媒体消费方共用一处真相；本包只负责计费传输与轮询。

### 2.1 端点自动故障切换（v0.2.0，响应"模型自处理异常"诉求）

产品事实：国内用户用 inferera 域名、国外用 aihubmix 域名，同一后端；aihubmix.com 在部分国内
网络被 DNS 污染。MCP 的消费者是模型，域名选择必须服务端自愈，不能要求人（或模型）判断：

- **端点链**：默认 `aihubmix.com → api.inferera.com`（`AIHUBMIX_API_BASE` 逗号分隔可自定义；
  单值 = 关闭切换，保留 test 环境工作流）。
- **GET（幂等）**：网络级失败（无 HTTP 状态码）→ 逐端点切换；有备选端点时单次尝试上限压到
  10s 快速失败。语义错误（4xx/5xx/网关 error body）不切换——网关已应答，换域名无意义。
- **chat-send / image / video（计费 POST）**：只在**连接期错误**（ENOTFOUND/ECONNREFUSED/连接
  超时等，请求确定未到达网关、不可能已计费）时切换端点；同端点零重试、响应中途断连不重发——
  杜绝重复扣费。视频提交成功后进入轮询阶段（幂等 GET 任务状态，可安全跨端点）。
- **粘性 + 自恢复**：服务成功的端点成为后续首选（不再为死端点付超时代价）；处于备用端点时
  每 10 分钟最多回探一次主端点，主端点恢复自动切回。`ping` 逐端点探活并把首个可达端点教给
  客户端。
- **透明性**：走备用端点的响应带 `endpoint_note`（同后端同数据、会自动回探，无需任何操作），
  server instructions 明确告知模型"不要让用户手动切域名"。
- **文档站无备用部署**：llms.txt 索引 stale-while-error（站点失联时用进程内旧索引继续服务
  docs-search 并标注 `stale_note`）；彻底不可达时错误文案面向模型编写（可直接转述给用户：
  网关工具不受影响，需要文档请开代理）。
- 实现备注：undici 对 fetch 规范 bad-port 名单（如 9/25/137…）**不拨号直接抛无 code 的
  "bad port"**——错误码提取带消息正则兜底并映射为 `EBADPORT`（归入连接期可切换类）。

## 3. 鉴权演进（对齐 OpenRouter「URL + OAuth」体验）

- **Phase A（本版）**：stdio + `AIHUBMIX_API_KEY`；HTTP + `Authorization: Bearer` 逐请求透传。
- **Phase B（托管上线）**：本服务原样部署到 `mcp.aihubmix.com/mcp`。用户体验 = 填 URL + 在客户端
  header 里贴 key。已可用，但还不是"零配置 OAuth"。
- **Phase C（OAuth 完全体，需要网关/控制台配合）**，按 MCP authorization 规范（OAuth 2.1 + PKCE）：
  1. MCP host 暴露 `/.well-known/oauth-protected-resource`，指向 AIHubMix authorization server；
  2. 网关补 authorize/token 端点 + 动态客户端注册（或预注册主流客户端）；
  3. 授权同意页 → 为该授权**颁发受限 key**：短有效期 + 消费上限 + 控制台可撤销
     ——网关 token 模型已有 `expired_time`/`remain_quota` 字段，天然支持（对标 OpenRouter
     的"7 天有效期、默认 $10 上限、dashboard 可撤销"）；
  4. MCP 服务端把 OAuth access token 映射到受限 key 后走现有透传路径，工具代码不变。

### 2.2 账户管理工具组（v0.3.0，接入官方 aihubmix CLI 的能力面）

官方 CLI（`AIhubmix/platfrom-cli`，二进制 `aihubmix`）封装的是 **CliEndpoints 用户级 API**
（凭证 = Manage Key「系统访问令牌」fd\*\*\*，≠ sk- API key）。MCP 按方案 A **原生直连同一组
API**（`/api/user/self`、`/api/token/` CRUD、`/api/user/available_models`，`{success,message,data}`
包裹），并与 CLI **共享登录态**：

- 凭证解析：`AIHUBMIX_ACCESS_TOKEN` > `AIHUBMIX_TOKEN`（CLI 同名 env）> `~/.aihubmix/config.json`
  （CLI `aihubmix login` 写入的 `{token, base_url}`；懒读取 + 60s 缓存，登录后无需重启 MCP）。
- 分级注册：读（account-get / keys-list / account-models）默认开；写（keys-create / keys-update /
  keys-delete）仅在 `AIHUBMIX_ENABLE_KEY_ADMIN=1` 时注册——防提示注入驱动的 key 增删。
- 写操作故障切换与 chat-send 同规则：仅连接期错误换端点、绝不重发（重发 create 会造出重复 key）。
- keys-update 读-合并-写（先 GET /api/token/:id 再 PUT 全量），未指定字段保持原值。
- key 值默认脱敏（末 4 位）；仅 keys-create 响应展示一次完整 key 并附 security_note。
- 401/过期凭证 → 错误信息带来源（env / CLI 登录态）与修复动作（重新 `aihubmix login` /
  重新生成令牌），模型可直接转述。

## 4. 测试结论（真实线上环境，三轮）

- 第三轮（2026-07-13，端点切换 v0.2.0）：确定性故障切换测试 **5/5** PASS（死主端点 →
  ping 逐端点健康、GET 冷启动切换 + endpoint_note、粘性无重复代价、chat-send 连接期切换且
  回复正常送达）；stdio 冒烟 **12/12**、HTTP 冒烟 **8/8** 回归通过（双端点均可达时主端点优先）。
- 第二轮（自查修复后）：stdio 冒烟 **12/12** PASS；HTTP 冒烟 **8/8** PASS。
- `chat-send` 真实计费链路验证：gpt-4o-mini 正常回复；gpt-5-nano + 小 max_tokens 复现
  "推理 token 吃光上限 → 空回复"，工具返回带解释的 `note` 字段 ✅。
- `credits-get` 实测解析正确（测试 key 余额 ≈ $0，返回 remaining=-0.000002）。
- 安全断言：外来 Origin POST → 403；伪造 Host（rebinding 特征）→ 421；localhost Origin 放行
  且 ACAO 精确回显。
- 合并版（v2.0.0，2026-07-30）：结构合并后回归 redact 30/30、stdio 冒烟网关路径全绿（12 默认 /
  15 全开工具注册、故障切换生效），仅 docs-* 因本机 docs.aihubmix.com 被 DNS 污染且无 inferera
  备用而失败（环境问题，非回归）。

### 4.1 第二轮自查修复清单

| # | 问题（思考不足处） | 修复 |
| --- | --- | --- |
| 1 | HTTP 模式 CORS `*` 且不校验 Origin/Host：本机以 env key 起服务时，恶意网页可借浏览器打 `127.0.0.1` 走 env-key 兜底烧余额（DNS rebinding/CSRF，MCP 规范明确要求本地校验 Origin） | 回环绑定时校验 Origin+Host 白名单（localhost/127.0.0.1/::1），CORS 改为精确回显；非回环绑定（托管）跳过并在设置 env key 时打印告警 |
| 2 | HTTP 模式每请求 `new AihubmixClient` → 目录/状态缓存跨请求全失效 | client 提升到进程级共享，`buildServer` 增加注入参数 |
| 3 | 推理模型（gpt-5\*）小 max_tokens 时返回空 content + finish=length，像"模型坏了" | chat-send 检测该形态并附解释性 `note`（实测 gateway 会把 max_tokens 转成 max_completion_tokens，不会 400） |
| 4 | 上游 context_length 字符串排序 bug 只记录未缓解 | 工具层数值重排；重排后真实榜首为 2M 上下文模型（此前被字典序完全埋没），证明该缓解必要 |
| 5 | `display_in_currency=false` 的站点（如自建/测试环境）余额单位会算错 | credits-get 读 `/api/status` 按 `quota_per_unit` 归一化（best-effort，status 失败则按 USD 处理） |
| 6 | 杂项：模型缓存无上限、ping 网关不可达时返回裸错误、chat 超时同数据查询、npm 发布缺构建钩子 | 缓存上限 64 条逐出最旧；ping 改为诊断输出（ok:false + 原因）；chat 超时提到 ≥120s；package.json 加 `prepack` |

## 5. 过程中发现的上游问题（建议另立任务，不在本任务范围内修）

1. **文档价格单位标错**：`cn/api/Models-API.mdx` 写"每 1K Token，美元"，但实测值为**每 1M**
   （gpt-5-nano output=0.4 ↔ 真实 $0.4/1M；若按 1K 则 gpt-5 输入价 $1250/1M，明显错误）。
   → 文档团队改 Models-API.mdx（cn/en 等各语言版）。
2. **`sort_by=context_length` 疑似按字符串排序**：`type=llm&features=function_calling&sort_by=context_length&sort_order=desc`
   返回榜首 ernie-x1-turbo（50500），而目录中存在 400000 上下文模型——"5xxxx" 字典序大于
   "4xxxxx"，符合字符串排序特征。→ 网关模型目录接口修数值排序。
3. `credits-get` 的 `used_usd` 语义随网关 `DisplayTokenStatEnabled` 配置在"当前 key 已用"与
   "账户已用"之间切换，产品化时需在文档里明确。
4. **网络可达性（2026-07-13 实测）**：`aihubmix.com` 及其子域（含 `docs.aihubmix.com`）在部分
   国内网络被 DNS 污染（解析到 Dropbox/Twitter/Facebook 污染池 IP，AliDNS DoH 亦中招），仅代理
   可达；`api.inferera.com`（同一后端）解析干净、直连全通。两个推论：
   - 本地 stdio 用户（国内、无代理）应设 `AIHUBMIX_API_BASE=https://api.inferera.com`（README 已注明）；
   - **托管 MCP 若部署在 `mcp.aihubmix.com` 将同样被污染**——域名规划建议同时提供
     `mcp.inferera.com`（或直接主用 inferera 侧），docs 站同理（`docs.inferera.com` 目前 404，未部署）。

## 5.1 已评估、决定不做（决策记录）

- **prod 主域路径接管（aihubmix.com/mcp、api.inferera.com/mcp）**——2026-07-16 与用户确认**不做**，
  prod 入口 = 专属子域名 only（对齐 OpenRouter 的 mcp.openrouter.ai 模式）。
  耦合盘点结论：代码/进程/镜像层零耦合（PR 全部为新增文件，主站与公用代码零改动；MCP 只经
  公开/鉴权 HTTP API 消费网关，与任意外部客户端同一契约）；唯一的真实耦合点在**路由层的路径方式**：
  与主站共享 hostname 的规则合并（我们靠 Exact > 遗留 PathPrefix 的优先级取胜——若主站日后把
  遗留规则也改成 Exact，按"老 Route 赢"会静默夺回流量）、同源安全边界合并、且清理遗留规则必须
  修改主站路由文件。砍掉路径方式后这些全部消失：mcp.* 子域的 HTTPRoute 与主站规则零交集，
  主域 /mcp 维持旧 image-MCP 现状、去留由网关团队独立决定，双向零影响。
  例外：ziai 测试环境保留路径方式（shkq.org/mcp）——测试子域未申请，且为测试环境务实妥协；
  若后续申请 mcp 测试子域可同样切换。
  剩余的有意依赖（可接受）：MCP→网关的单向 API 消费；集群内直连的 Service 名（one-api-service）
  写在部署 env 里——主站改名会断直连，但端点链带公网域名兜底，自动故障切换可续命。


- **只读 Manage Key（网关侧权限分级）**——2026-07-16 与用户确认**不做**。
  背景：系统访问令牌（fd\*\*\*）是账户全权凭证，无只读档；泄漏后果重于 sk- key。
  不做的理由：①MCP 层已兜底（写工具默认不注册、托管零存储、文档警示、账户工具定位本地优先）；
  ②当前暴露面为团队内部，credits-get（sk- 级）已覆盖大众"查余额"主诉求；
  ③若做 Phase C OAuth，同意页 scope 设计会自然引出"账户只读授权"，现在单独改网关 token
  模型可能被推翻重做——**推迟合并进 Phase C 是最省路径**，且 Phase C 未排期，故当前不欠账。
  重新评估的触发条件：账户工具向大众开放、或远程 MCP 需要账户面、或 Phase C 启动。

## 6. 当前边界

- 合并版（v2.0.0）：以现代 SDK 1.30 实现为基座并入官方包的图片/视频工具，改依赖
  `@aihubmix/media-adapters`；以 PR 形式提交上游 monorepo，评审后由负责人决定发布。
- `chat-send` 仅文本单轮（多模态/多轮/流式留 v2）；`docs-search` 为词法打分（够用；语义检索留 v2）。
