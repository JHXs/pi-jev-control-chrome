// Configuration for pi-jev-control-chrome.
//
// Everything the extension needs is read from one JSON file inside Pi's agent
// directory, so nothing depends on environment variables that only exist in the
// shell that happened to launch Pi:
//
//   ~/.pi/agent/jev-browser.json      (default; PI_CODING_AGENT_DIR overrides the directory)
//
//   {
//     "allowedOrigins": ["https://*.wikipedia.org", "https://github.com"],
//     "sharePageText": false,
//     "provider": "typesafe",
//     "model": "jev-latest",
//     "classifierBaseUrl": "http://127.0.0.1:3425/v1/",
//     "classifierApiKey": "magpie",
//     "hideNativeTools": false,
//     "autoLoadChromeSkill": true
//   }
//
// `provider`/`model` select which classifier Pi should ask (any provider that
// Pi knows a System One classifier for: typesafe, opencode, openrouter,
// vercel-ai-gateway, cloudflare-workers-ai, openai).
//
// `classifierBaseUrl`/`classifierApiKey` are optional and let that classifier be
// served by another endpoint — a local gateway such as magpie, a self-hosted
// relay — without touching ~/.pi/agent/models.json. They apply to this
// extension's Jev calls only; when unset, Pi's own endpoint and credentials are
// used. A baseUrl configured for the provider in models.json takes precedence
// over `classifierBaseUrl`.
//
// `allowedOrigins` is the security boundary and the only required key: without
// it the extension refuses to touch a page at all, because page content may be
// sent to TypeSafe Jev.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_FILE = "jev-browser.json";
export const DEFAULT_PROVIDER = "typesafe";
export const DEFAULT_MODEL = "jev-latest";
const CONFIG_KEYS = new Set(["allowedOrigins", "sharePageText", "provider", "model", "classifierBaseUrl", "classifierApiKey", "hideNativeTools", "autoLoadChromeSkill"]);

/** Pi's agent directory: `PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`. */
export function agentDir(env = process.env) {
  const override = typeof env.PI_CODING_AGENT_DIR === "string" ? env.PI_CODING_AGENT_DIR.trim() : "";
  return override || join(homedir(), ".pi", "agent");
}

export function configPath(env = process.env) {
  return join(agentDir(env), CONFIG_FILE);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串。`);
  return value.trim();
}

function httpUrl(value, label) {
  const text = nonEmptyString(value, label);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} 不是合法 URL：${text}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${label} 只支持 http(s)://，收到：${text}`);
  return text;
}

/**
 * Validate raw config text. Throws with an actionable message so the tool and
 * `/jev-chrome-check` can surface exactly what is wrong.
 */
export function parseConfig(text, source = CONFIG_FILE) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source} 的顶层必须是 JSON 对象。`);
  const unknown = Object.keys(raw).filter(key => !CONFIG_KEYS.has(key));
  const origins = raw.allowedOrigins;
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new Error(`${source} 需要非空的 allowedOrigins 数组，例如 ["https://*.wikipedia.org", "https://github.com"]。未配置时拒绝把任何网页交给 Jev。`);
  }
  const allowedOrigins = origins.map(entry => {
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`${source} 的 allowedOrigins 只能包含非空字符串。`);
    return entry.trim();
  });
  return {
    allowedOrigins,
    sharePageText: raw.sharePageText === true,
    provider: typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : DEFAULT_PROVIDER,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL,
    // Optional endpoint/key override for this extension's Jev calls. Present but
    // invalid is an error, so a typo cannot silently fall back to the vendor.
    classifierBaseUrl: raw.classifierBaseUrl === undefined ? null : httpUrl(raw.classifierBaseUrl, `${source} 的 classifierBaseUrl`),
    classifierApiKey: raw.classifierApiKey === undefined ? null : nonEmptyString(raw.classifierApiKey, `${source} 的 classifierApiKey`),
    hideNativeTools: raw.hideNativeTools === true,
    // pi-control-chrome keeps its browser tools inactive until its Skill is
    // loaded. Loading that Skill is the upstream consent gate, so doing it
    // automatically on the user's behalf is opt-out.
    autoLoadChromeSkill: raw.autoLoadChromeSkill !== false,
    // Unknown keys are reported instead of silently ignored: a typo in
    // "allowedOrigins" would otherwise look like an empty allowlist.
    warnings: unknown.length ? [`${source} 含有未知的配置项：${unknown.join(", ")}（已忽略）`] : [],
  };
}

/** Read and validate the config file. Throws when it is missing or invalid. */
export function readConfig({ env = process.env, readFile = readFileSync } = {}) {
  const path = configPath(env);
  let text;
  try {
    text = readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`未找到配置文件 ${path}；请创建它，例如 {"allowedOrigins":["https://*.wikipedia.org","https://github.com"]}。未配置时拒绝把任何网页交给 Jev。`);
    }
    throw new Error(`读取 ${path} 失败：${error?.message ?? String(error)}`);
  }
  return { config: parseConfig(String(text), path), path };
}

/**
 * Same as `readConfig` but cached by file mtime. Used where a fresh read per
 * call is pointless (tool-loadout shaping); a config edit is picked up as soon
 * as it is saved.
 */
export function readConfigCached({ env = process.env, readFile = readFileSync, stat = statSync, cache = configCache } = {}) {
  const path = configPath(env);
  let mtimeMs;
  try {
    mtimeMs = stat(path).mtimeMs;
  } catch {
    cache.current = null;
    return null;
  }
  if (cache.current && cache.current.path === path && cache.current.mtimeMs === mtimeMs) return cache.current.config;
  try {
    const { config } = readConfig({ env, readFile });
    cache.current = { path, mtimeMs, config };
    return config;
  } catch {
    cache.current = null;
    return null;
  }
}

const configCache = { current: null };
