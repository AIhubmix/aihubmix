# @aihubmix/mcp — AIHubMix 官方 MCP Server

对标 OpenRouter 托管 MCP（`https://mcp.openrouter.ai/mcp`）的 AIHubMix 实现（TASK-5VDR3N）。
让用户在 Claude Code / Codex / Cursor 等 AI 编程工具里，基于**实时数据**（而非模型过时的训练记忆）
查询 AIHubMix 模型目录、价格、余额、官方文档，快速试聊任意模型，并直接**生成图片 / 视频**。

- 语言/栈：TypeScript + 官方 `@modelcontextprotocol/sdk` 1.30；请求整形复用 `@aihubmix/media-adapters`
- 双 transport：**stdio**（本地配置即用）与 **Streamable HTTP**（即未来托管形态 `mcp.aihubmix.com/mcp`）
- 数据源全部为线上真实接口：`aihubmix.com/api/v1/models`、`/v1/dashboard/billing/*`、
  `/v1/images|videos`、`docs.aihubmix.com/llms.txt`
- **端点自动故障切换**：默认链 `aihubmix.com → api.inferera.com`（同一后端；国内网络 aihubmix.com
  常被 DNS 污染），网络级失败自动切换并粘住可用端点、每 10 分钟回探主端点——用户和模型都
  **无需手动选域名**，走了备用端点时响应会带 `endpoint_note` 说明

> **v2.0.0（合并版）**：以现代 SDK 1.30 实现为基座，并入官方包原有的图片 / 视频生成工具；
> 视频能力改为依赖共享包 `@aihubmix/media-adapters`（整个 AIHubMix 媒体栈的唯一请求整形来源），
> 仅保留本包自有的传输层（带故障切换的计费提交 + 幂等轮询）。工具数 7→**12**（开 key-admin 后 15）。

## 工具集（默认 12 个；开 key-admin 后 15 个）

**网关与文档（API Key `sk-***`，或无需鉴权）：**

| 工具 | 鉴权 | 说明 |
| --- | --- | --- |
| `ping` | 无 | 逐端点健康检查（可达性 + 延迟 + 当前活跃端点）；端点全挂时返回诊断而非报错 |
| `models-list` | 无 | 模型目录**全文搜索**（id/名称/描述）：按类型/模态/特性过滤、按价格/上下文/编程适配排序，含 USD 价格（每 1M token）与各模型可用的协议入口（endpoints） |
| `model-get` | 无 | 单模型完整详情；ID 拼错时返回相近建议 |
| `credits-get` | API Key | 当前 key 的余额：总额度 / 已用 / 剩余（USD）+ key 过期时间 |
| `chat-send` | API Key | 测试消息（单轮 prompt 或多轮 messages），返回回复 + token 用量 + 延迟 + **本次成本估算**（**消耗余额**） |
| `image-generate` | API Key | 图片生成：23 个模型 / 8 个家族，文生图 + 图生图（`input_reference`）；返回内联图或 URL（**消耗余额**，详见下表） |
| `video-generate` | API Key | 视频生成：异步提交任务后自动轮询直到完成，返回任务 id / 状态 / 鉴权下载地址（**消耗余额**，详见下表） |
| `docs-search` | 无 | 官方文档搜索：默认标题/摘要索引；`search_content: true` 搜正文并返回命中片段 |
| `docs-get` | 无 | 读取一篇文档页 markdown（仅允许 docs.aihubmix.com 域） |

**账户管理（Manage Key `fd***`「系统访问令牌」——与 sk- key 是两种凭证；对齐官方 aihubmix CLI）：**

| 工具 | 默认注册 | 说明 |
| --- | --- | --- |
| `account-get` | ✅ | 账户资料 + 账户级余额/已用（USD）、请求数、分组 |
| `keys-list` | ✅ | 列出全部 API key：状态/剩余/已用/过期/模型与 IP 限制（key 值仅显示末 4 位） |
| `account-models` | ✅ | 当前账户分组可用的模型列表 |
| `keys-create` | 需 `AIHUBMIX_ENABLE_KEY_ADMIN=1` | 创建 key（可限额/限期/限模型/限 IP），完整 key 只在响应中出现一次 |
| `keys-update` | 需 `AIHUBMIX_ENABLE_KEY_ADMIN=1` | 改名/改额度/改过期/启停/改限制（读-合并-写，未指定字段不动） |
| `keys-delete` | 需 `AIHUBMIX_ENABLE_KEY_ADMIN=1` | 删除 key（不可逆，`destructiveHint` 标注） |

Manage Key 解析顺序：`AIHUBMIX_ACCESS_TOKEN` > `AIHUBMIX_TOKEN`（CLI 同名变量）> **`~/.aihubmix/config.json`（与官方 aihubmix CLI 共享登录态——`aihubmix login` 一次，MCP 直接可用；懒读取，登录后无需重启）**。

对 OpenRouter 12 工具的裁剪对照与理由见 [docs/design.md](docs/design.md)、能力对比见 [docs/comparison.md](docs/comparison.md)。

## 图片生成模型（`image-generate`）

必填：`model`、`prompt`。支持的模型可传 `input_reference`（参考图 URL）做图生图。

| 模型 key | 上游 | 主要参数 |
| --- | --- | --- |
| `nano-banana-pro` *(默认)* / `nano-banana-2` | Google Gemini 原生 | `aspect_ratio`、`size`(1K/2K/4K)、`google_search` |
| `gpt-image-1.5` / `gpt-image-1` / `gpt-image-1-mini` / `dall-e-3` | OpenAI | `size`、`n`、`quality`、`background`、`output_format` |
| `imagen-4.0-ultra` / `imagen-4.0` / `imagen-4.0-fast` / `imagen-3.0` | Google Imagen | `aspect_ratio`、`n` |
| `flux-2-pro` / `flux-2-flex` | Black Forest Labs | `aspect_ratio`、`seed` |
| `ideogram-v3` | Ideogram | `rendering_speed`、`aspect_ratio` |
| `seedream-5.0-lite` / `seedream-4.5` / `seedream-4.0` | Doubao | `size`(1K/2K/4K)、`watermark`、`seed` |
| `wan2.7-image-pro` / `wan2.7-image` / `wan2.6-image` | Alibaba Wan | `size`、`aspect_ratio`、`n`、`seed`、`thinking_mode`、`prompt_extend`、`negative_prompt` |
| `qwen-image-2.0-pro` / `qwen-image-2.0` / `qwen-image-max` / `qwen-image` | Alibaba Qwen | `size`、`n`、`seed` |

## 视频生成模型（`video-generate`）

必填：`model`、`prompt`。异步：提交任务后自动轮询直到完成；超时（默认 8 分钟）仍未完成会返回任务 id
供后续查询。`seconds` 会被吸附到该模型支持的时长范围。返回鉴权下载地址
（`GET {base}/v1/videos/{id}/content`，需带 `Authorization: Bearer <AIHUBMIX_API_KEY>`）。

| 模型 key | 上游 | 时长 | 主要参数 |
| --- | --- | --- | --- |
| `seedance-2.0` *(默认)* / `seedance-2.0-fast` | ByteDance SeeDance | 4–15s | `resolution`(480p/720p)、`aspect_ratio`、`watermark`、`seed`、`camera_fixed`、`generate_audio` |
| `wan-2.7` / `wan-2.6` / `wan-2.5` | Alibaba Wan | 2–15s / 5·10s | `size`(WxH) |
| `sora-2` / `sora-2-pro` | OpenAI Sora | 4/8/12s | `size`(720x1280…1792x1024) |
| `jimeng-3.0-pro` / `jimeng-3.0` | ByteDance Jimeng | 5/10s | `size`、`aspect_ratio` |

`seedance` / `wan-2.6` / `wan-2.5` / `sora` / `jimeng` 支持 `input_reference`（参考图 URL）做图生视频。

## 快速开始

发布后直接用 `npx`，无需本地构建：

### Claude Code（stdio）

```bash
claude mcp add aihubmix --env AIHUBMIX_API_KEY=sk-你的key -- npx -y @aihubmix/mcp
```

### Codex CLI（`~/.codex/config.toml`）

```toml
[mcp_servers.aihubmix]
command = "npx"
args = ["-y", "@aihubmix/mcp"]
env = { AIHUBMIX_API_KEY = "sk-你的key" }
```

### Cursor（`.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "aihubmix": {
      "command": "npx",
      "args": ["-y", "@aihubmix/mcp"],
      "env": { "AIHUBMIX_API_KEY": "sk-你的key" }
    }
  }
}
```

> 国内无代理用户请加 `"AIHUBMIX_API_BASE": "https://api.inferera.com"`（同一后端，解析干净）；
> 或保持默认——网关工具会在 aihubmix.com 失败时自动切到 inferera。

### 本地开发

```bash
pnpm install          # 或在本包内 npm install
pnpm --filter @aihubmix/mcp build
node dist/index.js                       # stdio
node dist/index.js --http --port 7300    # Streamable HTTP

# 测试
npm test              # stdio 端到端冒烟（需网络；SKIP_PAID=1 跳过计费工具）
npm run test:http     # HTTP 模式冒烟（验证 Authorization 头逐请求鉴权）
npm run test:redact   # 内网地址脱敏单测（离线）
```

### HTTP 模式（托管形态预演）

```bash
node dist/index.js --http --port 7300
# 端点: http://127.0.0.1:7300/mcp   健康检查: /healthz
```

- 无状态（每 POST 一个独立 server 实例，模型目录/状态缓存进程级共享），可水平扩展
- 鉴权：优先取每个请求的 `Authorization: Bearer sk-...` 头，其次 `AIHUBMIX_API_KEY` 环境变量
- 支持 HTTP MCP 的客户端直接填 URL + 自定义 Authorization 头即可
- 绑定回环地址（默认）时自动开启 **DNS rebinding 防护**：校验 Origin/Host 仅允许 localhost，
  防止恶意网页借浏览器打本机端口盗用 env key；绑定非回环地址（托管、反代之后）时自动关闭

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AIHUBMIX_API_KEY` | — | credits-get / chat-send / image-generate / video-generate 用的 sk- key（HTTP 模式可用请求头代替） |
| `AIHUBMIX_ACCESS_TOKEN` | —（回落 `AIHUBMIX_TOKEN`，再回落 CLI 登录态） | 账户工具用的 Manage Key（系统访问令牌，fd\*\*\*） |
| `AIHUBMIX_ENABLE_KEY_ADMIN` | 关 | 置 `1` 才注册 keys-create/update/delete 三个写工具 |
| `AIHUBMIX_API_BASE` | `https://aihubmix.com,https://api.inferera.com` | 网关端点链（逗号分隔，自动故障切换）。填单个自定义地址（如 test 环境）则关闭切换 |
| `AIHUBMIX_PUBLIC_BASES` | 同 `AIHUBMIX_API_BASE` 默认 | 错误信息里可明文显示的公开端点白名单；其余（内网 FQDN / 私网 IP）一律脱敏为 `[internal-endpoint]` |
| `AIHUBMIX_DOCS_BASE` | `https://docs.aihubmix.com` | 文档站地址 |
| `AIHUBMIX_APP_CODE` | — | 可选 APP-Code 头（计费请求附带） |
| `AIHUBMIX_TIMEOUT_MS` | `30000` | 上游超时 |
| `AIHUBMIX_VIDEO_POLL_TIMEOUT_MS` | `480000` | 视频轮询总超时（8 分钟）；超时仍返回任务 id 供后续查询 |

## 安全说明

- API key 不落盘、不记日志；HTTP 模式逐请求透传，服务端不持有用户 key
- 本机 HTTP 模式带 DNS rebinding / 跨站防护（外来 Origin → 403，伪造 Host → 421，均有测试覆盖）
- 非回环绑定 + 设置了 env key 时启动会打印告警（托管部署应只用逐请求 Authorization）
- 错误信息里的内网 FQDN / 私网 IP 一律脱敏，只有 `AIHUBMIX_PUBLIC_BASES` 白名单端点明文显示
- `docs-get` 仅允许抓取配置的文档域（SSRF 防护）
- 除 `chat-send` / `image-generate` / `video-generate`（计费）外全部工具带 `readOnlyHint: true` annotation

## 媒体栈

`image-generate` / `video-generate` 的**逐模型能力与请求/响应整形**统一委托给共享包
`@aihubmix/media-adapters`（纯函数、无 transport）——一处维护，AIHubMix 全栈复用。本包只负责
**传输层**：带连接期故障切换的计费提交 + 幂等轮询（重发绝不重复扣费）。

## 路线图（托管 = 生产上线需要的服务端工作）

1. 部署本服务到 `mcp.aihubmix.com/mcp`（无状态，直接容器化）
2. OAuth 2.1（PKCE）+ 授权后颁发受限 key（短有效期/消费上限/控制台可撤销）——对齐 OpenRouter 体验，方案见 design.md
3. v2 候选工具：`generation-get`（单次生成成本）、`providers-list`（由目录 developer 字段聚合）
