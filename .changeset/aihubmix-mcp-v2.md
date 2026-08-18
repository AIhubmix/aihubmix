---
"@aihubmix/mcp": major
---

Rebuild `@aihubmix/mcp` on the modern MCP SDK (1.30, `McpServer` / `registerTool` / Streamable HTTP) and merge in the original package's image/video generation.

**Breaking**

- Requires Node >= 18. Config env changed: the gateway base is now a comma-separated failover chain `AIHUBMIX_API_BASE` (default `https://aihubmix.com,https://api.inferera.com`) — the old single-value `AIHUBMIX_BASE_URL` is gone.
- Tool names are hyphenated for consistency with the rest of the toolset: `image_generate` → `image-generate`, `video_generate` → `video-generate`. Update any client config or prompt that pins the old underscore names.

**Added**

- 12 tools by default (15 with `AIHUBMIX_ENABLE_KEY_ADMIN=1`): `ping`, `models-list`, `model-get`, `credits-get`, `chat-send`, `image-generate`, `video-generate`, `docs-search`, `docs-get`, `account-get`, `keys-list`, `account-models`, plus gated `keys-create` / `keys-update` / `keys-delete`.
- stdio **and** stateless Streamable HTTP transports (per-request `Authorization` pass-through; DNS-rebinding/CSRF protection on loopback binds).
- Automatic endpoint failover `aihubmix.com → api.inferera.com` (same backend; survives mainland DNS poisoning), with sticky-preferred endpoint, 10-minute primary re-probe, and `endpoint_note` transparency.
- Account/Key management aligned with the official `aihubmix` CLI (shared `~/.aihubmix/config.json` login state); `chat-send` cost estimation, full-text docs search + whole-page read.

**Changed**

- `image-generate` (23 models / 8 families) and `video-generate` (9 models) now delegate per-model capabilities and request/response shaping to `@aihubmix/media-adapters` — one source of truth for the whole AIHubMix media stack. Only the billing transport (connect-phase failover + idempotent polling, no double-charge) lives here.
