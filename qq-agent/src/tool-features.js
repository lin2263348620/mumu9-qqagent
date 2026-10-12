// Central feature gates for model tools. The UI, orchestrator and executor all
// use this table so a disabled switch is enforced by the backend as well.
export const TOOL_FEATURE_GROUPS = [
  { key: 'stickers', label: '表情包', tools: ['send_sticker', 'list_stickers', 'get_sticker_image', 'sticker_note', 'collect_sticker'] },
  { key: 'images', label: '图片收发与识别', tools: ['send_image', 'get_message_images'] },
  { key: 'files', label: '文件收发', tools: ['send_file', 'receive_file'] },
  { key: 'poke', label: '拍一拍', tools: ['send_poke'] },
  { key: 'messageHistory', label: '历史消息与消息详情', tools: ['get_recent_messages', 'get_message_detail'] },
  { key: 'memberLookup', label: '群成员查询', tools: ['get_active_members'] },
  { key: 'memory', label: '长期记忆', tools: ['memory_append', 'memory_query', 'memory_remove'] },
  { key: 'scheduledTasks', label: '定时任务', tools: ['schedule_task'] },
  { key: 'dsh', label: '后台任务', tools: ['dsh_task'] },
  { key: 'feedback', label: '问题反馈', tools: ['report_feedback'] }
];

export const ALWAYS_ENABLED_TOOLS = new Set(['finish']);
export const TOOL_SWITCH_NAMES = new Set(['send_message', 'web_search', 'web_fetch', ...TOOL_FEATURE_GROUPS.flatMap(group => group.tools)]);

const TOOL_TO_FEATURE = new Map(
  TOOL_FEATURE_GROUPS.flatMap((group) => group.tools.map((tool) => [tool, group.key]))
);

export function toolFeatureKey(toolName) {
  return TOOL_TO_FEATURE.get(String(toolName || '')) || null;
}

export function isToolEnabled(toolName, config = {}) {
  const name = String(toolName || '');
  if (ALWAYS_ENABLED_TOOLS.has(name)) return true;
  if (config.toolEnabled?.[name] === false) return false;

  const key = toolFeatureKey(name);
  if (key && config.toolFeatures?.[key] === false) return false;

  // Keep existing switches authoritative as well as the new grouped switches.
  if ((name === 'web_search' || name === 'web_fetch') && config.webSearch?.enabled === false) return false;
  if (['send_sticker', 'list_stickers', 'get_sticker_image', 'sticker_note', 'collect_sticker'].includes(name)
      && config.sticker?.enabled === false) return false;
  if ((name === 'get_message_images' || name === 'get_sticker_image') && config.api?.vision === false) return false;
  return true;
}

export function filterEnabledTools(defs, config = {}) {
  return (defs || []).filter((def) => def?.name && isToolEnabled(def.name, config));
}

export function toolFeatureSnapshot(config = {}) {
  return Object.fromEntries(TOOL_FEATURE_GROUPS.map((group) => [group.key, config.toolFeatures?.[group.key] !== false]));
}
