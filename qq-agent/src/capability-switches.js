import { toolFeatureKey, TOOL_SWITCH_NAMES, isToolEnabled } from './tool-features.js';

export function capabilityPatch(body, cfg) {
  if (!body || typeof body.enabled !== 'boolean') throw new Error('开关值必须为布尔值');
  const enabled = body.enabled;
  if (body.tool) {
    if (!TOOL_SWITCH_NAMES.has(body.tool)) throw new Error('此工具不能切换');
    // Enabling a legacy parent must not silently enable disabled sibling tools.
    const patch = { toolEnabled: Object.fromEntries([...TOOL_SWITCH_NAMES].map(name => [name, isToolEnabled(name, cfg)])) };
    patch.toolEnabled[body.tool] = enabled;
    const key = toolFeatureKey(body.tool);
    if (enabled && key) patch.toolFeatures = { [key]: true };
    if (enabled && ['send_sticker','list_stickers','get_sticker_image','sticker_note','collect_sticker'].includes(body.tool)) patch.sticker = { enabled: true };
    if (enabled && ['web_search','web_fetch'].includes(body.tool)) patch.webSearch = { enabled: true };
    if (enabled && ['get_message_images','get_sticker_image'].includes(body.tool)) patch.api = { vision: true };
    return patch;
  }
  if (body.mode) {
    if (!Object.hasOwn(cfg.identityModes || {}, body.mode) || !cfg.identityModes[body.mode]) throw new Error('身份模式不存在');
    return { identityModes: { [body.mode]: { enabled } } };
  }
  switch (body.feature) {
    case 'interaction': return { interaction: { enabled } };
    case 'fortune': return { interaction: { fortune: enabled, ...(enabled ? { enabled: true } : {}) } };
    case 'ranking': return { interaction: { ranking: enabled, ...(enabled ? { enabled: true } : {}) } };
    case 'checkinRanking': return { interaction: { checkinRanking: enabled, ...(enabled ? { enabled: true } : {}) } };
    case 'scheduledTasks': return { toolFeatures: { scheduledTasks: enabled }, ...(enabled ? { toolEnabled: { schedule_task: true } } : {}) };
    case 'webSearch': return { webSearch: { enabled }, ...(enabled ? { toolEnabled: { web_search: true, web_fetch: true } } : {}) };
    case 'groupResponse': return { groupResponse: { enabled } };
    default: throw new Error('功能不存在');
  }
}
