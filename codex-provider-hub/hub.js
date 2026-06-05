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

function loadConfig() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(CONFIG_PATH)) writeJson(CONFIG_PATH, defaultConfig());
  migrateOldKeys();
  const config = readJson(CONFIG_PATH, defaultConfig());
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

function proxyHttp(url, req, res, body, headers = {}) {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error(`Unsupported upstream protocol: ${target.protocol}`);
  }
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
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", (error) => sendJson(res, 502, { error: { type: "provider_hub_error", message: error.message } }));
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
    });
    return;
  }

  await ensureAdapter(provider);
  proxyHttp(`http://${API_HOST}:${ADAPTER_PORT}/v1/responses`, req, res, JSON.stringify(payload), {
    authorization: `Bearer ${adapter.authToken}`
  });
}

function installCodexConfig() {
  ensureDir(CODEX_DIR);
  const existing = fs.existsSync(CODEX_CONFIG_PATH) ? readText(CODEX_CONFIG_PATH) : "";
  const providerBlock = `[model_providers.provider-hub]
name = "Codex Provider Hub"
base_url = "http://127.0.0.1:${API_PORT}/v1"
wire_api = "responses"
requires_openai_auth = true
request_max_retries = 1`;
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
    adapterPort: ADAPTER_PORT
  };
}

async function readJsonBody(req) {
  return JSON.parse(await readRequestBody(req) || "{}");
}

async function handleApi(req, res) {
  if (req.method === "GET" && req.url === "/api/status") {
    sendJson(res, 200, await statusPayload());
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
  <title>Codex Provider Hub</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --panel:#fff; --ink:#1f2937; --muted:#667085; --line:#d7dce3; --brand:#0f766e; --dark:#334155; --warn:#b45309; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); }
    main { width:min(1120px, calc(100% - 28px)); margin:0 auto; padding:26px 0 36px; }
    header { display:flex; justify-content:space-between; gap:18px; align-items:flex-end; border-bottom:1px solid var(--line); padding-bottom:18px; }
    h1 { margin:0 0 5px; font-size:30px; line-height:1.15; letter-spacing:0; }
    p { margin:0; }
    .sub { color:var(--muted); font-size:14px; }
    .pill { border:1px solid #9dd8cd; color:var(--brand); background:#e7f6f2; padding:7px 13px; border-radius:999px; font-weight:700; white-space:nowrap; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:18px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; box-shadow:0 8px 20px rgba(31,41,55,.05); }
    .wide { grid-column:1 / -1; }
    h2 { margin:0 0 12px; font-size:17px; letter-spacing:0; }
    dl { display:grid; grid-template-columns:140px 1fr; gap:9px 12px; margin:0; font-size:14px; }
    dt { color:var(--muted); }
    dd { margin:0; font-weight:650; word-break:break-word; }
    .providers { display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:10px; }
    .provider { border:1px solid var(--line); border-radius:8px; padding:12px; background:#fbfcfd; }
    .provider.active { border-color:#8bd4c7; background:#ecf8f5; }
    .provider h3 { margin:0 0 7px; font-size:15px; letter-spacing:0; }
    .meta { color:var(--muted); font-size:12px; line-height:1.5; }
    button { border:0; border-radius:8px; min-height:38px; padding:0 13px; font-weight:750; cursor:pointer; color:#fff; background:var(--brand); }
    button.secondary { background:var(--dark); }
    button.light { color:var(--ink); background:#fff; border:1px solid var(--line); }
    button:disabled { opacity:.65; cursor:wait; }
    .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px; }
    form { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    label { display:grid; gap:5px; font-size:13px; color:var(--muted); }
    input, select { min-height:38px; border:1px solid var(--line); border-radius:8px; padding:0 10px; font:inherit; background:#fff; color:var(--ink); }
    .full { grid-column:1 / -1; }
    pre { margin:12px 0 0; padding:12px; max-height:180px; overflow:auto; border-radius:8px; background:#111827; color:#f9fafb; font-size:12px; line-height:1.5; }
    .notice { margin-top:10px; border:1px solid #f0cf9d; color:var(--warn); background:#fff7e8; padding:10px 12px; border-radius:8px; font-size:13px; line-height:1.45; }
    @media (max-width:760px) { header { align-items:flex-start; flex-direction:column; } .grid, form { grid-template-columns:1fr; } .wide { grid-column:auto; } dl { grid-template-columns:110px 1fr; } }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Codex Provider Hub</h1>
      <p class="sub">一个本地入口管理多个厂商。Codex 固定连 Hub，切换厂商不再反复改配置。</p>
    </div>
    <div id="pill" class="pill">读取中</div>
  </header>
  <section class="grid">
    <div class="panel">
      <h2>Hub 状态</h2>
      <dl>
        <dt>API</dt><dd id="apiUrl">-</dd>
        <dt>数据目录</dt><dd id="dataDir">-</dd>
        <dt>Codex 配置</dt><dd id="installed">-</dd>
        <dt>Adapter</dt><dd id="adapter">-</dd>
      </dl>
      <div class="row"><button id="install">重新同步 Codex 配置</button><button class="secondary" id="testActive">测试当前厂商</button><button class="light" id="refresh">刷新</button></div>
      <div class="row"><button class="light" id="uninstall" style="color:#b45309;border-color:#f0cf9d;">恢复官方配置</button></div>
      <div class="notice">启动 Hub 后会自动同步 Codex 到固定本地入口。之后只需在这里点厂商卡片，下一次 Codex 请求立即使用新厂商。</div>
    </div>
    <div class="panel">
      <h2>联网搜索</h2>
      <dl>
        <dt>状态</dt><dd id="searchStatus">-</dd>
        <dt>触发策略</dt><dd id="searchMode">-</dd>
      </dl>
      <div class="row"><button class="secondary" id="toggleSearch">切换搜索</button></div>
    </div>
    <div class="panel wide">
      <h2>厂商</h2>
      <div class="providers" id="providers"></div>
    </div>
    <div class="panel wide">
      <h2 id="providerFormTitle">添加自定义 OpenAI 兼容厂商</h2>
      <form id="providerForm">
        <label>ID<input name="id" placeholder="qwen"></label>
        <label>显示名<input name="displayName" placeholder="Qwen"></label>
        <label>类型<select name="type"><option value="openai-chat">OpenAI Chat Completions</option><option value="responses">Responses API</option></select></label>
        <label>模型<input name="model" placeholder="qwen3-coder-plus"></label>
        <label class="full">Base URL<input name="baseUrl" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"></label>
        <label class="full">API Key<input name="apiKey" type="password" placeholder="留空则沿用已保存密钥"></label>
        <div class="row full"><button id="saveProvider">保存厂商</button><button type="button" class="light" id="clearProviderForm">新增厂商</button></div>
      </form>
      <pre id="log" hidden></pre>
    </div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const AUTH_TOKEN = ${JSON.stringify(localAuthToken())};
let lastStatus = null;
function log(text) { $("log").hidden = false; $("log").textContent = text; }
async function api(path, opts = {}) {
  const headers = { authorization:"Bearer " + AUTH_TOKEN, ...(opts.headers || {}) };
  const res = await fetch(path, { cache:"no-store", ...opts, headers });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || data.error?.message || "request failed");
  return data;
}
async function refresh() {
  lastStatus = await api("/api/status");
  $("pill").textContent = "当前：" + (lastStatus.activeProviderDisplayName || lastStatus.activeProvider);
  $("apiUrl").textContent = lastStatus.apiUrl;
  $("dataDir").textContent = lastStatus.dataDir;
  $("installed").textContent = lastStatus.codexInstalled ? "已安装" : "未安装";
  $("adapter").textContent = lastStatus.adapterRunning ? "运行中" : "按需启动";
  $("searchStatus").textContent = lastStatus.localSearch?.enabled ? "开启" : "关闭";
  $("searchMode").textContent = lastStatus.localSearch?.onlyWhenLikelyNeeded ? "只在实时问题触发" : "每次 web_search 都触发";
  $("providers").innerHTML = "";
  for (const p of lastStatus.providers) {
    const el = document.createElement("div");
    el.className = "provider" + (p.id === lastStatus.activeProvider ? " active" : "");
    el.innerHTML = '<h3></h3><div class="meta"></div><div class="row"></div>';
    el.querySelector("h3").textContent = p.displayName || p.id;
    el.querySelector(".meta").textContent = [p.type, p.model, p.baseUrl, p.hasKey ? "key: yes" : "key: missing"].filter(Boolean).join(" · ");
    const btn = document.createElement("button");
    btn.textContent = p.id === lastStatus.activeProvider ? "当前使用" : "切换到此厂商";
    btn.disabled = p.id === lastStatus.activeProvider;
    btn.onclick = async () => { await api("/api/switch", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ id:p.id }) }); await refresh(); };
    el.querySelector(".row").append(btn);
    const editBtn = document.createElement("button");
    editBtn.className = "light";
    editBtn.textContent = "编辑";
    editBtn.onclick = () => fillProviderForm(p);
    el.querySelector(".row").append(editBtn);
    $("providers").append(el);
  }
}
function fillProviderForm(provider) {
  const form = $("providerForm");
  form.elements.id.value = provider.id || "";
  form.elements.displayName.value = provider.displayName || provider.id || "";
  form.elements.type.value = provider.type || "openai-chat";
  form.elements.model.value = provider.model || "";
  form.elements.baseUrl.value = provider.baseUrl || "";
  form.elements.apiKey.value = "";
  $("providerFormTitle").textContent = "编辑已保存厂商";
  $("saveProvider").textContent = "保存修改";
  log((provider.displayName || provider.id) + " 已载入表单。API Key 留空会继续使用本机已保存密钥。");
  form.scrollIntoView({ behavior:"smooth", block:"start" });
}
function resetProviderForm() {
  const form = $("providerForm");
  form.reset();
  $("providerFormTitle").textContent = "添加自定义 OpenAI 兼容厂商";
  $("saveProvider").textContent = "保存厂商";
}
$("refresh").onclick = refresh;
$("install").onclick = async () => { const r = await api("/api/install-codex", { method:"POST" }); log(r.message); await refresh(); };
$("uninstall").onclick = async () => {
  if (!confirm("确定要恢复官方 OpenAI 配置吗？\\n\\n当前配置会备份到 data/ 目录，之后可以手动恢复。")) return;
  const r = await api("/api/uninstall-codex", { method:"POST" }); log(r.message + "\\n备份: " + r.backupPath); await refresh();
};
$("testActive").onclick = async () => {
  log("正在测试当前厂商...");
  const r = await api("/api/test-active", { method:"POST" });
  log("测试通过: HTTP " + r.status + " · " + r.latencyMs + "ms · " + r.sample);
  await refresh();
};
$("toggleSearch").onclick = async () => {
  const enabled = !lastStatus.localSearch?.enabled;
  await api("/api/local-search", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ enabled, onlyWhenLikelyNeeded:true }) });
  await refresh();
};
$("providerForm").onsubmit = async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  const r = await api("/api/providers", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify(data) });
  log("已保存：" + (r.provider.displayName || r.provider.id));
  resetProviderForm();
  await refresh();
};
$("clearProviderForm").onclick = resetProviderForm;
refresh().catch((error) => log(error.message));
setInterval(() => refresh().catch(() => {}), 5000);
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
