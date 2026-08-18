import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "aihubmix-mcp";
export const SERVER_VERSION = "2.0.0";

/**
 * Ordered gateway failover chain. aihubmix.com is the primary brand domain;
 * api.inferera.com is the same backend on a domain that stays reachable from
 * mainland-China networks where aihubmix.com is DNS-poisoned. The client fails
 * over automatically, so neither users nor models pick a region by hand.
 */
export const DEFAULT_API_BASES = ["https://aihubmix.com", "https://api.inferera.com"];

export interface Config {
  /** Ordered gateway origins; [0] is primary, the rest are fallbacks */
  apiBases: string[];
  /**
   * User-facing public entrances shown by ping (defaults to the standard pair).
   * Hosted deployments whose apiBases are cluster-internal set this to the
   * domains users actually connect through (e.g. https://shkq.org on ziai).
   */
  publicBases: string[];
  /** Docs site origin (single deployment, no fallback exists) */
  docsBase: string;
  /** Default API key (stdio mode); HTTP mode prefers the Authorization header */
  apiKey?: string;
  /**
   * Manage Key (系统访问令牌, fd***) for account-level tools — a DIFFERENT credential
   * from the sk-*** API key. From console.aihubmix.com/setting.
   */
  accessToken?: string;
  /** Key-admin WRITE tools (keys-create/update/delete) register only when true */
  enableKeyAdmin: boolean;
  /** Optional APP-Code header forwarded on billable calls */
  appCode?: string;
  /** Upstream request timeout in ms */
  timeoutMs: number;
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

let cliTokenCache: { at: number; token: string | undefined } | null = null;

/**
 * Shared login state with the official aihubmix CLI: `aihubmix login` persists the
 * Manage Key to ~/.aihubmix/config.json ({token, base_url}). Read lazily with a short
 * cache so a login performed while this server is running is picked up without a
 * restart. Local convenience only — env vars always win.
 */
export function readCliManageKey(): string | undefined {
  if (cliTokenCache && Date.now() - cliTokenCache.at < 60_000) return cliTokenCache.token;
  let token: string | undefined;
  try {
    const p = path.join(os.homedir(), ".aihubmix", "config.json");
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { token?: unknown };
    if (typeof parsed.token === "string" && parsed.token.length > 0) token = parsed.token;
  } catch {
    token = undefined; // no file / unreadable / malformed — simply no CLI login
  }
  cliTokenCache = { at: Date.now(), token };
  return token;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // AIHUBMIX_API_BASE accepts a comma-separated chain; a single custom value
  // (e.g. a test environment) disables failover on purpose
  const apiBases = (env.AIHUBMIX_API_BASE || DEFAULT_API_BASES.join(","))
    .split(",")
    .map((s) => stripTrailingSlash(s.trim()))
    .filter(Boolean);
  const publicBases = (env.AIHUBMIX_PUBLIC_BASES || DEFAULT_API_BASES.join(","))
    .split(",")
    .map((s) => stripTrailingSlash(s.trim()))
    .filter(Boolean);
  return {
    apiBases: apiBases.length > 0 ? apiBases : [...DEFAULT_API_BASES],
    publicBases: publicBases.length > 0 ? publicBases : [...DEFAULT_API_BASES],
    docsBase: stripTrailingSlash(env.AIHUBMIX_DOCS_BASE || "https://docs.aihubmix.com"),
    // AIHUBMIX_TOKEN is the aihubmix CLI's env convention — honor it too
    apiKey: env.AIHUBMIX_API_KEY || undefined,
    accessToken: env.AIHUBMIX_ACCESS_TOKEN || env.AIHUBMIX_TOKEN || undefined,
    enableKeyAdmin: env.AIHUBMIX_ENABLE_KEY_ADMIN === "1" || env.AIHUBMIX_ENABLE_KEY_ADMIN === "true",
    appCode: env.AIHUBMIX_APP_CODE || undefined,
    timeoutMs: Number(env.AIHUBMIX_TIMEOUT_MS) > 0 ? Number(env.AIHUBMIX_TIMEOUT_MS) : 30_000,
  };
}
