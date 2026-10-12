export const BEHAVIOR_DEFAULTS = {
  mode: 'inherit', callWords: [], interactionException: true,
  activeProbability: 80, contextSeconds: 120, comfort: true,
  participation: { low: { enabled: false, probability: 5 }, medium: { enabled: true, probability: 20 } },
  batchMs: 4000, maxWaitMs: 10000,
  icebreaker: { enabled: true, sleepStart: '23:00', sleepEnd: '08:00', intervalMinutes: 60, probability: 25 },
  affinity: { enabled: true, tiers: [
    { min: 0, maxChars: 15, probability: 10 }, { min: 40, maxChars: 20, probability: 25 },
    { min: 80, maxChars: 30, probability: 45 }, { min: 120, maxChars: 40, probability: 65 },
    { min: 160, maxChars: 45, probability: 80 }, { min: 200, maxChars: 50, probability: 90 }
  ] },
  cache: { dailyBudget: 20, refill: true, target: 10 },
  solitaire: { enabled: false, windowSeconds: 120, maxChars: 1500 }
};
export function normalizeBehavior(raw = {}) {
  const out = { ...structuredClone(BEHAVIOR_DEFAULTS), ...raw };
  for (const k of ['icebreaker','affinity','cache','solitaire']) out[k] = { ...BEHAVIOR_DEFAULTS[k], ...raw[k] };
  out.participation = Object.fromEntries(['low','medium'].map(mode => [mode, { ...BEHAVIOR_DEFAULTS.participation[mode], ...raw.participation?.[mode] }]));
  delete out.solitaire.text;
  for (const rule of Object.values(out.participation)) {
    if (typeof rule.enabled !== 'boolean' || !Number.isInteger(rule.probability) || rule.probability < 0 || rule.probability > 100) throw new Error('普通群聊参与开关或概率无效');
  }
  if (!['inherit','low','medium','high'].includes(out.mode)) throw new Error('响应模式无效');
  if (!Array.isArray(out.callWords) || out.callWords.length > 30 || out.callWords.some(w => typeof w !== 'string' || w.length > 50)) throw new Error('呼叫词格式无效');
  out.callWords = out.callWords.map(w => w.trim()).filter(Boolean);
  for (const [obj,k,min,max] of [[out,'activeProbability',0,100],[out,'contextSeconds',10,600],[out,'batchMs',500,10000],[out,'maxWaitMs',1000,30000],[out.icebreaker,'intervalMinutes',5,1440],[out.icebreaker,'probability',0,100],[out.cache,'dailyBudget',0,200],[out.cache,'target',6,30],[out.solitaire,'maxChars',200,4000]]) {
    if (!Number.isInteger(obj[k]) || obj[k] < min || obj[k] > max) throw new Error(`${k} 数值范围为 ${min}–${max}`);
  }
  if (out.maxWaitMs < out.batchMs) throw new Error('最长等待不能小于聚合窗口');
  for (const [obj,k] of [[out,'interactionException'],[out,'comfort'],[out.icebreaker,'enabled'],[out.affinity,'enabled'],[out.cache,'refill'],[out.solitaire,'enabled']]) if (typeof obj[k] !== 'boolean') throw new Error(`${k} 必须为开关值`);
  for (const k of ['sleepStart','sleepEnd']) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.icebreaker[k])) throw new Error('睡觉时间格式为 HH:mm');
  if (!Number.isInteger(out.solitaire.windowSeconds) || out.solitaire.windowSeconds < 10 || out.solitaire.windowSeconds > 600) throw new Error('跟发统计窗口为 10–600 秒');
  if (!Array.isArray(out.affinity.tiers) || out.affinity.tiers.length !== 6) throw new Error('亲密度需要六个档位');
  out.affinity.tiers = out.affinity.tiers.map((t,i) => {
    if (t.min !== i*40 || !Number.isInteger(t.maxChars) || t.maxChars < 5 || t.maxChars > 500 || !Number.isInteger(t.probability) || t.probability < 0 || t.probability > 100) throw new Error('亲密度阶梯数值无效');
    return { min:t.min, maxChars:t.maxChars, probability:t.probability };
  });
  return out;
}
export function responseMode(cfg, persona = cfg.persona) {
  return cfg.behavior?.mode && cfg.behavior.mode !== 'inherit' ? cfg.behavior.mode : (persona?.participation || 'medium');
}
export function affinityTier(cfg, points = 0) {
  const rules = cfg.behavior?.affinity || BEHAVIOR_DEFAULTS.affinity;
  if (rules.enabled === false) return { maxChars: 2000, probability: cfg.sticker?.replyProbability ?? 30 };
  return (rules.tiers || BEHAVIOR_DEFAULTS.affinity.tiers).filter(t => t.min <= points).at(-1) || BEHAVIOR_DEFAULTS.affinity.tiers[0];
}
export function isSleeping(settings, now = Date.now()) {
  const current = new Date(now + 8*3600000).toISOString().slice(11,16);
  const {sleepStart:start,sleepEnd:end} = settings;
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}
export function routeMessage({ event, cfg, selfId, repliesToBot = false, recent = [], now = Date.now(), persona = cfg.persona }) {
  const settings = { ...BEHAVIOR_DEFAULTS, ...cfg.behavior };
  const segments = Array.isArray(event.message) ? event.message : [];
  const text = segments.length ? segments.filter(s=>s.type==='text').map(s=>s.data?.text || '').join('') : String(event.raw_message || event.message || '').replace(/\[CQ:[^\]]*\]/g,'');
  const mentioned = segments.some(s=>s.type==='at' && String(s.data?.qq)===String(selfId)) || (selfId && String(event.raw_message||'').includes(`[CQ:at,qq=${selfId}]`));
  const called = settings.callWords.some(w=>text.toLowerCase().includes(w.toLowerCase()));
  const direct = !!(mentioned || called || repliesToBot);
  const sender = String(event.user_id ?? event.sender?.user_id ?? '');
  const window = recent.filter(m=>now-m.ts<=settings.contextSeconds*1000);
  const related = window.some(m=>m.self) && window.some(m=>!m.self && m.senderId===sender && m.relevant);
  const sad = settings.comfort && /(?:我|今天|现在|真的|好).{0,10}(?:难过|伤心|想哭|撑不住|崩溃|失落)|^(?:难过|伤心|想哭|撑不住|崩溃)/.test(text)
    && !/歌词|引用|转发|他说|她说|开玩笑|哈哈|[“”「」]/.test(text);
  const mode = responseMode(cfg, persona);
  let respond = direct || (mode !== 'low' && (related || sad));
  const keywordMatched = (cfg.groupResponse?.keywords||[]).some(w=>w && text.includes(w));
  const blocked = cfg.groupResponse?.enabled===false || (cfg.groupResponse?.keywordOnly && !direct && !keywordMatched);
  const rule = settings.participation?.[mode] || BEHAVIOR_DEFAULTS.participation[mode];
  const plainText = text.trim() && (!segments.length || segments.every(s=>s.type==='text')) && !/\[CQ:|^\[(?:图片|表情)/.test(text);
  const ordinary = !respond && !blocked && !!plainText && (mode==='high' ? settings.activeProbability>0 : rule?.enabled && rule.probability>0);
  if (blocked) respond=false;
  const vision = respond && (related || (direct && /看|图|照片|图片|识别|这是什么|这个是什么|这张|看看/.test(text)));
  return {respond, ordinary:!!ordinary, ordinaryEligible:!!plainText, direct, related, sad:!!sad, vision, text, mode, keywordMatched, blocked};
}

// Ordinary participation is sampled once after the short collection window closes.
export function selectResponseBatch(entries, cfg, persona, random = Math.random) {
  const mode = responseMode(cfg, persona), settings = cfg.behavior || BEHAVIOR_DEFAULTS;
  const rule = settings.participation?.[mode] || BEHAVIOR_DEFAULTS.participation[mode];
  const probability = mode==='high' ? settings.activeProbability ?? 80 : rule?.enabled ? rule.probability : 0;
  const required=[], ordinary=[], skipped=[];
  for (const entry of entries) {
    const keywordMatched=entry.policyManaged?(cfg.groupResponse?.keywords||[]).some(w=>w && String(entry.exactText??entry.text??'').includes(w)):entry.keywordMatched;
    const blocked = entry.suppressed || cfg.groupResponse?.enabled===false || (cfg.groupResponse?.keywordOnly && !entry.direct && !keywordMatched);
    if (blocked) { skipped.push({entry,reason:entry.suppressed?'相同文字跟发规则接管':'群聊总开关或关键词规则拦截'}); continue; }
    const requested=entry.direct || (mode!=='low' && (entry.related || (settings.comfort && entry.sad))) || entry.interactionException;
    if (requested || (!entry.policyManaged && !entry.ordinaryCandidate)) required.push(entry);
    else if (entry.policyManaged ? entry.ordinaryEligible : entry.ordinaryCandidate) ordinary.push(entry);
    else skipped.push({entry,reason:'当前模式不回应此消息'});
  }
  const chosen = ordinary.length && probability>0 && random()*100 < probability;
  if (chosen) {for(const entry of ordinary)entry.participationSelected=true;required.push(...ordinary);}
  else for (const entry of ordinary) skipped.push({entry,reason:probability ? '本批未命中普通群聊参与概率' : '当前模式未开启普通群聊参与'});
  return {selected:required.sort((a,b)=>a.ts-b.ts),skipped};
}
export function limitReply(text, maxChars) {
  const chars = Array.from(String(text || '').trim());
  if (chars.length <= maxChars) return chars.join('');
  const suffix = '…';
  let cut = chars.slice(0,Math.max(1,maxChars-1)).join('');
  const open = Math.max(cut.lastIndexOf('（'),cut.lastIndexOf('('));
  if (open >= 0 && !/[）)]/.test(cut.slice(open))) cut=cut.slice(0,open).trim();
  return cut + suffix;
}
