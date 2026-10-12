// 🔴 时区铁律（记忆系统 00 铁律 0.5 / 01 第六节）：
//   服务器系统时区是 UTC，但用户在**中国（UTC+8）** —— 所有面向用户的时间必须是北京时间。
//   TZ 必须在任何 new Date() 之前设置，且 ESM 的 import 会先于模块体执行，
//   所以这三行放在**所有 import 之上**。
process.env.TZ = process.env.TZ || 'Asia/Shanghai';
// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig, ROOT, DATA_DIR, resolvePersona } from './config.js';
import { routeMessage, normalizeBehavior } from './behavior-policy.js';
import { identifySolitaire, handleRepeatFollow, repeatText } from './solitaire-service.js';
import { receiptView, listMessageRecords } from './message-receipts.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments } from './onebot.js';
import { ChatStore } from './store.js';
import { MemoryStore } from './memory.js';
import { StickerManager } from './sticker-manager.js';
import { SendQueue } from './sender.js';
import { SessionRegistry } from './sessions.js';
import { Orchestrator } from './orchestrator.js';
import { listModels, estimateCost, chatCompletion, getFailoverStatus } from './llm.js';
import { importFromDsh, currentProviders, setProviderKey, testAllProviders, testOneProvider, testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider } from './providers.js';
import { scanModelsVision, visionResults } from './vision-scan.js';
import { qrInfo, readQrBuffer } from './napcat-qr.js';
import { NapCatWebui } from './napcat-webui.js';
import { QrRefreshGuard } from './qr-refresh-guard.js';
import { OneBotHealth } from './onebot-health.js';
import { ScheduledTaskRunner } from './scheduled-tasks.js';
import { createEventBus, todayKey } from './util.js';
import { shouldTriggerGroupMessage } from './group-response.js';
import { ReceiveMonitor } from './receive-monitor.js';
import { HistoryRecovery } from './history-recovery.js';
import { AutoLoginRecovery } from './auto-login-recovery.js';
import { isNapCatAlreadyLoggedError } from './login-state.js';
import { isToolEnabled, toolFeatureKey, toolFeatureSnapshot, TOOL_SWITCH_NAMES } from './tool-features.js';
import { capabilityPatch } from './capability-switches.js';
import { InteractionService, TOOL_HELP, parseCommand as parseInteractionCommand } from './interaction-service.js';
import { LoginVault } from './login-vault.js';
import { inspectNativeSolitaire, nativeSolitaireStatus } from './native-solitaire.js';

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', 'ui');

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

/**
 * 调用外部桌面应用的内部 API（带访问令牌）。
 *
 * ⚠️ 令牌从 600 的 config.json 读取，**只在本进程使用**，不下发给浏览器。
 * 用于面板的「账号总览 / 一键切号」—— 复用桌面侧已实现且已做安全校验的能力
 * （桌面侧已限制 URL 白名单 + 改配置前自动备份），避免两处重复实现。
 */
async function deskApi(pathname, method = 'GET', body) {
  const cfgPath = '/path/to/desktop-app/data/config.json';
  let token = '';
  try {
    token = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).authToken || '';
  } catch (error) {
    throw new Error('读不到桌面令牌（' + cfgPath + '）');
  }
  if (!token) throw new Error('桌面令牌为空');
  const res = await fetch('http://127.0.0.1:8090' + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Desk-Token': token },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json().catch(() => ({}));
  return data?.data !== undefined ? data.data : data;
}

export function createApp({ log = console.log } = {}) {
  const cfg = getConfig();
  const bus = createEventBus();
  const sseClients = new Set();

  // ── SnowLuma 程序目录与进程管理 ──
  function snowlumaDir() {
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    const napcatDir = String(process.env.NAPCAT_DIR || '').trim();
    if (napcatDir && fs.existsSync(napcatDir)) return napcatDir;
    const bundled = path.join(ROOT, 'snowluma');
    return fs.existsSync(bundled) ? bundled : '';
  }

  function snowlumaWsPort() {
    try {
      const wsUrl = String(getConfig().snowluma?.wsUrl || 'ws://127.0.0.1:3001');
      const u = new URL(wsUrl);
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3001;
  }

  /** 从 SnowLuma 的 runtime.json 读取 WebUI 地址（http(s)://host:port/）。拿不到就返回空串。 */
  function snowlumaWebuiUrl() {
    try {
      const dir = snowlumaDir();
      if (!dir) return '';
      const rtPath = path.join(dir, 'config', 'runtime.json');
      const webuiPath = path.join(dir, 'config', 'webui.json');
      let host = '127.0.0.1';
      let port = 6099;
      let tls = false;
      if (fs.existsSync(rtPath)) {
        const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
        host = String(rt.webuiHost || host);
        port = Number(rt.webuiPort) || 5099;
        tls = !!(rt.webuiTls && rt.webuiTls.enabled);
      } else if (fs.existsSync(webuiPath)) {
        const webui = JSON.parse(fs.readFileSync(webuiPath, 'utf8'));
        host = String(webui.host || host);
        port = Number(webui.port) || port;
      } else {
        return '';
      }
      if (host === '::' || host === '0.0.0.0') host = '127.0.0.1';
      return `${tls ? 'https' : 'http'}://${host}:${port}/`;
    } catch {
      // 配置读不到时，从最近日志里找 "listening http(s)://…" 兜底
      for (const line of [...snowlumaLogs].reverse()) {
        const m = /listening\s+(https?:\/\/[\w.:-]+)/i.exec(line.text || '');
        if (m) return m[1];
      }
      return '';
    }
  }

  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  // SnowLuma 内置控制台日志（环形缓冲，最近 500 行）
  // 内置 SnowLuma 状态与日志。未采用多进程方案：由 Electron 主进程提供 IPC 控制与日志转发，
  // 确保 SnowLuma 随 QQ Agent 退出、无需单独管理窗口。
  const snowlumaLogs = [];
  let snowlumaProc = null;
  let snowlumaStopping = false;

  function pushSnowlumaLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    snowlumaLogs.push(line);
    if (snowlumaLogs.length > 500) snowlumaLogs.splice(0, snowlumaLogs.length - 500);
    emit('snowluma-log', line);
  }

  function snowlumaStatus() {
    return { embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null };
  }

  /** 关闭内置启动的 SnowLuma。返回是否执行了关闭动作。 */
  function stopSnowluma() {
    const proc = snowlumaProc;
    if (!proc) return false;
    try {
      proc.kill();
      pushSnowlumaLog('已请求关闭 SnowLuma。', 'stdout');
    } catch (error) {
      pushSnowlumaLog(`关闭 SnowLuma 失败：${error?.message ?? error}`, 'stderr');
      throw error;
    }
    return true;
  }

  /** 拉起 SnowLuma。优先用项目内置 node.exe 直接运行（日志进内置控制台）；失败再回退到独立窗口 launcher.bat。 */
  async function launchSnowluma() {
    const dir = snowlumaDir();
    if (!dir) return { ok: false, error: '找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在，或在设置里填写 SnowLuma 目录' };
    const wsPort = snowlumaWsPort();
    if (await isPortOpen('127.0.0.1', wsPort)) {
      pushSnowlumaLog(`SnowLuma 已在运行（端口 ${wsPort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }
    if (process.platform !== 'win32') {
      return { ok: false, error: 'AIO/Linux 请使用部署包 onebot/start.sh 启动协议端，然后重启实例。' };
    }
    const indexMjs = path.join(dir, 'index.mjs');
    const nodeExe = path.join(dir, 'node.exe');
    if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
      try {
        // 用 Windows 的 CREATE_NEW_PROCESS_GROUP + 独立进程方式启动，
        // 让 SnowLuma 真正独立于 Electron 主进程（Electron 退出时不会拖垮它）。
        const child = spawn(nodeExe, [indexMjs], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: false
        });
        snowlumaProc = child;
        child.unref();
        pushSnowlumaLog(`SnowLuma 启动中（内置模式，pid=${child.pid}）…`, 'stdout');
        child.stdout.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stdout');
          }
        });
        child.stderr.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          snowlumaProc = null;
          pushSnowlumaLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit('snowluma-status', { running: false, embedded: false, pid: null });
        });
        child.on('error', (error) => {
          pushSnowlumaLog(`SnowLuma 启动失败：${error?.message ?? error}`, 'stderr');
        });
        emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
        return { ok: true, launched: true, embedded: true, pid: child.pid };
      } catch (error) {
        pushSnowlumaLog(`内置模式启动失败，尝试回退独立窗口：${error?.message ?? error}`, 'stderr');
        snowlumaProc = null;
      }
    }
    // 回退：launcher.bat 独立控制台窗口（老行为，日志无法内置）
    const launcher = process.env.NAPCAT_START_SCRIPT || ['launcher.bat','napcat.bat','napcat.cmd'].map(name=>path.join(dir,name)).find(file=>fs.existsSync(file));
    if (!launcher || !fs.existsSync(launcher)) return { ok: false, error: '没有找到 Windows 协议端启动脚本，请在设置中指定目录或设置 NAPCAT_START_SCRIPT。' };
    const child = spawn('cmd.exe', ['/d','/s','/c',`"${launcher}"`], {
      cwd: dir,
      detached: false,
      stdio: ['ignore','pipe','pipe'],
      windowsHide: true
    });
    snowlumaProc=child;
    for(const [stream,name] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',data=>{for(const line of String(data).split(/\r?\n/))if(line.trim())pushSnowlumaLog(line,name);});
    child.on('error',error=>{snowlumaProc=null;pushSnowlumaLog(error.message,'stderr');});
    child.on('exit',()=>{snowlumaProc=null;emit('snowluma-status',{running:false,embedded:false,pid:null});});
    pushSnowlumaLog('Windows 协议端启动请求已提交，在线状态以 OneBot 检测为准。','stdout');
    return { ok: true, launched: true, embedded: true, pid:child.pid };
  }

  const emit = (type, payload) => {
    bus.emit(type, payload);
    const line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { /* 客户端断开会由 close 清理 */ }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 2000);
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 300);
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch(() => {receiveMonitor.record('error');log('[ingest] 消息处理失败，请检查消息接收诊断');})
  });
  const stickers = new StickerManager(onebot);
  const sender = new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`)
  });
  const orchestrator = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit });
  sender.repeatAllowed=chat=>{
    const current=getConfig(),id=chat.split(':')[1];
    return !orchestrator.paused && !orchestrator.aborted && current.behavior?.solitaire?.enabled && current.groupResponse?.enabled!==false && allowed('group',id,current) && (current.allow?.groups||current.allow?.group||[]).map(String).includes(id);
  };
  const interactions = new InteractionService({ dir: DATA_DIR, getConfig, generate: chatCompletion, sender, log, canRun: () => !orchestrator.paused });
  sender.behavior.affinityReader = (chat,q) => interactions.db.pointsForChat(chat,q);
  const loginVault = new LoginVault(DATA_DIR);

  // 通用定时任务（主人在 QQ 里下的提醒/定时指令）
  // ── NapCat WebUI 客户端（账密登录 / 人机验证代理）──
  const napcatWebui = new NapCatWebui({ log });

  async function restartNapCatForRecovery(dir) {
    if (process.platform !== 'win32') {
      const pidFile = path.join(DATA_DIR, 'napcat-supervisor.pid');
      try {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (!Number.isInteger(pid) || pid <= 1) throw new Error('守护进程 PID 无效');
        process.kill(pid, 'SIGUSR1');
        log(`[auto-recovery] 已通知 NapCat 守护进程 ${pid} 执行受控重启`);
        return { ok: true, via: 'aio-supervisor', pid };
      } catch (error) {
        log('[auto-recovery] AIO 守护进程不可用，回退 NapCat WebUI 重启：' + String(error?.message ?? error));
      }
    }
    return napcatWebui.restartNapCat(dir);
  }



  // ── QQ 账号健康探针 ──
  // 只用 WS 连接状态判断健康是不够的：NapCat 的 WS 在**账号离线**时依然在监听，
  // 会导致控制台误报"已连接"（2026-09-14 事故：掉线 5 小时无人发现）。
  // 这里周期性调 get_status 拿真实的 online 标志，掉线时推 SSE 事件 + 打印告警。
  const onebotHealth = new OneBotHealth({
    onebot,
    log,
    offlineThreshold: cfg.autoRecovery?.offlineConfirmations ?? 3
  });
  const autoLoginRecovery = new AutoLoginRecovery({
    passwordFallback: async (target) => {
      if (!getConfig().autoRecovery?.passwordFallback) return { attempted: false };
      const saved = loginVault.read();
      if (!saved || (target && target !== saved.qq)) return { attempted: false };
      const result = await napcatWebui.passwordLogin(saved.qq, saved.passwordMd5, snowlumaDir());
      const needsManual = !!(result?.needCaptcha || result?.needNewDevice || result?.ok === false);
      return { attempted: true, qq: saved.qq, needsManual, error: needsManual ? '登录需要人工验证，请打开 QQ 登录页面完成验证' : '' };
    },
    webui: napcatWebui,
    restartNapCat: restartNapCatForRecovery,
    getConfig,
    getHealth: () => onebotHealth.snapshot(),
    getSelfId: () => onebot.selfId,
    getDir: () => snowlumaDir(),
    emit,
    log
  });
  onebotHealth.on('offline', (st) => {
    log('[health] ⚠ QQ 账号离线，机器人将无法收发消息。请检查 NapCat 登录状态。');
    emit('onebot-health', { online: false, since: st.offlineSince, error: st.lastError });
    autoLoginRecovery.request('health-offline').catch(() => {});
  });
  onebotHealth.on('recovered', () => {
    log('[health] ✔ QQ 账号已恢复在线。');
    emit('onebot-health', { online: true, at: Date.now() });
    autoLoginRecovery.onRecovered();
  });

  // ── 登录二维码刷新守护 ──
  // NapCat 的自动刷新循环会卡死（2026-09-16 事故），进程却还活着，
  // 外部健康检查查不出来。这里靠"二维码文件是否还在更新"来发现并踢活。
  const qrGuard = new QrRefreshGuard({
    napcatWebui,
    // ⚠️ 必须用「账号是否在线」，**不能**用 onebot.connected（WS 是否连着）！
    //    NapCat 的 WS 在账号离线时依然在监听 → connected 恒为 true → 守护误以为
    //    "已登录"，直接跳过检查，于是二维码再旧也不会被踢活（2026-09-17 事故）。
    //    这是同一个坑第三次出现（前两次：控制台显示、二维码面板），务必保持警惕。
    isLoggedIn: () => onebotHealth.snapshot().online === true,
    dir: () => snowlumaDir(),
    log
  });

  const scheduledRunner = new ScheduledTaskRunner({ orchestrator, log });

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 从 SnowLuma 配置自动同步 OneBot 令牌 ──
  // SnowLuma 登录后会在 snowluma/config/onebot_<uin>.json 里写入随机 accessToken。
  // 脱敏发布/全新副本中 qq-agent 的 token 为空，若不自动同步会一直 401。这里在
  // OneBot 未连接时读取 SnowLuma 配置，把 HTTP/WS 令牌补进我们的配置。
  let lastSyncTokenSig = '';
  function syncSnowlumaTokens() {
    try {
      const dir = snowlumaDir();
      if (!dir) return false;
      const cfgDir = path.join(dir, 'config');
      const files = fs.readdirSync(cfgDir)
        .filter((f) => /^(?:onebot11|onebot)_\d+\.json$/.test(f) && !/_(?:0)\.json$/.test(f))
        .sort();
      for (const fallback of ['onebot11.json', 'onebot.json']) {
        if (!files.length && fs.existsSync(path.join(cfgDir, fallback))) files.push(fallback);
      }
      if (!files.length) return false;
      const data = JSON.parse(fs.readFileSync(path.join(cfgDir, files[0]), 'utf8'));
      const network = data?.network || data?.networks || {};
      const httpServers = network.httpServers || [];
      const websocketServers = network.websocketServers || network.wsServers || [];
      const http = httpServers.find((s) => (s.port === 3000) || (s.name === 'http-default') || (s.name === 'aio-http')) || httpServers[0];
      const ws = websocketServers.find((s) => (s.port === 3001) || (s.name === 'ws-default') || (s.name === 'aio-websocket')) || websocketServers[0];
      const wsToken = String(ws?.token ?? ws?.accessToken ?? '');
      const httpToken = String(http?.token ?? http?.accessToken ?? '');
      const sig = `${wsToken}|${httpToken}`;
      if ((!wsToken && !httpToken) || sig === lastSyncTokenSig) return false;
      const cur = getConfig();
      if (cur.snowluma?.accessToken !== wsToken || cur.snowluma?.httpAccessToken !== httpToken) {
        updateConfig({ snowluma: { ...cur.snowluma, accessToken: wsToken, httpAccessToken: httpToken } });
        log('[onebot] 已从 SnowLuma 配置同步 OneBot 访问令牌');
      }
      lastSyncTokenSig = sig;
      return true;
    } catch (error) {
      log('[onebot] 同步 SnowLuma 令牌失败:', error?.message ?? error);
      return false;
    }
  }

  // 401 / 未连接时自动同步一次令牌并重连
  let tokenSyncRetryAt = 0;
  function maybeRecoverOnebot() {
    const now = Date.now();
    if (now - tokenSyncRetryAt < 5000) return;   // 限频
    tokenSyncRetryAt = now;
    if (syncSnowlumaTokens()) {
      const cur = getConfig();
      onebot.wsUrl = String(cur.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(cur.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      onebot.accessToken = String(cur.snowluma?.accessToken || '');
      onebot.httpToken = String(cur.snowluma?.httpAccessToken || cur.snowluma?.accessToken || '');
      onebot.reconnect();
    }
  }
  onebot.onStatus((status) => {
    if (!status.connected && String(status.error || '').includes('401')) maybeRecoverOnebot();
  });

  // ── 入站事件处理 ──
  const receiveMonitor=new ReceiveMonitor();
  let logoutRefreshTimer = null;
  const greetingAt = new Map();
  const historyRecovery = new HistoryRecovery({ onebot, log, ingest: ingestMessage, selfIngest: reconcileOwnMessage, targets: () => {
    const c = getConfig();
    return [...store.listChats(), ...(c.allow?.groups || []).map(id => `group:${id}`),
      ...(c.allow?.private || []).map(id => `private:${id}`)]
      .filter(key => { const [kind, id] = key.split(':'); return allowed(kind, id, c); });
  }});
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  async function resolveReply(messageId) {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      const senderId = String(msg?.sender?.user_id ?? msg?.user_id ?? '');
      let text = '';
      if (Array.isArray(msg?.message)) {
        text = msg.message.map((s) => (s.type === 'text' ? s.data?.text ?? '' : `[${s.type}]`)).join('').trim();
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      return { sender: String(senderName), senderId, text: String(text).slice(0, 120) };
    } catch {
      return null;
    }
  }

  async function ingestMessage(kind, id, event, { recovered = false, archiveOnly = false } = {}) {
    const cfgNow = getConfig();
    const chatKey = kind + ':' + id;
    if(store.hasIncomingMessage(chatKey,event.message_id)||sender.behavior.seen(onebot.selfId,chatKey,event.message_id)){receiveMonitor.record('duplicate');return;}
    const receiptId=sender.behavior.receipt(onebot.selfId,chatKey,{...event,recovered});
    const record=(status,reason)=>{sender.behavior.receiptStatus(receiptId,status,reason);emit('receipt-update',{id:receiptId});};
    if (!allowed(kind, id, cfgNow)) {
      sender.behavior.remember(onebot.selfId,chatKey,event.message_id);
      record('filtered','白名单或黑名单拦截，仅记录，不调用模型');receiveMonitor.record('filtered');return;
    }
    let shouldRespond = false, interactionCommand = null, solitaire = null;

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');
    const media = segments ? extractMediaFromSegments(segments) : [];

    let text;
    if (segments) {
      text = await segmentsToText(segments);
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    if (!text && !media.length) {sender.behavior.remember(onebot.selfId,chatKey,event.message_id);record('skipped','消息格式暂不支持');receiveMonitor.record('unsupported');return;}
    // Recheck after asynchronous formatting, before the synchronous disk write.
    if(store.hasIncomingMessage(chatKey,event.message_id)||sender.behavior.seen(onebot.selfId,chatKey,event.message_id)){receiveMonitor.record('duplicate');return;}
    const saved=store.appendIncoming(chatKey, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: solitaire ? `${text || '[卡片消息]'} [QQ原生接龙结构已记录]` : (text || '[图片]'),
      media,
      read: true
    });
    saved.receiptId=receiptId;
    saved.exactText=repeatText(event);
    store.setIncomingRead(chatKey,saved.id,true);
    sender.behavior.remember(onebot.selfId,chatKey,event.message_id);
    emit('chat-update', chatKey);
    receiveMonitor.record('stored');
    log(`[ingest] ${new Date().toISOString()} ${chatKey} mid=${event.message_id} stored source=${recovered ? 'history' : 'live'}`);
    // Save first: optional feature parsing must not prevent a received message being archived.
    try {
      if(kind==='group' && !archiveOnly) {
        const follow=await handleRepeatFollow({event,chat:chatKey,state:sender.behavior,sender,settings:normalizeBehavior(cfgNow.behavior).solitaire,cfg:cfgNow,selfId:onebot.selfId,paused:orchestrator.paused||orchestrator.aborted,log,
          onClaim:exact=>{
            for(const entry of store.recent(chatKey,{limit:500})) {
              if(!entry.self && entry.exactText===exact) {
                entry.suppressed=true;store.setIncomingRead(chatKey,entry.id,true);
                const receipt=sender.behavior.receiptGet(entry.receiptId);
                if(receipt && ['received','waiting','running'].includes(receipt.status))sender.behavior.receiptStatus(entry.receiptId,'skipped','相同文字跟发规则接管，不额外聊天');
              }
            }
          }});
        if(follow.handled) {record(follow.status,follow.reason);return true;}
      }
      const relay=kind==='group'?identifySolitaire(event):null;
      if(relay){
        inspectNativeSolitaire(event,id,DATA_DIR,cfgNow.nativeSolitaire);
        record('skipped',relay.native?'QQ原生接龙仅记录，不冒充参加成功':'接龙消息只由三人相同文字规则处理，不额外聊天');
        return true;
      }
      let repliesToBot=false;
      const replyId=segments?.find(s=>s.type==='reply')?.data?.id;
      if(replyId!=null){
        const local=store.findByMid(chatKey,replyId);
        if(local) repliesToBot=local.self || local.senderId===onebot.selfId;
        else { let timer; try { const reply=await Promise.race([resolveReply(replyId),new Promise(r=>{timer=setTimeout(()=>r(null),1500);})]); repliesToBot=reply?.senderId===onebot.selfId; }finally{clearTimeout(timer);} }
      }
      const decision=routeMessage({event,cfg:cfgNow,selfId:onebot.selfId,repliesToBot,recent:store.recent(chatKey,{limit:30}),persona:resolvePersona(chatKey).persona});
      interactionCommand=kind==='group'?parseInteractionCommand(event,onebot.selfId):null;
      const exception=interactionCommand && cfgNow.behavior?.interactionException!==false;
      shouldRespond = !archiveOnly && (kind !== 'group' || decision.respond || decision.ordinary || (!decision.blocked && exception));
      saved.relevant=kind!=='group'||decision.direct||decision.related||decision.sad;
      saved.visionAllowed=kind!=='group'? /看|图|照片|识别|这是什么|这个是什么/.test(decision.text)||decision.related : decision.vision;
      saved.direct=decision.direct;
      saved.related=decision.related;saved.sad=decision.sad;saved.keywordMatched=decision.keywordMatched;
      saved.ordinaryCandidate=kind==='group' && !decision.respond && !exception && decision.ordinary;
      saved.policyManaged=kind==='group';saved.ordinaryEligible=decision.ordinaryEligible;saved.interactionException=!!exception;
      saved.exactText=repeatText(event);
      saved.replyTarget=replyId;
      if(!shouldRespond)sender.behavior.metric('skippedBeforeModel');
      store.setIncomingRead(chatKey,saved.id,!shouldRespond||!!interactionCommand);
      record(shouldRespond?'waiting':'skipped',archiveOnly?'历史消息仅存档，不重复触发':shouldRespond?(orchestrator.paused?'机器人已暂停，等待恢复':!cfgNow.api.model?'未配置模型，等待配置':saved.ordinaryCandidate?'等待合并后抽取本批参与概率':'等待合并处理'):decision.blocked?'群聊总开关或关键词规则拦截':'当前模式未选择此消息，已存档，不调用模型');
      if(!shouldRespond)interactionCommand=null;
      solitaire = kind === 'group' ? inspectNativeSolitaire(event, id, DATA_DIR, cfgNow.nativeSolitaire) : null;
    } catch(error) {shouldRespond=false;record('error','消息已存档，处理失败：'+error.message);receiveMonitor.record('error');log(`[ingest] ${chatKey}: feature parsing failed; message retained`);}
    store.setIncomingRead(chatKey, saved.id, !shouldRespond || !!interactionCommand);
    if (archiveOnly) return true;
    if(segments?.some(s=>s.type==='reply'||s.type==='at')){
      let timer;
      try{
        const enriched=await Promise.race([
          segmentsToText(segments,{resolveReply:mid=>resolveReply(mid),resolveAtName:qq=>kind==='group'?resolveAtName(id,qq):null}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('enrichment timeout')),2500);})
        ]);
        if(enriched&&!solitaire){store.updateIncomingText(chatKey,saved.id,enriched);emit('chat-update',chatKey);}
      }catch{receiveMonitor.record('enrichmentFailed');}finally{clearTimeout(timer);}
    }
    // 监控与回复条件分离：白名单内消息始终入库；开关/关键词只决定是否唤醒机器人。
    if (!shouldRespond) return true;
    if (interactionCommand) {
      const at=Date.now();
      if(await interactions.handle(kind,id,event,onebot.selfId)) {
        const delivery=sender.behavior.deliveries().find(d=>d.chat===chatKey && d.at>=at);
        record(delivery?.state==='pending'?'pending':delivery?.state==='sent'?'done':'skipped',delivery?.state==='pending'?`delivery:${delivery.id}`:delivery?.state==='sent'?'中文互动已处理并回复':'互动功能关闭或未产生回复');return true;
      }
      store.setIncomingRead(chatKey,saved.id,false);
    }
    // Only messages selected by the response policy wake the model.
    orchestrator.onIncoming(chatKey);
    return true;
  }

  async function reconcileOwnMessage(event) {
    const kind=event.message_type, id=kind==='group'?event.group_id:(event.target_id ?? event.peer_id ?? event.user_id);
    if(!id)return;
    const text=Array.isArray(event.message)?event.message.filter(s=>s.type==='text').map(s=>s.data?.text||'').join(''):String(event.raw_message||event.message||'');
    const chat=`${kind}:${id}`;
    const row=sender.behavior.reconcile(chat,text,event.message_id);
    if(row){
      if(!store.findByMid(chat,event.message_id))store.appendSelf(chat,{text,ts:Number(event.time)*1000||Date.now(),mid:event.message_id});
      const confirmed=sessions.confirmDelivery(row.id);
      if(confirmed)emit('session-update',confirmed.id);
      emit('chat-update',chat);log('[delivery] 迟到回执已确认成功：'+row.id);
    }
  }

  async function ingestPoke(event) {
    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;
    if (isGroup && cfgNow.groupResponse?.enabled === false) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = onebot.selfId;
    let text;
    if (String(targetId) === String(selfId)) {
      text = `[拍一拍] 你拍了拍${isGroup ? '' : '你'}（来自 ${operatorId}）`;
    } else {
      const operatorName = isGroup ? (await resolveAtName(id, operatorId)) || operatorId : operatorId;
      const targetName = isGroup ? (await resolveAtName(id, targetId)) || targetId : targetId;
      text = operatorId === targetId ? `[拍一拍] ${operatorName} 拍了拍自己` : `[拍一拍] ${operatorName} 拍了拍 ${targetName}`;
    }
    store.appendIncoming(`${isGroup ? 'group' : 'private'}:${id}`, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: '（拍一拍事件）',
      text,
      media: []
    });
    emit('chat-update', `${isGroup ? 'group' : 'private'}:${id}`);
    orchestrator.onIncoming(`${isGroup ? 'group' : 'private'}:${id}`);
  }

  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      receiveMonitor.received(event.message_type);
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      if (event.post_type==='message_sent'||String(event.user_id ?? event.sender?.user_id ?? '') === onebot.selfId) {receiveMonitor.record('self');await reconcileOwnMessage(event);return;}
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      receiveMonitor.record('unsupported');return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // meta/心跳等事件忽略
  }

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  function applyConfigSideEffects(next) {
    store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 2000);
    onebotHealth.offlineThreshold = Math.max(2, Math.min(10, Number(next.autoRecovery?.offlineConfirmations) || 3));
    autoLoginRecovery.applyConfig();
    if (next.groupResponse?.enabled !== false) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
    emit('status', { configUpdated: true });
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      const method = req.method;
      const cfgNow = getConfig();

      if (pathname === '/api/interactions' && method === 'GET') {
        return json(res, 200, { settings: interactions.settings(), ...interactions.status(), toolHelp: TOOL_HELP, login: loginVault.status(), recovery: autoLoginRecovery.snapshot(), nativeSolitaire: nativeSolitaireStatus(DATA_DIR) });
      }
      if (pathname === '/api/native-solitaire' && method === 'GET') {
        return json(res, 200, { ok: true, settings: cfgNow.nativeSolitaire || {}, ...nativeSolitaireStatus(DATA_DIR) });
      }
      if (pathname === '/api/interactions/user' && method === 'GET') {
        const g=String(url.searchParams.get('group')||''),q=String(url.searchParams.get('qq')||'');
        return json(res,200,{user:interactions.db.user(g,q),counts:interactions.db.counts(g,q),ranking:interactions.db.rank(g,interactions.settings().rankLimit),checkin:interactions.db.checkinUser(g,q),checkinRanking:interactions.db.checkinRank(g,interactions.settings().checkinRankLimit)});
      }
      if (pathname === '/api/interactions/manage' && method === 'POST') {
        try {
          const body=await readBody(req),g=String(body.group||''),q=String(body.qq||'');
          if(body.action==='set') interactions.db.change(g,q,body.points);
          else if(body.action==='reset-daily') interactions.db.reset(g,q);
          else if(body.action==='clear-group' && body.confirm===g) interactions.db.clearGroup(g);
          else throw new Error('操作无效，清空排行需输入群号确认');
          return json(res,200,{ok:true,user:interactions.db.user(g,q)});
        } catch(e) {return json(res,400,{error:e.message});}
      }
      if (pathname === '/api/interactions/cache' && method === 'POST') {
        try {
          const body=await readBody(req),cfg=interactions.settings();
          if(body.action==='clear' || body.action==='prune') {
            interactions.db.prune(cfg.cache.maxEntries,body.action==='clear');
            return json(res,200,{ok:true,...interactions.status()});
          }
          if(body.action!=='generate' && body.action!=='preview') throw new Error('未知操作');
          if(!['feed','pet','walk','checkin'].includes(body.kind)) throw new Error('互动类型无效');
          const points=Number(body.points||0);
          if(!Number.isInteger(points)||points<0||points>999999) throw new Error('好感度无效');
          const result=await interactions.enqueue(()=>interactions.reply({kind:body.kind,limited:body.limited===true,points},'preview','preview',true));
          return json(res,200,{ok:true,...result,...interactions.status()});
        } catch(e) {return json(res,400,{error:e.message});}
      }
      if (pathname === '/api/login-vault' && method === 'GET') return json(res,200,loginVault.status());
      if (pathname === '/api/login-vault' && method === 'POST') {
        try {
          const body=await readBody(req);
          const result=body.action==='clear'?loginVault.clear():loginVault.save(String(body.qq||''),body.password);
          return json(res,200,{ok:true,...result});
        } catch {return json(res,400,{error:'保存失败，请检查 QQ 号、密码及服务器密钥'});}
      }

      if (pathname === '/api/onebot/reconnect' && method === 'POST') {
        await onebot.reconnect();return json(res,200,{ok:true});
      }
      if (pathname === '/api/status' && method === 'GET') {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        return json(res, 200, {
          onebot: {
            connected: onebot.connected,
            transport:onebot.transportStatus(),
            receive:receiveMonitor.snapshot(),
            history:historyRecovery.snapshot(),
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null,
            // 账号级健康（与"WS 是否连上"不同：账号离线时 WS 仍可能连着）
            account: onebotHealth.snapshot(),
            // 综合结论：WS 连着 **且** 账号在线，才算真正可用
            healthy: !!onebot.connected && onebotHealth.snapshot().online !== false
          },
          snowluma: {
            dir: snowlumaDir(),
            running: await isPortOpen('127.0.0.1', snowlumaWsPort()),
            webuiUrl: snowlumaWebuiUrl(),
            ...snowlumaStatus()
          },
          orchestrator: orchestrator.statusSummary(),
          usage: {
            ...usage,
            cost: estimateCost(usage)
          },
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null,
          autoRecovery: autoLoginRecovery.snapshot(),
          modelFailover: getFailoverStatus()
        });
      }

      if (pathname === '/api/auto-recovery/status' && method === 'GET') {
        return json(res, 200, { ok: true, status: autoLoginRecovery.snapshot() });
      }

      if (pathname === '/api/model-failover/status' && method === 'GET') {
        return json(res, 200, { ok: true, status: getFailoverStatus() });
      }

      if (pathname === '/api/auto-recovery/run' && method === 'POST') {
        const result = await autoLoginRecovery.request('manual', { force: true });
        return json(res, 200, result);
      }

      if (pathname === '/api/snowluma/logout-all' && method === 'POST') {
        const body = await readBody(req);
        if (body?.confirm !== '退出全部登录') return json(res, 400, { ok: false, error: '需要确认退出全部登录' });
        try {
          autoLoginRecovery.suspendForManual('已退出本 AIO 实例登录，等待人工重新登录');
          updateConfig({ autoRecovery: { ...getConfig().autoRecovery, enabled: false, targetQQ: '' } });
          await napcatWebui.setQuickLogin('', snowlumaDir());
          fs.writeFileSync(path.join(DATA_DIR, 'manual-login-required'), '1\n');
          onebot.close();
          onebot.selfInfo = null;
          onebotHealth.reset('正在刷新登录状态');
          const childFile = path.join(DATA_DIR, 'napcat-child.pid');
          const oldChild = fs.existsSync(childFile) ? fs.readFileSync(childFile, 'utf8').trim() : '';
          const restart = await restartNapCatForRecovery(snowlumaDir());
          if (restart?.ok === false) throw new Error('NapCat 拒绝重启');
          if (restart?.via === 'aio-supervisor') {
            let replaced = false;
            for (let attempt = 0; attempt < 20; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 1000));
              const child = fs.existsSync(childFile) ? fs.readFileSync(childFile, 'utf8').trim() : '';
              if (child && child !== oldChild) { replaced = true; break; }
            }
            if (!replaced) throw new Error('未确认 QQ 进程重启完成，请检查 onebot.log');
          }
          clearTimeout(logoutRefreshTimer);
          logoutRefreshTimer = setTimeout(async () => {
            onebot.reconnect();
            await napcatWebui.refreshQr(snowlumaDir()).catch(() => {});
            await onebotHealth.probe().catch(() => {});
            emit('onebot-health', onebotHealth.snapshot());
          }, 8000);
          logoutRefreshTimer.unref?.();
          log('[login] 已清空自动登录目标并重启 NapCat，等待扫码或人工登录');
          return json(res, 200, { ok: true, restart, status: onebotHealth.snapshot() });
        } catch (error) {
          return json(res, 500, { ok: false, error: '退出登录失败：' + String(error?.message ?? error) });
        }
      }

      // ── SnowLuma 进程管理 ──
      if (pathname === '/api/snowluma/launch' && method === 'POST') {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/logs' && method === 'GET') {
        return json(res, 200, { logs: snowlumaLogs.slice(-200) });
      }

      // ── 登录二维码（未登录时展示，供扫码）──
      // NapCat 会把二维码写到它的 cache/qrcode.png，约每 2 分钟自动刷新。
      if (pathname === '/api/snowluma/qr' && method === 'GET') {
        const info = qrInfo(snowlumaDir());
        return json(res, 200, {
          exists: info.exists,
          qrAt: info.qrAt,
          ageMs: info.ageMs,
          // ⚠️ 用「账号是否在线」而非「WS 是否连着」——WS 在账号离线时依然在监听，
        //    用 connected 会让面板以为已登录、从而不显示二维码（2026-09-16 事故）。
        loggedIn: onebotHealth.snapshot().online === true,
          onebotError: onebot.lastConnectError || '',
          self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
        });
      }

      if (pathname === '/api/snowluma/qr.png' && method === 'GET') {
        const got = readQrBuffer(snowlumaDir());
        if (!got) return json(res, 404, { error: '暂无二维码（已登录，或 NapCat 未在等待扫码）' });
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'content-length': got.buffer.length
        });
        return res.end(got.buffer);
      }

      // ── NapCat 登录代理（账密登录 / 人机验证 / 新设备）──
      // 目的：QQ 风控掉线后，用户可在面板里用账号密码自助登录，不必找管理员扫码。
      // 安全：**密码明文不出浏览器**（前端算 MD5 后只传 passwordMd5），
      //       整个 /api/snowluma/* 已在 nginx Basic Auth 之后。
      if (pathname === '/api/snowluma/login/info' && method === 'GET') {
        return json(res, 200, napcatWebui.info(snowlumaDir()));
      }

      if (pathname === '/api/snowluma/login/status' && method === 'GET') {
        try {
          const st = await napcatWebui.loginStatus(snowlumaDir());
          const quick = await napcatWebui.quickList(snowlumaDir()).catch(() => []);
          return json(res, 200, { ok: true, status: st, quickList: quick });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/password' && method === 'POST') {
        let body = null;
        try {
          body = await readBody(req);
          if (!body?.uin || !body?.passwordMd5) return json(res, 400, { ok: false, error: '需要 uin 与 passwordMd5' });
          body.passwordMd5 = loginVault.resolve(body.uin, body.passwordMd5);
          const r = await napcatWebui.passwordLogin(body.uin, body.passwordMd5, snowlumaDir());
          // 三种结果：直接成功(null) / 需要人机验证 / 需要新设备验证
          return json(res, 200, {
            ok: true,
            needCaptcha: !!(r && r.needCaptcha),
            proofWaterUrl: r?.proofWaterUrl || '',
            needNewDevice: !!(r && r.needNewDevice),
            jumpUrl: r?.jumpUrl || '',
            newDevicePullQrCodeSig: r?.newDevicePullQrCodeSig || ''
          });
        } catch (error) {
          if (isNapCatAlreadyLoggedError(error) && body?.uin) {
            const health = await onebotHealth.probe().catch(() => onebotHealth.snapshot());
            if (health?.online === true) {
              return json(res, 200, { ok: true, alreadyLoggedIn: true, online: true });
            }

            try {
              // NapCat 认为“已登录”但 OneBot 判定离线，属于残留假会话。
              // 先指定本次账号为快速登录目标，再通过 AIO 守护进程受控重启。
              await napcatWebui.setQuickLogin(body.uin, snowlumaDir()).catch((setError) => {
                log('[login] 设置快速登录账号失败，仍继续重启：' + String(setError?.message ?? setError));
              });
              const restart = await restartNapCatForRecovery(snowlumaDir());
              log(`[login] 检测到 QQ ${body.uin} 假在线，已请求重启 NapCat 后重新登录`);
              return json(res, 200, {
                ok: true,
                staleLogin: true,
                recoveryStarted: true,
                retryAfterMs: 25000,
                restart
              });
            } catch (restartError) {
              return json(res, 200, {
                ok: false,
                staleLogin: true,
                error: 'QQ 显示已登录但实际离线，自动重启失败：' + String(restartError?.message ?? restartError)
              });
            }
          }
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/captcha' && method === 'POST') {
        try {
          const body = await readBody(req);
          const need = ['uin', 'passwordMd5', 'ticket', 'randstr'];
          for (const k of need) if (!body?.[k]) return json(res, 400, { ok: false, error: '缺少参数 ' + k });
          body.passwordMd5 = loginVault.resolve(body.uin, body.passwordMd5);
          const r = await napcatWebui.captchaLogin(body.uin, body.passwordMd5, body.ticket, body.randstr, body.sid, snowlumaDir());
          return json(res, 200, {
            ok: true,
            needNewDevice: !!(r && r.needNewDevice),
            jumpUrl: r?.jumpUrl || '',
            newDevicePullQrCodeSig: r?.newDevicePullQrCodeSig || ''
          });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/new-device' && method === 'POST') {
        try {
          const body = await readBody(req);
          body.passwordMd5 = loginVault.resolve(body.uin, body.passwordMd5);
          const r = await napcatWebui.newDeviceLogin(body.uin, body.passwordMd5, body.newDevicePullQrCodeSig, snowlumaDir());
          return json(res, 200, { ok: true, result: r });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新设备扫码验证：取二维码（str_url 给手机 QQ 扫）
      if (pathname === '/api/snowluma/login/new-device-qr' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin || !body?.jumpUrl) return json(res, 400, { ok: false, error: '需要 uin 与 jumpUrl' });
          const r = await napcatWebui.getNewDeviceQr(body.uin, body.jumpUrl, snowlumaDir());
          // 顺手在服务端把 str_url 渲染成二维码 dataURL，前端直接展示
          let qrImage = '';
          try {
            if (r?.str_url) qrImage = await napcatWebui.newDeviceQrDataUrl(r.str_url);
          } catch (e) {
            log('[login] 新设备二维码生成失败:', e?.message ?? e);
          }
          return json(res, 200, { ok: true, qr: r, qrImage });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新设备扫码验证：轮询状态（3=已扫码 / 1=已确认）
      if (pathname === '/api/snowluma/login/new-device-poll' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin || !body?.bytesToken) return json(res, 400, { ok: false, error: '需要 uin 与 bytesToken' });
          const r = await napcatWebui.pollNewDeviceQr(body.uin, body.bytesToken, snowlumaDir());
          return json(res, 200, { ok: true, poll: r });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 设备指纹：查看 / 重置（缓解风控掉线）
      if (pathname === '/api/snowluma/device' && method === 'GET') {
        try {
          const guid = await napcatWebui.getDeviceGuid(snowlumaDir()).catch((e) => ({ error: String(e?.message ?? e) }));
          const backups = await napcatWebui.getGuidBackups(snowlumaDir()).catch(() => []);
          return json(res, 200, { ok: true, guid, backups });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/device/reset' && method === 'POST') {
        try {
          const r = await napcatWebui.resetDeviceId(snowlumaDir());
          return json(res, 200, { ok: true, result: r });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // ── 账号总览与一键切号（2026-09-16 新增）─────────────────────────────
      // 用户诉求：面板里要能**直接看到后台在线账号并一键切过去**。
      // 原「快速登录」按钮调 SetQuickLoginQQ 只是**设定**、不触发登录，点了没反应（已查明）。
      // 这里改为：透传外部桌面应用已实现好的账号总览与切号能力。
      if (pathname === '/api/accounts/overview' && method === 'GET') {
        try {
          const data = await deskApi('/api/qq/accounts');
          return json(res, 200, { ok: true, data });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/accounts/switch' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.action) return json(res, 400, { ok: false, error: '需要 action' });
          const r = await deskApi('/api/qq/switch', 'POST', body);
          return json(res, 200, r);
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/set-quick' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin) return json(res, 400, { ok: false, error: '需要 uin' });
          await napcatWebui.setQuickLogin(body.uin, snowlumaDir());
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/refresh-qr' && method === 'POST') {
        try {
          await napcatWebui.refreshQr(snowlumaDir());
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/stop' && method === 'POST') {
        try {
          const stopped = stopSnowluma();
          return json(res, 200, { ok: true, stopped, embedded: snowlumaStatus().embedded, pid: snowlumaStatus().pid });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/open-folder' && method === 'POST') {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        if (process.platform !== 'win32') {
          return json(res, 200, { ok: true, dir, message: 'AIO/Linux 请在服务器文件管理中打开此目录。' });
        }
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/snowluma/open-webui' && method === 'POST') {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        if (process.platform !== 'win32') {
          return json(res, 200, { ok: true, webuiUrl, message: 'AIO/Linux 不会在服务器上打开浏览器。' });
        }
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }

      // ── 体检/引导相关 ──
      if (pathname === '/api/onebot/groups' && method === 'GET') {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/onebot/friends' && method === 'GET') {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/persona-templates' && method === 'GET') {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true, avatarUrl:getConfig().personaProfiles?.[id]?.avatarUrl || '', description:getConfig().personaProfiles?.[id]?.description || '' }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`,
          name: p.name,
          text: p.text,
          customRules: p.customRules || '',
          avatarUrl: p.avatarUrl || '',
          description: p.description || '',
          builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }

      // 用户自定义人设：新增 / 删除
      if (pathname === '/api/persona-templates' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        // customRules 允许为空
        const entry = { name, text };
        const avatarUrl = String(body.avatarUrl || '');
        if (avatarUrl.length > 700000 || (avatarUrl && !/^https?:\/\//i.test(avatarUrl) && !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(avatarUrl))) return json(res,400,{error:'头像需要有效的图片地址或小于 500KB 的 PNG/JPEG/WebP 图片'});
        entry.avatarUrl = avatarUrl;
        entry.description = String(body.description || '').slice(0,160);
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }

      const personaDeleteMatch = /^\/api\/persona-templates\/(custom_\d+)$/.exec(pathname);
      const builtinProfileMatch = /^\/api\/persona-templates\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (builtinProfileMatch && !personaDeleteMatch && method === 'PATCH') {
        const { PERSONAS } = await import('./personas.js');
        const id=builtinProfileMatch[1];
        if (!Object.hasOwn(PERSONAS,id)) return json(res,404,{error:'人设不存在'});
        const body=await readBody(req);
        const avatarUrl=String(body.avatarUrl || '');
        if (avatarUrl.length>700000 || (avatarUrl && !/^https?:\/\//i.test(avatarUrl) && !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(avatarUrl))) return json(res,400,{error:'头像格式或大小无效'});
        updateConfig({personaProfiles:{[id]:{avatarUrl,description:String(body.description || '').slice(0,160)}}});
        return json(res,200,{ok:true});
      }
      if (personaDeleteMatch && method === 'PATCH') {
        const index=Number(personaDeleteMatch[1].slice(7));
        const list=[...(getConfig().customPersonas || [])];
        if (!list[index]) return json(res,404,{error:'人设不存在'});
        const body=await readBody(req);
        const avatarUrl=String(body.avatarUrl || '');
        if (avatarUrl.length>700000 || (avatarUrl && !/^https?:\/\//i.test(avatarUrl) && !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(avatarUrl))) return json(res,400,{error:'头像格式或大小无效'});
        list[index]={...list[index],avatarUrl,description:String(body.description || '').slice(0,160)};
        updateConfig({customPersonas:list});
        return json(res,200,{ok:true});
      }
      if (personaDeleteMatch && method === 'DELETE') {
        const idx = Number(personaDeleteMatch[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }

      // ── 多提供商模型目录 ──
      if (pathname === '/api/providers' && method === 'GET') {
        const providers = currentProviders().map((p) => ({
          id: p.id,
          displayName: p.displayName,
          baseURL: p.baseURL,
          apiKey: p.apiKey || '',
          apiKeyFrom: p.apiKeyFrom || '',
          needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey,
          anthropicOrigin: p.anthropicOrigin === true,
          models: p.models,
          modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }

      // 用当前 api 配置拉取模型列表（前端“获取列表”）
      if (pathname === '/api/providers/fetch-models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          const apiKey = body.apiKey !== undefined ? String(body.apiKey ?? '') : String(cfgNow.api.apiKey || '');
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 测试单个提供商（测试连通性）
      if (pathname === '/api/providers/test-one' && method === 'POST') {
        try {
          const body = await readBody(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 用 baseUrl + apiKey + model 发送一次最小 chat 测试请求
      if (pathname === '/api/providers/test-chat' && method === 'POST') {
        try {
          const body = await readBody(req);
          const result = await testModelChat({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? ''),
            model: String(body.model ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新增提供商（同 baseURL 自动合并）
      if (pathname === '/api/providers' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? ''),
            models: body.models || []
          });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 给已有提供商追加模型
      if (pathname === '/api/providers/models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: p });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除某提供商下的一个模型
      if (pathname === '/api/providers/models' && method === 'DELETE') {
        try {
          const body = await readBody(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: p });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/providers/set-key' && method === 'POST') {
        const body = await readBody(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }

      if (pathname === '/api/providers/test-all' && method === 'POST') {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }

      if (pathname === '/api/vision/results' && method === 'GET') {
        return json(res, 200, { results: visionResults(), scanning: visionScan.running });
      }

      if (pathname === '/api/vision/scan' && method === 'POST') {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await readBody(req).catch(() => ({}));
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({
          providers: currentProviders(),
          emit,
          onlyProviderIds,
          timeoutMs: 25000,
          limit: 3
        })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }

      if (pathname === '/api/test/api' && method === 'POST') {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({
            messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
            tools: null,
            temperature: 0
          });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }

      if (pathname === '/api/config' && method === 'GET') {
        return json(res, 200, cfgNow);
      }

      if (pathname === '/api/behavior' && method === 'GET') {
        return json(res,200,{settings:normalizeBehavior(cfgNow.behavior),relations:sender.behavior.relations(),deliveries:sender.behavior.deliveries(),metrics:sender.behavior.metrics()});
      }
      if (pathname === '/api/relations' && ['POST','DELETE'].includes(method)) {
        try {const body=await readBody(req);if(method==='DELETE')sender.behavior.deleteRelation(body.q,body.scope);else sender.behavior.saveRelation(body);return json(res,200,{ok:true,relations:sender.behavior.relations()});}
        catch(error){return json(res,400,{error:error.message});}
      }

      if (pathname === '/api/config' && method === 'POST') {
        const patch = await readBody(req);
        let next;
        try { next = updateConfig(patch); } catch(e) { return json(res,400,{error:e.message}); }
        applyConfigSideEffects(next);
        return json(res, 200, { ok: true, config: next });
      }

      if (pathname === '/api/stickers' && method === 'GET') {
        const query = String(url.searchParams.get('query') || '').slice(0, 100);
        const force = url.searchParams.get('force') === '1';
        const result = await stickers.adminList(query, force);
        return json(res, 200, { ok: true, ...result });
      }

      if (pathname === '/api/stickers/sync' && method === 'POST') {
        const result = await stickers.adminList('', true);
        return json(res, 200, { ok: true, ...result });
      }

      if (pathname === '/api/stickers/note' && method === 'POST') {
        const body = await readBody(req);
        const id = String(body.id || '').trim();
        if (!id) return json(res, 400, { ok: false, error: '表情 ID 不能为空' });
        const tags = Array.isArray(body.tags)
          ? body.tags
          : String(body.tags || '').split(/[,，\s]+/);
        const entry = stickers.note(id, {
          note: String(body.note || '').trim().slice(0, 500),
          usage: String(body.usage || '').trim().slice(0, 500),
          tags: tags.map((tag) => String(tag || '').trim()).filter(Boolean).slice(0, 20),
          source: 'manual'
        });
        if (!entry) return json(res, 404, { ok: false, error: '找不到该表情，请先同步收藏表情' });
        return json(res, 200, { ok: true, entry });
      }

      if (pathname === '/api/models' && method === 'GET') {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/sessions' && method === 'GET') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
        const offset=Math.max(0,Math.min(1000000,Number(url.searchParams.get('offset'))||0));
        return json(res, 200, listMessageRecords(sender.behavior,sessions,limit,offset));
      }

      const sessionMatch = /^\/api\/sessions\/([\w-]+)$/.exec(pathname);
      if (sessionMatch && method === 'GET') {
        const s = sessionMatch[1].startsWith('receipt-') ? receiptView(sender.behavior.receiptGet(sessionMatch[1]),sessions,sender.behavior) : sessions.get(sessionMatch[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }

      if (pathname === '/api/chats' && method === 'GET') {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        return json(res, 200, { chats });
      }

      const chatMsgMatch = /^\/api\/chats\/(group|private)_(\d+)\/messages$/.exec(pathname);
      if (chatMsgMatch && method === 'GET') {
        const chatKey = `${chatMsgMatch[1]}:${chatMsgMatch[2]}`;
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const query = String(url.searchParams.get('query') || '').slice(0, 200);
        const result = store.search(chatKey, { limit, offset, query });
        const messages = result.messages.map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply
        }));
        return json(res, 200, { chatKey, messages, total: result.total, offset });
      }

      // 联网搜索的 key 状态与设置（key 本身**绝不回传**，只回遮影形态）
      if (pathname === '/api/search-keys' && method === 'GET') {
        try {
          const cfg = getConfig();
          const arr = Array.isArray(cfg.webSearch?.anysearchKeys) ? cfg.webSearch.anysearchKeys : [];
          const envCount = [process.env.ANYSEARCH_API_KEY, process.env.ANYSEARCH_API_KEY_2].filter(Boolean).length;
          return json(res, 200, {
            provider: String(cfg.webSearch?.provider || 'auto'),
            envCount,
            configKeys: arr.map((k) => {
              const s = String(k || '');
              return s ? (s.slice(0, 6) + '****' + s.slice(-4)) : '';
            }),
            configKeyCount: arr.filter((x) => String(x || '').trim()).length,
            total: envCount + arr.filter((x) => String(x || '').trim()).length
          });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
      // 保存 key：只接受新填入的值（不回显旧的）；传空字符串表示删除该位
      if (pathname === '/api/search-keys' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          if (!Array.isArray(body.keys)) return json(res, 400, { ok: false, error: 'keys 必须是数组' });
          const rawKeys = body.keys.map((k) => String(k ?? '').trim());
          // 判定用户意图：
          //   · 全部为空且显式传了 allowClear → 清空
          //   · 全部为空但没授权清空  → 保留原值（防误点保存把 key 清掉）
          //   · 有新值                → 用新值替换（遮影值 **** 不参与）
          const newOnes = rawKeys.filter((k) => k && !k.includes('****'));
          const hadMasked = rawKeys.some((k) => k.includes('****'));
          const prev = Array.isArray(getConfig().webSearch?.anysearchKeys) ? getConfig().webSearch.anysearchKeys : [];
          let next;
          if (newOnes.length) {
            // 有新填的：替换（若同时含遮影项，说明用户想保留其余，这里简单起见以新值为准）
            next = newOnes;
          } else if (hadMasked) {
            // 只有遮影项 = 用户没改，保持原样
            next = prev;
          } else if (body.allowClear === true) {
            next = [];
          } else {
            next = prev;   // 空提交且未授权清空 → 不动
          }
          updateConfig({ webSearch: { ...(getConfig().webSearch || {}), anysearchKeys: next } });
          return json(res, 200, { ok: true, saved: next.length, unchanged: next === prev });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (pathname === '/api/capabilities' && method === 'POST') {
        try {
          const body = await readBody(req);
          const next = updateConfig(capabilityPatch(body, getConfig()));
          applyConfigSideEffects(next);
          return json(res,200,{ok:true,config:next});
        } catch(error) {return json(res,400,{error:error.message});}
      }
      // 能力总览：工具清单 + 关键功能状态（供设置页展示）
      if (pathname === '/api/capabilities' && method === 'GET') {
        try {
          const { buildToolDefs } = await import('./tools.js');
          const defs = buildToolDefs();
          const GROUP_RULES = [
            ['消息与互动', /^(send_message|send_sticker|send_image|send_file|send_poke|receive_file|list_stickers|get_sticker_image|sticker_note|collect_sticker)$/],
            ['信息获取', /^(get_recent_messages|get_active_members|get_message_detail|get_message_images|web_search|web_fetch)$/],
            ['记忆', /^(memory_append|memory_query|memory_remove)$/],
            ['主人专属', /^(dsh_task)$/],
            ['其它', /.*/]
          ];
          const tools = defs.filter((d) => d && d.name).map((d) => {
            let group = '其它';
            for (const [g, re] of GROUP_RULES) { if (re.test(d.name)) { group = g; break; } }
            return {
              name: d.name,
              label: TOOL_HELP[d.name]?.[0] || d.name,
              example: TOOL_HELP[d.name]?.[1] || '',
              group,
              enabled: isToolEnabled(d.name, getConfig()),
              controllable: TOOL_SWITCH_NAMES.has(d.name),
              featureKey: toolFeatureKey(d.name),
              description: String(d.description || '').replace(/\b[a-z]+(?:_[a-z]+)+\b/g, word => TOOL_HELP[word]?.[0] || word).slice(0, 200),
              masterOnly: !!d.masterOnly,
              params: Object.keys(d.parameters?.properties || {})
            };
          });
          // 关键功能状态
          const cfg = getConfig();
          // 定时任务摘要
          let scheduled = { count: 0, items: [] };
          try {
            const ST = await import('./scheduled-tasks.js');
            const list = ST.listTasks().filter((t) => t.enabled);
            scheduled = { count: list.length, items: list.slice(0, 8).map((t) => ST.describeTask(t)) };
          } catch (e) { scheduled = { count: 0, items: [], error: String(e?.message || e) }; }
          // 搜索引擎状态
          const hasAnyKey = !!(process.env.ANYSEARCH_API_KEY || process.env.ANYSEARCH_API_KEY_2);
          const searchProvider = String(cfg.webSearch?.provider || 'auto');
          return json(res, 200, {
            tools,
            total: tools.length,
            enabledTotal: tools.filter((tool) => tool.enabled).length,
            features: {
              interaction: interactions.settings(),
              toolFeatures: toolFeatureSnapshot(cfg),
              masterQQ: String(cfg.persona?.masterQQ || ''),
              groupResponse: {
                enabled: cfg.groupResponse?.enabled !== false,
                keywordOnly: cfg.groupResponse?.keywordOnly === true,
                keywordCount: Array.isArray(cfg.groupResponse?.keywords) ? cfg.groupResponse.keywords.filter((x) => String(x || '').trim()).length : 0
              },
              autoRecovery: autoLoginRecovery.snapshot(),
              identityModes: Object.entries(cfg.identityModes || {})
                .filter(([, v]) => v && v.enabled !== false)
                .map(([k, v]) => ({ id: k, label: v?.label || k, enter: v?.enter || [], exit: v?.exit || [] })),
              personaModes: cfg.personaModes || {},
              customPersonas: (cfg.customPersonas || []).map((p) => p.name),
              search: {
                enabled: cfg.webSearch?.enabled !== false,
                provider: searchProvider,
                anysearchAvailable: hasAnyKey,
                effective: searchProvider === 'bing'
                  ? 'Bing 网页抓取'
                  : (searchProvider === 'anysearch'
                    ? (hasAnyKey ? 'AnySearch' : 'AnySearch（未配置 key，会失败）')
                    : (hasAnyKey ? 'AnySearch（失败自动回退 Bing）' : 'Bing（未配置 AnySearch key）'))
              },
              scheduled
            }
          });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      // 补报 DSH 任务：任务已完成但没汇报时（或通知链路故障后），让机器人现在汇报一次
      if (pathname === '/api/dsh/report' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const workDir = String(body.workDir ?? '').trim();
          const chatKey = String(body.chatKey ?? 'private:123456789').trim();
          if (!workDir) return json(res, 400, { ok: false, error: 'workDir 必填' });
          const fsmod = await import('node:fs');
          const pathmod = await import('node:path');
          if (!fsmod.existsSync(workDir)) return json(res, 404, { ok: false, error: '目录不存在' });
          const items = fsmod.readdirSync(workDir, { withFileTypes: true });
          const files = [];
          for (const it of items) {
            const p = pathmod.join(workDir, it.name);
            if (it.isDirectory()) {
              let n = 0; try { n = fsmod.readdirSync(p).length; } catch {}
              files.push({ name: it.name + '/', size: 0, dir: true, entries: n });
            } else {
              let sz = 0; try { sz = fsmod.statSync(p).size; } catch {}
              files.push({ name: it.name, size: sz, dir: false });
            }
          }
          const real = files.filter((f) => (f.dir ? (f.entries || 0) > 0 : (f.size || 0) > 0));
          let reportFile = '', reportText = '';
          const cand = real.find((f) => !f.dir && /回给主人|汇报|report|summary/i.test(f.name) && /\.(txt|md)$/i.test(f.name));
          if (cand) {
            reportFile = cand.name;
            try { reportText = fsmod.readFileSync(pathmod.join(workDir, cand.name), 'utf8').slice(0, 2500); } catch {}
          }
          orchestrator.wake(chatKey, {
            proactive: true,
            taskContext: {
              kind: 'DSH 后台任务（补报）',
              name: pathmod.basename(workDir),
              taskText: String(body.taskText || '').slice(0, 400),
              workDir, files: real, empty: !real.length,
              reportFile, reportText
            }
          }).catch(() => {});
          return json(res, 200, { ok: true, fileCount: real.length, reportFile });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      const chatWakeMatch = /^\/api\/chats\/(group|private)_(\d+)\/wake$/.exec(pathname);
      if (chatWakeMatch && method === 'POST') {
        const chatKey = `${chatWakeMatch[1]}:${chatWakeMatch[2]}`;
        const ok = orchestrator.forceWake(chatKey);
        return json(res, 200, { ok });
      }

      // 手动发一条测试消息（不走模型，直接经 OneBot 发出，用于配置后验证链路）
      const chatTestSendMatch = /^\/api\/chats\/(group|private)_(\d+)\/test-send$/.exec(pathname);
      if (chatTestSendMatch && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        try {
          const chatKey = `${chatTestSendMatch[1]}:${chatTestSendMatch[2]}`;
          const data = await onebot.sendText(chatTestSendMatch[1], chatTestSendMatch[2], text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const chatReadMatch = /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/.exec(pathname);
      const promptMatch = /^\/api\/chats\/(group|private)_(\d+)\/prompt$/.exec(pathname);
      const greetingMatch = /^\/api\/chats\/group_(\d+)\/greet$/.exec(pathname);
      if (greetingMatch && method === 'POST') {
        const id=greetingMatch[1],cfg=getConfig(),key=`group:${id}`;
        if (!allowed('group',id,cfg)) return json(res,403,{error:'请先将群聊加入白名单'});
        if (cfg.groupResponse?.enabled === false) return json(res,409,{error:'请先开启群聊响应'});
        if (orchestrator.paused || orchestrator.aborted) return json(res,409,{error:'请先恢复 bot 运行'});
        if (!onebot.connected || !onebot.selfId || onebotHealth.snapshot().online === false) return json(res,409,{error:'请先确认 QQ 登录和消息通道正常'});
        if (!cfg.api?.baseUrl || !cfg.api?.model) return json(res,409,{error:'请先配置模型 API'});
        if (orchestrator.overBudget()) return json(res,409,{error:'今日模型预算已用完'});
        if (Date.now()-(greetingAt.get(key)||0)<30000) return json(res,429,{error:'已触发问候，请等待 30 秒再试'});
        store.appendIncoming(key,{mid:null,ts:Date.now(),senderId:'admin',senderName:'后台管理员',
          text:'【后台手动主动问候】请现在按当前人设向本群成员主动打一次招呼，简短自然。不必等待有人提问，不要声称群里一直安静，不要编造群成员近况。请使用发送消息工具将问候发到本群。'});
        greetingAt.set(key,Date.now());orchestrator.onIncoming(key);emit('chat-update',key);
        return json(res,200,{ok:true,chatKey:key});
      }
      if (promptMatch && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text || text.length > 8000) return json(res,400,{error:'提示词不能为空且最多 8000 字'});
        if (!allowed(promptMatch[1],promptMatch[2],getConfig())) return json(res,403,{error:'请先将目标会话加入聊天白名单'});
        if (orchestrator.paused || orchestrator.aborted) return json(res,409,{error:'请先恢复 bot 运行'});
        const key = `${promptMatch[1]}:${promptMatch[2]}`;
        const saved = store.appendIncoming(key,{mid:null,text,ts:Date.now(),senderId:'admin',senderName:'后台管理员'});
        orchestrator.onIncoming(key); emit('chat-update',key);
        return json(res,200,{ok:true,id:saved.id});
      }
      if (chatReadMatch && method === 'POST') {
        const chatKey = `${chatReadMatch[1]}:${chatReadMatch[2]}`;
        const drained = store.drainUnread(chatKey);
        return json(res, 200, { ok: true, marked: drained.length });
      }

      if (pathname === '/api/pause' && method === 'POST') {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) {
          // 恢复时自动补处理暂停期间积压的未读消息
          orchestrator.drainBacklogAfterResume();
        }
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }

      // 恢复运行，并把所有会话当前未读一次性标记为已读（用户明确选择丢弃积压）
      if (pathname === '/api/pause' && method === 'DELETE') {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }

      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }

    // 静态 UI
    if (req.method === 'GET') {
      let file = pathname === '/' ? '/index.html' : pathname;
      file = file.replace(/\.\./g, '');
      const fullPath = path.join(UI_DIR, file);
      if (!fullPath.startsWith(UI_DIR)) { res.writeHead(403); res.end(); return; }
      try {
        let data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
        // index.html 里给 app.js / style.css 注入基于 mtime 的版本号，
        // 这样每次更新前端代码后浏览器会自动拉新文件（避免"改了没生效"的缓存问题）
        if (ext === '.html') {
          const stamp = (f) => { try { return Math.floor(fs.statSync(path.join(UI_DIR, f)).mtimeMs).toString(36); } catch { return '0'; } };
          // 用相对路径 + 版本号：
          //   · 浏览器在 /qqbot/ 下访问 './app.js' → 自动解析为 /qqbot/app.js（Nginx 反代正确）
          //   · 本地直连 3210 时解析为 /app.js（也对）
          //   · 这样既拿到缓存失效，又不依赖 Nginx 的 sub_filter 改写
          data = Buffer.from(
            data.toString('utf8')
              .replace(/(href|src)="(?:\.\/|\/)(style\.css|admin-v14\.css|interaction-panel\.js|app\.js|behavior\.js|behavior\.css|feature-center\.js|admin-center\.css|squish-switch\.js|squish-switch\.css)(?:\?[^"\s]*)?"/g,
                (_match,attribute,file) => `${attribute}="./${file}?v=${stamp(file)}"`),
            'utf8'
          );
        }
        res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      const host = process.env.QQ_AGENT_HOST || '127.0.0.1';
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // 先把 HTTP 服务拉起来，让窗口/浏览器立刻能加载页面（loading 壳）
    const basePort = Number(process.env.QQ_AGENT_PORT) || Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 启动账号健康探针（60 秒一次）
    onebotHealth.start();
    qrGuard.start();

    // 拉起 SnowLuma（如配置了自动启动）、连 OneBot。
    if (getConfig().snowluma?.autoLaunch) {
      try {
        const wsPort = snowlumaWsPort();
        if (!(await isPortOpen('127.0.0.1', wsPort))) {
          const r = await launchSnowluma();
          if (r.ok && r.launched) {
            for (let i = 0; i < 20 && !(await isPortOpen('127.0.0.1', wsPort)); i++) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }
      } catch (error) {
        log('[snowluma] 自动启动失败:', error?.message ?? error);
      }
    }
    // OneBot 连接前先尝试从 SnowLuma 配置同步令牌（脱敏副本/首次登录场景尤其重要）
    if (syncSnowlumaTokens()) {
      const c = getConfig();
      onebot.wsUrl = String(c.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(c.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      onebot.accessToken = String(c.snowluma?.accessToken || '');
      onebot.httpToken = String(c.snowluma?.httpAccessToken || c.snowluma?.accessToken || '');
    }
    await onebot.connect();
    historyRecovery.start();
    if (getConfig().groupResponse?.enabled !== false) orchestrator.startProactiveLoop();
    orchestrator.startDshWatcher(); // DSH 任务完成汇报 watcher
    scheduledRunner.start();   // 通用定时任务调度器
    log(`控制台已就绪：http://${process.env.QQ_AGENT_HOST || '127.0.0.1'}:${port}`);
    log(`OneBot（SnowLuma）: ws=${getConfig().snowluma?.wsUrl} http=${getConfig().snowluma?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  async function stop() {
    clearTimeout(logoutRefreshTimer);
    await historyRecovery.stop();
    onebotHealth.stop();
    autoLoginRecovery.stop();
    qrGuard.stop();
    scheduledRunner.stop();
    await interactions.close();
    await orchestrator.abortAll();
    onebot.close();
    server.close();
    // 内置启动的 SnowLuma：QQ Agent 退出时一并关掉，避免留一个无窗口的后台进程
    try { snowlumaProc?.kill(); } catch { /* ignore */ }
  }

  return { server, onebot, store, memory, stickers, sender, sessions, orchestrator, historyRecovery, start, stop, emit, getConfig, updateConfig, launchSnowluma, stopSnowluma, snowlumaStatus, onebotHealth, autoLoginRecovery, qrGuard };
}
