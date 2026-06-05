#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const ROOT = __dirname;
const API_HOST = "127.0.0.1";
const API_PORT = Number(process.env.CODEX_PROVIDER_HUB_API_PORT || 8789);
const UI_PORT = Number(process.env.CODEX_PROVIDER_HUB_UI_PORT || 8790);
const ADAPTER_PORT = Number(process.env.CODEX_PROVIDER_HUB_ADAPTER_PORT || 8791);
const MAX_BODY = 12 * 1024 * 1024;
const OLD_ROOT = path.resolve(ROOT, "..");
const OLD_MIMO_ENV = path.join(OLD_ROOT, ".mimo2codex-data", ".env");
const OLD_MIMO_BIN = path.join(OLD_ROOT, ".tools", "mimo2codex", "node_modules", "mimo2codex", "dist", "cli.js");
const PROVIDER_TYPES = new Set(["mimo", "openai-chat", "responses"]);

function appDataDir() {
  if (process.env.CODEX_PROVIDER_HUB_DATA_DIR) return process.env.CODEX_PROVIDER_HUB_DATA_DIR;
  const localDataDir = path.join(ROOT, "..", "data");
  if (fs.existsSync(localDataDir)) return localDataDir;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || os.homedir(), "Codex Provider Hub");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Codex Provider Hub");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "codex-provider-hub");
}

const DATA_DIR = appDataDir();

function hubPidFilePath() {
  return path.join(DATA_DIR, "hub.pid");
}

function writeHubPid() {
  ensureDir(DATA_DIR);
  fs.writeFileSync(hubPidFilePath(), String(process.pid));
}

function removeHubPid() {
  try { fs.unlinkSync(hubPidFilePath()); } catch {}
}

const CONFIG_PATH = path.join(DATA_DIR, "providers.json");
const KEYS_PATH = path.join(DATA_DIR, "keys.json");
const AUTH_TOKEN_PATH = path.join(DATA_DIR, "auth-token");
const LOG_PATH = path.join(DATA_DIR, "hub.log");
const STATS_PATH = path.join(DATA_DIR, "usage-stats.json");
const ADAPTER_DATA_DIR = path.join(DATA_DIR, "mimo2codex");
const ADAPTER_AUTH_TOKEN_PATH = path.join(ADAPTER_DATA_DIR, "hub-api-token");
const CODEX_DIR = path.join(os.homedir(), ".codex");
const CODEX_CONFIG_PATH = path.join(CODEX_DIR, "config.toml");
const CODEX_AUTH_PATH = path.join(CODEX_DIR, "auth.json");
const FUSECODE_AUTH_BACKUP = path.join(CODEX_DIR, "provider-switcher", "fusecode-auth.json");

let adapter = null;
let adapterKey = null;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensurePrivateDir(dir) {
  ensureDir(dir);
  if (process.platform !== "win32") {
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
}

function chmodPrivate(file) {
  if (process.platform !== "win32") {
    try { fs.chmodSync(file, 0o600); } catch {}
  }
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return fallback;
  }
}

function writeJson(file, data, privateFile = false) {
  if (privateFile) ensurePrivateDir(path.dirname(file));
  else ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  if (privateFile) chmodPrivate(file);
}

function isValidAuthToken(token) {
  return /^[A-Za-z0-9_-]{32,}$/.test(token);
}

function generateAuthToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function localAuthToken() {
  const envToken = String(process.env.CODEX_PROVIDER_HUB_AUTH_TOKEN || "").trim();
  if (isValidAuthToken(envToken)) return envToken;
  ensurePrivateDir(DATA_DIR);
  let token = "";
  try { token = readText(AUTH_TOKEN_PATH).trim(); } catch {}
  if (!isValidAuthToken(token)) {
    token = generateAuthToken();
    fs.writeFileSync(AUTH_TOKEN_PATH, `${token}\n`);
  }
  chmodPrivate(AUTH_TOKEN_PATH);
  return token;
}

function bearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hasValidAuth(req) {
  return timingSafeEqualText(bearerToken(req), localAuthToken());
}

function requireAuth(req, res) {
  if (hasValidAuth(req)) return true;
  sendJson(res, 401, { error: { type: "unauthorized", message: "Missing or invalid local auth token." } });
  return false;
}

function trustedUiOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    const port = Number(url.port || "80");
    return url.protocol === "http:" && port === UI_PORT && ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

function requireUiApiAccess(req, res) {
  if (!requireAuth(req, res)) return false;
  if (!["GET", "HEAD"].includes(req.method) && !trustedUiOrigin(req)) {
    sendJson(res, 403, { ok: false, message: "Cross-origin local API request rejected." });
    return false;
  }
  return true;
}

function appendLog(message, extra) {
  ensureDir(DATA_DIR);
  const line = `[${new Date().toISOString()}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`;
  fs.appendFileSync(LOG_PATH, line);
}

function readEnvFile(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of readText(file).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return env;
}

function migrateOldKeys() {
  const keys = readJson(KEYS_PATH, {});
  const oldEnv = readEnvFile(OLD_MIMO_ENV);
  if (!keys.mimo && oldEnv.MIMO_API_KEY) keys.mimo = oldEnv.MIMO_API_KEY;
  const fuseAuth = readJson(FUSECODE_AUTH_BACKUP, null);
  if (!keys.fusecode && fuseAuth?.OPENAI_API_KEY && fuseAuth.OPENAI_API_KEY !== "mimo2codex-local") {
    keys.fusecode = fuseAuth.OPENAI_API_KEY;
  }
  writeJson(KEYS_PATH, keys, true);
}

function defaultConfig() {
  const oldEnv = readEnvFile(OLD_MIMO_ENV);
  return {
    activeProvider: "mimo",
    codexInstalled: false,
    localSearch: {
      enabled: true,
      provider: "duckduckgo",
      onlyWhenLikelyNeeded: true
    },
    gateway: {
      listenHost: API_HOST,
      listenPort: API_PORT,
      uiPort: UI_PORT,
      upstreamBaseUrl: "https://api.deepseek.com",
      tlsCertPath: "",
      connectTimeoutMs: 5000,
      readTimeoutMs: 30000,
      maxRetries: 3,
      retryBackoff: "exponential",
      keyStrategy: "round-robin",
      logLevel: "INFO",
      logFilePath: LOG_PATH,
      logRequestBody: false,
      maxRequestsPerMinute: 120,
      maxConcurrentConnections: 20,
      routes: [
        { inbound: "POST /v1/responses", mode: "protocol-convert", outbound: "POST /v1/responses", enabled: true },
        { inbound: "GET /v1/models", mode: "passthrough", outbound: "GET /v1/models", enabled: true }
      ],
      modelMappings: [
        { input: "current", output: "<active provider model>", enabled: true },
        { input: "provider id", output: "provider.model", enabled: true }
      ]
    },
    providers: [
      {
        id: "mimo",
        type: "mimo",
        displayName: "MiMo v2.5 Pro",
        model: "mimo-v2.5-pro",
        baseUrl: oldEnv.MIMO_BASE_URL || "https://api.xiaomimimo.com/v1",
        keyId: "mimo",
        contextWindow: 1000000,
        maxOutputTokens: 131072
      },
      {
        id: "fusecode",
        type: "responses",
        displayName: "FuseCode",
        model: "gpt-5.5",
        baseUrl: "https://www.fusecode.cc",
        keyId: "fusecode"
      }
    ]
  };
}


function numberInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeGatewaySettings(settings = {}) {
  const defaults = defaultConfig().gateway;
  const retryBackoffs = new Set(["exponential", "fixed", "linear"]);
  const keyStrategies = new Set(["round-robin", "least-load", "primary-first"]);
  const logLevels = new Set(["DEBUG", "INFO", "WARN", "ERROR"]);
  return {
    ...defaults,
    ...settings,
    listenHost: String(settings.listenHost || defaults.listenHost),
    listenPort: numberInRange(settings.listenPort, defaults.listenPort, 1, 65535),
    uiPort: numberInRange(settings.uiPort, defaults.uiPort, 1, 65535),
    upstreamBaseUrl: String(settings.upstreamBaseUrl || defaults.upstreamBaseUrl),
    tlsCertPath: String(settings.tlsCertPath || ""),
    connectTimeoutMs: numberInRange(settings.connectTimeoutMs, defaults.connectTimeoutMs, 100, 120000),
    readTimeoutMs: numberInRange(settings.readTimeoutMs, defaults.readTimeoutMs, 1000, 600000),
    maxRetries: numberInRange(settings.maxRetries, defaults.maxRetries, 0, 10),
    retryBackoff: retryBackoffs.has(settings.retryBackoff) ? settings.retryBackoff : defaults.retryBackoff,
    keyStrategy: keyStrategies.has(settings.keyStrategy) ? settings.keyStrategy : defaults.keyStrategy,
    logLevel: logLevels.has(settings.logLevel) ? settings.logLevel : defaults.logLevel,
    logFilePath: String(settings.logFilePath || defaults.logFilePath),
    logRequestBody: settings.logRequestBody === true,
    maxRequestsPerMinute: numberInRange(settings.maxRequestsPerMinute, defaults.maxRequestsPerMinute, 1, 100000),
    maxConcurrentConnections: numberInRange(settings.maxConcurrentConnections, defaults.maxConcurrentConnections, 1, 10000),
    routes: Array.isArray(settings.routes) ? settings.routes.map((route) => ({
      inbound: String(route.inbound || ""),
      mode: String(route.mode || "protocol-convert"),
      outbound: String(route.outbound || ""),
      enabled: route.enabled !== false
    })).filter((route) => route.inbound && route.outbound).slice(0, 50) : defaults.routes,
    modelMappings: Array.isArray(settings.modelMappings) ? settings.modelMappings.map((mapping) => ({
      input: String(mapping.input || ""),
      output: String(mapping.output || ""),
      enabled: mapping.enabled !== false
    })).filter((mapping) => mapping.input && mapping.output).slice(0, 100) : defaults.modelMappings
  };
}

function loadConfig() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(CONFIG_PATH)) writeJson(CONFIG_PATH, defaultConfig());
  migrateOldKeys();
  const config = readJson(CONFIG_PATH, defaultConfig());
  config.gateway = normalizeGatewaySettings(config.gateway);
  const oldEnv = readEnvFile(OLD_MIMO_ENV);
  const mimo = providerById(config, "mimo");
  if (mimo && oldEnv.MIMO_BASE_URL && mimo.baseUrl === "https://api.xiaomimimo.com/v1" && oldEnv.MIMO_API_KEY?.startsWith("tp-")) {
    mimo.baseUrl = oldEnv.MIMO_BASE_URL;
    saveConfig(config);
  }
  syncCodexAuthToken(config);
  return config;
}

function saveConfig(config) {
  writeJson(CONFIG_PATH, config);
}

function loadKeys() {
  return readJson(KEYS_PATH, {});
}

function writeCodexAuthToken(token) {
  const auth = readJson(CODEX_AUTH_PATH, {});
  auth.OPENAI_API_KEY = token;
  writeJson(CODEX_AUTH_PATH, auth, true);
}

function syncCodexAuthToken(config) {
  if (!config.codexInstalled) return;
  const token = localAuthToken();
  const auth = readJson(CODEX_AUTH_PATH, {});
  if (auth.OPENAI_API_KEY !== token) writeCodexAuthToken(token);
}

function providerById(config, id = config.activeProvider) {
  return config.providers.find((provider) => provider.id === id);
}

function providerKey(provider) {
  if (!provider) return "";
  if (provider.apiKey) return provider.apiKey;
  const keys = loadKeys();
  return keys[provider.keyId || provider.id] || process.env[provider.envKey || ""] || "";
}

function redactedProvider(provider) {
  return {
    ...provider,
    hasKey: !!providerKey(provider),
    apiKey: provider.apiKey ? "***" : undefined
  };
}

function normalizeProviderType(type) {
  const normalized = String(type || "").trim();
  return PROVIDER_TYPES.has(normalized) ? normalized : "";
}

function normalizeHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

function isPrivateIpv4(host) {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function isBlockedProviderHost(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (["localhost", "localhost.localdomain"].includes(host) || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home")) return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) {
    if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab][0-9a-f]?:/i.test(host)) return true;
    if (host.startsWith("::ffff:")) return isPrivateIpv4(host.slice(7));
    return false;
  }
  return !host.includes(".");
}

function validateProviderBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl || "").trim());
  } catch {
    return { ok: false, message: "Base URL must be a valid URL." };
  }
  if (url.protocol !== "https:") return { ok: false, message: "Base URL must use https://." };
  if (url.username || url.password) return { ok: false, message: "Base URL must not include credentials." };
  if (url.search || url.hash) return { ok: false, message: "Base URL must not include query strings or fragments." };
  if (isBlockedProviderHost(url.hostname)) return { ok: false, message: "Base URL host must be a public provider host." };
  return { ok: true, url };
}

function assertProviderBaseUrl(provider) {
  const validation = validateProviderBaseUrl(provider?.baseUrl);
  if (!validation.ok) {
    throw new Error(`Invalid Base URL for ${provider?.displayName || provider?.id || "provider"}: ${validation.message}`);
  }
  return validation.url;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function decodeHtml(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

function stripTags(text) {
  return decodeHtml(String(text).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function fetchText(url, timeoutMs = 6500) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: {
        "user-agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/125 Safari/537.36",
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchText(new URL(res.headers.location, url).toString(), timeoutMs));
        res.resume();
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
        if (data.length > 1_200_000) req.destroy();
      });
      res.on("end", () => resolve(data));
    });
    req.on("timeout", () => req.destroy(new Error("search timeout")));
    req.on("error", reject);
  });
}

function normalizeDuckUrl(href) {
  try {
    const decoded = decodeHtml(href);
    const url = new URL(decoded, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return "";
  }
}

function parseDuckDuckGo(html) {
  const results = [];
  const blockRe = /<div[^>]+class="[^"]*result[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*result[^"]*"|<\/body>)/gi;
  const blocks = html.match(blockRe) || [];
  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = normalizeDuckUrl(linkMatch[1]);
    if (!url || url.includes("duckduckgo.com")) continue;
    const title = stripTags(linkMatch[2]);
    const snippetMatch = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[\s\S]*?>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[\s\S]*?>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";
    if (title) results.push({ title, url, snippet });
    if (results.length >= 5) break;
  }
  return results;
}

async function searchWeb(query) {
  const html = await fetchText(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  return parseDuckDuckGo(html);
}

function hasWebSearchTool(payload) {
  return Array.isArray(payload.tools) && payload.tools.some((tool) => tool && (tool.type === "web_search" || tool.type === "web_search_preview"));
}

function removeWebSearchTools(payload) {
  if (!Array.isArray(payload.tools)) return;
  payload.tools = payload.tools.filter((tool) => !(tool && (tool.type === "web_search" || tool.type === "web_search_preview")));
  if (payload.tools.length === 0) delete payload.tools;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    return "";
  }).filter(Boolean).join("\n");
}

function extractQuery(payload) {
  if (typeof payload.input === "string") return payload.input.slice(-700);
  if (!Array.isArray(payload.input)) return "";
  for (let i = payload.input.length - 1; i >= 0; i--) {
    const item = payload.input[i];
    if (!item || typeof item !== "object") continue;
    const role = item.role || item.type;
    if (role === "user" || role === "message" || item.type === "input_text") {
      const text = textFromContent(item.content || item.text || item.input || "");
      if (text) return text.slice(-700);
    }
  }
  return "";
}

function shouldSearch(query) {
  return /最新|今天|现在|当前|实时|新闻|搜索|查一下|查找|查询|联网|网上|价格|股价|汇率|天气|today|latest|current|news|search|web|price|weather|stock/i.test(query);
}

function searchNote(query, results, error) {
  const today = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  if (error) {
    return `本地联网搜索失败。不要声称已经联网搜索。\n当前日期: ${today}\n搜索词: ${query}\n错误: ${error.message || String(error)}`;
  }
  if (!results.length) {
    return `本地联网搜索没有找到可用结果。不要编造搜索结果。\n当前日期: ${today}\n搜索词: ${query}`;
  }
  return [
    "以下是 Codex Provider Hub 刚刚获取的网页搜索结果。请基于这些结果回答；引用事实时尽量给出链接。不要声称使用了上游厂商的付费搜索插件。",
    `当前日期: ${today}`,
    `搜索词: ${query}`,
    "",
    ...results.flatMap((result, index) => [
      `[${index + 1}] ${result.title}`,
      `URL: ${result.url}`,
      result.snippet ? `摘要: ${result.snippet}` : "",
      ""
    ])
  ].join("\n").trim();
}

async function applyLocalSearch(payload, config) {
  if (!config.localSearch?.enabled || !hasWebSearchTool(payload)) return payload;
  const query = extractQuery(payload) || "current information";
  removeWebSearchTools(payload);
  if (config.localSearch.onlyWhenLikelyNeeded !== false && !shouldSearch(query)) return payload;
  let results = [];
  let error = null;
  try {
    results = await searchWeb(query);
  } catch (err) {
    error = err;
  }
  const note = searchNote(query, results, error);
  payload.instructions = payload.instructions ? `${payload.instructions}\n\n${note}` : note;
  return payload;
}

function modelsResponse(config) {
  const now = Math.floor(Date.now() / 1000);
  const models = config.providers.map((provider) => ({
    id: provider.model || provider.id,
    object: "model",
    created: now,
    owned_by: "codex-provider-hub",
    display_name: provider.displayName || provider.id
  }));
  models.unshift({
    id: "current",
    object: "model",
    created: now,
    owned_by: "codex-provider-hub",
    display_name: "Current Provider"
  });
  return { object: "list", data: models };
}

function buildUrl(baseUrl, suffix) {
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

function emptyUsageStats() {
  return {
    totalRequests: 0,
    totalErrors: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    estimatedRequests: 0,
    byProvider: {},
    byModel: {},
    byDate: {},
    recent: []
  };
}

function loadUsageStats() {
  return { ...emptyUsageStats(), ...readJson(STATS_PATH, emptyUsageStats()) };
}

function roughTokenCount(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (text.replace(/[\u3400-\u9fff]/g, " ").match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) || []).length;
  return Math.max(1, Math.ceil(cjk * 0.8 + words * 0.75));
}

function outputTextFromPayload(payload) {
  if (!payload) return "";
  if (typeof payload.output_text === "string") return payload.output_text;
  if (Array.isArray(payload.output)) return JSON.stringify(payload.output);
  if (Array.isArray(payload.choices)) return JSON.stringify(payload.choices.map((choice) => choice.message?.content || choice.text || ""));
  return "";
}

function extractUsage(payload, requestPayload) {
  const usage = payload?.usage || {};
  let inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  let outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  if (!inputTokens) inputTokens = roughTokenCount(requestPayload?.input || requestPayload?.messages || requestPayload?.prompt || requestPayload);
  if (!outputTokens) outputTokens = roughTokenCount(outputTextFromPayload(payload));
  const totalTokens = Number(usage.total_tokens ?? (inputTokens + outputTokens)) || 0;
  return { inputTokens, outputTokens, totalTokens, estimated: !usage.total_tokens && !usage.input_tokens && !usage.prompt_tokens };
}

function incrementUsageBucket(bucket, key, usage, ok) {
  const id = key || "unknown";
  bucket[id] ||= { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedRequests: 0 };
  bucket[id].requests += 1;
  if (!ok) bucket[id].errors += 1;
  bucket[id].inputTokens += usage.inputTokens;
  bucket[id].outputTokens += usage.outputTokens;
  bucket[id].totalTokens += usage.totalTokens;
  if (usage.estimated) bucket[id].estimatedRequests += 1;
}

function localDateKey(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

function recordUsage({ provider, model, statusCode, latencyMs, payload, requestPayload }) {
  const stats = loadUsageStats();
  const ok = statusCode >= 200 && statusCode < 400;
  const usage = extractUsage(payload, requestPayload);
  stats.totalRequests += 1;
  if (!ok) stats.totalErrors += 1;
  stats.totalInputTokens += usage.inputTokens;
  stats.totalOutputTokens += usage.outputTokens;
  stats.totalTokens += usage.totalTokens;
  if (usage.estimated) stats.estimatedRequests = (stats.estimatedRequests || 0) + 1;
  incrementUsageBucket(stats.byProvider, provider?.id, usage, ok);
  incrementUsageBucket(stats.byModel, model || provider?.model, usage, ok);
  incrementUsageBucket(stats.byDate ||= {}, localDateKey(), usage, ok);
  stats.byDate = Object.fromEntries(Object.entries(stats.byDate).sort(([a], [b]) => a.localeCompare(b)).slice(-60));
  stats.recent = [{
    at: new Date().toISOString(),
    provider: provider?.id || "unknown",
    model: model || provider?.model || "unknown",
    statusCode,
    latencyMs,
    ...usage
  }, ...(Array.isArray(stats.recent) ? stats.recent : [])].slice(0, 100);
  writeJson(STATS_PATH, stats);
}

function proxyHttp(url, req, res, body, headers = {}, meta = {}) {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error(`Unsupported upstream protocol: ${target.protocol}`);
  }
  const started = Date.now();
  const transport = target.protocol === "https:" ? https : http;
  const outgoingHeaders = {
    "content-type": req.headers["content-type"] || "application/json",
    accept: req.headers.accept || "application/json",
    ...headers,
    host: target.host
  };
  outgoingHeaders["content-length"] = Buffer.byteLength(body);
  const upstream = transport.request({
    method: req.method,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    headers: outgoingHeaders
  }, (upstreamRes) => {
    const statusCode = upstreamRes.statusCode || 502;
    const contentType = String(upstreamRes.headers["content-type"] || "");
    const shouldCapture = !contentType.includes("text/event-stream");
    if (!shouldCapture) {
      recordUsage({ ...meta, statusCode, latencyMs: Date.now() - started, payload: null, requestPayload: meta.requestPayload });
      res.writeHead(statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
      return;
    }
    const chunks = [];
    upstreamRes.on("data", (chunk) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      const responseBody = Buffer.concat(chunks);
      let payload = null;
      try { payload = JSON.parse(responseBody.toString("utf8")); } catch {}
      recordUsage({ ...meta, statusCode, latencyMs: Date.now() - started, payload, requestPayload: meta.requestPayload });
      res.writeHead(statusCode, upstreamRes.headers);
      res.end(responseBody);
    });
  });
  upstream.on("error", (error) => {
    recordUsage({ ...meta, statusCode: 502, latencyMs: Date.now() - started, payload: null, requestPayload: meta.requestPayload });
    sendJson(res, 502, { error: { type: "provider_hub_error", message: error.message } });
  });
  upstream.end(body);
}

function findMimo2CodexCli() {
  const local = path.join(ROOT, "node_modules", "mimo2codex", "dist", "cli.js");
  if (fs.existsSync(local)) return local;
  if (fs.existsSync(OLD_MIMO_BIN)) return OLD_MIMO_BIN;
  return null;
}

function isValidAdapterAuthToken(token) {
  return /^m2c_[a-f0-9]{64}$/i.test(String(token || "").trim());
}

function mimoDistUrl(relativePath) {
  return pathToFileURL(path.join(ROOT, "node_modules", "mimo2codex", "dist", relativePath)).href;
}

async function ensureAdapterAuthToken() {
  ensurePrivateDir(ADAPTER_DATA_DIR);
  const [{ openDb, closeDb }, { createUser, findUserByUsername }, { createApiKey, findApiKeyByToken }] = await Promise.all([
    import(mimoDistUrl("db/index.js")),
    import(mimoDistUrl("db/users.js")),
    import(mimoDistUrl("db/apiKeys.js"))
  ]);
  openDb(ADAPTER_DATA_DIR);
  try {
    let token = "";
    try { token = readText(ADAPTER_AUTH_TOKEN_PATH).trim(); } catch {}
    if (isValidAdapterAuthToken(token) && findApiKeyByToken(token)) {
      chmodPrivate(ADAPTER_AUTH_TOKEN_PATH);
      return token;
    }
    const user = findUserByUsername("provider-hub") || createUser({
      username: "provider-hub",
      displayName: "Provider Hub",
      passwordHash: null,
      isAdmin: true
    });
    const created = createApiKey(user.id, "Provider Hub adapter");
    fs.writeFileSync(ADAPTER_AUTH_TOKEN_PATH, `${created.token}\n`);
    chmodPrivate(ADAPTER_AUTH_TOKEN_PATH);
    return created.token;
  } finally {
    closeDb();
  }
}

function adapterSignature(provider) {
  return JSON.stringify({
    id: provider.id,
    type: provider.type,
    baseUrl: provider.baseUrl,
    model: provider.model,
    key: providerKey(provider)
  });
}

function stopAdapter() {
  if (adapter?.process && !adapter.process.killed) {
    adapter.process.kill();
  }
  adapter = null;
  adapterKey = null;
}

function canConnect(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: API_HOST, port, timeout: timeoutMs }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, timeoutMs = 6500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function ensureAdapter(provider) {
  const sig = adapterSignature(provider);
  if (adapter?.process && !adapter.process.killed && adapterKey === sig && await canConnect(ADAPTER_PORT)) return;
  stopAdapter();
  assertProviderBaseUrl(provider);
  const cli = findMimo2CodexCli();
  if (!cli) throw new Error("mimo2codex is not installed. Run npm install in codex-provider-hub.");
  ensureDir(ADAPTER_DATA_DIR);
  const adapterAuthToken = await ensureAdapterAuthToken();
  const key = providerKey(provider);
  if (!key) throw new Error(`Provider ${provider.displayName || provider.id} has no API key.`);
  const env = {
    ...process.env,
    MIMO2CODEX_HOST: API_HOST,
    MIMO2CODEX_PORT: String(ADAPTER_PORT),
    MIMO2CODEX_DATA_DIR: ADAPTER_DATA_DIR,
    MIMO2CODEX_NO_UPDATE_CHECK: "1",
    MIMO2CODEX_DISABLE_WEB_SEARCH: "1",
    MIMO2CODEX_AUTH: "on"
  };
  const args = [cli, "--data-dir", ADAPTER_DATA_DIR, "--port", String(ADAPTER_PORT), "--host", API_HOST, "--no-update-check"];
  if (provider.type === "mimo") {
    env.MIMO_API_KEY = key;
    env.MIMO_BASE_URL = provider.baseUrl || "https://api.xiaomimimo.com/v1";
    args.push("--model", "mimo");
  } else {
    env.GENERIC_BASE_URL = provider.baseUrl;
    env.GENERIC_API_KEY = key;
    env.GENERIC_DEFAULT_MODEL = provider.model;
    args.push("--model", "generic");
  }
  const out = fs.openSync(path.join(DATA_DIR, "adapter.out.log"), "a");
  const err = fs.openSync(path.join(DATA_DIR, "adapter.err.log"), "a");
  const child = childProcess.spawn(process.execPath, args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", out, err],
    windowsHide: true
  });
  adapter = { process: child, providerId: provider.id, authToken: adapterAuthToken };
  adapterKey = sig;
  appendLog("adapter started", { provider: provider.id, pid: child.pid });
  child.on("exit", (code, signal) => appendLog("adapter exited", { provider: provider.id, code, signal }));
  if (!await waitForPort(ADAPTER_PORT)) {
    throw new Error(`mimo2codex adapter did not start on ${ADAPTER_PORT}. Check ${path.join(DATA_DIR, "adapter.err.log")}`);
  }
}

function rewriteModel(payload, provider) {
  if (provider.model) {
    payload.model = provider.model;
  }
}

async function prepareProviderForSwitch(provider) {
  assertProviderBaseUrl(provider);
  if (!providerKey(provider)) {
    throw new Error(`Provider ${provider.displayName || provider.id} has no API key.`);
  }
  if (provider.type !== "responses") await ensureAdapter(provider);
}

async function handleResponses(req, res) {
  const config = loadConfig();
  const provider = providerById(config);
  if (!provider) {
    sendJson(res, 500, { error: { type: "provider_hub_error", message: `Active provider not found: ${config.activeProvider}` } });
    return;
  }
  const raw = await readRequestBody(req);
  let payload = JSON.parse(raw || "{}");
  rewriteModel(payload, provider);
  payload = await applyLocalSearch(payload, config);

  if (provider.type === "responses") {
    assertProviderBaseUrl(provider);
    const key = providerKey(provider);
    if (!key) {
      sendJson(res, 400, { error: { type: "provider_hub_error", message: `Provider ${provider.displayName || provider.id} has no API key.` } });
      return;
    }
    proxyHttp(buildUrl(provider.baseUrl, "/v1/responses"), req, res, JSON.stringify(payload), {
      authorization: `Bearer ${key}`
    }, { provider, model: payload.model, requestPayload: payload });
    return;
  }

  await ensureAdapter(provider);
  proxyHttp(`http://${API_HOST}:${ADAPTER_PORT}/v1/responses`, req, res, JSON.stringify(payload), {
    authorization: `Bearer ${adapter.authToken}`
  }, { provider, model: payload.model, requestPayload: payload });
}

function installCodexConfig() {
  ensureDir(CODEX_DIR);
  const existing = fs.existsSync(CODEX_CONFIG_PATH) ? readText(CODEX_CONFIG_PATH) : "";
  const providerBlock = `[model_providers.provider-hub]
name = "Codex Provider Hub"
base_url = "http://127.0.0.1:${API_PORT}/v1"
wire_api = "responses"
requires_openai_auth = true
request_max_retries = 3`;
  const next = setTopLevel(upsertSection(existing, "model_providers.provider-hub", providerBlock), {
    model_provider: "\"provider-hub\"",
    model: "\"current\"",
    model_reasoning_effort: "\"high\""
  }, ["model_context_window", "model_max_output_tokens"]);
  fs.writeFileSync(CODEX_CONFIG_PATH, next);
  chmodPrivate(CODEX_CONFIG_PATH);
  writeCodexAuthToken(localAuthToken());
  const config = loadConfig();
  config.codexInstalled = true;
  saveConfig(config);
}

function ensureCodexConfigInstalled() {
  try {
    installCodexConfig();
    appendLog("codex config ensured", { path: CODEX_CONFIG_PATH });
  } catch (error) {
    appendLog("codex config ensure failed", { message: error.message });
  }
}

function restoreOpenAIConfig() {
  ensureDir(CODEX_DIR);
  const existing = fs.existsSync(CODEX_CONFIG_PATH) ? readText(CODEX_CONFIG_PATH) : "";
  
  // Backup current config
  const backupPath = path.join(DATA_DIR, `config-backup-${Date.now()}.toml`);
  ensureDir(DATA_DIR);
  fs.writeFileSync(backupPath, existing);
  appendLog("config backed up", { path: backupPath });
  
  // Remove provider-hub section
  const escaped = "model_providers.provider-hub".replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRe = new RegExp(`(^|\\n)\[${escaped}\]\\n[\\s\\S]*?(?=\\n\[|$)`);
  let cleaned = existing.replace(sectionRe, "$1").replace(/\n{3,}/g, "\n\n").replace(/\s+$/u, "") + "\n";
  
  // Restore official OpenAI settings
  const next = setTopLevel(cleaned, {
    model_provider: "\"openai\"",
    model: "\"o3\"",
    model_reasoning_effort: "\"high\""
  }, []);
  
  fs.writeFileSync(CODEX_CONFIG_PATH, next);
  chmodPrivate(CODEX_CONFIG_PATH);
  
  // Update hub config
  const config = loadConfig();
  config.codexInstalled = false;
  saveConfig(config);
  
  return backupPath;
}


function splitToml(text) {
  const lines = text.split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstSection === -1) return { header: lines, rest: [] };
  return { header: lines.slice(0, firstSection), rest: lines.slice(firstSection) };
}

function setTopLevel(text, orderedAssignments, removeKeys = []) {
  const { header, rest } = splitToml(text);
  const keys = new Set([...Object.keys(orderedAssignments), ...removeKeys]);
  const kept = header.filter((line) => {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    return !match || !keys.has(match[1]);
  }).filter((line, index, arr) => !(line.trim() === "" && index === arr.length - 1));
  const assignments = Object.entries(orderedAssignments).map(([key, value]) => `${key} = ${value}`);
  return [...assignments, ...kept, "", ...rest].join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/u, "") + "\n";
}

function upsertSection(text, sectionName, block) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRe = new RegExp(`(^|\\n)\\[${escaped}\\]\\n[\\s\\S]*?(?=\\n\\[|$)`);
  if (sectionRe.test(text)) return text.replace(sectionRe, (match, prefix) => `${prefix}${block}\n`);
  return text.replace(/\s+$/u, "") + "\n\n" + block + "\n";
}

function securityHeaders(extra = {}) {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, securityHeaders({ "content-type": "application/json; charset=utf-8" }));
  res.end(JSON.stringify(payload));
}

async function statusPayload() {
  const config = loadConfig();
  const provider = providerById(config);
  return {
    apiUrl: `http://${API_HOST}:${API_PORT}/v1`,
    uiUrl: `http://${API_HOST}:${UI_PORT}`,
    dataDir: DATA_DIR,
    activeProvider: config.activeProvider,
    activeProviderDisplayName: provider?.displayName || config.activeProvider,
    codexInstalled: !!config.codexInstalled,
    adapterRunning: !!(adapter?.process && !adapter.process.killed) && await canConnect(ADAPTER_PORT),
    providers: config.providers.map(redactedProvider),
    localSearch: config.localSearch,
    gateway: config.gateway,
    usageStats: loadUsageStats(),
    adapterPort: ADAPTER_PORT
  };
}

async function readJsonBody(req) {
  return JSON.parse(await readRequestBody(req) || "{}");
}

function readRecentLogLines(limit = 120) {
  try {
    const text = readText(LOG_PATH);
    return text.split(/\r?\n/).filter(Boolean).slice(-limit).reverse();
  } catch {
    return [];
  }
}

async function handleApi(req, res) {
  if (req.method === "GET" && req.url === "/api/status") {
    sendJson(res, 200, await statusPayload());
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/logs")) {
    const url = new URL(req.url, `http://${API_HOST}:${UI_PORT}`);
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 120)));
    sendJson(res, 200, { ok: true, lines: readRecentLogLines(limit) });
    return;
  }
  if (req.method === "GET" && req.url === "/api/gateway-settings") {
    const config = loadConfig();
    sendJson(res, 200, { ok: true, gateway: config.gateway });
    return;
  }
  if (req.method === "POST" && req.url === "/api/gateway-settings") {
    const body = await readJsonBody(req);
    const config = loadConfig();
    config.gateway = normalizeGatewaySettings({ ...config.gateway, ...body });
    saveConfig(config);
    sendJson(res, 200, { ok: true, gateway: config.gateway, message: "高级参数已保存。部分监听端口类参数需要重启 Hub 后生效。" });
    return;
  }
  if (req.method === "POST" && req.url === "/api/install-codex") {
    installCodexConfig();
    sendJson(res, 200, { ok: true, message: "Codex is pointed at Provider Hub. Provider switches take effect on the next Codex request." });
    return;
  }
  if (req.method === "POST" && req.url === "/api/switch") {
    const body = await readJsonBody(req);
    const config = loadConfig();
    const provider = providerById(config, body.id);
    if (!provider) {
      sendJson(res, 404, { ok: false, message: `Provider not found: ${body.id}` });
      return;
    }
    const previousProvider = config.activeProvider;
    try {
      config.activeProvider = provider.id;
      saveConfig(config);
      await prepareProviderForSwitch(provider);
      if (provider.type === "responses") stopAdapter();
    } catch (error) {
      const rollback = loadConfig();
      if (rollback.activeProvider === provider.id) {
        rollback.activeProvider = previousProvider;
        saveConfig(rollback);
      }
      throw error;
    }
    sendJson(res, 200, { ok: true, message: `Switched to ${provider.id}. Next Codex request will use ${provider.displayName || provider.id}.` });
    return;
  }
  if (req.method === "POST" && req.url === "/api/providers") {
    const body = await readJsonBody(req);
    const config = loadConfig();
    const id = String(body.id || "").trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      sendJson(res, 400, { ok: false, message: "Provider id must be 1-64 characters: letters, numbers, dot, underscore, or hyphen." });
      return;
    }
    const existingProvider = providerById(config, id);
    const type = normalizeProviderType(body.type || existingProvider?.type || "openai-chat");
    if (!type) {
      sendJson(res, 400, { ok: false, message: "Provider type must be mimo, openai-chat, or responses." });
      return;
    }
    const provider = {
      ...existingProvider,
      id,
      displayName: String(body.displayName || body.id || "").trim(),
      type,
      baseUrl: String(body.baseUrl || "").trim(),
      model: String(body.model || "").trim(),
      keyId: existingProvider?.keyId || id
    };
    if (!provider.id || !provider.baseUrl || !provider.model) {
      sendJson(res, 400, { ok: false, message: "id, baseUrl, and model are required." });
      return;
    }
    const baseUrlValidation = validateProviderBaseUrl(provider.baseUrl);
    if (!baseUrlValidation.ok) {
      sendJson(res, 400, { ok: false, message: baseUrlValidation.message });
      return;
    }
    config.providers = config.providers.filter((item) => item.id !== provider.id);
    config.providers.push(provider);
    saveConfig(config);
    if (body.apiKey) {
      const keys = loadKeys();
      keys[provider.keyId] = String(body.apiKey);
      writeJson(KEYS_PATH, keys, true);
    }
    sendJson(res, 200, { ok: true, provider: redactedProvider(provider) });
    return;
  }
  if (req.method === "POST" && req.url === "/api/local-search") {
    const body = await readJsonBody(req);
    const config = loadConfig();
    config.localSearch = {
      ...config.localSearch,
      enabled: !!body.enabled,
      onlyWhenLikelyNeeded: body.onlyWhenLikelyNeeded !== false
    };
    saveConfig(config);
    sendJson(res, 200, { ok: true, localSearch: config.localSearch });
    return;
  }
  if (req.method === "POST" && req.url === "/api/test-active") {
    const started = Date.now();
    const response = await fetch(`http://${API_HOST}:${API_PORT}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${localAuthToken()}`
      },
      body: JSON.stringify({
        model: "current",
        input: "Reply with exactly: ok",
        stream: false
      })
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 500) }; }
    const sample = payload.output?.find?.((item) => item.type === "message")?.content?.[0]?.text;
    sendJson(res, response.ok ? 200 : 502, {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      sample: sample || payload.error?.message || JSON.stringify(payload).slice(0, 500)
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/uninstall-codex") {
    const backupPath = restoreOpenAIConfig();
    sendJson(res, 200, { ok: true, message: "已恢复官方 OpenAI 配置。请重启 Codex。", backupPath });
    return;
  }
  sendJson(res, 404, { ok: false, message: "Not found" });
}

function html() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex Switcher</title>
<style>
*,*::before,*::after{box-sizing:border-box}body{margin:0;min-height:100vh;font:13px/1.45 "Segoe UI",-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:#1f2328;background:#6e6e6e;display:grid;place-items:center;padding:18px}button,input,select{font:inherit;max-width:100%}.window{width:min(1240px,calc(100vw - 24px));height:min(780px,calc(100vh - 24px));background:#f3f4f6;border-radius:14px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.34),0 0 0 1px rgba(0,0,0,.14);display:flex;flex-direction:column}.titlebar{height:34px;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;padding:0 12px 0 16px;user-select:none}.title-left{display:flex;align-items:center;gap:9px;color:#6b7280;font-size:12px}.app-icon{width:16px;height:16px;border-radius:4px;background:#2563eb;display:grid;place-items:center;color:white;font-weight:800;font-size:11px}.traffic{display:flex}.traffic button{width:42px;height:32px;border:0;background:transparent;color:#6b7280}.traffic button:hover{background:#f3f4f6}.traffic .close:hover{background:#dc2626;color:white}.shell{flex:1;min-height:0;display:flex}.sidebar{width:230px;background:#fff;border-right:1px solid #e5e7eb;display:flex;flex-direction:column}.brand{padding:18px 16px 10px}.brand h1{font-size:16px;line-height:1.1;margin:0;color:#111827;letter-spacing:-.02em}.brand p{margin:3px 0 0;color:#6b7280;font-size:11px}.status-pill{margin-top:12px;display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:700}.status-pill.ok{background:#ecfdf5;color:#15803d}.status-pill.warn{background:#fff7ed;color:#c2410c}.dot{width:6px;height:6px;border-radius:50%;background:currentColor}.nav-label{padding:14px 16px 5px;color:#8b949e;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.07em}.nav{padding:0 8px}.nav button{width:100%;height:36px;border:0;border-radius:7px;background:transparent;color:#6b7280;display:flex;align-items:center;gap:10px;padding:0 10px;text-align:left;cursor:pointer}.nav button:hover{background:#f3f4f6;color:#111827}.nav button.active{background:#eaf1ff;color:#2563eb;font-weight:700}.sidebar-footer{margin-top:auto;padding:12px 16px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:11px}.content{flex:1;min-width:0;display:flex;flex-direction:column}.page{display:none;min-height:0;flex:1;flex-direction:column}.page.active{display:flex}.page-header{background:#fff;border-bottom:1px solid #e5e7eb;padding:20px 24px 16px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.page-title{font-size:19px;font-weight:800;letter-spacing:-.025em;color:#111827}.page-sub{margin-top:3px;color:#6b7280;font-size:12px}.page-body{padding:20px 24px;overflow:auto;overflow-x:hidden}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn{border:0;border-radius:7px;min-height:34px;padding:0 13px;display:inline-flex;align-items:center;gap:7px;font-weight:750;cursor:pointer}.btn-primary{background:#2563eb;color:white}.btn-primary:hover{background:#1d4ed8}.btn-secondary{background:#fff;color:#111827;border:1px solid #d1d5db}.btn-secondary:hover{background:#f9fafb}.btn-danger{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}.btn-success{background:#ecfdf5;color:#15803d;border:1px solid #bbf7d0}.btn:disabled{opacity:.55;cursor:not-allowed}.grid{display:grid;gap:14px}.stats{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:18px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;min-width:0;overflow:hidden}.stat-label{font-size:11px;color:#6b7280;font-weight:800;text-transform:uppercase;letter-spacing:.04em}.stat-value{font-size:26px;font-weight:850;letter-spacing:-.03em;margin-top:4px;color:#111827}.stat-note{font-size:11px;color:#6b7280;margin-top:4px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:center;background:linear-gradient(135deg,#fff,#f8fbff);border:1px solid #dbeafe;border-radius:12px;padding:18px 20px;margin-bottom:18px}.hero h2{font-size:17px;margin:0;color:#111827}.hero p{margin:4px 0 0;color:#6b7280}.meta{display:flex;gap:18px;flex-wrap:wrap;margin-top:12px}.meta div{font-size:12px;color:#6b7280}.meta code,.code{font-family:"Cascadia Code",Consolas,ui-monospace,monospace;font-size:11px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:4px;padding:2px 6px;color:#111827}.providers{grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}.provider{position:relative;background:#fff;border:1px solid #e5e7eb;border-radius:11px;padding:15px;transition:.14s}.provider:hover{border-color:#bfdbfe;box-shadow:0 8px 24px rgba(37,99,235,.08)}.provider.active{border-color:#60a5fa;background:#f8fbff}.provider h3{margin:0;font-size:15px;color:#111827}.provider .type{margin-top:7px;color:#6b7280;font-size:12px;display:flex;gap:6px;flex-wrap:wrap}.provider .row{display:flex;gap:8px;margin-top:13px;flex-wrap:wrap}.badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:750}.badge-ok{background:#ecfdf5;color:#15803d}.badge-warn{background:#fff7ed;color:#c2410c}.badge-blue{background:#eaf1ff;color:#2563eb}.badge-muted{background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb}.split{grid-template-columns:minmax(0,1fr) minmax(320px,360px);align-items:start}.form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;min-width:0}.form label{display:grid;gap:5px;color:#6b7280;font-size:12px;min-width:0}.form .full{grid-column:1/-1}.input,select{width:100%;min-width:0;height:38px;border:1px solid #d1d5db;border-radius:7px;background:#fff;color:#111827;padding:0 10px}.input:focus,select:focus{outline:2px solid #bfdbfe;border-color:#60a5fa}select.native-select{position:absolute!important;opacity:0!important;pointer-events:none!important;width:1px!important;height:1px!important}.custom-select{position:relative;min-width:0}.custom-select-trigger{width:100%;height:38px;border:1px solid #d1d5db;border-radius:7px;background:#fff;color:#111827;padding:0 34px 0 10px;display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;text-align:left}.custom-select-trigger:hover{background:#f9fafb}.custom-select.open .custom-select-trigger{border-color:#60a5fa;outline:2px solid #bfdbfe}.custom-select-trigger::after{content:"";position:absolute;right:12px;top:50%;width:8px;height:8px;border-right:1.8px solid #6b7280;border-bottom:1.8px solid #6b7280;transform:translateY(-65%) rotate(45deg);transition:.14s}.custom-select.open .custom-select-trigger::after{transform:translateY(-35%) rotate(225deg)}.custom-select-menu{position:absolute;z-index:30;left:0;right:0;top:calc(100% + 6px);background:#fff;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 14px 36px rgba(15,23,42,.16);padding:5px;display:none;max-height:220px;overflow:auto}.custom-select.open .custom-select-menu{display:block}.custom-select-option{height:32px;border-radius:6px;padding:0 9px;display:flex;align-items:center;cursor:pointer;color:#374151}.custom-select-option:hover{background:#f3f4f6;color:#111827}.custom-select-option.selected{background:#eaf1ff;color:#2563eb;font-weight:750}.logbox{height:430px;overflow:auto;background:#0b1220;color:#dbeafe;border-radius:10px;border:1px solid #111827;padding:13px;font-family:"Cascadia Code",Consolas,ui-monospace,monospace;font-size:12px;line-height:1.6}.logbox div{white-space:pre-wrap;border-bottom:1px solid rgba(255,255,255,.06);padding:3px 0}.notice{border:1px solid #fed7aa;background:#fff7ed;color:#9a3412;border-radius:9px;padding:12px;font-size:12px}.chart{height:220px;border:1px solid #e5e7eb;border-radius:10px;background:linear-gradient(180deg,#fff,#f8fafc);padding:14px 14px 8px;display:flex;align-items:stretch;gap:10px;overflow:hidden}.chart-day{flex:1;min-width:38px;display:grid;grid-template-rows:1fr 22px;gap:7px;align-items:end}.bar-stack{height:100%;display:flex;align-items:end;gap:3px}.bar{flex:1;min-width:8px;border-radius:6px 6px 0 0;background:linear-gradient(180deg,#60a5fa,#2563eb);position:relative}.bar.output{background:linear-gradient(180deg,#34d399,#059669)}.chart-label{text-align:center;font-size:10px;color:#6b7280;white-space:nowrap}.bar:hover::after{content:attr(data-label);position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);white-space:nowrap;background:#111827;color:#fff;border-radius:6px;padding:4px 7px;font-size:11px;z-index:4}.hbar-row{display:grid;grid-template-columns:minmax(90px,1fr) 2fr auto;gap:10px;align-items:center}.hbar-track{height:9px;border-radius:999px;background:#e5e7eb;overflow:hidden}.hbar-fill{height:100%;border-radius:inherit;background:linear-gradient(90deg,#2563eb,#60a5fa)}.toast{position:fixed;right:28px;bottom:28px;max-width:460px;background:#111827;color:#fff;border-radius:10px;padding:12px 14px;box-shadow:0 16px 40px rgba(0,0,0,.28);display:none;z-index:10}.toast.show{display:block}@media(max-width:1100px){body{padding:0}.window{width:100vw;height:100vh;border-radius:0}.sidebar{width:200px}.stats,.split{grid-template-columns:1fr}.form{grid-template-columns:1fr}.hero{align-items:flex-start;flex-direction:column}.page-header{flex-direction:column}.stats{grid-template-columns:repeat(2,1fr)}}@media(max-width:760px){.shell{flex-direction:column}.sidebar{width:100%;border-right:0;border-bottom:1px solid #e5e7eb;max-height:190px}.brand{padding:12px 14px 6px}.nav-label{display:none}.nav{display:flex;gap:6px;overflow:auto;padding:6px 8px}.nav button{min-width:max-content;width:auto}.sidebar-footer{display:none}.page-header{padding:14px 16px}.page-body{padding:14px 16px}.stats{grid-template-columns:1fr}.providers{grid-template-columns:1fr}.traffic{display:none}}
</style>
</head>
<body>
<div class="window">
  <div class="titlebar"><div class="title-left"><span class="app-icon">C</span><span>Codex Switcher</span></div><div class="traffic"><button>—</button><button>□</button><button class="close">×</button></div></div>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><h1>Codex Switcher</h1><p>本地模型厂商控制台</p><div id="sideStatus" class="status-pill ok"><span class="dot"></span><span>读取中</span></div></div>
      <div class="nav-label">Workspace</div><nav class="nav">
        <button class="active" data-page="overview">⌘ 概览</button>
        <button data-page="providers">▦ 厂商</button>
        <button data-page="logs">≡ 日志</button>
        <button data-page="settings">⚙ 设置</button>
      </nav>
      <div class="nav-label">Quick Links</div><nav class="nav"><button id="openApi">↗ API 入口</button><button id="refreshAll">⟳ 刷新状态</button></nav>
      <div class="sidebar-footer"><div>固定入口</div><div><code id="sideApi" class="code">127.0.0.1</code></div></div>
    </aside>
    <main class="content">
      <section id="page-overview" class="page active">
        <header class="page-header"><div><div class="page-title">运行概览</div><div class="page-sub">Codex 固定连接 Hub，厂商切换在下一次请求生效。</div></div><div class="actions"><button id="testActive" class="btn btn-primary">测试当前厂商</button><button id="syncCodex" class="btn btn-secondary">同步 Codex 配置</button></div></header>
        <div class="page-body">
          <div class="hero"><div><h2 id="activeTitle">当前厂商</h2><p id="activeSub">读取中...</p><div class="meta"><div>API <code id="apiUrl">-</code></div><div>数据目录 <code id="dataDir">-</code></div><div>Adapter <code id="adapterState">-</code></div></div></div><span id="activeBadge" class="badge badge-blue">Current</span></div>
          <div class="grid stats"><div class="card"><div class="stat-label">总请求</div><div id="requestCount" class="stat-value">-</div><div class="stat-note" id="errorRate">错误率 -</div></div><div class="card"><div class="stat-label">Token 消耗</div><div id="tokenTotal" class="stat-value">-</div><div class="stat-note" id="tokenSplit">输入 - / 输出 -</div></div><div class="card"><div class="stat-label">当前模型消耗</div><div id="activeModelTokens" class="stat-value">-</div><div class="stat-note" id="activeModelName">-</div></div><div class="card"><div class="stat-label">密钥状态</div><div id="keyState" class="stat-value">-</div><div class="stat-note">缺失时不可切换</div></div></div>
          <div class="grid split"><div class="grid"><div class="card"><h3 style="margin:0 0 12px">Token 消耗趋势</h3><div id="tokenChart" class="chart"></div></div><div class="card"><h3 style="margin:0 0 12px">快速切换</h3><div id="quickProviders" class="grid providers"></div></div></div><div class="grid"><div class="card"><h3 style="margin:0 0 12px">模型消耗排行</h3><div id="modelUsage" class="grid"></div></div><div class="card"><h3 style="margin:0 0 12px">操作反馈</h3><div id="messagePanel" class="notice">准备就绪。选择厂商后，下次 Codex 请求会使用新厂商。</div></div></div></div>
        </div>
      </section>
      <section id="page-providers" class="page"><header class="page-header"><div><div class="page-title">厂商管理</div><div class="page-sub">新增、编辑、测试并切换 OpenAI 兼容或 Responses 厂商。</div></div><div class="actions"><button id="clearProviderForm" class="btn btn-secondary">新增厂商</button></div></header><div class="page-body"><div class="grid split"><div><div id="providers" class="grid providers"></div></div><div class="card"><h3 id="providerFormTitle" style="margin:0 0 12px">添加自定义厂商</h3><form id="providerForm" class="form"><label>ID<input class="input" name="id" placeholder="deepseek"></label><label>显示名<input class="input" name="displayName" placeholder="DeepSeek"></label><label>类型<select name="type"><option value="openai-chat">OpenAI Chat Completions</option><option value="responses">Responses API</option><option value="mimo">MiMo</option></select></label><label>模型<input class="input" name="model" placeholder="deepseek-chat"></label><label class="full">Base URL<input class="input" name="baseUrl" placeholder="https://api.deepseek.com/v1"></label><label class="full">API Key<input class="input" name="apiKey" type="password" placeholder="留空则沿用已保存密钥"></label><button class="btn btn-primary full" id="saveProvider">保存厂商</button></form></div></div></div></section>
      <section id="page-logs" class="page"><header class="page-header"><div><div class="page-title">运行日志</div><div class="page-sub">读取本地 data/hub.log，便于排查切换和适配器状态。</div></div><div class="actions"><button id="refreshLogs" class="btn btn-secondary">刷新日志</button></div></header><div class="page-body"><div id="logs" class="logbox">读取中...</div></div></section>
      <section id="page-settings" class="page"><header class="page-header"><div><div class="page-title">设置</div><div class="page-sub">高级网关参数、路由规则、模型映射和本地搜索。</div></div><div class="actions"><button id="saveGatewaySettings" class="btn btn-primary">保存高级参数</button></div></header><div class="page-body"><div class="grid split"><div class="grid">
        <div class="card"><h3 style="margin:0 0 12px">基础参数</h3><form id="gatewayForm" class="form"><label>监听地址<input class="input" name="listenHost" placeholder="127.0.0.1"></label><label>监听端口<input class="input" name="listenPort" type="number"></label><label>UI 端口<input class="input" name="uiPort" type="number"></label><label>上游 BaseURL<input class="input" name="upstreamBaseUrl" placeholder="https://api.deepseek.com"></label><label class="full">TLS 证书路径（可选）<input class="input" name="tlsCertPath" placeholder="路径或留空"></label><label>连接超时 (ms)<input class="input" name="connectTimeoutMs" type="number"></label><label>读取超时 (ms)<input class="input" name="readTimeoutMs" type="number"></label><label>最大重试次数<input class="input" name="maxRetries" type="number" min="0" max="10"></label><label>重试退避策略<select name="retryBackoff"><option value="exponential">指数退避</option><option value="fixed">固定间隔</option><option value="linear">线性增长</option></select></label><label>Key 调度策略<select name="keyStrategy"><option value="round-robin">轮询 Round Robin</option><option value="least-load">最低负载优先</option><option value="primary-first">固定首选</option></select></label><label>日志级别<select name="logLevel"><option>INFO</option><option>DEBUG</option><option>WARN</option><option>ERROR</option></select></label><label class="full">日志文件路径<input class="input" name="logFilePath"></label><label>每分钟最大请求数<input class="input" name="maxRequestsPerMinute" type="number"></label><label>并发连接上限<input class="input" name="maxConcurrentConnections" type="number"></label><label class="full" style="display:flex;align-items:center;gap:8px;grid-template-columns:auto 1fr"><input name="logRequestBody" type="checkbox" style="width:auto">记录请求体（含敏感信息，仅调试时开启）</label></form></div>
        <div class="card"><h3 style="margin:0 0 12px">路由规则</h3><p style="margin:0 0 10px;color:#6b7280;font-size:12px">对应原型里的 Codex 入站路径、转换方式、出站路径。</p><div id="routeRows" class="grid"></div><button id="addRouteRow" class="btn btn-secondary" style="margin-top:10px">添加路由规则</button></div>
        <div class="card"><h3 style="margin:0 0 12px">模型映射</h3><p style="margin:0 0 10px;color:#6b7280;font-size:12px">请求体中的 model 字段会由 Hub 按当前厂商模型重写；这里保留映射参数用于可视化和后续扩展。</p><div id="modelRows" class="grid"></div><button id="addModelRow" class="btn btn-secondary" style="margin-top:10px">添加模型映射</button></div>
      </div><div class="grid"><div class="card"><h3 style="margin:0 0 12px">本地搜索</h3><p style="margin:0 0 12px;color:#6b7280">当提示需要实时信息时，Hub 可本地搜索并注入结果。</p><button id="toggleSearch" class="btn btn-secondary">切换本地搜索</button></div><div class="card"><h3 style="margin:0 0 12px">参数说明</h3><div class="notice">监听地址/端口当前由环境变量和启动常量决定，保存后会进入配置文件；需要下一步接线后才会驱动真实监听端口。超时、限流、Key 调度、路由规则已先作为可配置参数落盘。</div></div><div class="card"><h3 style="margin:0 0 12px">危险操作</h3><p style="margin:0 0 12px;color:#6b7280">恢复官方 OpenAI 配置会让 Codex 离开 Hub。</p><button id="uninstall" class="btn btn-danger">恢复官方配置</button></div></div></div></div></section>
    </main>
  </div>
</div><div id="toast" class="toast"></div>
<script>
const AUTH_TOKEN = ${JSON.stringify(localAuthToken())};
const $ = (id) => document.getElementById(id);
let lastStatus = null;
function toast(text){ const el=$('toast'); el.textContent=text; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3500); $('messagePanel') && ($('messagePanel').textContent=text); }
async function api(path, opts={}){ const headers={authorization:'Bearer '+AUTH_TOKEN,...(opts.headers||{})}; const res=await fetch(path,{cache:'no-store',...opts,headers}); const data=await res.json(); if(!res.ok||data.ok===false) throw new Error(data.message||data.error?.message||'request failed'); return data; }
function nav(page){ document.querySelectorAll('.page').forEach(p=>p.classList.remove('active')); document.querySelectorAll('.nav button[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page)); $('page-'+page).classList.add('active'); if(page==='logs') loadLogs(); }
document.querySelectorAll('.nav button[data-page]').forEach(b=>b.onclick=()=>nav(b.dataset.page));
function providerCard(p, compact=false){ const el=document.createElement('div'); el.className='provider'+(p.id===lastStatus.activeProvider?' active':''); const keyBadge=p.hasKey?'<span class="badge badge-ok">key</span>':'<span class="badge badge-warn">missing key</span>'; const active=p.id===lastStatus.activeProvider; el.innerHTML='<h3></h3><div class="type"><span class="badge badge-muted"></span><span class="code"></span>'+keyBadge+'</div><div class="type url"></div><div class="row"></div>'; el.querySelector('h3').textContent=p.displayName||p.id; el.querySelector('.badge-muted').textContent=p.type||'provider'; el.querySelector('.code').textContent=p.model||p.id; el.querySelector('.url').textContent=p.baseUrl||''; const sw=document.createElement('button'); sw.className=active?'btn btn-success':'btn btn-primary'; sw.textContent=active?'当前使用':'切换到此厂商'; sw.disabled=active; sw.onclick=async()=>{ try{ sw.disabled=true; sw.textContent='切换中...'; const r=await api('/api/switch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:p.id})}); toast(r.message); await refresh(); }catch(e){ toast(e.message); await refresh(); } }; el.querySelector('.row').append(sw); if(!compact){ const edit=document.createElement('button'); edit.className='btn btn-secondary'; edit.textContent='编辑'; edit.onclick=()=>fillProviderForm(p); el.querySelector('.row').append(edit); } return el; }
async function refresh(){ lastStatus=await api('/api/status'); $('sideApi').textContent=lastStatus.apiUrl; $('apiUrl').textContent=lastStatus.apiUrl; $('dataDir').textContent=lastStatus.dataDir; $('adapterState').textContent=lastStatus.adapterRunning?'运行中':'按需启动'; $('activeTitle').textContent=lastStatus.activeProviderDisplayName||lastStatus.activeProvider; $('activeSub').textContent='当前 ID：'+lastStatus.activeProvider+' · 下一次 Codex 请求生效'; updateUsageStats(lastStatus.usageStats||{}); const missing=lastStatus.providers.filter(p=>!p.hasKey).length; $('keyState').textContent=missing===0?'完整':missing+' 缺失'; $('sideStatus').className='status-pill '+(lastStatus.codexInstalled?'ok':'warn'); $('sideStatus').lastElementChild.textContent=lastStatus.codexInstalled?'Hub 运行中':'待同步'; $('providers').innerHTML=''; $('quickProviders').innerHTML=''; lastStatus.providers.forEach(p=>{ $('providers').append(providerCard(p)); $('quickProviders').append(providerCard(p,true)); }); fillGatewaySettings(lastStatus.gateway||{}); }
function fillProviderForm(p){ const f=$('providerForm'); enhanceSelects(f); f.elements.id.value=p.id||''; f.elements.displayName.value=p.displayName||p.id||''; f.elements.type.value=p.type||'openai-chat'; f.elements.model.value=p.model||''; f.elements.baseUrl.value=p.baseUrl||''; f.elements.apiKey.value=''; f.querySelectorAll('select').forEach(syncCustomSelect); $('providerFormTitle').textContent='编辑已保存厂商'; $('saveProvider').textContent='保存修改'; nav('providers'); toast((p.displayName||p.id)+' 已载入表单，API Key 留空会沿用已保存密钥。'); }
function resetProviderForm(){ const f=$('providerForm'); f.reset(); f.querySelectorAll('select').forEach(syncCustomSelect); $('providerFormTitle').textContent='添加自定义厂商'; $('saveProvider').textContent='保存厂商'; }
async function loadLogs(){ try{ const r=await api('/api/logs?limit=160'); $('logs').innerHTML=(r.lines.length?r.lines:['暂无日志']).map(line=>'<div></div>').join(''); [...$('logs').children].forEach((el,i)=>el.textContent=r.lines[i]||'暂无日志'); }catch(e){ $('logs').textContent=e.message; } }
function closeCustomSelects(except){ document.querySelectorAll('.custom-select.open').forEach(el=>{ if(el!==except) el.classList.remove('open'); }); }
function syncCustomSelect(select){ const wrap=select._customSelect; if(!wrap) return; const selected=select.options[select.selectedIndex]; wrap.querySelector('.custom-select-value').textContent=selected?.textContent||''; wrap.querySelectorAll('.custom-select-option').forEach((option)=>option.classList.toggle('selected', option.dataset.value===select.value)); }
function enhanceSelect(select){ if(select._customSelect) { syncCustomSelect(select); return; } select.classList.add('native-select'); const wrap=document.createElement('div'); wrap.className='custom-select'; const trigger=document.createElement('button'); trigger.type='button'; trigger.className='custom-select-trigger'; trigger.innerHTML='<span class="custom-select-value"></span>'; const menu=document.createElement('div'); menu.className='custom-select-menu'; [...select.options].forEach((item)=>{ const option=document.createElement('div'); option.className='custom-select-option'; option.dataset.value=item.value; option.textContent=item.textContent; option.onclick=()=>{ select.value=item.value; select.dispatchEvent(new Event('change',{bubbles:true})); syncCustomSelect(select); wrap.classList.remove('open'); }; menu.append(option); }); trigger.onclick=(event)=>{ event.stopPropagation(); closeCustomSelects(wrap); wrap.classList.toggle('open'); }; wrap.append(trigger,menu); select.after(wrap); select._customSelect=wrap; syncCustomSelect(select); }
function enhanceSelects(root=document){ root.querySelectorAll('select').forEach(enhanceSelect); }
document.addEventListener('click',()=>closeCustomSelects());
function routeRow(route={}){ const el=document.createElement('div'); el.className='form'; el.innerHTML='<label>入站路径<input class="input" name="inbound" placeholder="POST /v1/responses"></label><label>转换方式<select name="mode"><option value="protocol-convert">协议转换</option><option value="passthrough">透传</option><option value="virtual-response">虚拟响应</option></select></label><label class="full">出站路径<input class="input" name="outbound" placeholder="POST /v1/responses"></label><label style="display:flex;align-items:center;gap:8px;grid-template-columns:auto 1fr"><input name="enabled" type="checkbox" style="width:auto">启用</label><button type="button" class="btn btn-danger">删除</button>'; el.elements=Object.fromEntries([...el.querySelectorAll('[name]')].map(x=>[x.name,x])); el.elements.inbound.value=route.inbound||''; el.elements.mode.value=route.mode||'protocol-convert'; el.elements.outbound.value=route.outbound||''; el.elements.enabled.checked=route.enabled!==false; el.querySelector('button').onclick=()=>el.remove(); enhanceSelects(el); return el; }
function modelRow(mapping={}){ const el=document.createElement('div'); el.className='form'; el.innerHTML='<label>Codex 模型名称<input class="input" name="input" placeholder="current"></label><label>输出模型名称<input class="input" name="output" placeholder="provider.model"></label><label style="display:flex;align-items:center;gap:8px;grid-template-columns:auto 1fr"><input name="enabled" type="checkbox" style="width:auto">启用</label><button type="button" class="btn btn-danger">删除</button>'; el.elements=Object.fromEntries([...el.querySelectorAll('[name]')].map(x=>[x.name,x])); el.elements.input.value=mapping.input||''; el.elements.output.value=mapping.output||''; el.elements.enabled.checked=mapping.enabled!==false; el.querySelector('button').onclick=()=>el.remove(); return el; }
function fillGatewaySettings(g={}){ const f=$('gatewayForm'); if(!f) return; enhanceSelects(f); for(const [k,v] of Object.entries(g)){ if(!f.elements[k]) continue; if(f.elements[k].type==='checkbox') f.elements[k].checked=!!v; else f.elements[k].value=v; } f.querySelectorAll('select').forEach(syncCustomSelect); $('routeRows').innerHTML=''; (g.routes||[]).forEach(r=>$('routeRows').append(routeRow(r))); $('modelRows').innerHTML=''; (g.modelMappings||[]).forEach(m=>$('modelRows').append(modelRow(m))); }
function collectGatewaySettings(){ const f=$('gatewayForm'); const data=Object.fromEntries(new FormData(f).entries()); ['listenPort','uiPort','connectTimeoutMs','readTimeoutMs','maxRetries','maxRequestsPerMinute','maxConcurrentConnections'].forEach(k=>data[k]=Number(data[k])); data.logRequestBody=!!f.elements.logRequestBody.checked; data.routes=[...$('routeRows').children].map(row=>({inbound:row.elements.inbound.value,mode:row.elements.mode.value,outbound:row.elements.outbound.value,enabled:row.elements.enabled.checked})); data.modelMappings=[...$('modelRows').children].map(row=>({input:row.elements.input.value,output:row.elements.output.value,enabled:row.elements.enabled.checked})); return data; }
function fmt(n){ n=Number(n)||0; if(n>=1000000) return (n/1000000).toFixed(1)+'M'; if(n>=1000) return (n/1000).toFixed(1)+'K'; return String(n); }
function lastNDates(n){ const dates=[]; const now=new Date(); for(let i=n-1;i>=0;i--){ const d=new Date(now); d.setDate(now.getDate()-i); dates.push(d.toISOString().slice(0,10)); } return dates; }
function renderTokenChart(byDate={}){ const chart=$('tokenChart'); const dates=lastNDates(14); const rows=dates.map(date=>({date,...(byDate[date]||{})})); chart.innerHTML=''; if(!Object.keys(byDate||{}).length){ chart.innerHTML='<div class="notice" style="align-self:center;width:100%">暂无按日期统计的 token 数据，发起请求后会显示每日趋势。</div>'; return; } const max=Math.max(1,...rows.map(r=>r.totalTokens||0)); rows.forEach((row)=>{ const day=document.createElement('div'); day.className='chart-day'; const stack=document.createElement('div'); stack.className='bar-stack'; const input=document.createElement('div'); input.className='bar'; input.style.height=Math.max(row.inputTokens?4:0,((row.inputTokens||0)/max)*100)+'%'; input.dataset.label=row.date+' 输入 '+fmt(row.inputTokens)+' tokens'; const output=document.createElement('div'); output.className='bar output'; output.style.height=Math.max(row.outputTokens?4:0,((row.outputTokens||0)/max)*100)+'%'; output.dataset.label=row.date+' 输出 '+fmt(row.outputTokens)+' tokens'+(row.estimatedRequests?' · 估算 '+row.estimatedRequests+' 次':''); const label=document.createElement('div'); label.className='chart-label'; label.textContent=row.date.slice(5); stack.append(input,output); day.append(stack,label); chart.append(day); }); }

function updateUsageStats(stats={}){ const requests=stats.totalRequests||0; const errors=stats.totalErrors||0; $('requestCount').textContent=fmt(requests); $('errorRate').textContent='错误率 '+(requests?((errors/requests)*100).toFixed(1):'0.0')+'%'; $('tokenTotal').textContent=fmt(stats.totalTokens); $('tokenSplit').textContent='输入 '+fmt(stats.totalInputTokens)+' / 输出 '+fmt(stats.totalOutputTokens)+(stats.estimatedRequests?' · 含估算 '+stats.estimatedRequests+' 次':''); const byModel=stats.byModel||{}; const activeModel=lastStatus?.providers?.find?.(p=>p.id===lastStatus.activeProvider)?.model || lastStatus?.activeProvider; const active=byModel[activeModel]||{}; $('activeModelTokens').textContent=fmt(active.totalTokens); $('activeModelName').textContent=activeModel||'-'; renderTokenChart(stats.byDate||{}); const rows=Object.entries(byModel).sort((a,b)=>(b[1].totalTokens||0)-(a[1].totalTokens||0)).slice(0,8); const max=Math.max(1,...rows.map(([,item])=>item.totalTokens||0)); $('modelUsage').innerHTML=rows.length?'':'<div class="notice">暂无模型消耗数据，发起请求后会自动统计。</div>'; rows.forEach(([model,item])=>{ const el=document.createElement('div'); el.className='hbar-row'; el.innerHTML='<span class="code"></span><div class="hbar-track"><div class="hbar-fill"></div></div><strong></strong><div style="grid-column:1/-1;font-size:12px;color:#6b7280"></div>'; el.querySelector('.code').textContent=model; el.querySelector('.hbar-fill').style.width=Math.max(2,((item.totalTokens||0)/max)*100)+'%'; el.querySelector('strong').textContent=fmt(item.totalTokens||0); el.lastElementChild.textContent=(item.requests||0)+' 请求 · 输入 '+fmt(item.inputTokens||0)+' / 输出 '+fmt(item.outputTokens||0)+(item.estimatedRequests?' · 估算 '+item.estimatedRequests+' 次':''); $('modelUsage').append(el); }); }

$('refreshAll').onclick=()=>refresh().then(()=>toast('状态已刷新')).catch(e=>toast(e.message));
$('openApi').onclick=()=>navigator.clipboard?.writeText(lastStatus?.apiUrl||'').then(()=>toast('API 地址已复制'));
$('syncCodex').onclick=async()=>{ try{ const r=await api('/api/install-codex',{method:'POST'}); toast(r.message); await refresh(); }catch(e){ toast(e.message); } };
$('testActive').onclick=async()=>{ try{ toast('正在测试当前厂商...'); const r=await api('/api/test-active',{method:'POST'}); toast('测试通过 HTTP '+r.status+' · '+r.latencyMs+'ms · '+r.sample); await refresh(); }catch(e){ toast(e.message); } };
$('addRouteRow').onclick=()=>$('routeRows').append(routeRow({enabled:true}));
$('addModelRow').onclick=()=>$('modelRows').append(modelRow({enabled:true}));
$('saveGatewaySettings').onclick=async()=>{ try{ const r=await api('/api/gateway-settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(collectGatewaySettings())}); toast(r.message); fillGatewaySettings(r.gateway); await refresh(); }catch(e){ toast(e.message); } };
$('toggleSearch').onclick=async()=>{ try{ const enabled=!lastStatus.localSearch?.enabled; await api('/api/local-search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled,onlyWhenLikelyNeeded:true})}); toast('本地搜索已'+(enabled?'开启':'关闭')); await refresh(); }catch(e){ toast(e.message); } };
$('uninstall').onclick=async()=>{ if(!confirm('确定恢复官方 OpenAI 配置吗？当前配置会备份到 data/ 目录。')) return; try{ const r=await api('/api/uninstall-codex',{method:'POST'}); toast(r.message+' 备份：'+r.backupPath); await refresh(); }catch(e){ toast(e.message); } };
$('providerForm').onsubmit=async(e)=>{ e.preventDefault(); try{ const data=Object.fromEntries(new FormData(e.currentTarget).entries()); const r=await api('/api/providers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}); toast('已保存：'+(r.provider.displayName||r.provider.id)); resetProviderForm(); await refresh(); }catch(err){ toast(err.message); } };
$('clearProviderForm').onclick=resetProviderForm; $('refreshLogs').onclick=loadLogs;
enhanceSelects(); refresh().then(loadLogs).catch(e=>toast(e.message)); setInterval(()=>refresh().catch(()=>{}),5000);
</script>
</body>
</html>`;
}

const apiServer = http.createServer(async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;
    const config = loadConfig();
    if (req.method === "GET" && req.url === "/v1/models") {
      sendJson(res, 200, modelsResponse(config));
      return;
    }
    if (req.url.startsWith("/v1/responses")) {
      await handleResponses(req, res);
      return;
    }
    sendJson(res, 404, { error: { type: "not_found", message: "Provider Hub API endpoint not found" } });
  } catch (error) {
    appendLog("api error", { message: error.message });
    sendJson(res, 500, { error: { type: "provider_hub_error", message: error.message } });
  }
});

const uiServer = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, securityHeaders({
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
      }));
      res.end(html());
      return;
    }
    if (req.url.startsWith("/api/")) {
      if (!requireUiApiAccess(req, res)) return;
      await handleApi(req, res);
      return;
    }
    sendJson(res, 404, { ok: false, message: "Not found" });
  } catch (error) {
    appendLog("ui error", { message: error.message });
    sendJson(res, 500, { ok: false, message: error.message });
  }
});

process.on("SIGINT", () => { stopAdapter(); removeHubPid(); process.exit(0); });
process.on("SIGTERM", () => { stopAdapter(); removeHubPid(); process.exit(0); });

loadConfig();
ensureCodexConfigInstalled();
writeHubPid();
apiServer.listen(API_PORT, API_HOST, () => {
  console.log(`Codex Provider Hub API: http://${API_HOST}:${API_PORT}/v1`);
});
uiServer.listen(UI_PORT, API_HOST, () => {
  console.log(`Codex Provider Hub UI:  http://${API_HOST}:${UI_PORT}`);
});
