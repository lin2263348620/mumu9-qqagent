"use strict";

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const websiteRoot = path.join(root, "website");
const dataRoot = path.join(root, "data");
const host = process.env.HOST || "0.0.0.0";
const port = parsePort(
  process.env.PORT || process.env.SERVER_PORT || process.env.HTTP_PORT || "8080",
  "PORT",
);
const agentPort = parsePort(process.env.QQ_AGENT_PORT || "3210", "QQ_AGENT_PORT");
const agentHost = "127.0.0.1";
const cookieName = "qq_admin_session";
const sessionLifetimeSeconds = 12 * 60 * 60;
const loginAttempts = new Map();

fs.mkdirSync(dataRoot, { recursive: true });
const suppliedPassword = String(process.env.ADMIN_PASSWORD || '').trim();
if (suppliedPassword && suppliedPassword.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters.');
const adminPassword = suppliedPassword || readOrCreateSecret(
  path.join(dataRoot, 'admin-password.txt'), () => crypto.randomBytes(16).toString('hex'),
);
let sessionSecret = readOrCreateSecret(
  path.join(dataRoot, "admin-session-secret.txt"),
  () => crypto.randomBytes(32).toString("hex"),
);

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function parsePort(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return parsed;
}

function readOrCreateSecret(filePath, createValue) {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    if (value) return value;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const value = createValue();
  fs.writeFileSync(filePath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  return value;
}

function timingSafeEqualText(left, right) {
  const leftHash = crypto.createHash("sha256").update(String(left)).digest();
  const rightHash = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function createSessionToken() {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionLifetimeSeconds;
  const payload = String(expiresAt);
  const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function hasValidSession(request) {
  const token = parseCookies(request.headers.cookie)[cookieName] || "";
  const [expiresAtText, signature = ""] = token.split(".");
  if (!/^\d+$/.test(expiresAtText || "")) return false;
  if (Number(expiresAtText) < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac("sha256", sessionSecret).update(expiresAtText).digest("base64url");
  return timingSafeEqualText(signature, expected);
}

function send(response, statusCode, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  response.writeHead(statusCode, {
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(payload);
}

function redirect(response, location) {
  send(response, 303, "Redirecting", { Location: location, "Content-Type": "text/plain; charset=utf-8" });
}

function loginPage(message = "") {
  const safeMessage = String(message)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QQ Agent 管理登录</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6f8;color:#18202a;font:16px/1.5 system-ui,sans-serif}.login{width:min(92vw,380px);padding:28px;background:#fff;border:1px solid #dce1e7;border-radius:8px;box-shadow:0 12px 30px #18202a14}h1{font-size:22px;margin:0 0 8px}p{color:#5c6673;margin:0 0 20px}.error{color:#b42318;margin-bottom:12px}label{display:block;font-weight:600;margin-bottom:6px}input{width:100%;height:44px;padding:0 12px;border:1px solid #aeb7c2;border-radius:6px;font:inherit}button{width:100%;height:44px;margin-top:14px;border:0;border-radius:6px;background:#1769e0;color:#fff;font:inherit;font-weight:700;cursor:pointer}
</style><link rel="stylesheet" href="/qqbot-public/effects.css?v=19"></head><body class="login-page"><form class="login" method="post" action="/qqbot/login"><h1>bot管理控制台</h1><p>请输入管理密码。</p>${safeMessage ? `<div class="error">${safeMessage}</div>` : ""}<label for="password">管理密码</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">登录</button></form><script defer src="/qqbot-public/effects.js?v=19"></script></body></html>`;
}

async function readForm(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 8192) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function clientKey(request) {
  return request.socket.remoteAddress || "unknown";
}

function isLoginBlocked(request) {
  const key = clientKey(request);
  const state = loginAttempts.get(key);
  if (!state) return false;
  if (state.blockedUntil > Date.now()) return true;
  if (Date.now() - state.startedAt > 15 * 60 * 1000) loginAttempts.delete(key);
  return false;
}

function recordLoginFailure(request) {
  const key = clientKey(request);
  const now = Date.now();
  const previous = loginAttempts.get(key);
  const state = !previous || now - previous.startedAt > 15 * 60 * 1000
    ? { count: 0, startedAt: now, blockedUntil: 0 }
    : previous;
  state.count += 1;
  if (state.count >= 5) state.blockedUntil = now + 15 * 60 * 1000;
  loginAttempts.set(key, state);
}

function proxyToAgent(request, response, url) {
  const proxyPath = url.pathname.slice("/qqbot".length) || "/";
  const headers = { ...request.headers, host: `${agentHost}:${agentPort}` };
  delete headers.cookie;

  const upstream = http.request({
    hostname: agentHost,
    port: agentPort,
    method: request.method,
    path: proxyPath + url.search,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders["set-cookie"];
    if (proxyPath === "/api/snowluma/logout-all" && request.method === "POST" && upstreamResponse.statusCode === 200) {
      // Invalidate all browser sessions, including cookies copied before logout.
      const nextSecret = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(path.join(dataRoot, "admin-session-secret.txt"), nextSecret, { mode: 0o600 });
      sessionSecret = nextSecret;
      responseHeaders["set-cookie"] = `${cookieName}=; HttpOnly; SameSite=Strict; Path=/qqbot; Max-Age=0`;
    }
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(response);
  });

  upstream.on("error", () => {
    if (!response.headersSent) {
      send(response, 502, "QQ Agent is starting or unavailable.", { "Content-Type": "text/plain; charset=utf-8" });
    } else {
      response.destroy();
    }
  });
  request.pipe(upstream);
}

function resolveWebsitePath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  const relativePath = pathname.replace(/^\/+/, "") || "index.html";
  const filePath = path.resolve(websiteRoot, relativePath);
  const rootPrefix = `${websiteRoot}${path.sep}`;
  return filePath === websiteRoot || filePath.startsWith(rootPrefix) ? filePath : null;
}

function serveWebsite(request, response) {
  let filePath;
  try {
    filePath = resolveWebsitePath(request.url || "/");
  } catch {
    send(response, 400, "Bad request", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  if (!filePath) {
    send(response, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (!error && stats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      try { stats = fs.statSync(filePath); } catch { error = new Error("Not found"); }
    }
    if (error || !stats?.isFile()) {
      send(response, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mimeTypes.get(extension) || "application/octet-stream",
      "Content-Length": stats.size,
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer(async (request, response) => {
  const method = request.method || "GET";
  if (!["GET", "HEAD", "POST", "DELETE", "PATCH"].includes(method)) {
    send(response, 405, "Method not allowed", { Allow: "GET, HEAD, POST, DELETE, PATCH", "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  let url;
  try { url = new URL(request.url || "/", "http://localhost"); }
  catch {
    send(response, 400, "Bad request", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  if (url.pathname === "/_health") {
    send(response, 200, JSON.stringify({ status: "ok", website: true, qqAgentPort: agentPort }), { "Content-Type": "application/json; charset=utf-8" });
    return;
  }

  if (['/qqbot-public/effects.js','/qqbot-public/effects.css'].includes(url.pathname) && ['GET','HEAD'].includes(method)) {
    const name=path.basename(url.pathname);
    try { send(response,200,fs.readFileSync(path.join(root,'qq-agent','ui',name)),{'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'}); }
    catch { send(response,404,'Not Found'); }
    return;
  }
  if (url.pathname === '/' && !fs.existsSync(path.join(websiteRoot,'index.html'))) {
    redirect(response,'/qqbot/');return;
  }

  if (url.pathname === "/qqbot") {
    redirect(response, "/qqbot/");
    return;
  }

  if (url.pathname === "/qqbot/login") {
    if (method === "GET" || method === "HEAD") {
      send(response, 200, loginPage(), { "Content-Type": "text/html; charset=utf-8" });
      return;
    }
    if (method !== "POST") {
      send(response, 405, "Method not allowed", { Allow: "GET, HEAD, POST", "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    if (isLoginBlocked(request)) {
      send(response, 429, loginPage("尝试次数过多，请 15 分钟后再试。"), { "Content-Type": "text/html; charset=utf-8" });
      return;
    }
    try {
      const form = await readForm(request);
      if (!timingSafeEqualText(form.get("password") || "", adminPassword)) {
        recordLoginFailure(request);
        send(response, 401, loginPage("密码错误。"), { "Content-Type": "text/html; charset=utf-8" });
        return;
      }
      loginAttempts.delete(clientKey(request));
      response.setHeader("Set-Cookie", `${cookieName}=${createSessionToken()}; HttpOnly; SameSite=Strict; Path=/qqbot; Max-Age=${sessionLifetimeSeconds}`);
      redirect(response, "/qqbot/");
    } catch {
      send(response, 400, loginPage("请求无效。"), { "Content-Type": "text/html; charset=utf-8" });
    }
    return;
  }

  if (url.pathname === "/qqbot/logout") {
    response.setHeader("Set-Cookie", `${cookieName}=; HttpOnly; SameSite=Strict; Path=/qqbot; Max-Age=0`);
    redirect(response, "/qqbot/login");
    return;
  }

  if (url.pathname.startsWith("/qqbot/")) {
    if (!hasValidSession(request)) {
      redirect(response, "/qqbot/login");
      return;
    }
    proxyToAgent(request, response, url);
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    send(response, 405, "Method not allowed", { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  serveWebsite(request, response);
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(port, host, () => {
  console.log(`bot admin: http://${host}:${port}/`);
  console.log(`QQ Agent admin: http://${host}:${port}/qqbot/`);
  console.log(suppliedPassword ? 'Admin password provided by ADMIN_PASSWORD.' : 'Generated admin password saved in data/admin-password.txt. Keep this file private.');
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down gateway.`);
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
