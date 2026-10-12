// OpenAI 兼容 Chat Completions 客户端（非流式；QQ 本身不支持流式，没必要）。
// 支持工具调用、usage 统计、可自选模型 —— 这是与 DSH 解耦后的"大脑"接口。
import { getConfig } from './config.js';
import { requestWithRetry } from './model-retry.js';

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * 单次对话请求。messages 为 OpenAI 格式；tools 为 OpenAI function 格式（可为空）。
 * 返回 { message, usage, raw }；usage 形如 { prompt_tokens, completion_tokens, total_tokens }。
 */
let requestQueue = Promise.resolve();
export function chatCompletion(options) {
  const job = requestQueue.then(() => performCompletionWithFailover(options));
  requestQueue = job.catch(() => {});
  return job;
}

const failoverState = {
  signature: '', consecutiveTimeouts: 0, circuitUntil: 0,
  primaryCalls: 0, fallbackCalls: 0, switches: 0,
  lastRoute: '', lastReason: '', lastSwitchAt: null, lastSuccessAt: null
};

function fallbackConfig(api) {
  const raw = api?.fallback || {};
  return {
    enabled: raw.enabled === true,
    baseUrl: String(raw.baseUrl || '').trim(),
    apiKey: String(raw.apiKey || ''),
    model: String(raw.model || '').trim(),
    timeoutMs: Math.max(5000, Math.min(180000, Number(raw.timeoutMs) || 60000)),
    failureThreshold: Math.max(1, Math.min(10, Math.round(Number(raw.failureThreshold) || 1))),
    cooldownMs: Math.max(30000, Math.min(3600000, Number(raw.cooldownMs) || 300000))
  };
}

function syncFailoverConfig(api) {
  const f = fallbackConfig(api);
  const signature = JSON.stringify([api?.baseUrl, api?.model, f.enabled, f.baseUrl, f.model, f.failureThreshold, f.cooldownMs]);
  if (signature !== failoverState.signature) {
    failoverState.signature = signature;
    failoverState.consecutiveTimeouts = 0;
    failoverState.circuitUntil = 0;
    failoverState.lastReason = '';
  }
  return f;
}

function timeoutFailure(error) {
  const text = `${error?.code || ''} ${error?.cause?.code || ''} ${error?.cause?.message || ''} ${error?.message || error}`;
  return /UND_ERR_CONNECT_TIMEOUT|Connect Timeout|模型请求超时|请求超时|timed?\s*out/i.test(text);
}

export function getFailoverStatus() {
  const api = getConfig().api || {};
  const f = syncFailoverConfig(api);
  return {
    enabled: f.enabled,
    configured: !!(f.baseUrl && f.model),
    primary: { baseUrl: String(api.baseUrl || ''), model: String(api.model || '') },
    fallback: { baseUrl: f.baseUrl, model: f.model, hasKey: !!f.apiKey },
    consecutiveTimeouts: failoverState.consecutiveTimeouts,
    coolingDown: Date.now() < failoverState.circuitUntil,
    circuitUntil: failoverState.circuitUntil || null,
    primaryCalls: failoverState.primaryCalls,
    fallbackCalls: failoverState.fallbackCalls,
    switches: failoverState.switches,
    lastRoute: failoverState.lastRoute,
    lastReason: failoverState.lastReason,
    lastSwitchAt: failoverState.lastSwitchAt,
    lastSuccessAt: failoverState.lastSuccessAt
  };
}

async function performCompletionWithFailover(options) {
  const api = getConfig().api || {};
  const fallback = syncFailoverConfig(api);
  const ready = fallback.enabled && !!fallback.baseUrl && !!fallback.model;
  const fallbackEndpoint = { ...fallback, route: 'fallback' };
  const primaryEndpoint = { ...api, route: 'primary' };
  if (ready && Date.now() < failoverState.circuitUntil) {
    options.onProgress?.('主接口冷却中，正在请求备用模型');
    failoverState.fallbackCalls++;
    const result = await performEndpoint(options, fallbackEndpoint);
    failoverState.lastRoute = 'fallback'; failoverState.lastSuccessAt = Date.now();
    return result;
  }
  failoverState.primaryCalls++;
  options.onProgress?.('正在请求主模型');
  try {
    const result = await performEndpoint(options, primaryEndpoint);
    failoverState.consecutiveTimeouts = 0; failoverState.circuitUntil = 0;
    failoverState.lastRoute = 'primary'; failoverState.lastSuccessAt = Date.now();
    return result;
  } catch (error) {
    if (options?.signal?.aborted || !ready || !(timeoutFailure(error) || [429,502,503,504].includes(error.status))) throw error;
    failoverState.consecutiveTimeouts++;
    failoverState.switches++;
    failoverState.lastReason = String(error?.message || error);
    failoverState.lastSwitchAt = Date.now();
    if (failoverState.consecutiveTimeouts >= fallback.failureThreshold) failoverState.circuitUntil = Date.now() + fallback.cooldownMs;
    console.warn('[model] 主 API 暂时不可用，切换备用 API');
    failoverState.fallbackCalls++;
    options.onProgress?.('主接口暂时不可用，正在切换备用模型');
    try {
      const result = await performEndpoint(options, fallbackEndpoint);
      failoverState.lastRoute = 'fallback'; failoverState.lastSuccessAt = Date.now();
      return result;
    } catch (fallbackError) {
      throw new Error(`主 API 暂时不可用；备用 API 也失败：${fallbackError?.message ?? fallbackError}`);
    }
  }
}

async function performEndpoint({ messages, tools = null, toolChoice = 'auto', temperature = null, signal = null }, endpoint) {
  const cfg = endpoint;
  const body = {
    model: cfg.model,
    messages,
    stream: false
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  const temp = temperature === null ? (cfg.temperature ?? 0.8) : temperature;
  if (temp !== null && temp !== undefined && Number.isFinite(Number(temp))) body.temperature = Number(temp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), Math.max(5000, Number(cfg.timeoutMs) || 180000));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', () => controller.abort(signal.reason ?? new Error('aborted')), { once: true });
  }

  let res;
  try {
    res = await requestWithRetry(joinUrl(cfg.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(cfg.apiKey) },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    if (signal?.aborted) throw signal.reason ?? error;
    if (controller.signal.aborted) throw new Error(`模型请求超时（${cfg.timeoutMs}ms）`);
    throw new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const hint = res.status === 429 ? '服务端并发或速率限制，已重试，请稍后再试或配置独立备用接口' :
      [502,503,504].includes(res.status) ? '模型服务暂时不可用，已重试，请稍后再试或配置备用接口' : text.slice(0,500);
    throw Object.assign(new Error(`模型 API HTTP ${res.status}：${hint}`), { status: res.status });
  }
  const contentType = String(res.headers.get('content-type') || '');
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const preview = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`模型 API 返回了无法解析的 JSON（${contentType || '未知类型'}）${preview ? `：${preview}` : ''}`);
  }
  const choice = data?.choices?.[0];
  if (!choice) throw new Error(`模型 API 响应缺少 choices：${JSON.stringify(data).slice(0, 300)}`);
  return {
    message: choice.message ?? {},
    finishReason: choice.finish_reason ?? null,
    usage: data.usage ?? null,
    model: data.model ?? cfg.model,
    route: cfg.route || 'primary',
    raw: data
  };
}

/** 获取模型列表（GET /models）。返回 [{ id }]；失败抛错。 */
export async function listModels() {
  const cfg = getConfig().api;
  const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
    headers: authHeaders(cfg.apiKey),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => ({ id: String(m.id ?? m.model ?? m) })).filter((m) => m.id);
}

/** 累加 usage。 */
export function addUsage(target, usage) {
  if (!usage) return target;
  target.promptTokens += Number(usage.prompt_tokens) || 0;
  target.completionTokens += Number(usage.completion_tokens) || 0;
  target.totalTokens += Number(usage.total_tokens) || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
  target.cachedInputTokens = (target.cachedInputTokens||0) + (Number(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens)||0);
  target.cacheUsageReported = target.cacheUsageReported || usage.prompt_tokens_details?.cached_tokens!==undefined || usage.prompt_cache_hit_tokens!==undefined;
  return target;
}

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
}

/** 按配置单价折算成本（元）。 */
export function estimateCost(usage) {
  const cfg = getConfig().api;
  const cost = (usage.promptTokens / 1e6) * (Number(cfg.priceInputPerM) || 0)
    + (usage.completionTokens / 1e6) * (Number(cfg.priceOutputPerM) || 0);
  return Math.round(cost * 1e4) / 1e4;
}
