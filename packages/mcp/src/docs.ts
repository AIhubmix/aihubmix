import type { Config } from "./config.js";
import { UpstreamError } from "./aihubmix.js";

export interface DocEntry {
  title: string;
  url: string;
  description: string;
  lang: string; // "cn" | "en" | "de" | "es" | "unknown", derived from the URL path
}

const INDEX_TTL_MS = 10 * 60_000;
const PAGE_MAX_CHARS = 60_000;
// H2: bound content-search work so an unauthenticated docs-search can't pin the single
// Node event loop. Cap the query length and the number of tokens scanned over the ~1 MB
// full-text corpus; per-token occurrence counting saturates at MAX_TOKEN_HITS.
const MAX_QUERY_CHARS = 300;
const MAX_CONTENT_TOKENS = 12;
const MAX_TOKEN_HITS = 5;

let indexCache: { at: number; entries: DocEntry[] } | null = null;

function langFromUrl(url: string): string {
  const m = url.match(/^https?:\/\/[^/]+\/([a-z]{2})\//);
  return m ? m[1] : "unknown";
}

/** Parse Mintlify llms.txt lines of the form `- [Title](https://.../page.md): description`. */
export function parseLlmsTxt(text: string): DocEntry[] {
  const entries: DocEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^-\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)(?::\s*(.*))?$/);
    if (!m) continue;
    entries.push({
      title: m[1].trim(),
      url: m[2].trim(),
      description: (m[3] || "").trim(),
      lang: langFromUrl(m[2]),
    });
  }
  return entries;
}

async function fetchTextOnce(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new UpstreamError(`HTTP ${res.status} from ${url}`, res.status);
    return await res.text();
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (ctrl.signal.aborted) throw new UpstreamError(`request to ${url} timed out after ${timeoutMs}ms`);
    throw new UpstreamError(`request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

// docs reads are idempotent GETs: retry network-level failures (no HTTP status) like aihubmix.ts
async function fetchText(url: string, timeoutMs: number, retries = 2): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchTextOnce(url, timeoutMs);
    } catch (e) {
      const transient = e instanceof UpstreamError && e.status === undefined;
      if (!transient || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}

/**
 * The docs site has a single deployment (docs.aihubmix.com) — no fallback domain
 * exists, and it can be unreachable from some networks. So the index is served
 * stale-while-error: once fetched, a later refresh failure degrades to the cached
 * copy (flagged `stale`) instead of taking docs-search down with the site.
 */
export async function getDocsIndex(cfg: Config): Promise<{ entries: DocEntry[]; stale: boolean }> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) {
    return { entries: indexCache.entries, stale: false };
  }
  try {
    const text = await fetchText(`${cfg.docsBase}/llms.txt`, cfg.timeoutMs);
    const entries = parseLlmsTxt(text);
    if (entries.length === 0) throw new UpstreamError("docs index (llms.txt) parsed to 0 entries");
    indexCache = { at: Date.now(), entries };
    return { entries, stale: false };
  } catch (e) {
    if (indexCache) return { entries: indexCache.entries, stale: true };
    throw e;
  }
}

/**
 * Rank docs by simple token scoring: title hits weigh more than description hits.
 * Latin queries are tokenized on non-alphanumerics; CJK queries also match as raw substrings.
 */
export function scoreDocs(entries: DocEntry[], query: string, lang?: string, limit = 8): DocEntry[] {
  const q = query.trim().toLowerCase();
  const tokens = q.split(/[^a-z0-9一-鿿]+/).filter((t) => t.length > 0);
  const scored: Array<{ e: DocEntry; s: number }> = [];
  for (const e of entries) {
    if (lang && e.lang !== lang) continue;
    const title = e.title.toLowerCase();
    const desc = e.description.toLowerCase();
    const url = e.url.toLowerCase();
    let s = 0;
    if (title === q) s += 100;
    if (title.includes(q)) s += 40;
    if (desc.includes(q)) s += 15;
    for (const t of tokens) {
      if (title.includes(t)) s += 10;
      if (url.includes(t)) s += 4;
      if (desc.includes(t)) s += 3;
    }
    if (s > 0) scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map(({ e }) => e);
}

interface FullDocPage {
  title: string;
  url: string;
  lang: string;
  body: string;
}

let fullIndexCache: { at: number; pages: FullDocPage[] } | null = null;

/** Parse llms-full.txt: pages open with `# Title` then a `Source: <url>` line. */
export function parseLlmsFullTxt(text: string): FullDocPage[] {
  const pages: FullDocPage[] = [];
  const chunks = text.split(/^# /m).slice(1);
  for (const chunk of chunks) {
    const nl = chunk.indexOf("\n");
    if (nl < 0) continue;
    const title = chunk.slice(0, nl).trim();
    const rest = chunk.slice(nl + 1);
    const src = rest.match(/^Source:\s*(https?:\/\/\S+)/m);
    if (!src) continue;
    pages.push({ title, url: src[1], lang: langFromUrl(src[1]), body: rest });
  }
  return pages;
}

/** Full-content docs index (llms-full.txt, ~1MB) — fetched lazily, stale-while-error. */
async function getFullIndex(cfg: Config): Promise<{ pages: FullDocPage[]; stale: boolean }> {
  if (fullIndexCache && Date.now() - fullIndexCache.at < INDEX_TTL_MS) {
    return { pages: fullIndexCache.pages, stale: false };
  }
  try {
    const text = await fetchText(`${cfg.docsBase}/llms-full.txt`, cfg.timeoutMs);
    const pages = parseLlmsFullTxt(text);
    if (pages.length === 0) throw new UpstreamError("llms-full.txt parsed to 0 pages");
    fullIndexCache = { at: Date.now(), pages };
    return { pages, stale: false };
  } catch (e) {
    if (fullIndexCache) return { pages: fullIndexCache.pages, stale: true };
    throw e;
  }
}

/** Snippet of ±radius chars around the first match, on word-ish boundaries. */
function snippetAround(body: string, needle: string, radius = 140): string {
  const idx = body.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return body.slice(0, radius * 2).replace(/\s+/g, " ").trim();
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + needle.length + radius);
  return `${start > 0 ? "…" : ""}${body.slice(start, end).replace(/\s+/g, " ").trim()}${end < body.length ? "…" : ""}`;
}

/**
 * Count occurrences of `needle` in `haystack`, stopping once `max` is reached. This
 * indexOf early-exit replaces `body.split(needle)` so a single long token can't force
 * an N-way split allocation over the ~1 MB page body (H2 DoS).
 */
function countUpTo(haystack: string, needle: string, max: number): number {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  while (n < max) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    n++;
    from = i + needle.length;
  }
  return n;
}

/**
 * Content-level search over full page bodies (llms-full.txt). Heavier than the
 * title/description index but finds matches inside page text, with snippets.
 */
export async function searchDocsContent(
  cfg: Config,
  query: string,
  lang?: string,
  limit = 8,
): Promise<{ results: Array<{ title: string; url: string; lang: string; snippet: string }>; stale: boolean }> {
  const { pages, stale } = await getFullIndex(cfg);
  const q = query.trim().slice(0, MAX_QUERY_CHARS).toLowerCase();
  const tokens = q
    .split(/[^a-z0-9一-鿿]+/)
    .filter((t) => t.length > 0)
    .slice(0, MAX_CONTENT_TOKENS);
  const scored: Array<{ p: FullDocPage; s: number; hit: string }> = [];
  for (const p of pages) {
    if (lang && p.lang !== lang) continue;
    const title = p.title.toLowerCase();
    const body = p.body.toLowerCase();
    let s = 0;
    let hit = q;
    if (title.includes(q)) s += 60;
    if (body.includes(q)) s += 25;
    for (const t of tokens) {
      if (title.includes(t)) s += 10;
      const count = countUpTo(body, t, MAX_TOKEN_HITS);
      if (count > 0) {
        s += count * 2;
        if (hit === q && !body.includes(q)) hit = t;
      }
    }
    if (s > 0) scored.push({ p, s, hit });
  }
  scored.sort((a, b) => b.s - a.s);
  return {
    results: scored.slice(0, limit).map(({ p, hit }) => ({
      title: p.title,
      url: p.url,
      lang: p.lang,
      snippet: snippetAround(p.body, hit),
    })),
    stale,
  };
}

/** Fetch a docs page as markdown. Only URLs under the configured docs origin are allowed. */
export async function getDocPage(cfg: Config, url: string): Promise<{ url: string; markdown: string; truncated: boolean }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UpstreamError(`invalid url: ${url}`);
  }
  const allowedOrigin = new URL(cfg.docsBase).origin;
  if (parsed.origin !== allowedOrigin) {
    throw new UpstreamError(`only ${allowedOrigin} pages can be fetched, got ${parsed.origin}`);
  }
  // Mintlify serves the markdown source when the path ends in .md
  let target = parsed.toString();
  if (!parsed.pathname.endsWith(".md")) {
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}.md`;
    target = parsed.toString();
  }
  const text = await fetchText(target, cfg.timeoutMs);
  const truncated = text.length > PAGE_MAX_CHARS;
  return { url: target, markdown: truncated ? text.slice(0, PAGE_MAX_CHARS) : text, truncated };
}
