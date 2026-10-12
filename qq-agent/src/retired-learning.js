import fs from 'node:fs';
import path from 'node:path';

export const RETIRED_TOOLS = new Set(['kb_overview', 'kb_questions', 'kb_textbook', 'kb_progress', 'study_log', 'study_plan', 'schedule_query', 'teacher_control']);
const groups = ['knowledge', 'studyPlan', 'scheduleQuery', 'teacherControl'];

export function stripLearning(config) {
  delete config.scheduleNotify;
  for (const key of groups) delete config.toolFeatures?.[key];
  for (const key of RETIRED_TOOLS) delete config.toolEnabled?.[key];
  delete config.identityModes?.tutor;
  for (const [key, value] of Object.entries(config.personaModes || {})) if (value?.mode === 'tutor') delete config.personaModes[key];
  for (const key of Object.keys(config.personaBindings || {})) if (key.endsWith(':tutor')) delete config.personaBindings[key];
  return config;
}

// Fixed paths only. Shared chat, memory, personas and credentials are untouched.
export function retireLearningFiles(root, dataDir) {
  const backup = path.join(dataDir, 'retired-learning-backup');
  for (const [base, relative, bucket] of [
    ...['knowledge.js', 'study-plan.js', 'schedule-query.js', 'schedule-notify.js'].map(file => [path.join(root, 'src'), file, 'source']),
    [dataDir, 'knowledge/securities', 'data'], [dataDir, 'schedule', 'data']
  ]) {
    const source = path.join(base, relative);
    if (!fs.existsSync(source)) continue;
    if (fs.lstatSync(source).isSymbolicLink() || !fs.realpathSync(source).startsWith(fs.realpathSync(base) + path.sep)) throw new Error('Retired path escapes its owner: ' + relative);
    let target = path.join(backup, bucket, relative);
    if (fs.existsSync(target)) target += '.' + Date.now();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.renameSync(source, target);
    console.log('[migration] Archived retired learning module: ' + relative);
  }
}

export function migrateLearningConfig(parsed, configFile, dataDir) {
  const clean = stripLearning(structuredClone(parsed));
  if (JSON.stringify(clean) === JSON.stringify(parsed)) return clean;
  const backupDir = path.join(dataDir, 'retired-learning-backup');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  // A complete private rollback snapshot, never included in release packages.
  fs.copyFileSync(configFile, path.join(backupDir, 'config-before-' + Date.now() + '.json'));
  const temporary = configFile + '.migration.tmp';
  fs.writeFileSync(temporary, JSON.stringify(clean, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, configFile);
  return clean;
}
