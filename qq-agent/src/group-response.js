/**
 * 判断一条群消息是否应进入机器人处理链路。
 * 总开关关闭时全部拒绝；关键词模式下，关键词或明确 @机器人 任一满足即可。
 */
export function shouldTriggerGroupMessage(event, cfg, selfId) {
  const settings = cfg?.groupResponse || {};
  if (settings.enabled === false) return false;
  if (settings.keywordOnly !== true) return true;

  const segments = Array.isArray(event?.message) ? event.message : [];
  const botId = String(selfId || '');
  const raw = String(event?.raw_message ?? (typeof event?.message === 'string' ? event.message : ''));
  const directlyMentioned = !!botId && (
    segments.some((segment) => segment?.type === 'at' && String(segment?.data?.qq ?? '') === botId) ||
    raw.includes(`[CQ:at,qq=${botId}`)
  );
  if (directlyMentioned) return true;

  const plainText = (segments.length
    ? segments.filter((segment) => segment?.type === 'text').map((segment) => segment?.data?.text ?? '').join(' ')
    : raw
  ).toLocaleLowerCase('zh-CN');
  const keywords = (Array.isArray(settings.keywords) ? settings.keywords : [])
    .map((keyword) => String(keyword || '').trim().toLocaleLowerCase('zh-CN'))
    .filter(Boolean);
  return keywords.some((keyword) => plainText.includes(keyword));
}
