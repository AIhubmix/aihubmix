import type { Config } from "./config.js";
import {
  aihubmixMediaRegistry,
  buildVideoRequest,
  normalizeVideoResponse,
  type NormalizedVideoResponse,
} from "@aihubmix/media-adapters";

/** Model record as returned by GET /api/v1/models (public, no auth). */
export interface AihubmixModel {
  model_id: string;
  model_name?: string;
  developer_id?: number;
  desc?: string;
  types?: string;
  features?: string;
  input_modalities?: string;
  max_output?: number;
  context_length?: number;
  pricing?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    [k: string]: number | undefined;
  };
  [k: string]: unknown;
}

export interface ModelsQuery {
  /** Fuzzy name match, maps to the upstream `model` query param */
  search?: string;
  type?: string;
  modalities?: string;
  features?: string;
  sort_by?: string;
  sort_order?: string;
}

export interface GatewayStatus {
  system_name?: string;
  version?: string;
  quota_per_unit?: number;
  display_in_currency?: boolean;
}

/**
 * Fail-closed check for whether a host is safe to reveal in public tool output.
 * Returns true ONLY for hosts we're confident are internet-routable; everything
 * ambiguous — bare in-cluster service names, loopback, RFC1918 private ranges,
 * 100.64/10 CGNAT, 169.254 link-local, IPv6 ULA (fc00::/7), and *.svc / .local /
 * .internal / .cluster.local suffixes — is treated as internal, so cluster topology
 * cannot leak through display fields or the error channel (H1).
 */
export function isPublicHost(host: string): boolean {
  if (!host) return false;
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // strip IPv6 brackets
  h = h.replace(/%.*$/, ""); // strip IPv6 zone id
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return false;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const o = v4.slice(1).map((n) => parseInt(n, 10));
    if (o.some((n) => n > 255)) return false; // malformed dotted-quad — don't echo
    const [a, b] = o;
    if (a === 0 || a === 127 || a === 10) return false; // this-host / loopback / 10/8 private
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12 private
    if (a === 192 && b === 168) return false; // 192.168/16 private
    if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
    if (a >= 224) return false; // multicast / reserved
    return true;
  }

  if (h.includes(":")) {
    // IPv6 literal
    if (h === "::1" || h === "::") return false; // loopback / unspecified
    if (/^fe80:/.test(h)) return false; // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return false; // fc00::/7 unique-local
    if (h.startsWith("::ffff:")) return isPublicHost(h.slice(7)); // IPv4-mapped
    return true;
  }

  if (!h.includes(".")) return false; // bare single-label name = in-cluster service
  if (
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".svc") ||
    h.endsWith(".cluster.local") ||
    h.includes(".svc.")
  ) {
    return false;
  }
  return true;
}

// Scheme-less internal authorities that redactInternal scrubs on top of full URLs.
const INTERNAL_HOST_RE =
  /\b(?:[a-z0-9-]+\.)+(?:svc\.cluster\.local|cluster\.local|internal|svc|local)(?![a-z0-9.-])(?::\d+)?/gi;
const INTERNAL_IP_RE =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b(?::\d+)?/g;

/**
 * Scrub cluster-internal origins from arbitrary text before it reaches a user or
 * their LLM. H1: displayBase only masks *display* fields, so raw internal FQDNs/IPs
 * embedded in error messages (and undici cause chains) would otherwise bypass it.
 * Collapses any http(s) URL with a non-public host, plus scheme-less internal DNS
 * names and private/loopback/CGNAT/link-local IP literals, to role labels.
 */
export function redactInternal(text: string): string {
  if (!text) return text;
  return String(text)
    .replace(/\bhttps?:\/\/[^\s"'`<>)\]}]+/gi, (m) => {
      try {
        return isPublicHost(new URL(m).hostname) ? m : "[internal-endpoint]";
      } catch {
        return "[internal-endpoint]";
      }
    })
    .replace(INTERNAL_HOST_RE, "[internal-host]")
    .replace(INTERNAL_IP_RE, "[internal-ip]");
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly type?: string,
    /** low-level error code (ENOTFOUND, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, TIMEOUT, …) */
    public readonly code?: string,
  ) {
    // H1: redact at the single choke point every upstream failure funnels through, so a
    // raw internal FQDN/IP in the message can never surface via ping/error tool output.
    super(redactInternal(message));
    this.name = "UpstreamError";
  }
}

/** Walk cause chains / AggregateError to find a network error code. */
function errorCode(e: unknown): string | undefined {
  const messages: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    if (typeof cur === "object" && cur !== null) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string") return code;
      const msg = (cur as { message?: unknown }).message;
      if (typeof msg === "string") messages.push(msg);
      if (cur instanceof AggregateError && cur.errors.length > 0) {
        cur = cur.errors[0];
        continue;
      }
      cur = (cur as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  // some wrappers carry the code only in text; undici's pre-dial rejections
  // ("bad port", fetch-spec blocked ports) have no code at all
  const joined = messages.join(" | ");
  const m = joined.match(/\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)\b/);
  if (m) return m[1];
  if (/bad port/i.test(joined)) return "EBADPORT";
  return undefined;
}

/**
 * Errors that happen strictly before the request reaches the gateway. Only these
 * are safe to fail over for non-idempotent (billable) requests: the server never
 * saw the request, so retrying elsewhere cannot double-bill.
 */
const CONNECT_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "EBADPORT", // undici refused pre-dial (fetch-spec blocked port) — request never sent
]);

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) {
      throw new UpstreamError(`request to ${url} timed out after ${timeoutMs}ms`, undefined, undefined, "TIMEOUT");
    }
    throw new UpstreamError(
      `request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`,
      undefined,
      undefined,
      errorCode(e),
    );
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonOnce<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const res = await fetchWithTimeout(url, init, timeoutMs);
  const text = await res.text();
  // H1: only echo the raw upstream body when the endpoint is a public host. The URL
  // itself is scrubbed centrally by UpstreamError, but a cluster-internal upstream's
  // response body is free-form text that redactInternal can't fully sanitize — drop it.
  let publicEndpoint = false;
  try {
    publicEndpoint = isPublicHost(new URL(url).hostname);
  } catch {
    publicEndpoint = false;
  }
  const bodyTail = (n: number): string => (publicEndpoint ? `: ${text.slice(0, n)}` : "");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UpstreamError(
      `non-JSON response (HTTP ${res.status}) from ${url}${bodyTail(200)}`,
      res.status,
    );
  }
  // central guard (gemini review): a literal "null"/primitive body would make every
  // downstream property access throw a bare TypeError instead of an UpstreamError
  if (body === null || typeof body !== "object") {
    throw new UpstreamError(
      `unexpected non-object JSON (HTTP ${res.status}) from ${url}${bodyTail(100)}`,
      res.status,
    );
  }
  // The gateway reports some errors as {"error": {...}} with HTTP 200.
  const errObj = (body as { error?: { message?: string; type?: string } }).error;
  if (errObj && typeof errObj === "object") {
    throw new UpstreamError(errObj.message || "upstream error", res.status, errObj.type);
  }
  if (!res.ok) {
    throw new UpstreamError(`HTTP ${res.status} from ${url}${bodyTail(200)}`, res.status);
  }
  return body as T;
}

function isTransient(e: unknown): boolean {
  return e instanceof UpstreamError && e.status === undefined;
}

/**
 * `retries` re-attempts NETWORK-level failures only (no HTTP status). HTTP/semantic
 * errors never retry. Billable POSTs must stay at 0 to avoid double billing.
 */
async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number, retries = 0): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchJsonOnce<T>(url, init, timeoutMs);
    } catch (e) {
      if (!isTransient(e) || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

/**
 * Client for the AIHubMix gateway API with automatic endpoint failover.
 *
 * cfg.apiBases is an ordered chain (primary first). Network-level failures move to
 * the next base; the base that serves a request becomes sticky so later calls skip
 * the dead endpoint's timeout. While on a fallback, the primary is re-probed at most
 * once per REPROBE_PRIMARY_MS so a recovered primary wins back automatically.
 * Models never need to pick a region by hand — ping exposes per-endpoint health.
 */
export class AihubmixClient {
  private modelsCache = new Map<string, CacheEntry<AihubmixModel[]>>();
  private statusCache: CacheEntry<GatewayStatus> | null = null;
  private preferred = 0;
  private lastPrimaryProbeAt = 0;
  private static readonly MODELS_TTL_MS = 5 * 60_000; // mirrors upstream Cache-Control max-age=300
  private static readonly MODELS_CACHE_MAX = 64; // bound distinct-query growth on long-lived instances
  private static readonly STATUS_TTL_MS = 5 * 60_000;
  private static readonly REPROBE_PRIMARY_MS = 10 * 60_000;
  /** per-attempt cap while other candidates remain, so a dead endpoint fails fast */
  private static readonly FAILOVER_ATTEMPT_TIMEOUT_MS = 10_000;

  constructor(private readonly cfg: Config) {}

  get primaryBase(): string {
    return this.cfg.apiBases[0];
  }

  get activeBase(): string {
    return this.cfg.apiBases[this.preferred] ?? this.cfg.apiBases[0];
  }

  get onFallback(): boolean {
    return this.activeBase !== this.primaryBase;
  }

  get bases(): string[] {
    return [...this.cfg.apiBases];
  }

  /** Candidate base indices in try-order, honoring stickiness and the periodic primary re-probe. */
  private candidateOrder(): number[] {
    const n = this.cfg.apiBases.length;
    let start = this.preferred;
    if (start !== 0 && Date.now() - this.lastPrimaryProbeAt > AihubmixClient.REPROBE_PRIMARY_MS) {
      this.lastPrimaryProbeAt = Date.now();
      start = 0;
    }
    return Array.from({ length: n }, (_, k) => (start + k) % n);
  }

  private markServed(idx: number): void {
    this.preferred = idx;
  }

  /** Explicitly prefer a base (used by ping after probing endpoint health). */
  notePreferredBase(base: string): void {
    const idx = this.cfg.apiBases.indexOf(base);
    if (idx >= 0) this.markServed(idx);
  }

  /** GET with failover across the base chain; retries stay within each base. */
  private async getJson<T>(
    pathAndQuery: string,
    headers: Record<string, string> | undefined,
    retriesPerBase: number,
  ): Promise<T> {
    const order = this.candidateOrder();
    let lastErr: unknown;
    for (let oi = 0; oi < order.length; oi++) {
      const idx = order[oi];
      const base = this.cfg.apiBases[idx];
      const hasMore = oi < order.length - 1;
      const attemptTimeout = hasMore
        ? Math.min(this.cfg.timeoutMs, AihubmixClient.FAILOVER_ATTEMPT_TIMEOUT_MS)
        : this.cfg.timeoutMs;
      try {
        const value = await fetchJson<T>(
          `${base}${pathAndQuery}`,
          { method: "GET", headers },
          attemptTimeout,
          retriesPerBase,
        );
        this.markServed(idx);
        return value;
      } catch (e) {
        if (!isTransient(e)) {
          this.markServed(idx); // the gateway answered — semantic error, other bases won't differ
          throw e;
        }
        lastErr = e; // network-level: try the next base
      }
    }
    throw lastErr;
  }

  private authHeaders(apiKey: string): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (this.cfg.appCode) h["APP-Code"] = this.cfg.appCode;
    return h;
  }

  /** GET /api/status — public gateway metadata, used by ping and billing normalization. */
  async status(): Promise<GatewayStatus> {
    if (this.statusCache && Date.now() - this.statusCache.at < AihubmixClient.STATUS_TTL_MS) {
      return this.statusCache.value;
    }
    const body = await this.getJson<{ data?: Record<string, unknown> }>("/api/status", undefined, 1);
    const value = parseStatus(body);
    this.statusCache = { at: Date.now(), value };
    return value;
  }

  /** Probe one specific base (no failover, short timeout) — powers ping's per-endpoint health. */
  async probeBase(base: string): Promise<GatewayStatus> {
    const body = await fetchJson<{ data?: Record<string, unknown> }>(
      `${base}/api/status`,
      { method: "GET" },
      Math.min(this.cfg.timeoutMs, 8_000),
      0,
    );
    return parseStatus(body);
  }

  /** GET /api/v1/models — public model catalog with pricing/capabilities. */
  async listModels(q: ModelsQuery = {}): Promise<AihubmixModel[]> {
    const params = new URLSearchParams();
    if (q.search) params.set("model", q.search);
    if (q.type) params.set("type", q.type);
    if (q.modalities) params.set("modalities", q.modalities);
    if (q.features) params.set("features", q.features);
    if (q.sort_by) params.set("sort_by", q.sort_by);
    if (q.sort_order) params.set("sort_order", q.sort_order);
    const key = params.toString();

    const hit = this.modelsCache.get(key);
    if (hit && Date.now() - hit.at < AihubmixClient.MODELS_TTL_MS) return hit.value;

    const body = await this.getJson<{ success?: boolean; message?: string; data?: AihubmixModel[] }>(
      `/api/v1/models${key ? `?${key}` : ""}`,
      undefined,
      1,
    );
    if (body.success === false) {
      throw new UpstreamError(body.message || "models API returned success=false");
    }
    // drop null/malformed catalog entries so downstream model_id reads can't throw
    const models = (Array.isArray(body.data) ? body.data : []).filter(
      (m): m is AihubmixModel => m !== null && typeof m === "object" && typeof (m as AihubmixModel).model_id === "string",
    );
    if (this.modelsCache.size >= AihubmixClient.MODELS_CACHE_MAX) {
      const oldest = this.modelsCache.keys().next().value;
      if (oldest !== undefined) this.modelsCache.delete(oldest);
    }
    this.modelsCache.set(key, { at: Date.now(), value: models });
    return models;
  }

  /** Exact model lookup over the cached catalog; falls back to fuzzy suggestions. */
  async getModel(modelId: string): Promise<{ model?: AihubmixModel; suggestions: string[] }> {
    const all = await this.listModels();
    const exact = all.find((m) => m.model_id === modelId);
    if (exact) return { model: exact, suggestions: [] };
    const needle = modelId.toLowerCase();
    let candidates = all.filter((m) => m.model_id.toLowerCase().includes(needle));
    if (candidates.length === 0) {
      // typo fallback: rank by longest common prefix with the requested id
      const lcp = (a: string, b: string): number => {
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        return i;
      };
      candidates = all
        .map((m) => ({ m, p: lcp(m.model_id.toLowerCase(), needle) }))
        .filter(({ p }) => p >= 3)
        .sort((a, b) => b.p - a.p)
        .slice(0, 10)
        .map(({ m }) => m);
    }
    return { suggestions: candidates.slice(0, 10).map((m) => m.model_id) };
  }

  /**
   * Account credits for the calling API key.
   * subscription → total quota + expiry; usage → used (×100); remain → remaining.
   * When the gateway runs with display_in_currency=false these endpoints return raw
   * quota units instead of USD, so values are normalized via /api/status quota_per_unit.
   */
  async getCredits(apiKey: string): Promise<{
    total_usd: number | null;
    used_usd: number | null;
    remaining_usd: number | null;
    key_expires_at: string | null;
  }> {
    const headers = this.authHeaders(apiKey);
    const [sub, usage, remain, status] = await Promise.all([
      this.getJson<{ soft_limit_usd?: number; access_until?: number }>(
        "/v1/dashboard/billing/subscription",
        headers,
        1,
      ),
      this.getJson<{ total_usage?: number }>("/dashboard/billing/usage", headers, 1),
      this.getJson<{ total_usage?: number }>("/dashboard/billing/remain", headers, 1),
      this.status().catch(() => ({}) as GatewayStatus), // normalization is best-effort
    ]);
    // aihubmix.com runs display_in_currency=true (values already USD); self-hosted/test
    // sites may not, in which case values are raw quota units (quota_per_unit per USD)
    const toUsd =
      status.display_in_currency === false && typeof status.quota_per_unit === "number" && status.quota_per_unit > 0
        ? (n: number) => n / status.quota_per_unit!
        : (n: number) => n;
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    const total = typeof sub.soft_limit_usd === "number" ? round(toUsd(sub.soft_limit_usd)) : null;
    const used = typeof usage.total_usage === "number" ? round(toUsd(usage.total_usage / 100)) : null;
    const remaining = typeof remain.total_usage === "number" ? round(toUsd(remain.total_usage)) : null;
    const expires =
      typeof sub.access_until === "number" && sub.access_until > 0
        ? new Date(sub.access_until * 1000).toISOString()
        : null;
    return { total_usd: total, used_usd: used, remaining_usd: remaining, key_expires_at: expires };
  }

  /**
   * POST /v1/chat/completions — single non-streaming test message. Consumes credits.
   * Never retried on the same base. Fails over to the next base ONLY on connect-phase
   * errors (request provably never reached the gateway), so it cannot double-bill.
   */
  async chatSend(
    apiKey: string,
    args: {
      model: string;
      prompt?: string;
      messages?: Array<{ role: string; content: string }>;
      system?: string;
      max_tokens?: number;
      temperature?: number;
    },
  ): Promise<{
    model: string;
    content: string;
    finish_reason: string | null;
    usage: unknown;
    latency_ms: number;
  }> {
    const messages: Array<{ role: string; content: string }> = [];
    if (args.system) messages.push({ role: "system", content: args.system });
    if (args.messages?.length) {
      messages.push(...args.messages);
    } else if (args.prompt) {
      messages.push({ role: "user", content: args.prompt });
    } else {
      throw new UpstreamError("chat-send requires either prompt or messages");
    }

    const payload: Record<string, unknown> = {
      model: args.model,
      messages,
      stream: false,
      max_tokens: args.max_tokens ?? 1024,
    };
    if (typeof args.temperature === "number") payload.temperature = args.temperature;
    const init: RequestInit = {
      method: "POST",
      headers: { ...this.authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
    // reasoning models (gpt-5*, o*) can legitimately take much longer than data lookups
    const chatTimeout = Math.max(this.cfg.timeoutMs, 120_000);

    const order = this.candidateOrder();
    let lastErr: unknown;
    for (const idx of order) {
      const base = this.cfg.apiBases[idx];
      const started = Date.now();
      try {
        const body = await fetchJsonOnce<{
          model?: string;
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          usage?: unknown;
        }>(`${base}/v1/chat/completions`, init, chatTimeout);
        this.markServed(idx);
        const choice = body.choices?.[0];
        return {
          model: body.model || args.model,
          content: choice?.message?.content ?? "",
          finish_reason: choice?.finish_reason ?? null,
          usage: body.usage ?? null,
          latency_ms: Date.now() - started,
        };
      } catch (e) {
        const connectPhase =
          e instanceof UpstreamError && e.status === undefined && e.code !== undefined && CONNECT_ERROR_CODES.has(e.code);
        if (!connectPhase) {
          if (e instanceof UpstreamError && e.status !== undefined) this.markServed(idx);
          throw e; // answered or ambiguous (possibly billed) — never re-send
        }
        lastErr = e;
      }
    }
    throw lastErr;
  }

  /**
   * Generate images across 23 models / 8 families (ported from AIhubmix/aihubmix
   * packages/mcp). Gemini-native models use the generateContent endpoint; the rest
   * use /v1/models/{model}/predictions with per-family request shaping. Supports
   * image-to-image via input_reference. Consumes credits — same billing-safe rules
   * as chatSend: no same-base retry, connect-phase-only failover.
   */
  async imageGenerate(
    apiKey: string,
    args: { model: string; prompt: string; [k: string]: unknown },
  ): Promise<{ model: string; label: string; content: ImageContentItem[]; latency_ms: number; note?: string }> {
    const def = IMAGE_MODELS[args.model];
    if (!def) {
      throw new UpstreamError(`unknown image model "${args.model}". Available: ${Object.keys(IMAGE_MODELS).join(", ")}`);
    }
    const family = getImageFamily(def.apiModel);
    const imageTimeout = Math.max(this.cfg.timeoutMs, 300_000);

    // Build the request once (base-independent). Gemini image-to-image needs the
    // reference fetched to inline base64; predictions families take the URL directly.
    let path: string;
    let payload: Record<string, unknown>;
    if (family === "gemini-native") {
      const parts: Array<Record<string, unknown>> = [{ text: String(args.prompt || "") }];
      const ref = typeof args.input_reference === "string" ? args.input_reference.trim() : "";
      if (ref) {
        const inline = await urlToInlineData(ref, imageTimeout);
        parts.push({ inlineData: { mimeType: inline.mimeType, data: inline.data } });
      }
      const size = normalizeSize(args.size as string | undefined);
      payload = {
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            ...(args.aspect_ratio ? { aspectRatio: args.aspect_ratio } : {}),
            ...(size ? { imageSize: size } : {}),
          },
        },
        ...(args.google_search ? { tools: [{ googleSearch: {} }] } : {}),
      };
      path = `/gemini/v1beta/models/${def.apiModel}:generateContent`;
    } else {
      payload = { input: buildPredictionsInput(args, def.apiModel) };
      path = `/v1/models/${def.apiModel}/predictions`;
    }
    const init: RequestInit = {
      method: "POST",
      headers: { ...this.authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };

    const order = this.candidateOrder();
    let lastErr: unknown;
    for (const idx of order) {
      const base = this.cfg.apiBases[idx];
      const started = Date.now();
      try {
        const data = await fetchJsonOnce<any>(`${base}${path}`, init, imageTimeout);
        this.markServed(idx);
        let content = extractImageContents(data);
        // FLUX 2 and similar return a polling URL first — follow it (idempotent GET).
        if (content.length === 0) {
          const out = data?.output;
          const pollingUrl = Array.isArray(out) ? out.find((i: any) => i?.polling_url)?.polling_url : out?.polling_url;
          if (pollingUrl) {
            try {
              content = await pollForImage(pollingUrl, apiKey, imageTimeout);
            } catch (e) {
              content = [{ type: "text", text: `polling URL: ${pollingUrl} (${e instanceof Error ? e.message : String(e)})` }];
            }
          }
        }
        let note: string | undefined;
        if (content.length === 0) {
          note = data?.id
            ? `task submitted (status: ${data?.status || "unknown"}), task id: ${data.id}`
            : `no image in response: ${JSON.stringify(data).slice(0, 300)}`;
        }
        return { model: def.apiModel, label: def.label, content, latency_ms: Date.now() - started, note };
      } catch (e) {
        const connectPhase =
          e instanceof UpstreamError && e.status === undefined && e.code !== undefined && CONNECT_ERROR_CODES.has(e.code);
        if (!connectPhase) {
          if (e instanceof UpstreamError && e.status !== undefined) this.markServed(idx);
          throw e; // answered or ambiguous (possibly billed) — never re-send
        }
        lastErr = e;
      }
    }
    throw lastErr;
  }

  /**
   * Generate a video (async: submit → poll → download URL). 9 models across
   * SeeDance / Sora / Wan / Jimeng. Consumes credits. The SUBMIT is a billable
   * POST — same billing-safe rule as chatSend (connect-phase-only failover, no
   * same-base retry). Polling is idempotent GET on the served base.
   */
  async videoGenerate(
    apiKey: string,
    args: { model: string; prompt: string; [k: string]: unknown },
  ): Promise<{ model: string; wireModel: string; task_id: string; status: string; url?: string; download_url?: string; error?: string; latency_ms: number }> {
    const registryId = VIDEO_MODELS[args.model];
    const cap = registryId ? aihubmixMediaRegistry.get(registryId) : undefined;
    if (!cap) {
      throw new UpstreamError(`unknown video model "${args.model}". Available: ${Object.keys(VIDEO_MODELS).join(", ")}`);
    }
    const imageTimeout = Math.max(this.cfg.timeoutMs, 300_000);

    // Optional image-to-video: fetch reference to a data URL (base-independent).
    let imageRef: { dataUrl: string } | undefined;
    if (typeof args.input_reference === "string" && args.input_reference.trim()) {
      if (!cap.caps.includes("i2v") && !cap.apiModelI2V) {
        throw new UpstreamError(`${cap.label || args.model} does not support input_reference (image-to-video)`);
      }
      const inline = await urlToInlineData(args.input_reference.trim(), imageTimeout);
      imageRef = { dataUrl: `data:${inline.mimeType};base64,${inline.data}` };
    }

    const built = buildVideoRequest(cap, {
      prompt: String(args.prompt || "").trim(),
      ...(typeof args.seconds === "number" ? { durationSeconds: args.seconds } : {}),
      ...(args.aspect_ratio ? { aspectRatio: args.aspect_ratio as string } : {}),
      ...(args.size ? { size: args.size as string } : {}),
      ...(args.resolution ? { resolution: args.resolution as string } : {}),
      ...(typeof args.watermark === "boolean" ? { watermark: args.watermark } : {}),
      ...(typeof args.seed === "number" ? { seed: args.seed } : {}),
      ...(typeof args.camera_fixed === "boolean" ? { cameraFixed: args.camera_fixed } : {}),
      ...(typeof args.generate_audio === "boolean" ? { generateAudio: args.generate_audio } : {}),
      ...(imageRef ? { imageRef } : {}),
    });
    const init: RequestInit = {
      method: "POST",
      headers: { ...this.authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(built.body),
    };

    // Submit — billable POST, connect-phase-only failover (identical to chatSend).
    const started = Date.now();
    const order = this.candidateOrder();
    let submitData: NormalizedVideoResponse | undefined;
    let servedBase = this.cfg.apiBases[order[0]];
    let lastErr: unknown;
    for (const idx of order) {
      const base = this.cfg.apiBases[idx];
      try {
        const raw = await fetchJsonOnce<unknown>(`${base}/v1${built.pathSuffix}`, init, imageTimeout);
        this.markServed(idx);
        submitData = normalizeVideoResponse(raw);
        servedBase = base;
        break;
      } catch (e) {
        const connectPhase =
          e instanceof UpstreamError && e.status === undefined && e.code !== undefined && CONNECT_ERROR_CODES.has(e.code);
        if (!connectPhase) {
          if (e instanceof UpstreamError && e.status !== undefined) this.markServed(idx);
          throw e;
        }
        lastErr = e;
      }
    }
    if (!submitData) throw lastErr;
    const taskId = submitData.id;
    if (!taskId) throw new UpstreamError(`no task id in video submit response (status: ${submitData.status || "unknown"})`);

    // Poll the served base (idempotent GET) until terminal or timeout.
    let last = submitData;
    const pollTimeout = Number(process.env.AIHUBMIX_VIDEO_POLL_TIMEOUT_MS) || 480_000;
    const deadline = Date.now() + pollTimeout;
    while (Date.now() < deadline) {
      const status = String(last.status || "").toLowerCase();
      if (VIDEO_TERMINAL_DONE.includes(status) || VIDEO_TERMINAL_FAILED.includes(status)) break;
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const raw = await fetchJson<unknown>(
          `${servedBase}/v1/videos/${taskId}`,
          { method: "GET", headers: this.authHeaders(apiKey) },
          Math.min(this.cfg.timeoutMs, 20_000),
          1,
        );
        last = normalizeVideoResponse(raw);
      } catch (e) {
        if (e instanceof UpstreamError && (e.status === 401 || e.status === 403)) throw e;
        // transient — keep polling
      }
    }

    const status = String(last.status || "").toLowerCase();
    const failed = VIDEO_TERMINAL_FAILED.includes(status);
    return {
      model: args.model,
      wireModel: built.wireModel,
      task_id: taskId,
      status: last.status || "unknown",
      url: last.url,
      // download must be publicly reachable — use the public entrance, never the
      // (possibly cluster-internal) base that served the submit
      download_url: `${this.cfg.publicBases[0] || servedBase}/v1/videos/${taskId}/content`,
      error: failed ? last.error || "generation failed" : undefined,
      latency_ms: Date.now() - started,
    };
  }

  /**
   * Estimate the USD cost of a chat call from the cached catalog pricing.
   * Best-effort: null when the model has no catalog pricing. Cached prompt tokens
   * are billed at cache_read when the model prices it, else as normal input.
   */
  async estimateChatCost(modelId: string, usage: unknown): Promise<number | null> {
    if (!usage || typeof usage !== "object") return null;
    const u = usage as ChatUsage;
    const prompt = u.prompt_tokens ?? 0;
    const completion = u.completion_tokens ?? 0;
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    let pricing: AihubmixModel["pricing"];
    try {
      const { model } = await this.getModel(modelId);
      pricing = model?.pricing;
    } catch {
      return null;
    }
    if (!pricing || typeof pricing.input !== "number" || typeof pricing.output !== "number") return null;
    const cacheRate = typeof pricing.cache_read === "number" ? pricing.cache_read : pricing.input;
    const usd = ((prompt - cached) * pricing.input + cached * cacheRate + completion * pricing.output) / 1e6;
    return Math.round(usd * 1e8) / 1e8;
  }

  // ---------------------------------------------------------------------------
  // Account management (AiHubMix CLI parity — same user-level API the CLI wraps).
  // Auth: Manage Key (系统访问令牌, fd***), NOT the sk- API key. Envelope is
  // {success, message, data}; success=false arrives with HTTP 200.
  // ---------------------------------------------------------------------------

  private accountHeaders(accessToken: string): Record<string, string> {
    return { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  }

  private unwrapEnvelope<T>(body: { success?: boolean; message?: string; data?: T }, what: string): T {
    if (body.success === false) {
      throw new UpstreamError(body.message || `${what} failed (success=false)`);
    }
    return body.data as T;
  }

  private async quotaPerUnit(): Promise<number> {
    try {
      const s = await this.status();
      if (typeof s.quota_per_unit === "number" && s.quota_per_unit > 0) return s.quota_per_unit;
    } catch {
      /* fall through to the documented default */
    }
    return 500_000;
  }

  /** Account GET with endpoint failover (reads are idempotent). */
  private async accountGetJson<T>(pathAndQuery: string, accessToken: string, what: string): Promise<T> {
    const body = await this.getJson<{ success?: boolean; message?: string; data?: T }>(
      pathAndQuery,
      this.accountHeaders(accessToken),
      1,
    );
    return this.unwrapEnvelope(body, what);
  }

  /**
   * Account WRITE with the same conservative failover rule as chatSend: no same-base
   * retries, next base only on connect-phase errors (request provably never sent) —
   * a re-sent create would otherwise mint duplicate keys.
   */
  private async accountWriteJson<T>(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    accessToken: string,
    payload: unknown,
    what: string,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: this.accountHeaders(accessToken),
      body: payload === undefined ? undefined : JSON.stringify(payload),
    };
    const order = this.candidateOrder();
    let lastErr: unknown;
    for (const idx of order) {
      const base = this.cfg.apiBases[idx];
      try {
        const body = await fetchJsonOnce<{ success?: boolean; message?: string; data?: T }>(
          `${base}${path}`,
          init,
          this.cfg.timeoutMs,
        );
        this.markServed(idx);
        return this.unwrapEnvelope(body, what);
      } catch (e) {
        const connectPhase =
          e instanceof UpstreamError && e.status === undefined && e.code !== undefined && CONNECT_ERROR_CODES.has(e.code);
        if (!connectPhase) {
          if (e instanceof UpstreamError && e.status !== undefined) this.markServed(idx);
          throw e;
        }
        lastErr = e;
      }
    }
    throw lastErr;
  }

  /** GET /api/user/self — account profile + balance. */
  async getSelf(accessToken: string): Promise<Record<string, unknown>> {
    const d = await this.accountGetJson<Record<string, unknown>>("/api/user/self", accessToken, "get user self");
    if (!d || typeof d !== "object") {
      throw new UpstreamError("user self API returned empty data");
    }
    const qpu = await this.quotaPerUnit();
    const toUsd = (n: unknown) => (typeof n === "number" ? Math.round((n / qpu) * 1e6) / 1e6 : null);
    return {
      username: d.username,
      display_name: d.display_name,
      email: d.email,
      group: d.group,
      role: d.role,
      status: d.status,
      balance_usd: toUsd(d.quota),
      used_usd: toUsd(d.used_quota),
      request_count: d.request_count,
    };
  }

  /** Raw token record from GET/POST/PUT /api/token — field names per CliEndpoints docs. */
  private async normalizeKeyRecord(t: Record<string, unknown>, revealKey: boolean): Promise<Record<string, unknown>> {
    if (!t || typeof t !== "object") {
      throw new UpstreamError("invalid key record from token API");
    }
    const qpu = await this.quotaPerUnit();
    const toUsd = (n: unknown) => (typeof n === "number" ? Math.round((n / qpu) * 1e6) / 1e6 : null);
    // H4: gateway-core masks `key` (controller/token.go:38/67); the plaintext is only in
    // `full_key` (:57/473). Prefer full_key as the returned key so keys-create hands back a
    // usable sk- value, not sk-abcd****wxyz. Fall back to `key` for gateways that put the
    // plaintext there; the masked `key` still yields the real trailing last-4.
    const fullRaw = typeof t.full_key === "string" && t.full_key ? t.full_key : undefined;
    const maskedRaw = typeof t.key === "string" && t.key ? t.key : undefined;
    const withPrefix = (k: string) => (k.startsWith("sk-") ? k : `sk-${k}`);
    const returnedKey = fullRaw ? withPrefix(fullRaw) : maskedRaw ? withPrefix(maskedRaw) : undefined;
    const last4Src = fullRaw ?? maskedRaw;
    const expired = t.expired_time;
    return {
      id: t.id,
      name: t.name,
      enabled: t.status === 1,
      status: t.status,
      key: revealKey ? returnedKey : undefined,
      key_last4: last4Src ? last4Src.slice(-4) : undefined,
      unlimited_quota: t.unlimited_quota === true,
      remaining_usd: t.unlimited_quota === true ? null : toUsd(t.remain_quota),
      used_usd: toUsd(t.used_quota),
      expires_at:
        typeof expired === "number" && expired > 0 ? new Date(expired * 1000).toISOString() : null,
      models: t.models || null,
      subnet: t.subnet || null,
    };
  }

  /** GET /api/token/ — list API keys (masked). */
  async listKeys(accessToken: string, num?: number): Promise<Array<Record<string, unknown>>> {
    const q = typeof num === "number" ? `?num=${num}` : "";
    const d = await this.accountGetJson<Array<Record<string, unknown>> | Record<string, unknown>>(
      `/api/token/${q}`,
      accessToken,
      "list keys",
    );
    const items = (Array.isArray(d) ? d : [d]).filter(
      (t): t is Record<string, unknown> => t !== null && typeof t === "object",
    );
    return Promise.all(items.map((t) => this.normalizeKeyRecord(t, false)));
  }

  /** GET /api/token/:id — one key (raw record, used for update merging). */
  private async getKeyRaw(accessToken: string, id: number): Promise<Record<string, unknown>> {
    return this.accountGetJson<Record<string, unknown>>(`/api/token/${id}`, accessToken, "get key");
  }

  /** GET /api/user/available_models — models usable by this account's group. */
  async accountModels(accessToken: string): Promise<unknown> {
    return this.accountGetJson<unknown>("/api/user/available_models", accessToken, "available models");
  }

  /** POST /api/token/ — create a key. Returns the record WITH the full sk- key. */
  async createKey(
    accessToken: string,
    args: { name: string; quota_usd?: number; unlimited?: boolean; expires_in_days?: number; models?: string; subnet?: string },
  ): Promise<Record<string, unknown>> {
    const qpu = await this.quotaPerUnit();
    const payload: Record<string, unknown> = {
      name: args.name,
      expired_time:
        typeof args.expires_in_days === "number" && args.expires_in_days > 0
          ? Math.floor(Date.now() / 1000) + Math.floor(args.expires_in_days * 86400)
          : -1,
      unlimited_quota: args.unlimited === true,
      remain_quota: typeof args.quota_usd === "number" ? Math.round(args.quota_usd * qpu) : 0,
    };
    if (args.models) payload.models = args.models;
    if (args.subnet) payload.subnet = args.subnet;
    const d = await this.accountWriteJson<Record<string, unknown> | null>("POST", "/api/token/", accessToken, payload, "create key");
    // some gateway versions return the record, others only success — re-read the list to find it
    if (d && typeof d === "object" && ("key" in d || "id" in d)) {
      return this.normalizeKeyRecord(d, true);
    }
    const all = await this.accountGetJson<Array<Record<string, unknown>>>("/api/token/", accessToken, "list keys");
    const created = (Array.isArray(all) ? all : []).find(
      (t) => t !== null && typeof t === "object" && t.name === args.name,
    );
    return created ? this.normalizeKeyRecord(created, true) : { created: true, note: "created; fetch details via keys-list" };
  }

  /** PUT /api/token/ — read-merge-write so unspecified fields keep their values. */
  async updateKey(
    accessToken: string,
    args: {
      id: number;
      name?: string;
      quota_usd?: number;
      unlimited?: boolean;
      expires_in_days?: number;
      never_expires?: boolean;
      models?: string;
      subnet?: string;
      enabled?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const current = await this.getKeyRaw(accessToken, args.id);
    // read-merge-write depends on a real base record; a null/empty envelope (unknown id)
    // would silently PUT a stripped record — fail loudly instead
    if (!current || typeof current !== "object" || Object.keys(current).length === 0) {
      throw new UpstreamError(`key ${args.id} not found (cannot update)`);
    }
    const qpu = await this.quotaPerUnit();
    const merged: Record<string, unknown> = { ...current };
    if (args.name !== undefined) merged.name = args.name;
    if (args.quota_usd !== undefined) merged.remain_quota = Math.round(args.quota_usd * qpu);
    if (args.unlimited !== undefined) merged.unlimited_quota = args.unlimited;
    if (args.never_expires) merged.expired_time = -1;
    else if (args.expires_in_days !== undefined)
      merged.expired_time = Math.floor(Date.now() / 1000) + Math.floor(args.expires_in_days * 86400);
    if (args.models !== undefined) merged.models = args.models;
    if (args.subnet !== undefined) merged.subnet = args.subnet;
    // H5: gateway-core TokenStatusDisabled=2, and status 0 is read as "leave unchanged"
    // (controller/token.go:580 `if token.Status != 0`), so `0` silently no-ops a disable.
    if (args.enabled !== undefined) merged.status = args.enabled ? 1 : 2;
    const d = await this.accountWriteJson<Record<string, unknown> | null>("PUT", "/api/token/", accessToken, merged, "update key");
    return this.normalizeKeyRecord(d && typeof d === "object" ? d : merged, false);
  }

  /** DELETE /api/token/:id */
  async deleteKey(accessToken: string, id: number): Promise<{ deleted: boolean; id: number }> {
    await this.accountWriteJson<unknown>("DELETE", `/api/token/${id}`, accessToken, undefined, "delete key");
    return { deleted: true, id };
  }
}

/** OpenAI-style usage block, as returned by /v1/chat/completions. */
interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

// ─── Image generation (ported from AIhubmix/aihubmix packages/mcp painting-tools) ──
// Covers 23 models across 8 upstream families via the /v1/models/{model}/predictions
// endpoint (Gemini native uses its own generateContent path). Per-family request
// shaping + image-to-image (input_reference) mirror the reference implementation so
// this stays swap-compatible when the two MCPs merge.

export type ImageContentItem =
  | { type: "image"; data: string; mimeType: string }
  | { type: "text"; text: string };

type ImageModelDef = { apiModel: string; label: string };

/** Friendly alias → upstream wire model. Keys are what the user passes as `model`. */
export const IMAGE_MODELS: Record<string, ImageModelDef> = {
  "nano-banana-pro": { apiModel: "gemini-3-pro-image-preview", label: "Nano Banana Pro (Gemini 3 Pro)" },
  "nano-banana-2": { apiModel: "gemini-3.1-flash-image-preview", label: "Nano Banana 2 (Gemini 3.1 Flash)" },
  "gpt-image-1.5": { apiModel: "openai/gpt-image-1.5", label: "GPT Image 1.5" },
  "gpt-image-1": { apiModel: "openai/gpt-image-1", label: "GPT Image 1" },
  "gpt-image-1-mini": { apiModel: "openai/gpt-image-1-mini", label: "GPT Image 1 Mini" },
  "dall-e-3": { apiModel: "openai/dall-e-3", label: "DALL·E 3" },
  "imagen-4.0-ultra": { apiModel: "google/imagen-4.0-ultra-generate-001", label: "Imagen 4.0 Ultra" },
  "imagen-4.0": { apiModel: "google/imagen-4.0-generate-001", label: "Imagen 4.0" },
  "imagen-4.0-fast": { apiModel: "google/imagen-4.0-fast-generate-001", label: "Imagen 4.0 Fast" },
  "imagen-3.0": { apiModel: "google/imagen-3.0-generate-002", label: "Imagen 3.0" },
  "flux-2-pro": { apiModel: "bfl/flux-2-pro", label: "FLUX 2 Pro" },
  "flux-2-flex": { apiModel: "bfl/flux-2-flex", label: "FLUX 2 Flex" },
  "ideogram-v3": { apiModel: "ideogram/V3", label: "Ideogram V3" },
  "seedream-5.0-lite": { apiModel: "doubao/doubao-seedream-5.0-lite", label: "Doubao Seedream 5.0 Lite" },
  "seedream-4.5": { apiModel: "doubao/doubao-seedream-4-5", label: "Doubao Seedream 4.5" },
  "seedream-4.0": { apiModel: "doubao/doubao-seedream-4-0", label: "Doubao Seedream 4.0" },
  "wan2.7-image-pro": { apiModel: "bailian/wan2.7-image-pro", label: "Wan 2.7 Image Pro" },
  "wan2.7-image": { apiModel: "bailian/wan2.7-image", label: "Wan 2.7 Image" },
  "wan2.6-image": { apiModel: "bailian/wan2.6-t2i", label: "Wan 2.6 Image" },
  "qwen-image-2.0-pro": { apiModel: "bailian/qwen-image-2.0-pro", label: "Qwen Image 2.0 Pro" },
  "qwen-image-2.0": { apiModel: "bailian/qwen-image-2.0", label: "Qwen Image 2.0" },
  "qwen-image-max": { apiModel: "bailian/qwen-image-max", label: "Qwen Image Max" },
  "qwen-image": { apiModel: "qianfan/qwen-image", label: "Qwen Image" },
};

type ImageFamily =
  | "gemini-native"
  | "openai"
  | "imagen"
  | "qwen"
  | "doubao"
  | "flux"
  | "ideogram"
  | "bailian"
  | "generic";

function getImageFamily(apiModel: string): ImageFamily {
  if (apiModel.startsWith("gemini-")) return "gemini-native";
  if (apiModel.startsWith("openai/")) return "openai";
  if (apiModel.startsWith("google/imagen-")) return "imagen";
  if (apiModel.startsWith("bailian/")) return "bailian";
  if (apiModel.startsWith("qianfan/qwen-")) return "qwen";
  if (apiModel.startsWith("doubao/")) return "doubao";
  if (apiModel.startsWith("bfl/") || apiModel.startsWith("FLUX")) return "flux";
  if (apiModel.startsWith("ideogram/")) return "ideogram";
  return "generic";
}

function normalizeSize(size?: string): string | undefined {
  if (!size) return size;
  return size.replace(/×/g, "x").replace(/\s+/g, "");
}

/** Shape the predictions `input` object per model family. */
function buildPredictionsInput(args: Record<string, any>, apiModel: string): Record<string, unknown> {
  const family = getImageFamily(apiModel);
  const input: Record<string, unknown> = { prompt: String(args.prompt ?? "").trim() };
  const size = normalizeSize(args.size);
  const ref = typeof args.input_reference === "string" && args.input_reference.trim() ? args.input_reference.trim() : undefined;

  switch (family) {
    case "openai":
      if (size) input.size = size;
      if (args.n) input.n = args.n;
      if (args.quality) input.quality = args.quality;
      if (args.moderation && !ref) input.moderation = args.moderation;
      if (args.background) input.background = args.background;
      if (args.output_format) input.output_format = args.output_format;
      if (args.input_fidelity && ref) input.input_fidelity = args.input_fidelity;
      if (ref) input.image = ref;
      return input;
    case "imagen":
      if (args.n) input.sampleCount = args.n;
      if (args.aspect_ratio) input.aspectRatio = args.aspect_ratio;
      return input;
    case "qwen":
      if (size) input.size = size;
      if (args.n) input.n = args.n;
      if (typeof args.watermark === "boolean") input.watermark = args.watermark;
      if (typeof args.seed === "number") input.seed = args.seed;
      if (ref) input.image = ref;
      return input;
    case "doubao":
      if (size) input.size = size;
      if (typeof args.watermark === "boolean") input.watermark = args.watermark;
      if (typeof args.seed === "number") input.seed = args.seed;
      if (args.response_format) input.response_format = args.response_format;
      if (ref) input.image = ref;
      return input;
    case "flux":
      if (args.aspect_ratio) input.aspect_ratio = args.aspect_ratio;
      if (typeof args.seed === "number") input.seed = args.seed;
      if (ref) input.input_image = ref;
      return input;
    case "ideogram":
      if (args.rendering_speed) input.rendering_speed = args.rendering_speed;
      if (args.aspect_ratio) input.aspect_ratio = args.aspect_ratio;
      return input;
    case "bailian": {
      if (size) {
        const isShorthand = /^[1-9]\d*[Kk]$/.test(size);
        input.size = isShorthand ? size : size.replace(/x/gi, "*");
      }
      if (args.n) input.n = args.n;
      if (typeof args.seed === "number") input.seed = args.seed;
      if (typeof args.watermark === "boolean") input.watermark = args.watermark;
      if (typeof args.thinking_mode === "boolean") input.thinking_mode = args.thinking_mode;
      if (typeof args.prompt_extend === "boolean") input.prompt_extend = args.prompt_extend;
      if (args.negative_prompt) input.negative_prompt = args.negative_prompt;
      if (ref) input.images = [ref];
      return input;
    }
    default:
      if (size) input.size = size;
      if (args.aspect_ratio) input.aspect_ratio = args.aspect_ratio;
      if (args.quality) input.quality = args.quality;
      if (args.n) input.n = args.n;
      if (ref) input.image = ref;
      return input;
  }
}

/** Extract MCP content items (base64 images + URLs) from any image API response shape. */
function extractImageContents(data: any): ImageContentItem[] {
  const contents: ImageContentItem[] = [];
  const seen = new Set<string>();
  const addImage = (b64: string, mimeType = "image/png") => {
    if (b64 && !seen.has(b64)) {
      seen.add(b64);
      contents.push({ type: "image", data: b64, mimeType });
    }
  };
  const addUrl = (url: string) => {
    if (url && !seen.has(url)) {
      seen.add(url);
      contents.push({ type: "text", text: url });
    }
  };
  const isHttpUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//.test(v);

  const geminiParts = [
    ...(data?.candidates || []).flatMap((c: any) => c?.content?.parts || []),
    ...(data?.response?.parts || data?.parts || []),
  ];
  for (const part of geminiParts) {
    const inline = part?.inlineData || part?.inline_data;
    if (inline && typeof inline.data === "string") addImage(inline.data, inline.mimeType || inline.mime_type || "image/png");
  }
  if (Array.isArray(data?.data)) {
    for (const item of data.data) {
      if (isHttpUrl(item)) addUrl(item);
      else if (isHttpUrl(item?.url)) addUrl(item.url);
      else if (typeof item?.b64_json === "string") addImage(item.b64_json);
    }
  }
  const out = data?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      if (isHttpUrl(item)) addUrl(item);
      else if (isHttpUrl(item?.url)) addUrl(item.url);
      else if (typeof item?.bytesBase64 === "string") addImage(item.bytesBase64);
    }
  }
  if (Array.isArray(out?.b64_json)) for (const item of out.b64_json) if (typeof item?.bytesBase64 === "string") addImage(item.bytesBase64);
  if (Array.isArray(out?.urls)) for (const url of out.urls) if (typeof url === "string") addUrl(url);
  if (isHttpUrl(out?.url)) addUrl(out.url);
  if (isHttpUrl(data?.url)) addUrl(data.url);
  if (isHttpUrl(data?.image_url)) addUrl(data.image_url);
  if (Array.isArray(data?.images)) {
    for (const item of data.images) {
      if (isHttpUrl(item)) addUrl(item);
      else if (isHttpUrl(item?.url)) addUrl(item.url);
      else if (typeof item?.b64_json === "string") addImage(item.b64_json);
    }
  }
  return contents;
}

/** Fetch a user-supplied reference-image URL to inline base64 (for image-to-image). */
async function urlToInlineData(url: string, timeoutMs: number): Promise<{ mimeType: string; data: string }> {
  if (!/^https?:\/\//i.test(url)) {
    throw new UpstreamError(`reference image must be an http(s) URL, got: ${url.slice(0, 40)}`);
  }
  const res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
  if (!res.ok) throw new UpstreamError(`failed to fetch reference image: HTTP ${res.status}`);
  const mimeType = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  return { mimeType, data: buf.toString("base64") };
}

/** Poll a predictions polling URL (idempotent GET) until the image task completes. */
async function pollForImage(pollingUrl: string, apiKey: string, timeoutMs: number, maxAttempts = 30): Promise<ImageContentItem[]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(
        pollingUrl,
        { method: "GET", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } },
        Math.min(timeoutMs, 15_000),
      );
      if (!res.ok) {
        const err = new UpstreamError(`polling failed: HTTP ${res.status}`, res.status);
        if (res.status >= 400 && res.status < 500) throw err; // 4xx won't recover
        throw err;
      }
      const data = await res.json();
      const status = (data as any)?.status;
      if (status === "succeeded" || status === "completed" || status === "Ready") return extractImageContents(data);
      if (status === "failed") throw new UpstreamError(`image task failed: ${(data as any)?.error || "unknown"}`, 500);
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      if (attempt === maxAttempts - 1 || (e instanceof UpstreamError && e.status !== undefined)) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return [];
}

// ─── Video generation ───────────────────────────────────────────────────
// Per-model capabilities and request/response shaping are delegated to the shared
// @aihubmix/media-adapters package (aihubmixMediaRegistry / buildVideoRequest /
// normalizeVideoResponse, imported above) — one source of truth for the whole
// AIHubMix media stack. Only the transport below (billable submit with
// connect-phase failover + idempotent polling, in videoGenerate above) is ours.

/** Friendly alias → registry id. */
export const VIDEO_MODELS: Record<string, string> = {
  "seedance-2.0": "doubao-seedance-2-0-260128",
  "seedance-2.0-fast": "doubao-seedance-2-0-fast-260128",
  "wan-2.7": "wan2.7-t2v",
  "wan-2.6": "wan2.6-t2v",
  "wan-2.5": "wan2.5-t2v-preview",
  "sora-2": "sora-2",
  "sora-2-pro": "sora-2-pro",
  "jimeng-3.0-pro": "jimeng-3.0-pro",
  "jimeng-3.0": "jimeng-3.0-1080p",
};

const VIDEO_TERMINAL_DONE = ["completed", "complete", "succeeded", "success", "done", "finished"];
const VIDEO_TERMINAL_FAILED = ["failed", "error", "cancelled", "canceled", "rejected"];

/**
 * User-facing label for an upstream base. Cluster-internal addresses (Service DNS,
 * private IPs) must not leak into public tool output — mask them as a role label.
 * H1: fail-closed whitelist. A configured public entrance (cfg.publicBases) always
 * shows as-is; otherwise only structurally-public hosts (isPublicHost) are revealed,
 * so bare service names / CGNAT / IPv6-ULA / loopback also collapse to the label.
 */
export function displayBase(base: string, publicBases?: string[]): string {
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return "in-cluster-direct"; // unparseable — never echo it verbatim
  }
  if (publicBases?.length) {
    const hl = host.toLowerCase();
    for (const pb of publicBases) {
      try {
        if (new URL(pb).hostname.toLowerCase() === hl) return base;
      } catch {
        /* skip a malformed whitelist entry */
      }
    }
  }
  return isPublicHost(host) ? base : "in-cluster-direct";
}

function parseStatus(body: { data?: Record<string, unknown> }): GatewayStatus {
  // typeof null === "object" — explicit null check required (gemini review)
  const d = body && typeof body === "object" && body.data !== null && typeof body.data === "object" ? body.data : {};
  return {
    system_name: typeof d.system_name === "string" ? d.system_name : undefined,
    version: typeof d.version === "string" ? d.version : undefined,
    quota_per_unit: typeof d.quota_per_unit === "number" ? d.quota_per_unit : undefined,
    display_in_currency: typeof d.display_in_currency === "boolean" ? d.display_in_currency : undefined,
  };
}
