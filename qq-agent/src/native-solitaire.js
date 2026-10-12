import fs from 'node:fs';
import path from 'node:path';

const FILE = 'native-solitaire-events.json';

function structuredSegments(event) {
  if (!Array.isArray(event?.message)) return [];
  return event.message.filter((segment) => ['json','xml','ark','light_app'].includes(String(segment?.type || '').toLowerCase()));
}

function looksLikeSolitaire(segment) {
  const raw = JSON.stringify(segment?.data || {});
  return /接龙|solitaire|group[_-]?relay|relay/i.test(raw);
}

export function inspectNativeSolitaire(event, groupId, dataDir, config = {}) {
  if (config.enabled === false || config.capture === false) return null;
  const segments = structuredSegments(event);
  const matched = segments.filter(looksLikeSolitaire);
  if (!matched.length) return null;
  const file = path.join(dataDir, FILE);
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { rows = []; }
  const entry = {
    at: Date.now(), groupId: String(groupId), messageId: event?.message_id ?? null,
    senderId: String(event?.user_id ?? event?.sender?.user_id ?? ''),
    types: matched.map((x) => String(x.type)),
    segments: matched.map((x) => ({ type: String(x.type), data: x.data }))
  };
  rows.push(entry);
  rows = rows.slice(-50);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(rows, null, 2), 'utf8');
  fs.renameSync(file + '.tmp', file);
  return entry;
}

export function nativeSolitaireStatus(dataDir) {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8'));
    const latest = Array.isArray(rows) ? rows.at(-1) : null;
    return { captures: Array.isArray(rows) ? rows.length : 0, latest: latest ? { ...latest, segments: undefined } : null, nativeJoinSupported: false };
  } catch {
    return { captures: 0, latest: null, nativeJoinSupported: false };
  }
}
