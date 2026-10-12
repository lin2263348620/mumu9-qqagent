export const INTERACTION_DEFAULTS = {
  enabled: true, requireAt: true, blockedBots: [],
  feed: { enabled: true, limit: 3, points: 2 },
  pet: { enabled: true, limit: 1, points: 1 },
  walk: { enabled: true, limit: 1, points: 3 },
  affinity: true, ranking: true, fortune: true, commandList: true, rankLimit: 10,
  checkin: true, checkinRanking: true, checkinRankLimit: 10,
  highThreshold: 200, multiReply: true, minMessages: 3, maxMessages: 5, messageMaxChars: 120, gapMs: 1500,
  persona: '', extraRules: '', forbidden: [],
  cache: { enabled: true, files: true, days: 7, maxEntries: 300, target: 10, batch: 3, recent: 5, autoFill: false },
  regeneration: 1
};

export function normalizeInteraction(value = {}) {
  const out = structuredClone(INTERACTION_DEFAULTS);
  for (const key of ['enabled','requireAt','affinity','ranking','fortune','commandList','multiReply','checkin','checkinRanking']) {
    if (key in value) { if (typeof value[key] !== 'boolean') throw new Error(`${key} 必须为开关值`); out[key] = value[key]; }
  }
  const integer = (val, fallback, min, max) => {
    if (val === undefined) return fallback;
    if (!Number.isInteger(val) || val < min || val > max) throw new Error(`数值必须为 ${min} 到 ${max} 的整数`);
    return val;
  };
  for (const key of ['feed','pet','walk']) {
    const item = value[key] || {};
    out[key] = { enabled: item.enabled ?? out[key].enabled,
      limit: integer(item.limit, out[key].limit, 1, 100), points: integer(item.points, out[key].points, 0, 1000) };
    if (typeof out[key].enabled !== 'boolean') throw new Error('互动开关无效');
  }
  for (const [key,min,max] of [['rankLimit',1,50],['checkinRankLimit',1,50],['highThreshold',0,999999],['minMessages',1,5],['maxMessages',1,5],['messageMaxChars',20,1000],['gapMs',500,10000],['regeneration',0,2]]) {
    out[key] = integer(value[key], out[key], min, max);
  }
  if (out.minMessages > out.maxMessages) throw new Error('最少回复条数不能大于最多条数');
  for (const key of ['persona','extraRules']) {
    if (key in value) { if (typeof value[key] !== 'string' || value[key].length > 20000) throw new Error('人设文字过长或无效'); out[key] = value[key]; }
  }
  for (const key of ['forbidden','blockedBots']) {
    if (key in value) {
      if (!Array.isArray(value[key]) || value[key].length > 100 || value[key].some(x => typeof x !== 'string' || x.length > 200)) throw new Error('列表格式无效');
      out[key] = value[key].map(x => x.trim()).filter(Boolean);
    }
  }
  const cache = value.cache || {};
  for (const key of ['enabled','files','autoFill']) {
    if (key in cache) { if (typeof cache[key] !== 'boolean') throw new Error('缓存开关无效'); out.cache[key] = cache[key]; }
  }
  for (const [key,min,max] of [['days',1,90],['maxEntries',10,10000],['target',1,30],['batch',1,10],['recent',0,30]]) out.cache[key] = integer(cache[key], out.cache[key], min, max);
  return out;
}
