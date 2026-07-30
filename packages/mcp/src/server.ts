import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { SERVER_NAME, SERVER_VERSION, readCliManageKey } from "./config.js";
import { AihubmixClient, UpstreamError, displayBase, redactInternal, IMAGE_MODELS, VIDEO_MODELS, type AihubmixModel } from "./aihubmix.js";
import { getDocsIndex, getDocPage, scoreDocs, searchDocsContent } from "./docs.js";

const INSTRUCTIONS = `AIHubMix MCP server: live model catalog (pricing, context windows, capabilities),
account credits, docs search and a test-chat tool for the AIHubMix gateway (https://aihubmix.com).
Use models-list / model-get to pick models from real-time data instead of training memory.
credits-get, chat-send and image-generate require an AIHubMix API key (AIHUBMIX_API_KEY env in
stdio mode, or "Authorization: Bearer <key>" header in HTTP mode). chat-send and image-generate
consume credits; image generation can take minutes.
Gateway endpoints fail over automatically (aihubmix.com → api.inferera.com, same backend) —
never ask the user to switch regions or domains; an endpoint_note field appears on responses
when a fallback endpoint served the request. Use ping for per-endpoint health when diagnosing.
Account tools (account-get, keys-list, account-models, and the opt-in keys-create/update/delete)
use a SEPARATE credential: the Manage Key (系统访问令牌, fd***) via AIHUBMIX_ACCESS_TOKEN —
not the sk- API key. Key-admin write tools exist only when AIHUBMIX_ENABLE_KEY_ADMIN=1.`;

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type ToolResult = {
  content: ContentBlock[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function errText(e: unknown): string {
  // H1 backstop: UpstreamError already redacts, but non-UpstreamError messages
  // (undici cause chains, etc.) may still carry internal FQDNs/IPs — redact all.
  const raw =
    e instanceof UpstreamError
      ? `AIHubMix upstream error: ${e.message}${e.type ? ` (type: ${e.type})` : ""}`
      : e instanceof Error
        ? e.message
        : String(e);
  return redactInternal(raw);
}

/** Docs failures get context a model can relay: single deployment, possibly region-blocked. */
function docsErrText(e: unknown): string {
  const base = errText(e);
  if (e instanceof UpstreamError && e.status === undefined) {
    return (
      `${base}. The documentation site (docs.aihubmix.com) is a single deployment with no fallback ` +
      "domain and is unreachable from some networks (e.g. mainland China without a proxy). " +
      "Gateway tools (models/credits/chat) are unaffected — they fail over between API endpoints " +
      "automatically. If the user needs docs, suggest enabling a proxy for docs.aihubmix.com."
    );
  }
  return base;
}

/** Compact list-view projection of a model record (full desc only in model-get). */
function modelSummary(m: AihubmixModel) {
  return {
    model_id: m.model_id,
    model_name: m.model_name,
    types: m.types,
    features: m.features,
    input_modalities: m.input_modalities,
    context_length: m.context_length,
    max_output: m.max_output,
    // upstream values are USD per 1M tokens (verified against real OpenAI list prices;
    // the Models-API doc's "per 1K" label is wrong)
    pricing_usd_per_1m_tokens: m.pricing,
    // which gateway protocol entry points can call this model (AIHubMix multi-protocol feature)
    endpoints: m.endpoints,
    playground_checked: m.playground_checked,
    desc: typeof m.desc === "string" && m.desc.length > 200 ? `${m.desc.slice(0, 200)}…` : m.desc,
  };
}

/** Client-side full-text match over id + name + description (upstream only fuzzy-matches the id). */
function fullTextFilter(models: AihubmixModel[], search: string): AihubmixModel[] {
  const tokens = search
    .toLowerCase()
    .split(/[^a-z0-9一-鿿.-]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return models;
  const scored: Array<{ m: AihubmixModel; s: number }> = [];
  for (const m of models) {
    const id = m.model_id.toLowerCase();
    const name = (m.model_name ?? "").toLowerCase();
    const desc = (m.desc ?? "").toLowerCase();
    let s = 0;
    for (const t of tokens) {
      if (id.includes(t)) s += 10;
      else if (name.includes(t)) s += 6;
      else if (desc.includes(t)) s += 2;
      else {
        s = 0;
        break; // AND semantics: every token must match somewhere
      }
    }
    if (s > 0) scored.push({ m, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.map(({ m }) => m);
}

export function buildServer(
  cfg: Config,
  getApiKey: () => string | undefined,
  // HTTP mode passes one shared client so catalog/status caches survive across
  // per-request server instances; stdio mode uses the default
  client: AihubmixClient = new AihubmixClient(cfg),
  // HTTP mode: the Host the current request arrived on (which public entrance
  // the caller used); stdio mode leaves it undefined
  getEntrance: () => string | undefined = () => undefined,
  // HTTP mode: Manage Key from the X-Aihubmix-Manage-Key header — the remote counterpart
  // of the local CLI-login/env sources (a hosted pod cannot read the user's ~/.aihubmix)
  getManageKey: () => string | undefined = () => undefined,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  const requireKey = (): string => {
    const key = getApiKey();
    if (!key) {
      throw new Error(
        "no AIHubMix API key: set the AIHUBMIX_API_KEY environment variable (stdio mode) " +
          'or send an "Authorization: Bearer <key>" header (HTTP mode). Keys: https://aihubmix.com/token',
      );
    }
    return key;
  };

  /** Present on responses only when a fallback endpoint served the request. */
  const endpointNote = (): string | undefined =>
    client.onFallback
      ? `served via fallback upstream ${displayBase(client.activeBase, cfg.publicBases)} (primary ${displayBase(client.primaryBase, cfg.publicBases)} was unreachable; ` +
        "same backend and data, the primary is re-probed automatically — no action needed)"
      : undefined;

  server.registerTool(
    "ping",
    {
      title: "Ping AIHubMix",
      description:
        "Health-check every configured gateway endpoint (with latency) and report which one is active. " +
        "Diagnostic: returns ok=false with reasons instead of erroring when endpoints are down.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      // ping is a diagnostic: an unreachable gateway is a *finding*, not a tool failure.
      // Probes the union of upstream bases (data-plane failover chain) and public
      // entrances (the domains users connect through), labeling each by role.
      const entranceHost = getEntrance();
      const upstreamSet = new Set(client.bases);
      const probeList = [...client.bases, ...cfg.publicBases.filter((b) => !upstreamSet.has(b))];
      const endpoints = await Promise.all(
        probeList.map(async (base) => {
          const roles: string[] = [];
          if (upstreamSet.has(base)) roles.push("upstream");
          if (cfg.publicBases.includes(base)) roles.push("public-entrance");
          const started = Date.now();
          try {
            const status = await client.probeBase(base);
            return {
              endpoint: displayBase(base, cfg.publicBases),
              roles,
              reachable: true,
              latency_ms: Date.now() - started,
              system_name: status.system_name,
              _base: base,
            };
          } catch (e) {
            return { endpoint: displayBase(base, cfg.publicBases), roles, reachable: false, error: errText(e), _base: base };
          }
        }),
      );
      const firstUpUpstream = endpoints.find((e) => e.reachable && upstreamSet.has(e._base));
      if (firstUpUpstream) client.notePreferredBase(firstUpUpstream._base); // teach later calls the healthy upstream
      // match the entrance to its endpoint family by registrable domain, so
      // mcp.aihubmix.com ↔ aihubmix.com and mcp.inferera.com ↔ api.inferera.com
      const family = (host: string) => host.split(".").slice(-2).join(".");
      const entranceMatch = entranceHost
        ? endpoints.find((e) => {
            try {
              return family(new URL(e._base).hostname) === family(entranceHost);
            } catch {
              return false;
            }
          })
        : undefined;
      return ok({
        ok: endpoints.some((e) => e.reachable),
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        serving_entrance: entranceHost
          ? {
              host: entranceHost,
              note:
                "the domain this call arrived through" +
                (entranceMatch
                  ? ` — same family as ${displayBase(entranceMatch._base, cfg.publicBases)} (marked current_entrance below)`
                  : ""),
            }
          : { host: "stdio (local process)", note: "local transport — no network entrance" },
        active_upstream: displayBase(client.activeBase, cfg.publicBases),
        endpoints: endpoints.map(({ _base, ...rest }) => ({
          ...rest,
          current_entrance: entranceMatch ? _base === entranceMatch._base : undefined,
          active_upstream: _base === client.activeBase ? true : undefined,
        })),
      });
    },
  );

  server.registerTool(
    "models-list",
    {
      title: "List / search AIHubMix models",
      description:
        "Search the live AIHubMix model catalog with pricing (USD per 1K tokens), context window, modalities and features. " +
        "All filters are optional and combined with AND. Public data, no API key needed.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Full-text search over model id, name and description, e.g. 'gpt-5', 'claude', 'reasoning'"),
        type: z
          .enum(["llm", "image_generation", "video", "tts", "stt", "embedding", "rerank"])
          .optional()
          .describe("Model type"),
        modalities: z
          .string()
          .optional()
          .describe("Required input modalities, comma-separated: text,image,audio,video,pdf"),
        features: z
          .string()
          .optional()
          .describe(
            "Required features, comma-separated: thinking,tools,function_calling,web,deepsearch,long_context,structured_outputs",
          ),
        sort_by: z
          .enum(["model_ratio", "context_length", "coding", "order"])
          .optional()
          .describe("model_ratio = price, context_length, coding = coding models first, order = default"),
        sort_order: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Max results to return (default 20)"),
        offset: z.number().int().min(0).optional().describe("Skip this many results (default 0)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        // search is applied CLIENT-SIDE over the cached catalog (id+name+desc full-text);
        // upstream's `model` param only substring-matches the id and would miss desc hits
        let models = await client.listModels({
          type: args.type,
          modalities: args.modalities,
          features: args.features,
          sort_by: args.sort_by,
          sort_order: args.sort_order,
        });
        if (args.search) models = fullTextFilter(models, args.search);
        if (args.sort_by === "context_length") {
          // upstream sorts context_length lexicographically ("50500" > "400000");
          // re-sort numerically here so the tool returns what the caller asked for
          const dir = args.sort_order === "asc" ? 1 : -1;
          models.sort((a, b) => dir * ((a.context_length ?? 0) - (b.context_length ?? 0)));
        }
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 20;
        const page = models.slice(offset, offset + limit);
        return ok({
          total_matched: models.length,
          offset,
          returned: page.length,
          models: page.map(modelSummary),
          hint:
            models.length > offset + page.length
              ? "more results available — refine filters or pass a larger offset"
              : undefined,
          endpoint_note: endpointNote(),
        });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "model-get",
    {
      title: "Get one AIHubMix model",
      description:
        "Fetch full details for a single model by exact model_id (pricing, full description, capabilities). " +
        "Returns close-match suggestions when the id is unknown. Public data, no API key needed.",
      inputSchema: {
        model_id: z.string().min(1).max(120).describe("Exact model id, e.g. 'gpt-5-nano' or 'claude-sonnet-4-6'"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { model, suggestions } = await client.getModel(args.model_id);
        if (!model) {
          return ok({
            found: false,
            model_id: args.model_id,
            suggestions,
            hint: suggestions.length
              ? "no exact match; closest model ids listed in suggestions"
              : "no exact or fuzzy match in the current catalog",
            endpoint_note: endpointNote(),
          });
        }
        return ok({
          found: true,
          model: { ...model, pricing_usd_per_1m_tokens: model.pricing, pricing: undefined },
          endpoint_note: endpointNote(),
        });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "credits-get",
    {
      title: "Get AIHubMix credits",
      description:
        "Account balance for the calling API key: total quota, used and remaining (USD), plus key expiry. Requires an API key.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const credits = await client.getCredits(requireKey());
        return ok({ ...credits, endpoint_note: endpointNote() });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "chat-send",
    {
      title: "Send a test chat message",
      description:
        "Send one non-streaming chat message to any AIHubMix model and get the reply with token usage and latency. " +
        "Intended for quick model testing/comparison from the editor. Requires an API key and CONSUMES CREDITS.",
      inputSchema: {
        model: z.string().min(1).max(120).describe("Model id, e.g. 'gpt-5-nano'"),
        prompt: z.string().min(1).max(8000).optional().describe("Single-turn user message (use this OR messages)"),
        messages: z
          .array(
            z.object({
              role: z.enum(["user", "assistant", "system"]),
              content: z.string().max(16000),
            }),
          )
          .min(1)
          .max(50)
          .optional()
          .describe("Multi-turn conversation (use this OR prompt)"),
        system: z.string().max(16000).optional().describe("Optional system prompt (prepended)"),
        max_tokens: z
          .number()
          .int()
          .min(1)
          .max(8192)
          .optional()
          .describe("Response token cap (default 1024)"),
        temperature: z.number().min(0).max(2).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (!args.prompt && !args.messages?.length) {
          return fail("chat-send needs either prompt (single-turn) or messages (multi-turn)");
        }
        const result = await client.chatSend(requireKey(), args);
        // reasoning models spend hidden reasoning tokens first; a small cap can produce
        // an empty reply with finish_reason=length, which looks like a broken model
        const note =
          result.content === "" && result.finish_reason === "length"
            ? "empty reply: the token cap was consumed before any visible text was produced " +
              "(reasoning models spend hidden reasoning tokens first) — retry with a larger max_tokens"
            : undefined;
        // covers the practical core of OpenRouter's generation-get without a server-side record
        const estimated_cost_usd = await client.estimateChatCost(result.model, result.usage);
        return ok({ ...result, estimated_cost_usd, note, endpoint_note: endpointNote() });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "image-generate",
    {
      title: "Generate images",
      description:
        "Generate image(s) across 23 models / 8 families. Text-to-image and image-to-image (pass input_reference). " +
        "Models: nano-banana-pro/nano-banana-2 (Gemini native: aspect_ratio, size 1K/2K/4K, google_search); " +
        "gpt-image-1.5/gpt-image-1/gpt-image-1-mini/dall-e-3 (OpenAI: size, n, quality, background, output_format); " +
        "imagen-4.0-ultra/imagen-4.0/imagen-4.0-fast/imagen-3.0 (aspect_ratio, n); flux-2-pro/flux-2-flex (aspect_ratio, seed); " +
        "ideogram-v3 (rendering_speed, aspect_ratio); seedream-5.0-lite/seedream-4.5/seedream-4.0 (Doubao: size 1K/2K/4K, watermark, seed); " +
        "wan2.7-image-pro/wan2.7-image/wan2.6-image (Wan: size, aspect_ratio, n, seed, thinking_mode, prompt_extend, negative_prompt); " +
        "qwen-image-2.0-pro/qwen-image-2.0/qwen-image-max/qwen-image (size, n, seed). " +
        "Requires an API key, CONSUMES CREDITS, can take 1–3 minutes.",
      inputSchema: {
        model: z
          .enum(Object.keys(IMAGE_MODELS) as [string, ...string[]])
          .describe("Image model (see description for per-model params)"),
        prompt: z.string().min(1).max(8000).describe("What to draw (all models)"),
        input_reference: z.string().url().optional().describe("Reference image URL for image-to-image (supported models only)"),
        size: z.string().optional().describe("OpenAI 1024x1024/1024x1536/1536x1024/auto; Doubao/Wan 1K/2K/4K or WxH; Qwen WxH"),
        aspect_ratio: z.string().optional().describe("e.g. 1:1, 16:9, 9:16 (Gemini/Imagen/Flux/Ideogram/Wan)"),
        n: z.number().int().min(1).max(12).optional().describe("Number of images (OpenAI/Imagen/Qwen/Wan)"),
        quality: z.enum(["low", "medium", "high", "auto"]).optional().describe("OpenAI image quality"),
        moderation: z.enum(["auto", "low"]).optional().describe("OpenAI content moderation"),
        background: z.enum(["transparent", "opaque", "auto"]).optional().describe("OpenAI background"),
        output_format: z.enum(["png", "jpeg", "webp"]).optional().describe("OpenAI output format"),
        input_fidelity: z.enum(["low", "high"]).optional().describe("OpenAI edit fidelity to reference"),
        response_format: z.enum(["url", "base64_json"]).optional().describe("Doubao response format"),
        rendering_speed: z.enum(["QUALITY", "SPEED"]).optional().describe("Ideogram rendering speed"),
        negative_prompt: z.string().optional().describe("Wan/Qwen negative prompt"),
        prompt_extend: z.boolean().optional().describe("Wan/Qwen automatic prompt rewriting"),
        thinking_mode: z.boolean().optional().describe("Wan 2.7 thinking mode"),
        google_search: z.boolean().optional().describe("Gemini native Google Search grounding"),
        watermark: z.boolean().optional().describe("Doubao/Wan/Qwen watermark"),
        seed: z.number().int().optional().describe("Random seed for reproducibility"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await client.imageGenerate(requireKey(), args);
        const content: ContentBlock[] = result.content.map((c) =>
          c.type === "image" ? { type: "image", data: c.data, mimeType: c.mimeType } : { type: "text", text: c.text },
        );
        const imageCount = result.content.filter((c) => c.type === "image").length;
        const urlCount = result.content.filter((c) => c.type === "text").length;
        content.push({
          type: "text",
          text: JSON.stringify(
            {
              model: `${args.model} (${result.model})`,
              label: result.label,
              images_inline: imageCount,
              image_urls: urlCount,
              latency_ms: result.latency_ms,
              note: result.note,
              endpoint_note: endpointNote(),
            },
            null,
            2,
          ),
        });
        if (result.content.length === 0) {
          return fail(result.note || "image API returned no image (model may not be enabled on this account)");
        }
        return { content };
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "video-generate",
    {
      title: "Generate video (async)",
      description:
        "Generate a video (submits a task then polls until ready — can take several minutes). " +
        "Models: seedance-2.0 / seedance-2.0-fast (ByteDance SeeDance, 4-15s, resolution 480p/720p/1080p, aspect_ratio, watermark, seed, camera_fixed, generate_audio, image-to-video); " +
        "sora-2 / sora-2-pro (OpenAI Sora, 4/8/12s, size 720x1280…1792x1024, image-to-video); " +
        "wan-2.7 / wan-2.6 / wan-2.5 (Alibaba Wan, size WxH, image-to-video); " +
        "jimeng-3.0-pro / jimeng-3.0 (ByteDance Jimeng, 5/10s, image-to-video). " +
        "Returns task id, status, and an authenticated download URL. Requires an API key, CONSUMES CREDITS.",
      inputSchema: {
        model: z.enum(Object.keys(VIDEO_MODELS) as [string, ...string[]]).describe("Video model"),
        prompt: z.string().min(1).max(8000).describe("What the video should show"),
        input_reference: z.string().url().optional().describe("Reference image URL for image-to-video (supported models)"),
        seconds: z.number().int().min(1).max(20).optional().describe("Duration (snapped to the model's supported range)"),
        size: z.string().optional().describe("Pixel size WxH (Sora/Wan/Jimeng), e.g. 1280x720"),
        aspect_ratio: z.string().optional().describe("e.g. 16:9, 9:16 (SeeDance ratio)"),
        resolution: z.enum(["480p", "720p", "1080p"]).optional().describe("Resolution token (SeeDance)"),
        watermark: z.boolean().optional().describe("Add watermark (SeeDance)"),
        seed: z.number().int().optional().describe("Random seed (SeeDance)"),
        camera_fixed: z.boolean().optional().describe("Fix the camera (SeeDance)"),
        generate_audio: z.boolean().optional().describe("Generate audio track (SeeDance/Wan)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const r = await client.videoGenerate(requireKey(), args);
        return ok({ ...r, download_note: "GET the download_url with header: Authorization: Bearer <key>", endpoint_note: endpointNote() });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "docs-search",
    {
      title: "Search AIHubMix docs",
      description:
        "Search the official AIHubMix documentation index (docs.aihubmix.com) by keyword; returns page titles, URLs and summaries. " +
        "Follow up with docs-get to read a page. Public data, no API key needed.",
      inputSchema: {
        query: z.string().min(1).max(300).describe("Keywords, English or Chinese, e.g. 'claude code' or '计费'"),
        lang: z.enum(["cn", "en", "de", "es"]).optional().describe("Restrict to one docs language (default: all)"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 8)"),
        search_content: z
          .boolean()
          .optional()
          .describe("true = search full page bodies and return snippets (slower first call); default searches titles/summaries"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        if (args.search_content) {
          const { results, stale } = await searchDocsContent(cfg, args.query, args.lang, args.limit ?? 8);
          return ok({
            query: args.query,
            mode: "content",
            returned: results.length,
            results,
            hint: results.length === 0 ? "no matches — try shorter or English keywords" : undefined,
            stale_note: stale ? "results come from a cached copy: the docs site is currently unreachable" : undefined,
          });
        }
        const { entries, stale } = await getDocsIndex(cfg);
        const results = scoreDocs(entries, args.query, args.lang, args.limit ?? 8);
        return ok({
          query: args.query,
          mode: "index",
          returned: results.length,
          results,
          hint:
            results.length === 0
              ? "no matches in titles/summaries — retry with search_content: true to search page bodies"
              : undefined,
          stale_note: stale
            ? "results come from a cached copy of the docs index: the docs site is currently " +
              "unreachable from this network, so docs-get for uncached pages may fail"
            : undefined,
        });
      } catch (e) {
        return fail(docsErrText(e));
      }
    },
  );

  server.registerTool(
    "docs-get",
    {
      title: "Read an AIHubMix docs page",
      description:
        "Fetch one documentation page from docs.aihubmix.com as markdown (use URLs returned by docs-search). Public data, no API key needed.",
      inputSchema: {
        url: z.string().url().describe("Docs page URL from docs-search, e.g. https://docs.aihubmix.com/cn/api/Claude-Code.md"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const page = await getDocPage(cfg, args.url);
        return {
          content: [
            {
              type: "text" as const,
              text: `# source: ${page.url}${page.truncated ? "\n# (truncated)" : ""}\n\n${page.markdown}`,
            },
          ],
        };
      } catch (e) {
        return fail(docsErrText(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // Account tools (AiHubMix CLI parity). Credential: Manage Key, NOT sk- key.
  // Reads are always registered; key-admin WRITES only with AIHUBMIX_ENABLE_KEY_ADMIN=1.
  // -------------------------------------------------------------------------

  const resolveManageKey = (): { token: string; source: "request-header" | "env" | "cli-login" } => {
    // per-request header wins (remote/hosted mode), then env, then the local CLI login
    const hdr = getManageKey();
    if (hdr) return { token: hdr, source: "request-header" };
    if (cfg.accessToken) return { token: cfg.accessToken, source: "env" };
    const t = readCliManageKey();
    if (t) return { token: t, source: "cli-login" };
    throw new Error(
      "no Manage Key: account tools need the 系统访问令牌 (fd***, NOT the sk- API key). " +
        "Local (stdio): run `aihubmix login` (this server shares the CLI login) or set AIHUBMIX_ACCESS_TOKEN. " +
        'Remote (HTTP): send it in the "X-Aihubmix-Manage-Key" request header. ' +
        'Generate the key at https://console.aihubmix.com/setting ("生成系统访问令牌").',
    );
  };

  /** Account errors with a rejected credential get a fix-it message the model can relay. */
  const accountFail = (e: unknown, source: "request-header" | "env" | "cli-login"): ToolResult => {
    if (e instanceof UpstreamError && (e.status === 401 || /unauthorized|invalid or expired/i.test(e.message))) {
      const sourceLabel =
        source === "request-header"
          ? "X-Aihubmix-Manage-Key request header"
          : source === "cli-login"
            ? "aihubmix CLI login"
            : "AIHUBMIX_ACCESS_TOKEN env";
      const fix =
        source === "request-header"
          ? "generate a fresh 系统访问令牌 on the SAME site this server talks to (its console → 设置) and update the header — note prod and test sites have独立 accounts."
          : source === "cli-login"
            ? "re-run `aihubmix login` with a fresh 系统访问令牌 from https://console.aihubmix.com/setting."
            : "generate a fresh 系统访问令牌 at https://console.aihubmix.com/setting and update AIHUBMIX_ACCESS_TOKEN.";
      return fail(`${errText(e)} — the Manage Key (source: ${sourceLabel}) was rejected as invalid or expired. Fix: ${fix}`);
    }
    return fail(errText(e));
  };

  server.registerTool(
    "account-get",
    {
      title: "Get AIHubMix account profile",
      description:
        "Account-level profile and balance for the Manage Key owner: username, group, total balance and used amount (USD), " +
        "request count. This is the ACCOUNT balance — credits-get shows the calling sk- key's balance. Requires AIHUBMIX_ACCESS_TOKEN.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      let source: "request-header" | "env" | "cli-login" = "env";
      try {
        const cred = resolveManageKey();
        source = cred.source;
        const self = await client.getSelf(cred.token);
        return ok({ ...self, credential_source: source, endpoint_note: endpointNote() });
      } catch (e) {
        return accountFail(e, source);
      }
    },
  );

  server.registerTool(
    "keys-list",
    {
      title: "List AIHubMix API keys",
      description:
        "List the account's API keys with status, remaining/used quota (USD), expiry and model/IP restrictions. " +
        "Key values are masked (last 4 chars only). Requires AIHUBMIX_ACCESS_TOKEN.",
      inputSchema: {
        num: z.number().int().min(1).max(500).optional().describe("Max keys to return (upstream default when omitted)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      let source: "request-header" | "env" | "cli-login" = "env";
      try {
        const cred = resolveManageKey();
        source = cred.source;
        const keys = await client.listKeys(cred.token, args.num);
        return ok({ count: keys.length, keys, endpoint_note: endpointNote() });
      } catch (e) {
        return accountFail(e, source);
      }
    },
  );

  server.registerTool(
    "account-models",
    {
      title: "List models available to this account",
      description:
        "Models usable by THIS account's group (may differ from the public catalog in models-list). Requires AIHUBMIX_ACCESS_TOKEN.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      let source: "request-header" | "env" | "cli-login" = "env";
      try {
        const cred = resolveManageKey();
        source = cred.source;
        const data = await client.accountModels(cred.token);
        return ok({
          models: data,
          count: Array.isArray(data) ? data.length : undefined,
          endpoint_note: endpointNote(),
        });
      } catch (e) {
        return accountFail(e, source);
      }
    },
  );

  if (cfg.enableKeyAdmin) {
    server.registerTool(
      "keys-create",
      {
        title: "Create an AIHubMix API key",
        description:
          "Create a new API key with optional quota cap (USD), expiry and model/IP restrictions. " +
          "Returns the FULL sk- key ONCE — treat the output as a secret. Prefer small quotas and expiry dates " +
          "(e.g. a dedicated low-quota key per tool). Requires AIHUBMIX_ACCESS_TOKEN.",
        inputSchema: {
          name: z.string().min(1).max(64).describe("Key name, e.g. 'mcp-dedicated'"),
          quota_usd: z.number().positive().optional().describe("Quota cap in USD (omit with unlimited=true for no cap)"),
          unlimited: z.boolean().optional().describe("No quota cap (default false; prefer a quota_usd cap)"),
          expires_in_days: z.number().positive().optional().describe("Expire after N days (default: never)"),
          models: z.string().optional().describe("Comma-separated model whitelist (default: all)"),
          subnet: z.string().optional().describe("Allowed IP/CIDR (default: any)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        let source: "request-header" | "env" | "cli-login" = "env";
        try {
          const cred = resolveManageKey();
          source = cred.source;
          const created = await client.createKey(cred.token, args);
          return ok({
            ...created,
            security_note: "the full key above is shown ONCE — store it now; keys-list only shows the last 4 chars",
            endpoint_note: endpointNote(),
          });
        } catch (e) {
          return accountFail(e, source);
        }
      },
    );

    server.registerTool(
      "keys-update",
      {
        title: "Update an AIHubMix API key",
        description:
          "Update a key's name, quota (USD), expiry, enabled state or model/IP restrictions. Unspecified fields keep " +
          "their current values (read-merge-write). Requires AIHUBMIX_ACCESS_TOKEN.",
        inputSchema: {
          id: z.number().int().describe("Key ID (from keys-list)"),
          name: z.string().min(1).max(64).optional(),
          quota_usd: z.number().min(0).optional().describe("New remaining quota in USD"),
          unlimited: z.boolean().optional(),
          expires_in_days: z.number().positive().optional().describe("Expire after N days from now"),
          never_expires: z.boolean().optional().describe("Clear the expiry"),
          models: z.string().optional().describe("Comma-separated model whitelist ('' clears)"),
          subnet: z.string().optional(),
          enabled: z.boolean().optional().describe("Enable/disable the key"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        let source: "request-header" | "env" | "cli-login" = "env";
        try {
          const cred = resolveManageKey();
          source = cred.source;
          const updated = await client.updateKey(cred.token, args);
          return ok({ ...updated, endpoint_note: endpointNote() });
        } catch (e) {
          return accountFail(e, source);
        }
      },
    );

    server.registerTool(
      "keys-delete",
      {
        title: "Delete an AIHubMix API key",
        description:
          "Permanently delete an API key by ID. IRREVERSIBLE — anything still using the key loses access immediately. " +
          "Confirm the ID against keys-list first. Requires AIHUBMIX_ACCESS_TOKEN.",
        inputSchema: {
          id: z.number().int().describe("Key ID (from keys-list)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async (args) => {
        let source: "request-header" | "env" | "cli-login" = "env";
        try {
          const cred = resolveManageKey();
          source = cred.source;
          const result = await client.deleteKey(cred.token, args.id);
          return ok({ ...result, endpoint_note: endpointNote() });
        } catch (e) {
          return accountFail(e, source);
        }
      },
    );
  }

  return server;
}
