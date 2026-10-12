// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const APP_BASE = location.pathname === '/qqbot' || location.pathname.startsWith('/qqbot/') ? '/qqbot' : '';
const appUrl = (path) => APP_BASE && path.startsWith('/') ? APP_BASE + path : path;

const state = {
  tab: 'sessions',
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
  chats: [],
  currentChatKey: null,
  chatMessages: [],
  config: null,
  personaTemplates: {},
  // 覆盖人设前的临时备份（仅本页面会话内有效，刷新即失效）
  personaBackup: null,
  status: null,
  paused: false,
  pauseReason: null,
  autoFollowRunning: true,
  settingsSection: 'center',
  featureCategory: 'response',
  stickerAdmin: { loading: false, query: '', total: 0, matched: 0, entries: [], error: '', syncError: '' }
};

// ── 工具函数 ──
async function api(path, options = {}) {
  const res = await fetch(appUrl(path), {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// 时间一律按**北京时间**渲染：进程已锁 TZ=Asia/Shanghai（见 src/server.js 首行），
// 所以这里的 getHours()/getMonth() 取到的就是北京时间，不是服务器 UTC。
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = { received:'已收到',waiting:'等待合并',skipped:'已跳过',filtered:'已拦截',done: '已发言', pending: '结果待确认', noreply: '未回复', running: '运行中', error: '出错', aborted: '中止' };

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingOverlay = $('#loading-overlay');
const loadingStatus = $('#loading-status');
const loadingLogs = $('#loading-logs');
let appReady = false;
let bootLogs = [];

function setLoadingStatus(text) {
  bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = bootLogs.slice(-12).join('\n');
}

function hideLoading() {
  appReady = true;
  if (loadingOverlay) {
    loadingOverlay.style.transition = 'opacity .25s ease';
    loadingOverlay.style.opacity = '0';
    setTimeout(() => { loadingOverlay?.remove(); }, 300);
  }
}

async function pollUntilReady() {
  const startedAt = Date.now();
  try {
    const status = await api('/api/status');
    if (!status.onebot?.connected) setLoadingStatus('SnowLuma 已就绪，正在连接 OneBot…');
    else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return true;
  } catch (e) {
    if (Date.now() - startedAt > 45000) {
      setLoadingStatus('启动超时。请确认项目内 snowluma 文件夹完整，或到设置页手动启动 SnowLuma。');
      return false;
    }
    return false;
  }
}

async function bootLoop() {
  for (let i = 0; i < 90; i++) {
    if (await pollUntilReady()) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  hideLoading();
  refreshStatus();
  if (state.tab === 'sessions') loadSessions();
}

// ── 就绪度体检（傻瓜式引导的核心） ──
function assessReadiness(cfg, status) {
  const checks = [];
  if (!cfg) return { ready: false, checks: [{ ok: false, label: '配置加载失败' }] };
  const modelOk = !!(cfg.api.model && cfg.api.baseUrl);
  checks.push({ ok: modelOk, label: modelOk ? `模型已选择：${cfg.api.model}` : '还没有选择模型（必填）', fix: modelOk ? null : 'settings-api' });
  const allowOk = (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty);
  checks.push({ ok: !!allowOk, label: allowOk ? `白名单：${(cfg.allow.groups || []).length} 个群 / ${(cfg.allow.private || []).length} 个好友` : '还没有配置白名单（必填）', fix: allowOk ? null : 'settings-allow' });
  const obOk = status?.onebot?.connected;
  const acct2 = status?.onebot?.account || {};
  const acctOffline2 = acct2.online === false;
  // 分两条报：WS 连接 / 账号在线。只报前者会把"账号掉线"判成健康（2026-09-14 事故）
  checks.push({ ok: !!obOk, label: obOk ? `OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}` : 'OneBot（SnowLuma）未连接 —— 请到 SnowLuma 页签启动', fix: obOk ? null : 'snowluma-tab' });
  if (obOk) {
    const mins2 = acct2.offlineMs ? Math.round(acct2.offlineMs / 60000) : 0;
    checks.push({
      ok: !acctOffline2,
      label: acctOffline2
        ? `⚠ QQ 账号已离线${mins2 ? `（${mins2} 分钟）` : ''} —— 机器人收不到消息，请重新登录`
        : (acct2.online === true ? 'QQ 账号在线' : 'QQ 账号状态未探测（稍候自动重试）'),
      fix: acctOffline2 ? 'snowluma-tab' : null
    });
  }
  return { ready: modelOk && allowOk && obOk && !acctOffline2, checks };
}

function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  if (state.paused && state.pauseReason === 'budget') {
    show = true;
    const cap = state.config?.budget?.dailyCostYuan || 0;
    const cost = state.status?.usage?.cost ?? 0;
    html = `💰 已触发今日预算上限（¥${cost.toFixed(2)} / ¥${cap}），机器人自动暂停。可先 <a href="#" id="banner-goto-settings">设置 → 预算保险丝</a> 调整上限，然后选择"恢复"（补处理积压消息）或"恢复并全部标为已读"（丢弃积压）。`;
  } else if (state.paused) {
    show = true;
    html = '⏸ 机器人已暂停，不会处理任何消息。';
  } else if (s && !s.onebot.connected && !s.onebot.everConnected) {
    show = true;
    html = '🔌 OneBot（SnowLuma）还没连上：请确认 SnowLuma 已启动，且设置里的 WS/HTTP 地址正确。';
  }
  banner.classList.toggle('hidden', !show);
  if (show) {
    if (state.paused) {
      html += ` <button class="btn btn-small" id="banner-resume-btn">恢复</button>
        <button class="btn btn-small btn-danger" id="banner-resume-read-btn" title="恢复运行，并把暂停期间积压的所有未读消息直接标记为已读（不再处理）">恢复并全部标为已读</button>`;
    }
    banner.innerHTML = html;
    const link = $('#banner-goto-settings');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); switchTab('settings'); });
    const resumeBtn = $('#banner-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
    const resumeReadBtn = $('#banner-resume-read-btn');
    if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
  }
}

async function resumePause({ skipBacklog = false } = {}) {
  try {
    if (skipBacklog) {
      await api('/api/pause', { method: 'DELETE', body: '{}' });
    } else {
      await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
    }
    await refreshStatus();
    if (state.tab === 'chats') loadChats({ quiet: true });
  } catch (e) {
    console.error('恢复失败:', e);
  }
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  state.tab = name;
  if (name === 'sessions') loadSessions();
  if (name === 'chats') loadChats();
  if (name === 'snowluma') loadSnowlumaPage();
  if (name === 'settings') loadSettings();
}

// ── 状态栏 ──
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const receivePanel=document.querySelector('#receive-link-status');
    if(receivePanel)receivePanel.innerHTML=renderReceiveStatus();
    const s = state.status;
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    // ⚠️ 关键：WS 连着 ≠ 账号可用。NapCat 的 WS 在账号离线时依然在监听，
    // 只看 connected 会让"掉线"显示成"已连接"（2026-09-14 事故）。
    const acct = s.onebot.account || {};
    const acctOffline = acct.online === false;
    const acctUnknown = acct.online === null || acct.online === undefined;
    if (acctOffline) {
      dot.className = 'dot dot-off';
      const mins = acct.offlineMs ? Math.round(acct.offlineMs / 60000) : 0;
      label.textContent = `⚠ QQ 账号已离线${mins ? `（${mins} 分钟）` : ''} —— 机器人收不到消息，请检查登录`;
    } else if (s.onebot.connected) {
      dot.className = 'dot ' + (acctUnknown ? 'dot-wait' : 'dot-on');
      label.textContent = `OneBot 已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}`
        + (acctUnknown ? ' · 账号状态未探测' : '');
    } else {
      dot.className = 'dot ' + (s.onebot.everConnected ? 'dot-wait' : 'dot-off');
      label.textContent = 'OneBot 未连接';
    }
    $('#model-label').textContent = `模型：${s.orchestrator.model || '未设置'}`;
    const u = s.usage;
    $('#usage-label').textContent = `今日：${u.runs} 次运行 · ${fmtTokens(u.totalTokens)}${u.cost ? ` · ¥${u.cost.toFixed(2)}` : ''}`;
    // 显式展示时区（记忆系统 01 第六节：页面时间必须让用户看到北京时间）
    const tzEl = document.getElementById('tz-label');
    if (tzEl) {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const off = -d.getTimezoneOffset() / 60;
      tzEl.textContent = `北京时间 ${p2(d.getHours())}:${p2(d.getMinutes())}（UTC${off >= 0 ? '+' : ''}${off}）`;
    }
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    renderBanner();
  } catch (e) { /* 忽略瞬时错误 */ }
}

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// ── SSE ──
function connectSSE() {
  const es = new EventSource(appUrl('/api/events'));
  let refreshing=false;
  const catchUp=async()=>{
    if(document.hidden||refreshing)return;
    refreshing=true;
    try{
      if(state.tab==='chats')await loadChats({quiet:true});
      if(state.tab==='sessions'){
        await loadSessions({quiet:true});
        if(state.currentSessionId)await loadSessionDetail(state.currentSessionId,{quiet:true});
      }
      await refreshStatus();
    }finally{refreshing=false;}
  };
  es.addEventListener('open',catchUp);
  document.addEventListener('visibilitychange',catchUp);
  const recoveryPoll=setInterval(catchUp,15000);
  window.addEventListener('beforeunload',()=>{clearInterval(recoveryPoll);es.close();},{once:true});
  es.addEventListener('session-start', () => { loadSessions(); refreshStatus(); });
  es.addEventListener('receipt-update',()=>{
    if(state.tab!=='sessions')return;
    loadSessions({quiet:true});
    if(state.currentSessionId)loadSessionDetail(state.currentSessionId,{quiet:true});
  });
  es.addEventListener('session-update', (ev) => {
    const id = JSON.parse(ev.data).sessionId;
    if (id === state.currentSessionId) loadSessionDetail(id, { quiet: true });
    const item = state.sessions.find((s) => s.id === id);
    if (item && item.status !== 'done' && item.status !== 'noreply') loadSessions({ quiet: true });
  });
  es.addEventListener('session-end', () => {
    loadSessions();
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
  });
  es.addEventListener('chat-update', () => {
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
  });  es.addEventListener('onebot-status', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('status', () => refreshStatus());
  // 账号健康事件：掉线/恢复时立即刷新界面，不必等 15 秒轮询
  es.addEventListener('onebot-health', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('snowluma-status', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('snowluma-log', (ev) => {
    const d = JSON.parse(ev.data);
    if (!appReady && d?.text) {
      setLoadingStatus(d.text);
    }
    if (appReady && (state.tab === 'snowluma' || state.tab === 'settings')) {
      refreshSnowlumaLogs();
    }
  });
  es.addEventListener('feedback', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// ── 会话视图 ──
let sessionLimit=80;
$('#session-more').addEventListener('click',()=>{sessionLimit+=80;loadSessions();});
async function loadSessions({ quiet = false } = {}) {
  try {
    const loaded=[];let total=0;
    for(let offset=0;offset<sessionLimit;offset+=200) {
      const data=await api(`/api/sessions?limit=${Math.min(200,sessionLimit-offset)}&offset=${offset}`);
      loaded.push(...(data.sessions||[]));total=data.total||loaded.length;
      if(loaded.length>=total)break;
    }
    state.sessions=loaded;
    $('#session-more').hidden=loaded.length>=total;
    renderSessionList();
    // 自动跟随最新运行中的会话
    if (state.autoFollowRunning && !state.currentSessionId) {
      const running = state.sessions.find((s) => s.status === 'running');
      if (running) selectSession(running.id);
    }
  } catch (e) { if (!quiet) console.error(e); }
}

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）
setInterval(() => {
  if (state.tab === 'sessions') loadSessions({ quiet: true });
  if (state.tab === 'chats') loadChats({ quiet: true });
  if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true });
  if (state.tab === 'settings') refreshStatus();
}, 4000);

function renderSessionList() {
  const box = $('#session-items');
  box.innerHTML = state.sessions.map((s) => {
    const chatName = s.chatKey.replace('group:', '群 ').replace('private:', '私聊 ');
    return `
      <div class="session-item ${s.id === state.currentSessionId ? 'selected' : ''}" data-id="${s.id}">
        <div class="session-title">
          <span class="session-chat">${esc(chatName)}</span>
          <span class="session-time">${fmtTime(s.startedAt)}</span>
        </div>
        <div class="session-trigger">${esc(s.trigger || '')}</div>
        ${s.receipt?`<div class="session-trigger">${esc(s.receipt.reason)}</div>`:''}
        <div class="session-meta">
          <span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          <span>${s.usage ? fmtTokens(s.usage.totalTokens) : '-'}</span>
          <span>${s.rounds || 0} 轮</span>
        </div>
      </div>`;
  }).join('');
  $$('.session-item', box).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
  });
}

async function selectSession(id) {
  state.currentSessionId = id;
  state.sessionDetail = null;
  lastDetailFp = null;
  renderSessionList();
  $('#session-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadSessionDetail(id);
}

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
let lastDetailFp = null;

async function loadSessionDetail(id, { quiet = false } = {}) {
  try {
    const s = await api(`/api/sessions/${id}`);
    state.sessionDetail = s;
    if (state.currentSessionId === id && state.tab === 'sessions') renderSessionDetail(s);
  } catch (e) {
    if (!quiet) $('#session-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderSessionDetail(s) {
  const detail = $('#session-detail');
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态
  const fp = `${s.id}|${s.status}|${s.receipt?.updated||0}|${s.receipt?.reason||''}|${s.rounds || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.error ? 1 : 0}|${s.progress?.length || 0}|${s.progress?.at(-1)?.at || 0}`;
  if (lastDetailFp === fp) return;
  const firstRender = lastDetailFp === null;
  lastDetailFp = fp;

  // 保留用户的阅读位置；仅当用户本来就贴着底部时才跟随新内容（聊天式）
  const wasAtBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 48;
  const keepScroll = detail.scrollTop;
  const chatName = s.chatKey.replace('group:', '群 ').replace('private:', '私聊 ');
  const statusBadge = `<span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
  const usage = s.usage || {};

  const html = [];
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${statusBadge}</h2>
      <div class="sub">
        <span>触发：${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span>
        <span>开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · 结束 ${fmtClock(s.endedAt)}` : ' · 进行中'}</span>
        <span>模型 ${esc(s.model || '-')}</span>
        <span>${usage.calls || 0} 次调用 · ${fmtTokens(usage.promptTokens)} 入 / ${fmtTokens(usage.completionTokens)} 出 / ${fmtTokens(usage.totalTokens)} 总</span>
        <span>${s.rounds || 0} 轮工具</span>
      </div>
    </div>`);

  if(s.receipt) html.push(`<div class="coll-body"><div>${esc(s.receipt.senderName)} (${esc(s.receipt.senderId)}) · ${s.receipt.source==='history'?'历史补拉':'实时接收'}</div><div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(s.receipt.text)}</div><div>${esc(s.receipt.reason)}</div></div>`);
  html.push('<div id="v16-progress" class="persona-progress"></div>');
  if (s.systemPrompt) {
    html.push(`
      <details class="collapsible">
        <summary>系统提示（${s.systemPrompt.length} 字符，每次运行重发）</summary>
        <div class="coll-body">${esc(s.systemPrompt)}</div>
      </details>`);
  }
  if (s.userPrompt) {
    html.push(`
      <details class="collapsible" open>
        <summary>本次输入（${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档）</summary>
        <div class="coll-body">${esc(s.userPrompt)}</div>
      </details>`);
  }

  html.push('<div class="msg-flow">');
  for (const item of s.messages || []) {
    if (item.toolCall) {
      html.push(`
        <div class="tool-card ${item.toolCall.isError ? 'tool-error' : ''}">
          <div class="tool-head"><span class="tool-name">${esc(item.toolCall.name)}</span></div>
          <div class="tool-args">${esc(JSON.stringify(item.toolCall.args, null, 1))}</div>
          <div class="tool-result ${item.toolCall.isError ? 'is-error' : ''}">${esc(item.toolCall.result)}</div>
        </div>`);
    } else if (item.toolImages) {
      html.push(`
        <div class="tool-card">
          <div class="tool-head"><span class="tool-name">${esc(item.toolImages.tool)}</span>
          <span class="muted">→ ${item.toolImages.count} 张图片已作为图像输入注入模型</span></div>
        </div>`);
    } else if (item.role === 'assistant') {
      const text = typeof item.content === 'string' ? item.content : '';
      if (item.tool_calls && item.tool_calls.length && !text.trim()) continue; // 纯工具调用轮，卡片已展示
      html.push(`
        <div class="bubble bubble-assistant">
          <div class="asr-label">思考（不发送）</div>
          ${esc(text || '（无文本输出，仅调用工具）')}
        </div>`);
    }
  }
  // 发出的消息
  for (const sent of s.sent || []) {
    html.push(`
      <div class="sent-badge">
        <div class="asr-label">已发送到 QQ${sent.at ? ` · ${sent.at}` : ''}</div>
        ${esc(sent.text)}
      </div>`);
  }
  if (s.error) html.push(`<div class="session-error">${esc(s.error)}</div>`);
  if (s.finishReason) html.push(`<div class="bubble bubble-user">finish：${esc(s.finishReason)}</div>`);
  html.push('</div>');

  // 折叠面板的展开状态也要保留（否则每次刷新"系统提示"都被折回去）
  const openStates = new Map();
  detail.querySelectorAll('details.collapsible').forEach((d, i) => openStates.set(i, d.open));
  detail.innerHTML = html.join('');
  window.BotEffects?.progress(document.querySelector('#v16-progress'),s);
  detail.querySelectorAll('details.collapsible').forEach((d, i) => { if (openStates.has(i)) d.open = openStates.get(i); });
  if (firstRender || (s.status === 'running' && wasAtBottom)) {
    detail.scrollTop = detail.scrollHeight;      // 首次打开 / 贴底跟随新内容
  } else {
    detail.scrollTop = keepScroll;               // 保留阅读位置
  }
  if (s.status === 'running') {
    // 运行中轮询（仅当前打开的会话详情）
    setTimeout(() => { if (state.currentSessionId === s.id && state.tab === 'sessions') loadSessionDetail(s.id, { quiet: true }); }, 1500);
  }
}

// ── SnowLuma 页签：防闪烁基础设施 ──
// 本页每 4 秒被全局定时器刷新一次。早期实现每次都 `box.innerHTML = ...` 整块重建卡片，
// 导致二维码 <img> 与日志 <pre> 反复销毁重建、图片重复下载 → 屏幕持续闪烁。
// 现在：骨架只建一次（事件也只绑一次），之后只"按需打补丁"更新变化的文本；
// 二维码仅在 NapCat 换码（qrAt 变化）时才换 src。
const SL = { built: false, bound: false, qrTimer: null, qrAt: '', loggedIn: null, logText: '' };

function slEl(id) { return document.getElementById(id); }

function setText(id, text) {
  const el = slEl(id);
  if (el && el.textContent !== text) el.textContent = text;
}
function setDot(id, on) {
  const el = slEl(id);
  if (!el) return;
  const want = on ? 'dot dot-on' : 'dot dot-off';
  if (el.className !== want) el.className = want;
}

/** 建立卡片骨架 + 绑定事件（只做一次）。 */
function buildSnowlumaSkeleton() {
  const box = slEl('snowluma-page');
  if (!box || SL.built) return;
  box.innerHTML = `
    <div class="snowluma-page-card">
      <div class="snowluma-head">
        <h2>SnowLuma（OneBot 网关）</h2>
        <div class="snowluma-qr" id="sl-qr-panel"></div>
      </div>
      <div class="sl-login" id="sl-login-panel"></div>
      <!-- 账号总览与一键切号（2026-09-16 新增，见 renderAccountsPanel） -->
      <div class="sl-accounts" id="sl-accounts-panel"></div>
      <div class="snowluma-state-row">
        <span class="dot" id="sl-dot-run"></span>
        <span>SnowLuma：<strong id="sl-txt-run"></strong></span>
        <span class="muted" id="sl-txt-pid"></span>
        <span class="muted" id="sl-txt-mode"></span>
      </div>
      <div class="snowluma-state-row">
        <span class="dot" id="sl-dot-ob"></span>
        <span>OneBot：<strong id="sl-txt-ob"></strong></span>
        <span class="muted" id="sl-txt-obws"></span>
      </div>
      <div class="snowluma-state-row muted"><span id="sl-txt-dir"></span></div>
      <div class="snowluma-state-row">
        <span>WebUI：</span>
        <span id="sl-webui-slot"></span>
      </div>
      <div class="snowluma-actions">
        <button class="btn btn-primary" id="sl-start-btn">启动 SnowLuma</button>
        <button class="btn btn-danger" id="sl-stop-btn">关闭 SnowLuma</button>
        <button class="btn btn-small" id="sl-refresh-btn">刷新状态</button>
        <button class="btn btn-danger" id="sl-logout-all-btn">退出全部登录并刷新</button>
        <button class="btn btn-small" id="sl-open-folder-btn">打开文件夹</button>
        <span id="sl-hint" class="muted" style="font-size:12px"></span>
      </div>
      <div>
        <div class="hint" style="margin-bottom:6px">运行日志（实时滚动，仅保留最近 500 行）</div>
        <pre class="snowluma-logs-view" id="sl-logs"></pre>
      </div>
    </div>`;
  SL.built = true;
  bindSnowlumaEvents();
}

function bindSnowlumaEvents() {
  if (SL.bound) return;
  SL.bound = true;

  slEl('sl-start-btn')?.addEventListener('click', async () => {
    const btn = slEl('sl-start-btn');
    btn.disabled = true; btn.textContent = '启动中…';
    setText('sl-hint', '');
    try {
      const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
      setText('sl-hint', r.alreadyRunning ? 'SnowLuma 已经在运行 ✓' : (r.ok ? '已启动，日志见下方。' : ('启动失败：' + r.error)));
    } catch (e) { setText('sl-hint', '启动失败：' + e.message); }
    setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
  });

  slEl('sl-stop-btn')?.addEventListener('click', async () => {
    const btn = slEl('sl-stop-btn');
    btn.disabled = true; btn.textContent = '关闭中…';
    setText('sl-hint', '');
    try {
      await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
      setText('sl-hint', '已请求关闭 SnowLuma。');
    } catch (e) { setText('sl-hint', '关闭失败：' + e.message); }
    setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
  });

  slEl('sl-refresh-btn')?.addEventListener('click', () => loadSnowlumaPage());
  slEl('sl-logout-all-btn')?.addEventListener('click', async () => {
    if (!confirm('确认退出当前 AIO 机器人实例的全部登录状态？\n\n这会停止自动恢复、清空自动登录目标并重启 NapCat。不会退出手机 QQ 或其他设备，也不会删除服务器加密保存的凭据。')) return;
    const btn = slEl('sl-logout-all-btn');
    btn.disabled = true; btn.textContent = '退出并刷新中…';
    setText('sl-hint', '正在清理旧登录状态并重启 NapCat…');
    try {
      const result = await api('/api/snowluma/logout-all', { method: 'POST', body: JSON.stringify({ confirm: '退出全部登录' }) });
      if (!result.ok) throw new Error(result.error || '退出失败');
      if (location.pathname.startsWith('/qqbot')) { location.replace('/qqbot/login'); return; }
      setText('sl-hint', result.ok ? '旧登录状态已清理，正在等待新的二维码和状态探测…' : ('操作失败：' + result.error));
      SL.loggedIn = false;
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 3000);
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 10000);
    } catch (error) {
      setText('sl-hint', '退出失败：' + error.message);
    } finally {
      btn.disabled = false; btn.textContent = '退出全部登录并刷新';
    }
  });
  slEl('sl-open-folder-btn')?.addEventListener('click', async () => {
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { setText('sl-hint', '失败：' + e.message); }
  });
}

// ── 账号密码登录（含人机验证中转）──
// 目的：QQ 风控掉线时，用户可在面板里自助用账密登录，不必找管理员扫码。
// 安全：**密码明文不出浏览器** —— 前端算 MD5 后只把 passwordMd5 发给后端；
// “记住密码”也只在当前浏览器保存 QQ 号与 passwordMd5，不保存明文。
// 人机验证走腾讯 TCaptcha（NapCat 返回的 proofWaterUrl 里带 aid/sid），
// 验证通过拿到 ticket/randstr 再回传后端完成登录。
const SLLogin = { uin: '', passwordMd5: '', capSid: '', capAid: '', busy: false, timer: null, staleRetryCount: 0 };
const SL_LOGIN_MEMORY_KEY = 'qq-agent:snowluma-login:v1';

function readRememberedQQLogin() {
  try {
    const saved = JSON.parse(localStorage.getItem(SL_LOGIN_MEMORY_KEY) || 'null');
    const uin = String(saved?.uin || '').trim();
    const passwordMd5 = String(saved?.passwordMd5 || '').trim().toLowerCase();
    if (!/^\d{5,12}$/.test(uin) || !/^[a-f0-9]{32}$/.test(passwordMd5)) return null;
    return { uin, passwordMd5 };
  } catch {
    return null;
  }
}

function rememberQQLogin(uin, passwordMd5) {
  try {
    localStorage.setItem(SL_LOGIN_MEMORY_KEY, JSON.stringify({ uin, passwordMd5 }));
    return true;
  } catch {
    return false;
  }
}

function forgetQQLogin() {
  try { localStorage.removeItem(SL_LOGIN_MEMORY_KEY); } catch { /* ignore */ }
}

/** 纯 JS MD5（同步，无依赖）。密码只在这里转成 MD5，明文不上行。 */
function md5(str) {
  // 精简实现（RFC 1321），足够登录用
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function au(x, y) { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
  function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function tb(str2) {
    const n = ((str2.length + 8) >> 6) + 1;
    const blk = new Array(n * 16).fill(0);
    for (let i = 0; i < str2.length; i++) blk[i >> 2] |= str2.charCodeAt(i) << ((i % 4) * 8);
    blk[str2.length >> 2] |= 0x80 << ((str2.length % 4) * 8);
    blk[n * 16 - 2] = str2.length * 8;
    return blk;
  }
  function hex(num) { let s2 = ''; for (let i = 0; i < 4; i++) s2 += ('0' + ((num >> (i * 8)) & 0xff).toString(16)).slice(-2); return s2; }
  const utf8 = unescape(encodeURIComponent(str));
  const x = tb(utf8);
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
  }
  return hex(a) + hex(b) + hex(c) + hex(d);
}

function slLoginMsg(text, kind) {
  const el = slEl('sl-login-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'sl-login-msg' + (kind ? ' ' + kind : '');
}

function renderSnowlumaLogin(info) {
  const box = slEl('sl-login-panel');
  if (!box) return;
  if (!info?.available) {
    box.innerHTML = '<div class="muted" style="font-size:12.5px">未找到 NapCat WebUI 配置，无法使用账密登录。</div>';
    return;
  }
  const remembered = readRememberedQQLogin();
  box.innerHTML = `
    <div class="sl-login-title">账号密码登录 <span class="muted">（风控掉线时用，免扫码）</span></div>
    <div class="field-row">
      <div class="field" style="max-width:170px">
        <label>QQ 号</label>
        <input type="text" id="sl-uin" placeholder="如 3831864262" autocomplete="username">
      </div>
      <div class="field">
        <label>QQ 密码 <span class="muted">（仅在本机浏览器算 MD5，明文不上传）</span></label>
        <input type="password" id="sl-pwd" placeholder="密码" autocomplete="current-password">
      </div>
    </div>
    <div class="checkbox-row">
      <input type="checkbox" id="sl-remember-login" checked>
      <label for="sl-remember-login">记住 QQ 号和密码，下次自动填入</label>
    </div>
    <div class="hint">仅保存在当前浏览器；密码保存为登录所需的 MD5，不保存 QQ 明文密码。共享设备请取消勾选。</div>
    <div class="snowluma-actions">
      <button class="btn btn-primary btn-small" id="sl-do-login">登录</button>
      <button class="btn btn-small" id="sl-saved-login">使用服务器保存的账号登录</button>
      <button class="btn btn-small" id="sl-quick-login">快速登录（已登录过的号）</button>
      <span class="muted" id="sl-quick-list" style="font-size:12px"></span>
    </div>
    <div class="sl-login-msg" id="sl-login-msg"></div>
    <div id="sl-captcha-slot"></div>`;

  slEl('sl-do-login')?.addEventListener('click', () => doPasswordLogin());
  slEl('sl-saved-login')?.addEventListener('click', async () => {
    try {
      const saved = await api('/api/login-vault');
      if (!saved.saved || saved.unreadable || !saved.qq) return slLoginMsg('请先在功能配置中保存服务器登录凭据', 'err');
      if (SLLogin.timer) clearTimeout(SLLogin.timer);
      SLLogin.timer = null;
      SLLogin.staleRetryCount = 0;
      SLLogin.uin = saved.qq;
      SLLogin.passwordMd5 = '__server_saved__';
      slEl('sl-uin').value = saved.qq;
      await doPasswordLogin({ reuse: true });
    } catch (e) { slLoginMsg('读取失败：' + e.message, 'err'); }
  });
  slEl('sl-quick-login')?.addEventListener('click', doQuickLogin);
  const uinEl = slEl('sl-uin');
  const pwdEl = slEl('sl-pwd');
  if (remembered) {
    if (uinEl) uinEl.value = remembered.uin;
    if (pwdEl) pwdEl.placeholder = '已记住，可直接登录';
  }
  slEl('sl-remember-login')?.addEventListener('change', (event) => {
    if (event.target.checked) return;
    forgetQQLogin();
    if (pwdEl && !pwdEl.value) pwdEl.placeholder = '密码';
    slLoginMsg('已清除当前浏览器保存的 QQ 登录信息', 'ok');
  });
  loadQuickList();
}

async function loadQuickList() {
  try {
    const r = await api('/api/snowluma/login/status');
    const list = r.quickList || [];
    const el = slEl('sl-quick-list');
    if (el) el.textContent = list.length ? ('可用：' + list.join('、')) : '（暂无快速登录记录）';
    const uinEl = slEl('sl-uin');
    if (uinEl && !uinEl.value && list.length === 1) uinEl.value = list[0];
  } catch { /* ignore */ }
}

async function doQuickLogin() {
  const uin = (slEl('sl-uin')?.value || '').trim();
  if (!uin) return slLoginMsg('请先填 QQ 号', 'err');
  slLoginMsg('正在快速登录 ' + uin + ' …');
  try {
    const r = await api('/api/snowluma/login/set-quick', { method: 'POST', body: JSON.stringify({ uin }) });
    if (!r.ok) return slLoginMsg('快速登录失败：' + r.error, 'err');
    slLoginMsg('已请求快速登录，请稍候观察状态…', 'ok');
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}

async function doPasswordLogin({ reuse = false } = {}) {
  if (!reuse && SLLogin.timer) {
    clearTimeout(SLLogin.timer);
    SLLogin.timer = null;
    SLLogin.staleRetryCount = 0;
  }
  const uin = reuse ? SLLogin.uin : (slEl('sl-uin')?.value || '').trim();
  const pwdEl = slEl('sl-pwd');
  const pwd = pwdEl?.value || '';
  const remembered = readRememberedQQLogin();
  const passwordMd5 = reuse
    ? SLLogin.passwordMd5
    : (pwd ? md5(pwd) : (remembered?.uin === uin ? remembered.passwordMd5 : ''));
  if (!uin || !passwordMd5) return slLoginMsg('请填 QQ 号与密码', 'err');
  if (!/^\d{5,12}$/.test(uin)) return slLoginMsg('QQ 号格式不对', 'err');
  SLLogin.uin = uin;
  SLLogin.passwordMd5 = passwordMd5;        // 明文到此为止，不上行
  const shouldRemember = slEl('sl-remember-login')?.checked === true;
  if (passwordMd5 !== '__server_saved__') {
    if (shouldRemember) rememberQQLogin(uin, passwordMd5); else forgetQQLogin();
  }
  if (pwdEl && !shouldRemember) pwdEl.value = '';
  slLoginMsg('正在登录…');
  try {
    const r = await api('/api/snowluma/login/password', {
      method: 'POST',
      body: JSON.stringify({ uin, passwordMd5: SLLogin.passwordMd5 })
    });
    if (!r.ok) {
      const serviceStarting = reuse && /fetch failed|ECONNREFUSED|连接失败|暂时不可用/i.test(String(r.error || ''));
      if (serviceStarting && SLLogin.staleRetryCount < 2) {
        SLLogin.staleRetryCount += 1;
        slLoginMsg('NapCat 仍在启动，15 秒后再试一次…', 'warn');
        SLLogin.timer = setTimeout(() => {
          SLLogin.timer = null;
          doPasswordLogin({ reuse: true });
        }, 15000);
        return;
      }
      return slLoginMsg('登录失败：' + r.error, 'err');
    }
    if (r.alreadyLoggedIn && r.online) {
      SLLogin.staleRetryCount = 0;
      return slLoginMsg('QQ 已确认在线，无需重复登录', 'ok');
    }
    if (r.staleLogin && r.recoveryStarted) {
      if (SLLogin.staleRetryCount >= 2) {
        return slLoginMsg('NapCat 已重启两次但 QQ 仍离线，请进行扫码或新设备验证', 'warn');
      }
      SLLogin.staleRetryCount += 1;
      const retryAfterMs = Math.max(10000, Math.min(60000, Number(r.retryAfterMs) || 25000));
      slLoginMsg(`检测到“已登录但实际离线”，正在重启 NapCat；${Math.round(retryAfterMs / 1000)} 秒后自动重试…`, 'warn');
      SLLogin.timer = setTimeout(() => {
        SLLogin.timer = null;
        doPasswordLogin({ reuse: true });
      }, retryAfterMs);
      return;
    }
    if (r.needNewDevice) return startNewDeviceVerify(r.jumpUrl, r.newDevicePullQrCodeSig);
    if (r.needCaptcha) {
      slLoginMsg('需要人机验证，请在下方完成', 'warn');
      return showCaptcha(r.proofWaterUrl);
    }
    SLLogin.staleRetryCount = 0;
    slLoginMsg('登录请求已发送，稍候观察状态', 'ok');
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}


/* ───────────────────────── 账号总览与一键切号（2026-09-16 新增）─────────────────────────
 *
 * 背景：用户点了原来的「快速登录（已登录过的号）」按钮，提示「已请求快速登录，请稍候观察状态…」
 *       然后**永远没反应**。查明真凶：该按钮调的是 NapCat 的 SetQuickLoginQQ，
 *       它**只是设定『下次快速登录用哪个号』，完全不触发登录动作** —— 状态自然不会变。
 *
 * 用户诉求：「直接展示后台在线账号，然后切换过去」。
 * 本区块因此：
 *   ① 列出每个 QQ 实例**当前真实登录的账号**（UIN + 昵称 + 端点）；
 *   ② 列出已缓存可快速登录的号；
 *   ③ 提供「切到此号」按钮 → 先设定、再询问是否重启生效（两步，避免误操作掉线）。
 *
 * 数据来自外部桌面应用的 /api/qq/accounts（面板后端已透传，令牌不下发浏览器）。
 */
async function renderAccountsPanel() {
  const box = slEl('sl-accounts-panel');
  if (!box) return;
  let d;
  try {
    const r = await api('/api/accounts/overview');
    if (!r.ok) { box.innerHTML = '<div class="muted" style="font-size:12px">账号总览不可用：' + (r.error || '') + '</div>'; return; }
    d = r.data;
  } catch (e) {
    box.innerHTML = '<div class="muted" style="font-size:12px">账号总览读取失败：' + e.message + '</div>';
    return;
  }

  const rows = (d.instances || []).map((i) => `
    <div class="sl-acct-row">
      <span class="sl-acct-pill ${i.online ? 'on' : 'off'}">${i.online ? '在线' : '离线'}</span>
      <span class="sl-acct-label">${esc(i.label)}</span>
      <span class="sl-acct-uin">${i.online ? esc(i.uin + (i.nick ? '　' + i.nick : '')) : '—'}</span>
      <span class="muted" style="font-size:11px">${i.oneBotPort ? ':' + i.oneBotPort : ''}</span>
    </div>`).join('');

  const cached = (d.quickList || []).length
    ? d.quickList.map((q) => esc(q)).join('、')
    : '（无）';

  const switches = (d.switchable || []).map((s) => {
    const isCurrent = s.online && s.from === 'bot';
    return `
    <div class="sl-acct-row">
      <span class="sl-acct-pill ${s.online ? 'on' : 'off'}">${s.online ? '在线' : '已缓存'}</span>
      <span class="sl-acct-uin">${esc(s.uin)}${s.nick ? '　' + esc(s.nick) : ''}</span>
      <span class="muted" style="font-size:11px">${esc(s.fromLabel)}</span>
      <span style="flex:1"></span>
      ${isCurrent
        ? '<span class="sl-acct-cur">✓ 当前使用中</span>'
        : `<button class="btn btn-small" data-switch-uin="${esc(s.uin)}" data-switch-nick="${esc(s.nick || '')}">切到此号</button>`}
    </div>`;
  }).join('');

  box.innerHTML = `
    <div class="sl-accounts-title">后台在线账号 <span class="muted" style="font-size:11.5px">${esc(d.note || '')}</span></div>
    <div class="sl-accounts-card">
      ${rows || '<div class="muted" style="font-size:12px">未发现实例</div>'}
      <div class="muted" style="font-size:11.5px;margin-top:8px">已缓存可快速登录：${cached}</div>
    </div>
    <div class="sl-accounts-title" style="margin-top:12px">切换机器人登录账号</div>
    <div class="sl-accounts-card">
      ${switches || '<div class="muted" style="font-size:12px">暂无可切换账号</div>'}
      <div class="muted" style="font-size:11px;margin-top:8px;line-height:1.7">
        点「切到此号」= 先把它设为机器人的快速登录账号，再询问是否重启 NapCat 生效。<br>
        ⚠️ 重启期间机器人会短暂离线（30–60 秒）；同一 QQ 号不能在两处同时在线（会互踢）。
      </div>
    </div>`;

  // 绑定切号按钮
  box.querySelectorAll('[data-switch-uin]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const uin = btn.getAttribute('data-switch-uin');
      const nick = btn.getAttribute('data-switch-nick') || '';
      const ok = window.confirm(
        '将把 QQ 机器人的快速登录账号设为 ' + uin + (nick ? '（' + nick + '）' : '') + '。\n\n' +
        '⚠️ 这一步只是「设定」；需要重启 NapCat 才会真正用它登录，\n' +
        '   期间机器人会短暂离线（约 30–60 秒）。\n\n' +
        '另外：同一个 QQ 号不能在两处同时在线，否则会互踢。\n\n' +
        '确定继续吗？'
      );
      if (!ok) return;
      btn.disabled = true;
      btn.textContent = '设定中…';
      try {
        const r1 = await api('/api/accounts/switch', {
          method: 'POST',
          body: JSON.stringify({ action: 'bot-quick-login', uin })
        });
        if (!r1.ok) { alert('设定失败：' + (r1.error || '')); btn.disabled = false; btn.textContent = '切到此号'; return; }
        btn.textContent = '重启中…';
        const r2 = await api('/api/accounts/switch', {
          method: 'POST',
          body: JSON.stringify({ action: 'bot-restart' })
        });
        alert(r2.ok ? ('已设定并重启机器人。\n\n' + (r2.message || '') + '\n\n约 30–60 秒后完成登录，可稍后刷新查看。')
                    : ('设定成功，但重启失败：' + (r2.error || r2.message || '')));
      } catch (e) {
        alert('操作失败：' + e.message);
      }
      btn.disabled = false;
      btn.textContent = '切到此号';
      setTimeout(renderAccountsPanel, 1500);
    });
  });
}

// 注：HTML 转义复用文件顶部已有的 esc()（第 50 行），不重复定义。

/** 登录面板只渲染一次（否则 4 秒定时刷新会把用户输入冲掉）。 */
function renderSnowlumaLoginOnce() {
  const box = slEl('sl-login-panel');
  if (!box) return;
  if (box.dataset.ready === '1') return;      // 已建，保留用户输入
  box.dataset.ready = '1';
  api('/api/snowluma/login/info')
    .then((info) => renderSnowlumaLogin(info))
    .catch(() => { box.dataset.ready = ''; });
}

// ── 新设备扫码验证 ──
// QQ 检测到"新设备登录"时会要求用**手机 QQ 扫码**确认（不是登录二维码，是设备验证）。
// 流程：GetNewDeviceQRCode 取 str_url → 渲染二维码 → 每 2.5s 轮询 PollNewDeviceQR
//       → 手机确认后拿 str_nt_succ_token → NewDeviceLogin 完成登录。
const SLDev = { uin: '', passwordMd5: '', bytesToken: '', timer: null };

function stopDevPoll() {
  if (SLDev.timer) { clearInterval(SLDev.timer); SLDev.timer = null; }
}

async function startNewDeviceVerify(jumpUrl, sig) {
  stopDevPoll();
  const slot = slEl('sl-captcha-slot');
  if (!slot) return;
  SLDev.uin = SLLogin.uin;
  SLDev.passwordMd5 = SLLogin.passwordMd5;
  slLoginMsg('检测到新设备：请用**手机 QQ** 扫码确认（不是登录码）', 'warn');
  slot.innerHTML = '<div class="sl-captcha-box"><div class="muted">正在获取验证二维码…</div></div>';

  try {
    const r = await api('/api/snowluma/login/new-device-qr', {
      method: 'POST',
      body: JSON.stringify({ uin: SLDev.uin, jumpUrl })
    });
    if (!r.ok) { slot.innerHTML = ''; return slLoginMsg('获取验证二维码失败：' + r.error, 'err'); }
    const qr = r.qr || {};
    SLDev.bytesToken = qr.bytes_token || '';
    if (!qr.str_url) { slot.innerHTML = ''; return slLoginMsg('NapCat 未返回验证二维码', 'err'); }

    const imgTag = r.qrImage
      ? '<img class="sl-devqr-img" src="' + r.qrImage + '" alt="新设备验证二维码">'
      : '<div class="muted">（服务端未生成图片，请点下方链接）</div>';
    slot.innerHTML = '<div class="sl-captcha-box">'
      + '<div class="sl-login-title">用手机 QQ 扫码完成设备验证</div>'
      + imgTag
      + '<div class="sl-devqr-hint" id="sl-devqr-hint">等待扫码…</div>'
      + '<div class="muted" style="font-size:12px;word-break:break-all">扫码不了可复制：'
      + '<a href="' + esc(qr.str_url) + '" target="_blank" rel="noopener">验证链接</a></div>'
      + '</div>';

    startDevPoll();
  } catch (e) {
    slot.innerHTML = '';
    slLoginMsg('失败：' + e.message, 'err');
  }
}

function startDevPoll() {
  stopDevPoll();
  SLDev.timer = setInterval(async () => {
    try {
      const r = await api('/api/snowluma/login/new-device-poll', {
        method: 'POST',
        body: JSON.stringify({ uin: SLDev.uin, bytesToken: SLDev.bytesToken })
      });
      if (!r.ok) return;
      const p = r.poll || {};
      const st = p.uint32_guarantee_status;
      if (st === 3) {
        const h = slEl('sl-devqr-hint');
        if (h) h.textContent = '已扫描，请在手机上确认…';
      } else if (st === 1) {
        stopDevPoll();
        const h = slEl('sl-devqr-hint');
        if (h) h.textContent = '验证成功，正在登录…';
        // 用返回的 token 完成登录
        await finishNewDeviceLogin(p.str_nt_succ_token || SLDev.bytesToken);
      }
    } catch { /* 轮询失败继续 */ }
  }, 2500);
}

async function finishNewDeviceLogin(sig) {
  try {
    const r = await api('/api/snowluma/login/new-device', {
      method: 'POST',
      body: JSON.stringify({
        uin: SLDev.uin, passwordMd5: SLDev.passwordMd5, newDevicePullQrCodeSig: sig
      })
    });
    if (!r.ok) return slLoginMsg('设备验证后登录失败：' + r.error, 'err');
    slLoginMsg('登录成功 ✧ 稍候即可收发消息', 'ok');
    const slot = slEl('sl-captcha-slot');
    if (slot) slot.innerHTML = '';
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}

/** 渲染腾讯 TCaptcha：解析 proofWaterUrl 里的 aid/sid，动态加载 TCaptcha.js。 */
function showCaptcha(proofWaterUrl) {
  const slot = slEl('sl-captcha-slot');
  if (!slot) return;
  let aid = '', sid = '';
  try {
    const q = proofWaterUrl.includes('?') ? proofWaterUrl.split('?')[1].split('#')[0] : '';
    for (const kv of q.split('&')) {
      const [k, v] = kv.split('=');
      if (k === 'aid') aid = decodeURIComponent(v || '');
      if (k === 'sid') sid = decodeURIComponent(v || '');
    }
  } catch { /* ignore */ }
  SLLogin.capAid = aid || '2081081773';
  SLLogin.capSid = sid;
  slot.innerHTML = '<div class="sl-captcha-box"><div id="sl-captcha-target"></div>'
    + '<div class="muted" style="font-size:12px">若验证码未出现，点此手动打开：'
    + '<a href="' + esc(proofWaterUrl) + '" target="_blank" rel="noopener">验证链接</a></div></div>';

  const load = (src) => new Promise((resolve, reject) => {
    if (window.TencentCaptcha) return resolve();
    const sc = document.createElement('script');
    sc.src = src; sc.onload = () => resolve(); sc.onerror = () => reject(new Error('load fail'));
    document.head.appendChild(sc);
  });
  load('https://captcha.gtimg.com/TCaptcha.js')
    .catch(() => load('https://ssl.captcha.qq.com/TCaptcha.js'))
    .then(() => {
      const cap = new window.TencentCaptcha(SLLogin.capAid, (res) => {
        if (res.ret === 0 && res.ticket) return submitCaptcha(res.ticket, res.randstr);
        slLoginMsg('验证未通过或已取消', 'err');
      }, { type: 'popup', showHeader: false, uin: SLLogin.uin, sid: SLLogin.capSid });
      cap.show();
    })
    .catch(() => slLoginMsg('验证码脚本加载失败，请点上面的验证链接手动完成', 'err'));
}

async function submitCaptcha(ticket, randstr) {
  slLoginMsg('验证通过，正在提交…');
  try {
    const r = await api('/api/snowluma/login/captcha', {
      method: 'POST',
      body: JSON.stringify({
        uin: SLLogin.uin, passwordMd5: SLLogin.passwordMd5,
        ticket, randstr, sid: SLLogin.capSid
      })
    });
    if (!r.ok) return slLoginMsg('验证码登录失败：' + r.error, 'err');
    if (r.needNewDevice) return startNewDeviceVerify(r.jumpUrl, r.newDevicePullQrCodeSig);
    slLoginMsg('登录成功，稍候即可收发消息 ✧', 'ok');
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}

// ── 卡片右上角的登录二维码 ──
async function renderSnowlumaQr(connectedHint, selfHint) {
  const box = slEl('sl-qr-panel');
  if (!box) return;

  const showLoggedIn = (nick, uid) => {
    if (SL.loggedIn === true) return;
    SL.loggedIn = true;
    box.innerHTML = '<div class="sl-qr-done">✅ 已登录'
      + (nick ? '<br><strong>' + esc(nick) + '</strong>' : '')
      + (uid ? '<br><span class="muted">' + esc(String(uid)) + '</span>' : '')
      + '</div>';
    stopSnowlumaQrTimer();
  };

  if (connectedHint === true) return showLoggedIn(selfHint?.nickname, selfHint?.userId);

  try {
    const r = await api('/api/snowluma/qr');
    if (r.loggedIn) return showLoggedIn(r.self?.nickname, r.self?.userId);
    SL.loggedIn = false;

    if (!r.exists) {
      if (box.querySelector('.sl-qr-img') || !box.querySelector('.sl-qr-empty')) {
        box.innerHTML = '<div class="sl-qr-empty">等待 NapCat 生成二维码…<br>'
          + '<span class="muted">若长时间无二维码，请检查下方日志</span></div>';
      }
      return;
    }

    const age = Math.round((r.ageMs || 0) / 1000);
    const stale = age > 150;   // NapCat 约 2 分钟换一次
    const hint = stale ? '⏳ 二维码可能已过期，等待刷新…' : ('用手机 QQ 扫码 · ' + age + 's 前刷新');

    const img = box.querySelector('.sl-qr-img');
    if (!img) {
      box.innerHTML = '<div class="sl-qr-title">扫码登录 QQ</div>'
        + '<img class="sl-qr-img" src="' + appUrl('/api/snowluma/qr.png?t=' + Date.now()) + '" alt="登录二维码">'
        + '<div class="sl-qr-hint" id="sl-qr-hint"></div>';
      SL.qrAt = r.qrAt;
    } else if (r.qrAt && r.qrAt !== SL.qrAt) {
      SL.qrAt = r.qrAt;                    // 仅在 NapCat 换码时换图，避免闪烁
      img.src = appUrl('/api/snowluma/qr.png?t=' + Date.now());
    }
    setText('sl-qr-hint', hint);
    startSnowlumaQrTimer();
  } catch (e) {
    if (!box.querySelector('.sl-qr-empty')) {
      box.innerHTML = '<div class="sl-qr-empty">二维码加载失败<br><span class="muted">' + esc(e.message) + '</span></div>';
    }
  }
}

function startSnowlumaQrTimer() {
  if (SL.qrTimer) return;
  SL.qrTimer = setInterval(() => {
    if (state.tab !== 'snowluma') return;
    if (SL.loggedIn === true) { stopSnowlumaQrTimer(); return; }
    renderSnowlumaQr(false, null);
  }, 5000);
}
function stopSnowlumaQrTimer() {
  if (SL.qrTimer) { clearInterval(SL.qrTimer); SL.qrTimer = null; }
}

// ── SnowLuma 独立页签 ──
async function loadSnowlumaPage({ quiet = false } = {}) {
  try {
    const [status, logs] = await Promise.all([
      api('/api/status'),
      api('/api/snowluma/logs')
    ]);
    const s = status;
    const box = $('#snowluma-page');
    if (!box) return;
    const running = !!(s.snowluma?.running);
    const onebotConnected = !!s.onebot?.connected;
    const dir = s.snowluma?.dir || '';
    const embedded = !!s.snowluma?.embedded;
    const pid = s.snowluma?.pid ?? null;
    const webuiUrl = s.snowluma?.webuiUrl || '';
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';

    buildSnowlumaSkeleton();
    {
      const _s = s;
      const _running = !!( _s.snowluma?.running );
      const _obOk = !!_s.onebot?.connected;
      const _pid = _s.snowluma?.pid ?? null;
      const _embedded = !!_s.snowluma?.embedded;
      const _webui = _s.snowluma?.webuiUrl || '';

      setDot('sl-dot-run', _running);
      setText('sl-txt-run', _running ? '运行中' : '未运行');
      setText('sl-txt-pid', _pid ? ('pid ' + _pid) : '');
      setText('sl-txt-mode', _embedded ? '内置模式（随 QQ Agent 退出）' : (_running ? '独立模式' : ''));

      setDot('sl-dot-ob', _obOk);
      const _acct = _s.onebot?.account || {};
      const _acctOff = _acct.online === false;
      if (_acctOff) {
        const _m = _acct.offlineMs ? Math.round(_acct.offlineMs / 60000) : 0;
        setText('sl-txt-ob', '⚠ 账号已离线' + (_m ? ('（' + _m + ' 分钟）') : ''));
        setDot('sl-dot-ob', false);
      } else {
        setText('sl-txt-ob', _obOk ? ('已连接' + (_s.onebot.self ? ('（' + _s.onebot.self.nickname + '）') : '')) : '未连接');
        setDot('sl-dot-ob', _obOk);
      }
      setText('sl-txt-obws', _acctOff
        ? ('账号离线 —— 扫码或检查登录' + (_acct.lastError ? ('（' + _acct.lastError + '）') : ''))
        : (_s.onebot?.error ? ('WS ：' + _s.onebot.error) : ''));
      setText('sl-txt-dir', '目录：' + (dir || '（未找到项目内 snowluma/ 文件夹）'));

      const webSlot = slEl('sl-webui-slot');
      if (webSlot) {
        const want = _webui
          ? ('<button class="btn btn-small" id="sl-open-webui-btn" title="在浏览器中打开 SnowLuma 控制台">' + esc(_webui) + '</button>')
          : '<span class="muted">等待 SnowLuma 启动后自动识别…</span>';
        if (webSlot.innerHTML !== want) {
          webSlot.innerHTML = want;
          const b = slEl('sl-open-webui-btn');
          if (b) b.addEventListener('click', async () => {
            try {
              const r = await api('/api/snowluma/open-webui', { method: 'POST', body: '{}' });
              if (!r.ok) setText('sl-hint', r.error);
            } catch (e) { setText('sl-hint', '打开失败：' + e.message); }
          });
        }
      }

      const startBtn = slEl('sl-start-btn');
      if (startBtn) {
        const label = _running ? '已运行' : '启动 SnowLuma';
        if (startBtn.textContent !== label) startBtn.textContent = label;
        if (startBtn.disabled !== _running) startBtn.disabled = _running;
      }
      const stopBtn = slEl('sl-stop-btn');
      if (stopBtn && stopBtn.disabled === _running) stopBtn.disabled = !_running;

      // 日志：内容变化才写，并保持贴底滚动
      const pre = slEl('sl-logs');
      if (pre && logText !== SL.logText) {
        SL.logText = logText;
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
        pre.textContent = logText;
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      }

      // ⚠️ 必须传「账号是否真的在线」，不能传 _obOk（= WS 是否连着）。
      //    NapCat 的 WS 在账号离线时依然在监听，传 _obOk 会让面板误显示
      //    「✅ 已登录」，于是**不显示二维码**，用户想重登都没码可扫。
      //    （2026-09-16 事故：掉线后二维码消失，用户无法自助恢复）
      renderSnowlumaQr(_acctOff === false, _s.onebot?.self || null);
    renderSnowlumaLoginOnce();
    // 账号总览与一键切号：每轮刷新都重渲染（数据实时变化，且没有用户输入需要保留）
    renderAccountsPanel().catch(() => {});
    }

  } catch (e) {
    if (!quiet) console.error(e);
  }
}

// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChatList();
    if (state.currentChatKey) {
      if (document.activeElement?.closest('#manual-prompt')) return;
      // 打开着某群详情时也刷新该群消息
      loadChatMessages(state.currentChatKey);
    }
  } catch (e) { if (!quiet) console.error(e); }
}

function renderChatList() {
  const box = $('#chat-items');
  box.innerHTML = state.chats.map((c) => {
    const name = c.key.replace('group:', '群 ').replace('private:', '私聊 ');
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''}" data-key="${c.key}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(name)}</span>
          ${c.unread ? `<span class="unread-pill">${c.unread}</span>` : ''}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条</span><span>${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).join('') || '<div class="list-head muted">还没有消息存档（等白名单里的群/好友来消息）</div>';
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => selectChat(el.dataset.key));
  });
}

async function selectChat(key) {
  state.currentChatKey = key;
  state.chatOffset = 0; state.chatQuery = '';
  renderChatList();
  $('#chat-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

async function loadChatMessages(key) {
  const offset = state.chatOffset || 0, query = state.chatQuery || '';
  try {
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=200&offset=${offset}&query=${encodeURIComponent(query)}`);
    if (key !== state.currentChatKey || offset !== (state.chatOffset || 0) || query !== (state.chatQuery || '')) return;
    state.chatTotal = data.total || 0;
    state.chatMessages = data.messages || [];
    renderChatMessages();
  } catch (e) {
    if (key !== state.currentChatKey) return;
    $('#chat-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const name = key.replace('group:', '群 ').replace('private:', '私聊 ');
  const meta = state.chats.find((c) => c.key === key) || {};
  const detail = $('#chat-detail');
  const rows = state.chatMessages.map((m) => `
    <tr class="${m.read ? '' : 'unread'}">
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
    </tr>`).join('');
  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
      <div class="sub"><span>共 ${meta.total || 0} 条 · 存储于 data/messages/</span></div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">唤醒一次处理</button>
      ${key.startsWith('group:') ? '<button class="btn btn-small" id="chat-greet-btn">主动问候一次</button><span id="chat-greet-result" role="status"></span>' : ''}
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息（不走模型）" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <form id="archive-search" class="chat-toolbar">
      <input id="archive-query" aria-label="搜索存档" placeholder="消息内容、昵称或 QQ 号" value="${esc(state.chatQuery || '')}" />
      <button class="btn" type="submit">搜索</button>
      <button class="btn" type="button" id="archive-newer" ${(state.chatOffset || 0) === 0 ? 'disabled' : ''} aria-label="较新消息">←</button>
      <span>${state.chatTotal || 0} 条匹配 · 第 ${Math.floor((state.chatOffset || 0) / 200) + 1} 页</span>
      <button class="btn" type="button" id="archive-older" ${(state.chatOffset || 0) + 200 >= state.chatTotal ? 'disabled' : ''} aria-label="较早消息">→</button>
    </form>
    <form id="manual-prompt" class="chat-toolbar">
      <textarea id="manual-prompt-text" aria-label="新提示词" placeholder="输入给 bot 的新消息" maxlength="8000" rows="2" style="flex:1;min-width:160px"></textarea>
      <button class="btn btn-primary" type="submit">发送提示词</button>
      <span id="manual-prompt-result" role="status"></span>
    </form>
    <table class="archive-table"><tbody>${rows}</tbody></table>`;
  $('#manual-prompt').onsubmit = async event => {
    event.preventDefault(); const form=event.currentTarget,button=form.querySelector('button'),input=$('#manual-prompt-text'),result=$('#manual-prompt-result');
    const text=input.value.trim();if(!text)return;button.disabled=true;
    try {await api(`/api/chats/${key.replace(':','_')}/prompt`,{method:'POST',body:JSON.stringify({text})});input.value='';result.textContent='已提交处理';}
    catch(error){result.textContent=error.message;}finally{button.disabled=false;}
  };
  $('#archive-search').onsubmit = event => { event.preventDefault(); state.chatQuery = $('#archive-query').value; state.chatOffset = 0; loadChatMessages(key); };
  $('#archive-newer').onclick = () => { state.chatOffset = Math.max(0, (state.chatOffset || 0) - 200); loadChatMessages(key); };
  $('#archive-older').onclick = () => { state.chatOffset = (state.chatOffset || 0) + 200; loadChatMessages(key); };
  $('#chat-wake-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/wake`, { method: 'POST', body: '{}' });
    refreshStatus();
  });
  $('#chat-greet-btn')?.addEventListener('click', async event => {
    const button=event.currentTarget,result=$('#chat-greet-result');button.disabled=true;
    try {await api(`/api/chats/${key.replace(':','_')}/greet`,{method:'POST',body:'{}'});result.textContent='已提交问候，正在处理';}
    catch(error){result.textContent=error.message;}finally{button.disabled=false;}
  });
  $('#chat-read-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
    loadChats();
    loadChatMessages(key);
  });
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    const btn = $('#chat-testsend-btn');
    btn.textContent = '发送中…';
    try {
      await api(`/api/chats/${key.replace(':', '_')}/test-send`, { method: 'POST', body: JSON.stringify({ text }) });
      btn.textContent = '已发出 ✓';
      input.value = '';
      loadChatMessages(key);
    } catch (e) {
      btn.textContent = `失败：${e.message}`.slice(0, 40);
    }
    setTimeout(() => { btn.textContent = '发送'; }, 2500);
  });
}

// ── 设置视图 ──
async function loadSettings() {
  const [cfg, tplData, provData, visionData, capData] = await Promise.all([
    api('/api/config'),
    api('/api/persona-templates').catch(() => ({ templates: [] })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
    api('/api/capabilities').catch(() => null)
  ]);
  state.config = cfg;
  state.capabilities = capData;
  loadSearchKeys().catch(() => {});
  state.providers = provData.providers || [];
  state.visionResults = visionData.results || {};
  state.visionScanning = !!visionData.scanning;
  state.personaTemplates = {};
  for (const t of tplData.templates || []) state.personaTemplates[t.id] = { ...t, builtin: !!t.builtin };
  renderSettings();
}

function renderPersonaPicker(c) {
  const currentId = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === (c.persona?.roleText || ''))?.[0] || '';
  const currentName = state.personaTemplates[currentId]?.name || '';
  return `
    <div class="field-row" style="align-items:flex-end">
      <div class="field">
        <label>选择人设（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-persona-pick" readonly placeholder="点击选择人设" value="${esc(currentName)}" style="flex:1;cursor:pointer" />
          <button class="btn btn-small" id="new-persona-btn">＋ 添加人设</button>
          <button class="btn btn-small btn-danger hidden" id="del-persona-btn">删除当前自定义人设</button>
        </div>
        <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>`;
}

function renderPersonaSaveBar() {
  return `
    <div class="persona-save-row">
      <button class="btn btn-primary" id="save-persona-btn">保存人设修改</button>
      <span id="persona-save-result" class="muted"></span>
    </div>`;
}

function renderHealthCard() {
  const { ready, checks } = assessReadiness(state.config, state.status);
  const rows = checks.map((c) => {
    let extra = '';
    if (!c.ok && c.fix === 'snowluma-tab') {
      extra = ' <button class="btn btn-small" id="hc-goto-snowluma">前往 SnowLuma 页签</button>';
    }
    return `
    <div class="h-item ${c.ok ? 'ok' : 'bad'}">
      <span>${c.ok ? '✓' : '✗'}</span>
      <span class="h-label">${esc(c.label)}${extra}</span>
    </div>`;
  }).join('');
  const testRow = `
    <div class="h-item ${'mute'}">
      <span>·</span>
      <span class="h-label">API 连通性：
        <button class="btn btn-small" id="test-api-btn">测试一下</button>
        <span id="test-api-result" class="muted"></span>
      </span>
    </div>`;
  return `
    <div class="health-card ${ready ? 'all-ok' : ''}">
      <div class="h-title">${ready ? '✅ 一切就绪，机器人运行中' : '🧭 完成下面缺失项就能跑起来'}</div>
      ${rows}
      ${testRow}
    </div>`;
}

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）

// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '【官方资料】' : (r?.source === 'probe' ? '【在线探测】' : '');
  const t = (cls, text) => `<span class="vbadge ${cls}" title="${esc(src + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片');
  if (r.verdict === 'no-vision') return t('no', '无图片输入');
  return t('unk', '无法判定');
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 目录的"点击外部 / Esc 收起"监听器只在全局注册一次（renderSettings 每次重渲染都会
// 重建 DOM，若在这里注册会随渲染次数无限叠加、并引用已脱离文档的旧节点）。
// 事件触发时按 id 现查当前元素，天然跟随最新 DOM。
let modelDdDismissBound = false;
function bindModelDdDismiss() {
  if (modelDdDismissBound) return;
  modelDdDismissBound = true;
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('model-dd');
    if (!dd || dd.hidden || dd.contains(e.target)) return;
    const btn = document.getElementById('model-pick-btn');
    if (btn && btn.contains(e.target)) return;   // 按钮自己负责开合
    dd.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    const dd = document.getElementById('model-dd');
    if (dd && !dd.hidden && e.key === 'Escape') dd.hidden = true;
  });
}

function renderProviderColumn(c) {
  const provs = state.providers || [];
  if (!provs.length) return '<div class="muted" style="padding:10px;font-size:12px">目录为空——点"从 DSH 导入"。</div>';
  let html = '<div class="mdd-prov" data-pid="__manual__"><span class="mdd-prov-name">（手动输入模型名）</span></div>';
  for (const p of provs) {
    const warn = [!p.hasKey ? '⚠无密钥' : '', p.needsBaseUrl ? '⚠需补地址' : ''].filter(Boolean).join(' ');
    const visionOk = (p.models || []).filter((m) => visionVerdictOf(p.id, m) === 'vision').length;
    const meta = warn || `${p.models.length} 模型${visionOk ? ` · ${visionOk} 可看图` : ' · 0 可看图'}`;
    html += `<div class="mdd-prov" data-pid="${esc(p.id)}">
      <span class="mdd-prov-name">${esc(p.displayName || p.id)}</span>
      <span class="mdd-prov-meta">${esc(meta)}</span>
    </div>`;
  }
  return html;
}

function renderModelColumn(pid, c) {
  if (pid === '__manual__') {
    return '<div class="muted" style="padding:12px;font-size:12px">选此项后直接在下方"模型"输入框填任意模型名，并手动填 Base URL / Key。</div>';
  }
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) return '';
  const current = `${c.api.provider || ''}|||${c.api.model || ''}`;
  return `<div class="mp-provider"><span>${esc(p.displayName || p.id)}${p.anthropicOrigin ? ' · Anthropic 协议' : ''}</span><span class="mp-url">${esc(p.baseURL || '无端点')}</span></div>
    ${p.models.map((m) => {
      const v = `${p.id}|||${m}`;
      return `<div class="mp-row${v === current ? ' current' : ''}" data-v="${esc(v)}"><span class="mp-name">${esc(m)}</span>${visionBadge(p.id, m)}</div>`;
    }).join('')}`;
}

function applyProviderPick(value, { silent = false } = {}) {
  const hint = $('#provider-hint');
  const store = $('#cfg-provider');
  if (!value || value === '__manual__') {
    store.value = '';
    if (!silent) hint.textContent = '手动模式：直接在下面填 Base URL / Key / 模型名。';
    return;
  }
  const [pid, model] = value.split('|||');
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) { hint.textContent = '未找到该提供商，请重新从 DSH 导入。'; return; }
  store.value = pid;
  $('#cfg-model').value = model;
  const notes = [];
  if (p.baseURL) {
    $('#cfg-baseurl').value = p.baseURL;
    notes.push(`端点 ${p.baseURL}`);
  } else {
    notes.push('⚠ 该提供商地址未知，请手动填 Base URL');
  }
  if (p.hasKey && p.apiKey) {
    $('#cfg-apikey').value = p.apiKey;
    notes.push(`密钥已填充（${p.apiKeyFrom === 'manual' ? '手动保存' : `来自环境变量 ${p.apiKeyFrom}`}）`);
  } else {
    notes.push('⚠ 该提供商没有可用密钥，请手动粘贴 API Key');
  }
  if (p.anthropicOrigin) notes.push('（DSH 中为 Anthropic 协议，已按 OpenAI 兼容模式调用，若报错请换用其他模型）');
  hint.textContent = `已选 ${p.displayName || p.id} · ${model}：${notes.join('；')}`;
}

function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  const menu = [
    ['center', '功能中心'], ['api', '模型 API'], ['persona', '人设'],
    ['stickers', '表情素材'], ['login', '登录恢复'], ['system', '系统设置']
  ];
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${(s?.onebot?.account?.online === false) ? 'dot-off' : (s?.onebot?.connected ? 'dot-on' : 'dot-off')}"></span><span>${(s?.onebot?.account?.online === false) ? '⚠ 账号已离线' : (s?.onebot?.connected ? '运行中' : '未就绪')}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${s.orchestrator.model}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${menu.map(([id, label]) => `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}">${label}</button>`).join('')}
    </div>`;
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      if(settingsDirty()&&!confirm('当前有未保存的设置，放弃本页修改？'))return;
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
      if (state.settingsSection === 'stickers') loadStickerAdmin(false);
    });
  });
}

function renderSettings() {
  const c = state.config;
  const box = $('#settings-form');
  renderSettingsSidebar();
  box.innerHTML = `
    ${renderSettingsSection(c)}`;
  bindSettingsEvents(c);
  bindBotSettings();
  window.BehaviorPanel.bind(api);
  if(state.settingsSection==='center')window.FeatureCenter.bind();
  state.settingsBase=structuredClone(c);
  state.settingsInputs=settingsInputSnapshot();
}

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  const sections = {
    center: () => window.FeatureCenter.render(c,state.capabilities,state.featureCategory),
    stickers: () => renderStickerSection(),
    api: () => renderApiSection(c),
    persona: () => renderPersonaSection(c)+renderBotSettings(c,'persona'),
    login: () => window.FeatureCenter.login(c),
    system: () => renderChatSection(c)+renderOnebotSection(c)+renderDesktopSection(c)
  };
  const render = sections[sec] || sections.api;
  return `
    ${`<div class="save-bar">
      <span class="save-bar-title">${esc({center:'功能中心',stickers:'表情素材',api:'模型 API',persona:'人设',login:'登录恢复',system:'系统设置'}[sec] || '后台设置')}</span>
      ${sec==='stickers'?'':'<button class="btn btn-primary" id="save-cfg-btn">保存设置</button>'}
      <span id="cfg-save-result" class="muted"></span>
    </div>`}
    ${render()}`;
}

function renderStickerSection() {
  const data = state.stickerAdmin || { entries: [] };
  const cards = (data.entries || []).map((entry) => `
    <article class="sticker-admin-card" data-sticker-id="${esc(entry.id)}">
      <div class="sticker-admin-preview">
        ${entry.url ? `<img src="${esc(entry.url)}" alt="表情预览" loading="lazy" referrerpolicy="no-referrer" />` : '<span>暂无图片</span>'}
      </div>
      <div class="sticker-admin-body">
        <div class="sticker-admin-title">${esc(entry.desc || 'QQ 未设置备注')}</div>
        <div class="sticker-admin-meta">使用 ${Number(entry.useCount) || 0} 次 · ${esc(entry.source === 'qq' ? 'QQ 收藏' : '本地收藏')}</div>
        <label>情感 / 含义
          <input class="sticker-emotion" type="text" maxlength="500" placeholder="例如：开心、得意、看到好消息" value="${esc(entry.localNote || '')}" />
        </label>
        <label>适合使用的场景
          <textarea class="sticker-usage" maxlength="500" placeholder="例如：群友夸奖bot时，开心回应">${esc(entry.usage || '')}</textarea>
        </label>
        <label>标签
          <input class="sticker-tags" type="text" placeholder="开心，赞同，庆祝" value="${esc((entry.tags || []).join('，'))}" />
        </label>
        <div class="sticker-admin-actions">
          <button class="btn btn-primary btn-small sticker-save" type="button">保存备注</button>
          <span class="muted sticker-save-result"></span>
        </div>
      </div>
    </article>`).join('');
  return `
    <div class="sticker-admin-head">
      <div><div class="bot-eyebrow">STICKER LIBRARY / 本地持久化</div><h3>表情包管理</h3></div>
      <div class="sticker-admin-count">${data.loading ? '加载中…' : `${Number(data.matched) || 0} / ${Number(data.total) || 0} 个表情`}</div>
    </div>
    <div class="sticker-admin-toolbar">
      <input id="sticker-search" type="search" placeholder="搜索情感、场景、标签或 QQ 备注" value="${esc(data.query || '')}" />
      <button class="btn btn-small" id="sticker-search-btn" type="button">搜索</button>
      <button class="btn btn-small" id="sticker-clear-search-btn" type="button">清空</button>
      <button class="btn btn-primary btn-small" id="sticker-sync-btn" type="button">同步 QQ 收藏表情</button>
    </div>
    <div class="hint">你填写的“情感 / 含义”、使用场景和标签会保存在 data/stickers.json，并优先提供给机器人选择表情。同步不会覆盖本地备注。</div>
    <div id="sticker-admin-status" class="sticker-admin-status ${data.error ? 'error' : ''}">${esc(data.error || data.syncError || '')}</div>
    <div class="sticker-admin-grid">${cards || `<div class="sticker-admin-empty">${data.loading ? '正在读取表情库…' : '没有找到表情。请先连接 QQ，再点击“同步 QQ 收藏表情”。'}</div>`}</div>`;
}

async function loadStickerAdmin(force = false, query = state.stickerAdmin?.query || '') {
  state.stickerAdmin = { ...(state.stickerAdmin || {}), loading: true, query, error: '' };
  if (state.settingsSection === 'stickers') renderSettings();
  try {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    if (force) params.set('force', '1');
    const result = await api(`/api/stickers?${params.toString()}`);
    state.stickerAdmin = { ...result, query, loading: false, error: '' };
  } catch (error) {
    state.stickerAdmin = { ...(state.stickerAdmin || {}), query, loading: false, error: error.message };
  }
  if (state.settingsSection === 'stickers') renderSettings();
}

function bindStickerAdminEvents() {
  const search = $('#sticker-search');
  const runSearch = () => loadStickerAdmin(false, search?.value.trim() || '');
  $('#sticker-search-btn')?.addEventListener('click', runSearch);
  search?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); runSearch(); }
  });
  $('#sticker-clear-search-btn')?.addEventListener('click', () => loadStickerAdmin(false, ''));
  $('#sticker-sync-btn')?.addEventListener('click', () => loadStickerAdmin(true, search?.value.trim() || ''));
  $$('.sticker-admin-card').forEach((card) => {
    card.querySelector('.sticker-save')?.addEventListener('click', async () => {
      const button = card.querySelector('.sticker-save');
      const result = card.querySelector('.sticker-save-result');
      button.disabled = true;
      if (result) result.textContent = '保存中…';
      try {
        const response = await api('/api/stickers/note', {
          method: 'POST',
          body: JSON.stringify({
            id: card.dataset.stickerId,
            note: card.querySelector('.sticker-emotion')?.value.trim() || '',
            usage: card.querySelector('.sticker-usage')?.value.trim() || '',
            tags: (card.querySelector('.sticker-tags')?.value || '').split(/[,，\s]+/).filter(Boolean)
          })
        });
        const index = state.stickerAdmin.entries.findIndex((entry) => entry.id === response.entry.id);
        if (index >= 0) state.stickerAdmin.entries[index] = { ...state.stickerAdmin.entries[index], ...response.entry };
        if (result) result.textContent = '已保存';
      } catch (error) {
        if (result) result.textContent = `失败：${error.message}`;
      } finally {
        button.disabled = false;
      }
    });
  });
}

function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  return `
    <h3 id="settings-api">模型 API</h3>
    <div class="field"><label>模型目录（点击选择）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-model-pick" readonly placeholder="点击选择模型" value="${esc(currentModelDisplay || '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="test-provider-btn">测试连通性</button>
        <span id="provider-test-result" class="muted" style="align-self:center"></span>
      </div>
      <div class="hint" id="provider-hint">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}` : '尚未选择模型'}</div>
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
    </div>
    <div class="field-row">
      <div class="field"><label>当前 Base URL</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-baseurl" readonly value="${esc(c.api.baseUrl)}" style="flex:1" />
          <button class="btn btn-small" id="fetch-current-models-btn">获取列表</button>
        </div></div>
      <div class="field"><label>当前 API Key</label><input type="text" id="cfg-apikey" value="${esc(c.api.apiKey)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>温度</label><input type="number" id="cfg-temperature" step="0.1" min="0" max="2" value="${esc(c.api.temperature)}" /></div>
      <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="cfg-maxrounds" min="1" max="40" value="${esc(c.api.maxRounds)}" /></div>
    </div>
    <div class="settings-divider"></div>
    <h3>备用 API</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-fallback-enabled" ${c.api?.fallback?.enabled ? 'checked' : ''} />
      <label for="cfg-fallback-enabled">主 API 连接或请求超时时自动切换备用 API</label></div>
    <div class="field-row">
      <div class="field"><label>备用 Base URL</label><input type="text" id="cfg-fallback-baseurl" placeholder="https://api.example.com/v1" value="${esc(c.api?.fallback?.baseUrl || '')}" /></div>
      <div class="field"><label>备用 API Key</label><input type="password" id="cfg-fallback-apikey" autocomplete="off" value="${esc(c.api?.fallback?.apiKey || '')}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>备用模型（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-fallback-model" readonly placeholder="点击获取并选择备用模型" value="${esc(c.api?.fallback?.model || '')}" style="flex:1;min-width:0;cursor:pointer" />
          <button class="btn btn-small" type="button" id="fetch-fallback-models-btn">获取列表</button>
        </div>
        <div class="hint" id="fallback-model-hint">从备用中转站读取真实模型列表，点击模型即可选中。</div>
      </div>
      <div class="field"><label>备用超时（秒）</label><input type="number" id="cfg-fallback-timeout" min="5" max="180" value="${Math.round(Number(c.api?.fallback?.timeoutMs || 60000) / 1000)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>连续超时阈值</label><input type="number" id="cfg-fallback-threshold" min="1" max="10" value="${Number(c.api?.fallback?.failureThreshold) || 1}" /></div>
      <div class="field"><label>故障冷却（分钟）</label><input type="number" id="cfg-fallback-cooldown" min="1" max="60" value="${Math.round(Number(c.api?.fallback?.cooldownMs || 300000) / 60000)}" /></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><button class="btn btn-small" type="button" id="test-fallback-btn">测试备用接口</button><span id="fallback-test-result" class="muted"></span></div>
    <div class="hint">只在连接超时或请求超时时切换。鉴权、模型不存在、请求格式错误不会切换；一次请求最多尝试一个备用接口。超时不代表主接口没有计费。</div>
    <h3>手动添加提供商</h3>
    <div class="field"><label>Base URL（可填写）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="new-baseurl" placeholder="例如 http://127.0.0.1:8787/v1 或 https://api.example.com/v1" style="flex:1" />
        <button class="btn btn-small" id="fetch-models-btn">获取列表</button>
      </div></div>
    <div class="field"><label>API Key</label><input type="text" id="new-apikey" placeholder="sk-..." /></div>
    <div class="field"><label>模型 id（两列：左侧模型 ID，右侧模型目录中显示的名字；可添加多行）</label>
      <div id="model-rows"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-small" id="add-model-row-btn">＋ 添加一行</button>
      </div>
      <div class="hint">「获取列表」会从上面的 Base URL 拉取模型，并在弹窗里勾选加入列表。</div></div>
    <div class="field-row">
      <div class="field"><button class="btn btn-primary" id="confirm-add-provider-btn">确认添加</button></div>
      <div class="field"><button class="btn btn-danger" id="delete-model-btn">删除模型…</button></div>
    </div>
    <div class="hint" id="provider-action-hint"></div>`;
}

function renderPersonaSection(c) {
  return `
    <h3>人设</h3>
    ${renderPersonaPicker(c)}
    <div class="field-row">
      <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona.botName)}" /></div>
      <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona.selfNickname || '')}" /></div>
    </div>
    <div id="persona-backup-bar" style="display:flex;gap:8px;align-items:center;min-height:20px"></div>
    <div class="field"><label>角色设定（每轮注入，群友不可修改）</label>
      <div class="hint" style="margin-bottom:6px">选模板不会直接覆盖：会先问「覆盖还是追加」，覆盖前自动备份、可一键还原。</div>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是运维群里的老油条……">${esc(c.persona.roleText || '')}</textarea></div>
    <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px">${esc(c.persona.customRules || '')}</textarea></div>
    ${renderPersonaSaveBar()}`;
}


// ── 能力面板：展示机器人当前具备的工具与功能（数据来自 /api/capabilities）──
// ── AnySearch Key 管理 ──────────────────────────────
function renderSearchKeyRows() {
  const box = $('#search-key-rows');
  if (!box) return;
  const sk = state.searchKeys || {};
  const masked = sk.configKeys || [];
  const envCount = sk.envCount || 0;
  const rows = [];
  if (envCount > 0) {
    rows.push('<div class="muted" style="font-size:12px;margin-bottom:6px">检测到 ' + envCount + ' 个环境变量注入的 Key（优先使用，不在此显示）</div>');
  }
  const n = Math.max(masked.length, 1);
  for (let i = 0; i < n; i++) {
    const v = masked[i] || '';
    rows.push('<div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">' +
      '<input type="text" class="search-key-input" data-idx="' + i + '" placeholder="粘贴 AnySearch API Key" value="' + esc(v) + '" style="flex:1" />' +
      '<button class="btn btn-small" type="button" data-del-key="' + i + '" title="删除这一项">✕</button>' +
      '</div>');
  }
  box.innerHTML = rows.join('');
  box.querySelectorAll('[data-del-key]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.delKey);
      const inputs = [...box.querySelectorAll('.search-key-input')];
      if (inputs[idx]) inputs[idx].value = '';
      el.closest('div').style.opacity = '.4';
      el.disabled = true;
    });
  });
}

async function loadSearchKeys() {
  try {
    state.searchKeys = await api('/api/search-keys');
    renderSearchKeyRows();
  } catch (e) { /* 忽略 */ }
}

async function saveSearchKeys() {
  const box = $('#search-key-rows');
  const out = $('#search-key-result');
  if (!box) return;
  const inputs = [...box.querySelectorAll('.search-key-input')];
  const keys = inputs.map((el) => el.value.trim()).filter(Boolean);
  // 只提交新填的（含 **** 的是遮影值，不提交）
  try {
    const r = await fetch(appUrl('/api/search-keys'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys })
    });
    const j = await r.json();
    if (j.ok) {
      if (out) out.textContent = '已保存 ' + j.saved + ' 个 Key';
      await loadSearchKeys();
    } else if (out) out.textContent = '保存失败：' + (j.error || '');
  } catch (e) {
    if (out) out.textContent = '保存失败：' + e.message;
  }
}

function renderAllowSection(c) {
  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <div class="hint" style="margin-bottom:10px">白名单为空时机器人不会在任何群聊/私聊内运行。</div>
    <div class="field"><label>从 QQ 账号直接勾选（不用查群号）</label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-small" id="pick-groups-btn">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn">选择好友</button>
        <span id="pick-result" class="muted" style="align-self:center"></span>
      </div></div>
    <div class="field-row">
      <div class="field"><label>允许的群号（逗号分隔）</label><input type="text" id="cfg-allowgroups" value="${esc((c.allow.groups || []).join(','))}" /></div>
      <div class="field"><label>允许的 QQ（逗号分隔）</label><input type="text" id="cfg-allowprivate" value="${esc((c.allow.private || []).join(','))}" /></div>
    </div>`;
}

function renderChatSection(c) {
  return `
    <h3>运行节奏</h3>
    <div class="field-row">
      <div class="field"><label>防抖聚批窗口（毫秒）—— 等连发消息聚成一批再开运行</label><input type="number" id="cfg-wakedelay" min="0" value="${esc(c.wakeDelayMs)}" /></div>
      <div class="field"><label>批次间隔（毫秒）—— 上轮结束到下轮处理的间隔</label><input type="number" id="cfg-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      <div class="field"><label>同时处理几个会话</label><input type="number" id="cfg-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
    </div>

    <h3>发送保护</h3>
    <div class="field-row">
      <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="cfg-mingap" min="200" value="${esc(c.send.minGapMs)}" /></div>
      <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="cfg-maxgap" min="500" value="${esc(c.send.maxGapMs)}" /></div>
      <div class="field"><label>每分钟最多发送</label><input type="number" id="cfg-maxpermin" min="0" value="${esc(c.send.maxPerMinute)}" /></div>
    </div>

    <h3>发给模型的聊天记录</h3>
    <div class="field-row">
      <div class="field"><label>最多条数</label>
        <input type="number" id="cfg-pastlimit" min="10" max="500" value="${esc(c.store?.pastStateLimit ?? 80)}" />
        <div class="hint">每次运行提示词里"过去状态"最多携带的历史消息条数。</div></div>
      <div class="field"><label>字符预算</label>
        <input type="number" id="cfg-pastchars" min="1000" max="60000" step="500" value="${esc(c.store?.pastStateMaxChars ?? 6000)}" />
        <div class="hint">聊天记录的总字符上限，超出时从最旧的开始丢弃。保存后下次运行立即生效。</div></div>
    </div>`;
}

function renderDesktopSection(c) {
  return `
    <h3>桌面端</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">开机自启（登录 Windows 后自动运行）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">点关闭时最小化到托盘（机器人常驻，从托盘真正退出）</label></div>`;
}

function renderReceiveStatus(){
  const onebot=state.status?.onebot||{},t=onebot.transport||{},r=onebot.receive||{},c=r.counts||{};
  const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'暂无';
  const labels={stored:'已存档',filtered:'接入权限过滤',duplicate:'重复消息',unsupported:'不支持的消息格式',error:'处理失败',enrichmentFailed:'附加查询超时或失败',self:'自身消息回显'};
  return `<dl><dt>QQ 账号</dt><dd>${onebot.account?.online===true?'在线':onebot.account?.online===false?'离线':'未确认'}</dd>
    <dt>消息连接</dt><dd>${!t.connected?'未连接':t.heartbeatVerified?'已连接，心跳已验证':'已连接，等待心跳验证'}</dd>
    <dt>最近心跳响应</dt><dd>${time(t.lastPongAt)}</dd><dt>最近事件</dt><dd>${time(t.lastEventAt)}</dd>
    <dt>最近消息</dt><dd>${time(r.lastReceivedAt)}</dd><dt>最近存档</dt><dd>${time(r.lastStoredAt)}</dd>
    <dt>本次进程接收</dt><dd>群聊 ${c.group||0} · 私聊 ${c.private||0} · 已存档 ${c.stored||0}</dd>
    <dt>处理结果</dt><dd>${Object.entries(labels).map(([key,label])=>`${label} ${c[key]||0}`).join(' · ')}</dd>
    <dt>连接重试</dt><dd>${t.reconnects||0}</dd>
    <dt>历史补查</dt><dd>${time(onebot.history?.lastCheckAt)} · 已补回 ${onebot.history?.recovered||0} 条 · 失败 ${onebot.history?.failures||0} 次</dd></dl>
    ${onebot.history?.lastError ? '<p class="error">历史补查失败，请检查 NapCat 历史消息接口。实时接收仍会继续。</p>' : ''}
    ${t.error?`<p class="error">${esc(t.error)}</p>`:''}
    <ul>${(r.recent||[]).slice(0,6).map(x=>`<li>${time(x.at)} ${labels[x.result]||'其他'}</li>`).join('')}</ul>`;
}
function renderOnebotSection(c) {
  return `
    <h3 id="settings-onebot">OneBot（SnowLuma）</h3>
    <h4>消息接收诊断</h4><div id="receive-link-status" aria-live="polite">${renderReceiveStatus()}</div>
    <button class="btn" id="reconnect-message-link" type="button">重连消息通道</button><span id="reconnect-message-result" role="status"></span>
    <div class="hint" style="margin-bottom:10px">SnowLuma 的启动、关闭与日志已移动到顶部「SnowLuma」页签。此处只保留连接配置。</div>
    <div class="field"><label>SnowLuma 程序目录（留空 = 自动使用项目内 snowluma/ 文件夹）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" style="flex:1" />
        <button class="btn btn-small" id="open-snowluma-btn">打开文件夹</button>
      </div>
      <div class="hint" id="snowluma-hint"></div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-snowlumalaunch" ${c.snowluma.autoLaunch ? 'checked' : ''} />
      <label for="cfg-snowlumalaunch">QQ Agent 启动时自动拉起 SnowLuma（未运行时）</label></div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.snowluma.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.snowluma.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label><input type="password" id="cfg-obtoken" value="${esc(c.snowluma.accessToken || '')}" /></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填；SnowLuma 默认分开）</label><input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma.httpAccessToken || '')}" /></div>
    </div>
    <div class="hint">改完 OneBot 地址需要重启应用生效；模型/人设/白名单即时生效。</div>`;
}

function bindSettingsEvents(c) {
  const reconnectLink=document.querySelector('#reconnect-message-link');
  if(reconnectLink)reconnectLink.onclick=async()=>{
    reconnectLink.disabled=true;const result=document.querySelector('#reconnect-message-result');
    try{await api('/api/onebot/reconnect',{method:'POST',body:'{}'});result.textContent='已发起重连，QQ 登录状态未清除';await refreshStatus();}
    catch(error){result.textContent=error.message;}finally{reconnectLink.disabled=false;}
  };
  bindStickerAdminEvents();
  const groupEnabled = $('#cfg-feature-group-enabled');
  const groupKeywordOnly = $('#cfg-feature-group-keyword-only');
  const groupKeywords = $('#cfg-feature-group-keywords');
  const syncGroupResponseControls = () => {
    if (!groupEnabled) return;
    if (groupKeywordOnly) groupKeywordOnly.disabled = !groupEnabled.checked;
    if (groupKeywords) groupKeywords.disabled = !groupEnabled.checked || !groupKeywordOnly?.checked;
  };
  if (groupEnabled) groupEnabled.addEventListener('change', syncGroupResponseControls);
  if (groupKeywordOnly) groupKeywordOnly.addEventListener('change', syncGroupResponseControls);
  syncGroupResponseControls();

  const recoveryBtn = $('#run-auto-recovery-btn');
  if (recoveryBtn) recoveryBtn.addEventListener('click', async () => {
    const out = $('#auto-recovery-result');
    recoveryBtn.disabled = true;
    recoveryBtn.textContent = '恢复中…';
    if (out) out.textContent = '正在检查快速登录缓存并请求恢复…';
    try {
      await saveConfig({ quiet: true });
      const result = await api('/api/auto-recovery/run', { method: 'POST', body: '{}' });
      if (out) out.textContent = result.ok
        ? `已请求恢复 QQ ${result.targetQQ || ''}，请稍候查看在线状态`
        : `未能自动恢复：${result.error || result.status?.lastError || result.skipped || '需要人工处理'}`;
      refreshStatus();
    } catch (error) {
      if (out) out.textContent = '恢复失败：' + error.message;
    } finally {
      recoveryBtn.disabled = false;
      recoveryBtn.textContent = '立即尝试恢复';
    }
  });

  // AnySearch Key 的添加/保存按钮
  const addKeyBtn = $('#add-search-key-btn');
  if (addKeyBtn) addKeyBtn.addEventListener('click', () => {
    const box = $('#search-key-rows');
    if (!box) return;
    const inputs = box.querySelectorAll('.search-key-input');
    const idx = inputs.length;
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center';
    div.innerHTML = '<input type="text" class="search-key-input" data-idx="' + idx + '" placeholder="粘贴 AnySearch API Key" style="flex:1" />' +
      '<button class="btn btn-small" type="button" title="清空">✕</button>';
    div.querySelector('button').addEventListener('click', () => { div.remove(); });
    box.appendChild(div);
  });
  const saveKeyBtn = $('#save-search-keys-btn');
  if (saveKeyBtn) saveKeyBtn.addEventListener('click', saveSearchKeys);

  // 保存当前区块设置（通用保存按钮）。只有当前区块的字段才会被读取，不会 null 报错。
  const saveCfgBtn = $('#save-cfg-btn');
  if (saveCfgBtn) saveCfgBtn.addEventListener('click', async () => {
    saveCfgBtn.disabled=true;
    $('#cfg-save-result').textContent='保存中…';
    try {
      await saveConfig();
      state.capabilities = await api('/api/capabilities').catch(() => state.capabilities);
      window.FeatureCenter.sync();
      $('#cfg-save-result').textContent = '已保存 ✓';
      refreshStatus();
    } catch (e) {
      $('#cfg-save-result').textContent = `保存失败：${e.message}`;
    } finally {saveCfgBtn.disabled=false;}
  });

  // ── 模型 API 区块事件 ──
  // 点击文本框弹出选择模态框（无“选择”按钮）
  const modelPickInput = $('#cfg-model-pick');
  if (modelPickInput) modelPickInput.addEventListener('click', () => openModelPicker());
  const testProviderBtn = $('#test-provider-btn');
  if (testProviderBtn) testProviderBtn.addEventListener('click', async () => {
    const btn = testProviderBtn;
    const out = $('#provider-test-result');
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      const baseUrl = $('#cfg-baseurl')?.value.trim() || '';
      const apiKey = $('#cfg-apikey')?.value.trim() || '';
      const model = $('#cfg-model')?.value.trim() || '';
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, model })
      });
      const res = r.result || {};
      if (out) out.textContent = res.ok
        ? `✓ 测试通过（${res.latencyMs}ms）：${res.note || '请求成功'}`
        : `✗ 测试失败：${res.note || '未知错误'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.textContent = '测试连通性';
  });

  const testFallbackBtn = $('#test-fallback-btn');
  if (testFallbackBtn) testFallbackBtn.addEventListener('click', async () => {
    const out = $('#fallback-test-result');
    testFallbackBtn.disabled = true;
    testFallbackBtn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({
          baseUrl: $('#cfg-fallback-baseurl')?.value.trim() || '',
          apiKey: $('#cfg-fallback-apikey')?.value.trim() || '',
          model: $('#cfg-fallback-model')?.value.trim() || ''
        })
      });
      const result = r.result || {};
      if (out) out.textContent = result.ok
        ? `✓ 备用接口可用（${result.latencyMs}ms）`
        : `✗ ${result.note || '测试失败'}`;
    } catch (error) {
      if (out) out.textContent = '测试失败：' + error.message;
    } finally {
      testFallbackBtn.disabled = false;
      testFallbackBtn.textContent = '测试备用接口';
    }
  });

  const fetchFallbackBtn = $('#fetch-fallback-models-btn');
  const fallbackModelInput = $('#cfg-fallback-model');
  const fetchFallbackModels = async () => {
    const out = $('#fallback-model-hint');
    const baseUrl = $('#cfg-fallback-baseurl')?.value.trim() || '';
    const apiKey = $('#cfg-fallback-apikey')?.value.trim() || '';
    if (!baseUrl) {
      if (out) out.textContent = '请先填写备用 Base URL。';
      return;
    }
    if (fetchFallbackBtn) {
      fetchFallbackBtn.disabled = true;
      fetchFallbackBtn.textContent = '拉取中…';
    }
    if (out) out.textContent = '正在读取备用中转站模型列表…';
    try {
      const result = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey })
      });
      const models = result.models || [];
      if (!models.length) {
        if (out) out.textContent = '备用中转站没有返回可选模型。';
        return;
      }
      if (out) out.textContent = `已读取 ${models.length} 个模型，请在弹窗中选择。`;
      openFallbackModelPicker(models);
    } catch (error) {
      if (out) out.textContent = `获取失败：${error.message}`;
    } finally {
      if (fetchFallbackBtn) {
        fetchFallbackBtn.disabled = false;
        fetchFallbackBtn.textContent = '获取列表';
      }
    }
  };
  if (fetchFallbackBtn) fetchFallbackBtn.addEventListener('click', fetchFallbackModels);
  if (fallbackModelInput) fallbackModelInput.addEventListener('click', fetchFallbackModels);

  // 当前 Base URL 右侧的“获取列表”
  const fetchCurrentBtn = $('#fetch-current-models-btn');
  if (fetchCurrentBtn) fetchCurrentBtn.addEventListener('click', async () => {
    const btn = fetchCurrentBtn;
    const base = $('#cfg-baseurl')?.value.trim() || '';
    const key = $('#cfg-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '当前 Base URL 为空'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  const fetchModelsBtn = $('#fetch-models-btn');
  if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
    const btn = fetchModelsBtn;
    const base = $('#new-baseurl')?.value.trim() || '';
    const key = $('#new-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '请先填写 Base URL'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  // 模型列表行：ID + 显示名
  let modelRows = [{ id: '', name: '' }];
  function renderModelRows() {
    const box = $('#model-rows');
    if (!box) return;
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th style="width:44%">模型 ID</th><th style="width:44%">模型目录显示名</th><th></th></tr>
        ${modelRows.map((row, i) => `
          <tr>
            <td><input type="text" class="mr-id" data-i="${i}" placeholder="如 glm-5.3-flash" value="${esc(row.id)}" /></td>
            <td><input type="text" class="mr-name" data-i="${i}" placeholder="如 智谱 GLM 5.3 Flash" value="${esc(row.name)}" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger mr-del" data-i="${i}" ${modelRows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.mr-id').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].id = el.value; });
    });
    box.querySelectorAll('.mr-name').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].name = el.value; });
    });
    box.querySelectorAll('.mr-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (modelRows.length <= 1) return;
        modelRows.splice(Number(el.dataset.i), 1);
        renderModelRows();
      });
    });
  }
  renderModelRows();
  const addModelRowBtn = $('#add-model-row-btn');
  if (addModelRowBtn) addModelRowBtn.addEventListener('click', () => {
    modelRows.push({ id: '', name: '' });
    renderModelRows();
  });

  const confirmAddProviderBtn = $('#confirm-add-provider-btn');
  if (confirmAddProviderBtn) confirmAddProviderBtn.addEventListener('click', async () => {
    const baseUrl = $('#new-baseurl').value.trim();
    const apiKey = $('#new-apikey').value.trim();
    const models = modelRows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id);
    if (!baseUrl) { $('#provider-action-hint').textContent = '请填写 Base URL'; return; }
    if (!models.length) { $('#provider-action-hint').textContent = '请至少添加一个模型（先点「获取列表」勾选，或手动填一行）'; return; }
    try {
      const r = await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models }) });
      $('#provider-action-hint').textContent = r.created ? '已添加新提供商，并自动切换为当前模型。' : '该 Base URL 已存在，模型已合并进该提供商。';
      modelRows = [{ id: '', name: '' }];
      renderModelRows();
      $('#new-baseurl').value = '';
      $('#new-apikey').value = '';
      setTimeout(() => loadSettings(), 500);
    } catch (e) {
      $('#provider-action-hint').textContent = `添加失败：${e.message}`;
    }
  });

  const deleteModelBtn = $('#delete-model-btn');
  if (deleteModelBtn) deleteModelBtn.addEventListener('click', () => openModelDeleteModal());

  // 图片输入开关联动（视觉扫描结果）
  function syncVisionSwitch(pid, model) {
    const box = $('#cfg-vision');
    const hint = $('#vision-switch-hint');
    if (!box) return;
    const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
    if (r && r.verdict === 'no-vision') {
      box.checked = false;
      box.disabled = true;
      if(hint)hint.textContent = '此模型无图片输入';
    } else {
      box.disabled = false;
      box.checked = state.config.api.vision !== false;
      if(hint)hint.textContent = r && r.verdict === 'vision' ? '检测结果：支持图片输入' : '';
    }
  }
  syncVisionSwitch(c.api.provider, c.api.model);

  // ── 人设区块事件 ──
  renderPersonaBackupBar();
  const personaPick = $('#cfg-persona-pick');
  function currentPersonaId() {
    const roleText = $('#cfg-roletext')?.value ?? '';
    const found = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === roleText);
    return found ? found[0] : '';
  }
  function syncPersonaButtons() {
    const id = currentPersonaId();
    const tpl = state.personaTemplates[id];
    const isCustom = id.startsWith('custom_');
    const delBtn = $('#del-persona-btn');
    if (delBtn) delBtn.classList.toggle('hidden', !isCustom);
    const hint = $('#persona-pick-hint');
    if (hint) hint.textContent = tpl ? (tpl.builtin ? '空白模板' : '自定义人设') : '';
  }
  if (personaPick) {
    personaPick.addEventListener('click', () => openPersonaPicker());
  }
  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    if (!confirm(`确定删除自定义人设「${tpl.name}」？`)) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      $('#cfg-roletext').value = state.personaTemplates.blank?.text || '';
      $('#cfg-customrules').value = '';
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
    }
  });
  const savePersonaBtn = $('#save-persona-btn');
  if (savePersonaBtn) savePersonaBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      $('#persona-save-result').textContent = '人设已保存 ✓';
      setTimeout(() => { $('#persona-save-result').textContent = ''; }, 3000);
    } catch (e) {
      $('#persona-save-result').textContent = `保存失败：${e.message}`;
    }
  });
  syncPersonaButtons();

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

  // ── OneBot 区块事件 ──
  const openSnowlumaBtn = $('#open-snowluma-btn');
  if (openSnowlumaBtn) openSnowlumaBtn.addEventListener('click', async () => {
    await saveConfig({ quiet: true });
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { $('#snowluma-hint').textContent = `失败：${e.message}`; }
  });
}

// ── 模型选择/添加/删除 模态框 ──
function closeModelModal(overlay) {
  if (overlay) overlay.remove();
}

function modelModalShell({ head, body, foot = '', danger = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'model-modal-overlay';
  overlay.innerHTML = `
    <div class="model-modal ${danger ? 'danger' : ''}">
      <div class="model-modal-head">
        <span>${head}</span>
        <button class="model-modal-close">×</button>
      </div>
      <div class="model-modal-body">${body}</div>
      ${foot ? `<div class="model-modal-foot">${foot}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModelModal(overlay);
  });
  overlay.querySelector('.model-modal-close').addEventListener('click', () => closeModelModal(overlay));
  return overlay;
}

// ── 人设选择/添加 模态框 ──

/** 选择人设：弹窗列出所有人设（含自定义），点击后填入角色设定文本框。 */
function openPersonaPicker() {
  const entries = Object.entries(state.personaTemplates || {});
  if (!entries.length) {
    $('#persona-pick-hint').textContent = '人设列表为空';
    return;
  }
  const overlay = modelModalShell({
    head: '选择人设',
    body: `
      <div class="model-modal-right" id="persona-list" style="flex:1">
        ${entries.map(([id, p]) => `
          <div class="mm-model" data-id="${esc(id)}">
            <span class="mm-check">${(state.personaTemplates[id]?.text === ($('#cfg-roletext')?.value ?? '')) ? '✓' : ''}</span>
            <span>${esc(p.name)}</span>
            <span class="muted" style="font-size:11px">${p.builtin ? '内置' : '自定义'}</span>
          </div>`).join('')}
      </div>`,
    foot: `<button class="btn" id="persona-cancel">取消</button>`
  });
  overlay.querySelectorAll('.mm-model').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const tpl = state.personaTemplates[id];
      closeModelModal(overlay);
      if (tpl) applyPersonaTemplate(tpl);
    });
  });
  overlay.querySelector('#persona-cancel').addEventListener('click', () => closeModelModal(overlay));
  window.BotEffects?.personas(overlay.querySelector('#persona-list'),entries.map(([id,p])=>({...p,id,selected:p.text===($('#cfg-roletext')?.value||'')})),id=>{
    const tpl=state.personaTemplates[id];closeModelModal(overlay);if(tpl)applyPersonaTemplate(tpl);
  });
}

// 应用人设模板。**不再无条件整体覆盖**（2026-09-17 改）：
//   旧行为 = 点模板直接把 roleText 换掉、还把 customRules 清空，且无提示不可撤销，
//   用户自己写的人设会瞬间丢失。
//   新行为 = 先弹确认框，让用户选「覆盖」还是「追加」，并在覆盖前自动备份旧人设。
function applyPersonaTemplate(tpl) {
  const roleEl = $('#cfg-roletext');
  const rulesEl = $('#cfg-customrules');
  if (!roleEl) return;

  const oldText = roleEl.value || '';
  const oldRules = rulesEl?.value || '';
  const newText = tpl.text || '';
  const newRules = tpl.customRules || '';

  // 无内容可覆盖 → 直接套用，不打扰
  if (!oldText.trim()) {
    roleEl.value = newText;
    if (rulesEl && newRules) rulesEl.value = newRules;
    const input = $('#cfg-persona-pick');
    if (input) input.value = tpl.name;
    syncPersonaButtons();
    return;
  }

  // 已有内容 → 询问覆盖还是追加（追加 = 保留旧人设，把模板接在后面）
  const keepRules = oldRules.trim()
    ? '\n\n（你原有的「附加规则」会保留，不会被模板清掉。）'
    : '';
  const useOverwrite = window.confirm(
    `要把当前人设替换为「${tpl.name}」吗？\n\n`
    + `当前人设：${oldText.length} 字\n`
    + `新模板：${newText.length} 字\n\n`
    + `【确定】= 覆盖（旧人设会先自动备份，可还原）\n`
    + `【取消】= 改为「追加」（保留旧人设，模板内容接在后面）`
    + keepRules
  );

  if (useOverwrite) {
    // 覆盖前备份旧人设，防误操作
    state.personaBackup = { text: oldText, rules: oldRules, at: Date.now() };
    roleEl.value = newText;
    if (rulesEl) rulesEl.value = newRules;   // 覆盖时才替换附加规则
  } else {
    roleEl.value = oldText.trimEnd() + '\n\n---\n\n' + newText;
    // 追加模式保留原有附加规则；若原本为空，则带入模板自带的
    if (rulesEl && !oldRules.trim() && newRules) rulesEl.value = newRules;
  }

  const input = $('#cfg-persona-pick');
  if (input) input.value = tpl.name;
  syncPersonaButtons();
  renderPersonaBackupBar();
}

// 覆盖后可一键还原（仅在本次页面会话内有效，刷新即失效）
function renderPersonaBackupBar() {
  const bar = $('#persona-backup-bar');
  if (!bar) return;
  const b = state.personaBackup;
  if (!b) { bar.innerHTML = ''; return; }
  const t = new Date(b.at).toLocaleTimeString('zh-CN', { hour12: false });
  bar.innerHTML = `<span class="muted" style="font-size:12px">已备份覆盖前的人设（${b.text.length} 字，${t}）</span>
    <button class="btn btn-small" id="persona-restore-btn">还原</button>`;
  const btn = $('#persona-restore-btn');
  if (btn) btn.addEventListener('click', () => {
    const roleEl = $('#cfg-roletext');
    if (roleEl) roleEl.value = b.text;
    const rulesEl = $('#cfg-customrules');
    if (rulesEl) rulesEl.value = b.rules;
    state.personaBackup = null;
    renderPersonaBackupBar();
    syncPersonaButtons();
  });
}

/** 添加人设：弹窗填写人设名称、角色设定、管理员附加规则。 */
function openPersonaCreateModal() {
  const overlay = modelModalShell({
    head: '添加人设',
    body: `
      <div class="persona-create-layout"><div class="persona-preview" id="new-persona-preview"></div><div class="persona-editor">
      <div class="field" style="flex:1;min-width:0">
        <label>人设名称</label>
        <input type="text" id="new-persona-name" placeholder="例如：毒舌老哥" />
      </div>
      <div class="field"><label>头像图片（PNG / JPEG / WebP，最大 500KB）</label><input id="new-persona-file" type="file" accept="image/png,image/jpeg,image/webp"><input id="new-persona-avatar" type="text" placeholder="或填写 https:// 图片地址"></div>
      <div class="field"><label>卡片简介</label><input id="new-persona-description" type="text" maxlength="160" placeholder="角色性格与身份"></div>
      <div class="field" style="flex:1;min-width:0">
        <label>角色设定</label>
        <textarea id="new-persona-text" class="persona-role-text" style="min-height:220px" placeholder="人设文本（每轮注入，群友不可修改）"></textarea>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>管理员附加规则（可选）</label>
        <textarea id="new-persona-rules" style="min-height:90px" placeholder="可选：追加到系统提示的规则"></textarea>
      </div></div></div>`,
    foot: `<button class="btn" id="persona-add-cancel">取消</button>
           <button class="btn btn-primary" id="persona-add-apply">确认添加</button>`
  });
  bindPersonaPreview(overlay);
  overlay.querySelector('#persona-add-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#persona-add-apply').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-persona-name').value.trim();
    const text = overlay.querySelector('#new-persona-text').value.trim();
    const customRules = overlay.querySelector('#new-persona-rules').value.trim();
    if (!name) { $('#persona-pick-hint').textContent = '人设名称不能为空'; return; }
    if (!text) { $('#persona-pick-hint').textContent = '角色设定不能为空'; return; }
    try {
      await api('/api/persona-templates', {
        method: 'POST',
        body: JSON.stringify({ name, text, customRules, avatarUrl:overlay.querySelector('#new-persona-avatar').value.trim(),description:overlay.querySelector('#new-persona-description').value.trim() })
      });
      closeModelModal(overlay);
      await loadSettings();
      $('#cfg-roletext').value = text;
      $('#cfg-customrules').value = customRules;
      const input = $('#cfg-persona-pick');
      if (input) input.value = name;
      $('#persona-pick-hint').textContent = `人设「${name}」已添加。记得点「保存人设修改」使当前填写生效。`;
    } catch (e) {
      $('#persona-pick-hint').textContent = `添加失败：${e.message}`;
    }
  });
}

function bindPersonaPreview(overlay, name = '') {
  const update=()=>window.BotEffects?.preview(overlay.querySelector('#new-persona-preview'),{
    name:overlay.querySelector('#new-persona-name')?.value||name,
    avatarUrl:overlay.querySelector('#new-persona-avatar').value,
    description:overlay.querySelector('#new-persona-description').value
  });
  overlay.querySelectorAll('input[type=text]').forEach(el=>el.addEventListener('input',update));
  overlay.querySelector('#new-persona-file').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    if(file.size>500*1024||!['image/png','image/jpeg','image/webp'].includes(file.type)){alert('请选择小于 500KB 的 PNG / JPEG / WebP 图片');event.target.value='';return;}
    const reader=new FileReader();reader.onload=()=>{overlay.querySelector('#new-persona-avatar').value=reader.result;update();};reader.readAsDataURL(file);
  });
  update();
}

window.addEventListener('edit-persona-profile',event=>{
  const p=event.detail;
  document.querySelectorAll('.model-modal-overlay').forEach(el=>el.remove());
  const overlay=modelModalShell({head:'修改人设资料',body:`<div class="persona-create-layout"><div id="new-persona-preview"></div><div class="persona-editor"><div class="field"><label>头像图片</label><input id="new-persona-file" type="file" accept="image/png,image/jpeg,image/webp"><input id="new-persona-avatar" type="text" value="${esc(p.avatarUrl||'')}" placeholder="图片地址"></div><div class="field"><label>简介</label><input id="new-persona-description" type="text" maxlength="160" value="${esc(p.description||'')}"></div><div id="profile-result" role="status"></div></div></div>`,foot:'<button id="profile-save" class="btn btn-primary">保存资料</button>'});
  bindPersonaPreview(overlay,p.name);
  overlay.querySelector('#profile-save').addEventListener('click',async()=>{
    try{await api('/api/persona-templates/'+p.id,{method:'PATCH',body:JSON.stringify({avatarUrl:overlay.querySelector('#new-persona-avatar').value.trim(),description:overlay.querySelector('#new-persona-description').value.trim()})});closeModelModal(overlay);await loadSettings();openPersonaPicker();}
    catch(e){overlay.querySelector('#profile-result').textContent=e.message;}
  });
});

/** 选择模型：左提供商 / 右模型，点击模型后保存到当前 api 配置并关闭。 */
function openModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-hint').textContent = '模型目录为空：请先在下方的“手动添加提供商”里添加。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  const current = state.config?.api?.provider;
  let activePid = current || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === state.config?.api?.model && p.id === current ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ api: { provider: pid, model, baseUrl: p.baseURL, apiKey: p.apiKey || '' } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#provider-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** “获取列表”后的勾选添加弹窗：已添加的模型显示为已选（不可重复勾选）。 */
function openModelAddModal(baseUrl, apiKey, remoteModels) {
  const providers = state.providers || [];
  const existingProvider = providers.find((p) => (p.baseURL || '').replace(/\/+$/, '') === baseUrl.replace(/\/+$/, ''));
  const existingIds = new Set(existingProvider?.models || []);
  const overlay = modelModalShell({
    head: '勾选模型加入列表',
    body: `
      <div class="model-modal-right" id="ma-list" style="flex:1">
        ${remoteModels.map((m) => `
          <label class="mm-model">
            <input type="checkbox" class="ma-check" value="${esc(m)}" ${existingIds.has(m) ? 'checked disabled' : ''} />
            <span>${esc(m)}</span>
            ${existingIds.has(m) ? '<span class="muted" style="font-size:11px">已添加</span>' : ''}
          </label>`).join('') || '<div class="muted" style="padding:10px">没有拉到模型</div>'}
      </div>`,
    foot: `<button class="btn" id="ma-cancel">取消</button>
           <button class="btn btn-primary" id="ma-apply">加入列表</button>`
  });
  overlay.querySelector('#ma-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ma-apply').addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.ma-check:checked')].map((el) => el.value);
    const newModels = picked.filter((m) => !existingIds.has(m));
    if (!newModels.length) {
      closeModelModal(overlay);
      return;
    }
    try {
      const body = existingProvider
        ? { providerId: existingProvider.id, models: newModels.map((m) => ({ id: m, name: m })) }
        : { baseUrl, apiKey, models: newModels.map((m) => ({ id: m, name: m })) };
      const endpoint = existingProvider ? '/api/providers/models' : '/api/providers';
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      closeModelModal(overlay);
      $('#provider-action-hint').textContent = `已加入 ${newModels.length} 个模型。`;
      loadSettings();
    } catch (e) {
      $('#provider-action-hint').textContent = `加入失败：${e.message}`;
      closeModelModal(overlay);
    }
  });
}

/** 从备用中转站返回的真实模型列表中选择一个，不写入主模型目录。 */
function openFallbackModelPicker(remoteModels) {
  const models = [...new Set((remoteModels || []).map((model) => String(model || '').trim()).filter(Boolean))];
  const current = $('#cfg-fallback-model')?.value || '';
  const overlay = modelModalShell({
    head: '选择备用模型',
    body: `
      <div class="model-modal-right" id="fallback-model-list" style="flex:1">
        ${models.map((model) => `
          <div class="mm-model" data-model="${esc(model)}">
            <span class="mm-check">${model === current ? '✓' : ''}</span>
            <span>${esc(model)}</span>
          </div>`).join('') || '<div class="muted" style="padding:10px">没有可选模型</div>'}
      </div>`,
    foot: '<button class="btn" id="fallback-model-cancel">取消</button>'
  });
  overlay.querySelectorAll('.mm-model').forEach((item) => {
    item.addEventListener('click', () => {
      const input = $('#cfg-fallback-model');
      if (input) input.value = item.dataset.model || '';
      const hint = $('#fallback-model-hint');
      if (hint) hint.textContent = `已选择备用模型：${item.dataset.model || ''}，请保存设置。`;
      closeModelModal(overlay);
    });
  });
  overlay.querySelector('#fallback-model-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** 删除模型：左提供商 / 右模型（带删除按钮），暗红色调。 */
function openModelDeleteModal() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-action-hint').textContent = '模型目录为空，没有可删除的模型。';
    return;
  }
  const overlay = modelModalShell({
    head: '删除模型',
    body: `
      <div class="model-modal-left" id="md-left"></div>
      <div class="model-modal-right" id="md-right"></div>`,
    foot: `<button class="btn" id="md-cancel">关闭</button>`,
    danger: true
  });
  const left = overlay.querySelector('#md-left');
  const right = overlay.querySelector('#md-right');
  let activePid = providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-model="${esc(m)}">
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
        <button class="mm-del">删除</button>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.querySelector('.mm-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const model = el.dataset.model;
        if (!confirm(`确定从「${p.displayName || p.id}」删除模型 ${model}？`)) return;
        try {
          await api('/api/providers/models', {
            method: 'DELETE',
            body: JSON.stringify({ providerId: p.id, modelId: model })
          });
          renderRight();
          loadSettings();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#md-cancel').addEventListener('click', () => closeModelModal(overlay));
}

// ── 白名单可视化选择器 ──
async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  $('#pick-result').textContent = '拉取中…';
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    $('#pick-result').textContent = `拉取失败：${e.message}（OneBot 未连接？）`;
    return;
  }
  if (!list?.length) {
    $('#pick-result').textContent = isGroups ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表';
    return;
  }
  const inputEl = $(isGroups ? '#cfg-allowgroups' : '#cfg-allowprivate');
  const selected = new Set(parseList(inputEl.value));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">选择${isGroups ? '群' : '好友'}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#pick-cancel', overlay).addEventListener('click', () => overlay.remove());
  $('#pick-apply', overlay).addEventListener('click', () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    inputEl.value = picked.join(',');
    $('#pick-result').textContent = `已选 ${picked.length} 个${isGroups ? '群' : '好友'}，记得点"保存设置"`;
    overlay.remove();
  });
}

function parseList(s) {
  return String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

function settingsInputSnapshot(){
  return JSON.stringify([...document.querySelectorAll('#settings-form input[id^="cfg-"],#settings-form select[id^="cfg-"],#settings-form textarea[id^="cfg-"],#settings-form [data-bot],#settings-form [id^="behavior-"]')].filter(el=>el.matches('input,select,textarea')).map(el=>[el.id||el.dataset.bot,el.type==='checkbox'?el.checked:el.value]));
}
function settingsDirty(){return !!state.settingsInputs&&state.settingsInputs!==settingsInputSnapshot();}
function changedSettings(patch,base){
  const out={};
  for(const [key,value]of Object.entries(patch)){
    if(value&&typeof value==='object'&&!Array.isArray(value)){
      const child=changedSettings(value,base?.[key]||{});if(Object.keys(child).length)out[key]=child;
    }else if(JSON.stringify(value)!==JSON.stringify(base?.[key]))out[key]=value;
  }
  return out;
}
async function saveConfig({ quiet = false } = {}) {
  const c = state.config;
  // 只在当前区块的元素存在时才读取，避免“每个区块保存时读取其他区块元素”导致的 null 报错。
  const el = (sel) => document.querySelector(sel);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };
  const sec = state.settingsSection || 'api';

  const patch = {};
  if(sec==='center'){
    patch.behavior=window.BehaviorPanel.values(c);
    patch.interaction=collectBotSettings();
  }

  if(sec==='center'){
    if(el('#cfg-feature-masterqq'))patch.persona={masterQQ:val('#cfg-feature-masterqq').replace(/\D/g,'')};
    if(el('#cfg-feature-group-enabled'))patch.groupResponse={enabled:chk('#cfg-feature-group-enabled'),keywordOnly:chk('#cfg-feature-group-keyword-only'),keywords:parseList(val('#cfg-feature-group-keywords'))};
    if(el('#cfg-allowgroups'))patch.allow={groups:parseList(val('#cfg-allowgroups')),private:parseList(val('#cfg-allowprivate'))};
    if(el('#bot-solitaire-capture'))patch.nativeSolitaire={capture:chk('#bot-solitaire-capture')};
    if(el('#cfg-sticker-probability'))patch.sticker={replyProbability:Number(val('#cfg-sticker-probability')),cooldownSeconds:Number(val('#cfg-sticker-cooldown')),promptMaxStickers:Number(val('#cfg-sticker-prompt-limit')),collectEnabled:chk('#cfg-collect-enabled'),maxCollectPerHour:Number(val('#cfg-sticker-collect-limit'))};
    if(el('#cfg-vision'))patch.api={vision:chk('#cfg-vision')};
    if(el('#cfg-searchprovider'))patch.webSearch={provider:val('#cfg-searchprovider'),searchUrl:val('#cfg-searchurl').trim()};
    if(el('#cfg-memory-consolidate'))patch.memory={consolidateEnabled:chk('#cfg-memory-consolidate'),consolidateMinIntervalMs:Number(val('#cfg-memory-interval'))*3600000};
    if(el('#cfg-proactive'))patch.proactive={enabled:chk('#cfg-proactive'),checkIntervalMinMs:Number(val('#cfg-pro-min')),checkIntervalMaxMs:Number(val('#cfg-pro-max')),probability:Number(val('#cfg-pro-prob')),idleThresholdMs:Number(val('#cfg-pro-idle'))};
  }
  if(sec==='login')patch.autoRecovery={
    passwordFallback:chk('#bot-password-fallback'),enabled:chk('#cfg-feature-recovery-enabled'),
    targetQQ:val('#cfg-feature-recovery-qq').replace(/\D/g,''),
    offlineConfirmations:Number(val('#cfg-feature-recovery-confirmations')),
    cooldownMinutes:Number(val('#cfg-feature-recovery-cooldown')),
    maxAttemptsPerHour:Number(val('#cfg-feature-recovery-max'))
  };

  if (sec === 'api') {
    patch.api = {
      ...c.api,
      apiKey:val('#cfg-apikey',c.api.apiKey).trim(),
      provider:val('#cfg-provider',c.api.provider),model:val('#cfg-model',c.api.model),
      baseUrl:val('#cfg-baseurl',c.api.baseUrl).trim(),
      temperature: Number(val('#cfg-temperature', c.api.temperature)),
      maxRounds: Number(val('#cfg-maxrounds', c.api.maxRounds)) || 12,
      fallback: {
        ...(c.api?.fallback || {}),
        enabled: chk('#cfg-fallback-enabled', !!c.api?.fallback?.enabled),
        baseUrl: val('#cfg-fallback-baseurl', c.api?.fallback?.baseUrl || '').trim(),
        apiKey: val('#cfg-fallback-apikey', c.api?.fallback?.apiKey || '').trim(),
        model: val('#cfg-fallback-model', c.api?.fallback?.model || '').trim(),
        timeoutMs: Math.max(5000, Math.min(180000, Number(val('#cfg-fallback-timeout', 60)) * 1000 || 60000)),
        failureThreshold: Math.max(1, Math.min(10, Number(val('#cfg-fallback-threshold', 1)) || 1)),
        cooldownMs: Math.max(60000, Math.min(3600000, Number(val('#cfg-fallback-cooldown', 5)) * 60000 || 300000))
      }
    };
  }

  if (sec === 'persona') {
    patch.interaction=collectBotSettings();
    patch.persona = {
      botName: val('#cfg-botname', c.persona.botName).trim() || 'bot',
      selfNickname: val('#cfg-selfnick', c.persona.selfNickname || '').trim(),
      roleText: val('#cfg-roletext', c.persona.roleText || ''),
      customRules: val('#cfg-customrules', c.persona.customRules || '')
    };
  }

  if (sec === 'system') {
    patch.wakeDelayMs = Number(val('#cfg-wakedelay', c.wakeDelayMs));
    patch.drainDelayMs = Number(val('#cfg-draindelay', c.drainDelayMs));
    patch.maxConcurrentRuns = Number(val('#cfg-maxruns', c.maxConcurrentRuns)) || 2;
    patch.send = {
      ...c.send,
      minGapMs: Number(val('#cfg-mingap', c.send?.minGapMs)) || 1000,
      maxGapMs: Number(val('#cfg-maxgap', c.send?.maxGapMs)) || 3000,
      maxPerMinute: Number(val('#cfg-maxpermin', c.send?.maxPerMinute))
    };
    patch.store = {
      pastStateLimit: Math.min(500, Math.max(10, Number(val('#cfg-pastlimit', c.store?.pastStateLimit)) || 80)),
      pastStateMaxChars: Math.min(60000, Math.max(1000, Number(val('#cfg-pastchars', c.store?.pastStateMaxChars)) || 6000))
    };
  }

  if (sec === 'system') {
    patch.server = {
      ...c.server,
      autoStart: chk('#cfg-autostart', !!c.server?.autoStart),
      closeToTray: chk('#cfg-closetray', c.server?.closeToTray !== false)
    };
  }

  if (sec === 'system') {
    patch.snowluma = {
      dir: val('#cfg-snowlumadir', c.snowluma?.dir || '').trim(),
      autoLaunch: chk('#cfg-snowlumalaunch', !!c.snowluma?.autoLaunch),
      wsUrl: val('#cfg-wsurl', c.snowluma?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.snowluma?.httpUrl || '').trim(),
      accessToken: val('#cfg-obtoken', c.snowluma?.accessToken || '').trim(),
      httpAccessToken: val('#cfg-obhttptoken', c.snowluma?.httpAccessToken || '').trim()
    };
  }

  const changed=changedSettings(patch,state.settingsBase||c);
  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(changed) });
  state.settingsBase=structuredClone(data.config);
  state.settingsInputs=settingsInputSnapshot();
  state.config = data.config;
  if (!quiet) $('#model-label').textContent = `模型：${state.config.api.model || '未设置'}`;
  return data;
}

// ── 标签页切换 ──
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${tab.dataset.tab}`).classList.add('active');
    state.tab = tab.dataset.tab;
    if (state.tab === 'sessions') loadSessions();
    if (state.tab === 'chats') loadChats();
    if (state.tab === 'snowluma') loadSnowlumaPage();
    if (state.tab === 'settings') loadSettings();
  });
});

// ── 启动 ──
(async function init() {
  // 启动 loading：先等 HTTP 服务可用（页面可能先于服务打开）
  setLoadingStatus('正在启动 QQ Agent 服务…');
  await bootLoop();

  // 首启引导：关键配置（模型/白名单）没填就直接带去设置页
  try {
    const cfg = await api('/api/config');
    const ready = !!cfg.api.model && ((cfg.allow.groups?.length || cfg.allow.private?.length) || cfg.allowAllWhenEmpty);
    if (!ready) {
      switchTab('settings');
      connectSSE();
      refreshStatus();
      setInterval(refreshStatus, 15000);
      return;
    }
  } catch { /* 按默认流程走 */ }
  refreshStatus();
  setInterval(refreshStatus, 15000);
  connectSSE();
  loadSessions();
})();
