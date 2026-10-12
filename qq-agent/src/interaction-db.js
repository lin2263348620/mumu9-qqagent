import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';

export function chinaDate(time = Date.now()) {
  return new Date(time + 8 * 3600000).toISOString().slice(0, 10);
}
export function validateIds(group, qq) {
  if (!/^\d{1,20}$/.test(String(group)) || !/^\d{5,12}$/.test(String(qq))) throw new Error('请填写有效群号和 QQ 号');
}
export class InteractionDB {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.cacheDir = path.join(dir, 'cache', 'interaction-panel');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'bot-data.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (g TEXT NOT NULL,q TEXT NOT NULL,n TEXT NOT NULL DEFAULT '',points INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(g,q));
      CREATE TABLE IF NOT EXISTS daily (day TEXT,g TEXT,q TEXT,kind TEXT,n INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,g,q,kind));
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,g TEXT,q TEXT,kind TEXT,at INTEGER,result TEXT,status TEXT);
      CREATE TABLE IF NOT EXISTS fortunes (day TEXT,g TEXT,q TEXT,result TEXT,PRIMARY KEY(day,g,q));
      CREATE TABLE IF NOT EXISTS checkins (day TEXT,g TEXT,q TEXT,n TEXT NOT NULL DEFAULT '',at INTEGER,PRIMARY KEY(day,g,q));
      CREATE INDEX IF NOT EXISTS checkins_group ON checkins(g,q,day);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY,at INTEGER,g TEXT,q TEXT,action TEXT,before_value INTEGER,after_value INTEGER);
      CREATE TABLE IF NOT EXISTS cache (id INTEGER PRIMARY KEY,k TEXT,messages TEXT,created INTEGER,expires INTEGER,used INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS cache_key ON cache(k,expires);
      CREATE TABLE IF NOT EXISTS recent (g TEXT,q TEXT,cache_id INTEGER,at INTEGER);
      CREATE TABLE IF NOT EXISTS metrics (day TEXT,k TEXT,n INTEGER DEFAULT 0,PRIMARY KEY(day,k));`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  user(g, q) { return this.db.prepare('SELECT * FROM users WHERE g=? AND q=?').get(g, q) || { g, q, n: q, points: 0 }; }
  pointsForChat(chat, q) {
    const [kind, id] = String(chat).split(':');
    if (kind === 'group') return this.user(id, String(q)).points;
    return this.db.prepare('SELECT MAX(points) AS points FROM users WHERE q=?').get(String(q))?.points || 0;
  }
  counts(g,q,day=chinaDate()) { return this.db.prepare('SELECT kind,n FROM daily WHERE day=? AND g=? AND q=?').all(day,g,q); }
  rank(g, limit=10) { return this.db.prepare('SELECT q,n,points FROM users WHERE g=? ORDER BY points DESC,q LIMIT ?').all(g,limit); }
  change(g,q,points,action='set') {
    validateIds(g,q);
    if (!Number.isInteger(points) || points < 0 || points > 999999) throw new Error('好感度范围为 0–999999');
    return this.transaction(() => {
      const previous = this.user(g,q).points;
      this.db.prepare('INSERT INTO users(g,q,n,points) VALUES(?,?,?,?) ON CONFLICT(g,q) DO UPDATE SET points=excluded.points').run(g,q,q,points);
      this.db.prepare('INSERT INTO audit(at,g,q,action,before_value,after_value) VALUES(?,?,?,?,?,?)').run(Date.now(),g,q,action,previous,points);
      return this.user(g,q);
    });
  }
  reset(g,q) {
    validateIds(g,q);
    this.transaction(() => {
      this.db.prepare('DELETE FROM daily WHERE day=? AND g=? AND q=?').run(chinaDate(),g,q);
      this.db.prepare('INSERT INTO audit(at,g,q,action) VALUES(?,?,?,?)').run(Date.now(),g,q,'reset-daily');
    });
  }
  clearGroup(g) {
    if (!/^\d{1,20}$/.test(g)) throw new Error('群号无效');
    this.transaction(() => {
      this.db.prepare('UPDATE users SET points=0 WHERE g=?').run(g);
      this.db.prepare('INSERT INTO audit(at,g,action) VALUES(?,?,?)').run(Date.now(),g,'clear-ranking');
    });
  }
  settle({id,g,q,n,kind}, settings, now=Date.now()) {
    return this.transaction(() => {
      const exists = this.db.prepare('SELECT id FROM events WHERE id=?').get(id);
      if (exists) return { duplicate: true };
      this.db.prepare('INSERT INTO users(g,q,n) VALUES(?,?,?) ON CONFLICT(g,q) DO UPDATE SET n=excluded.n').run(g,q,n);
      const day = chinaDate(now);
      const used = this.db.prepare('SELECT n FROM daily WHERE day=? AND g=? AND q=? AND kind=?').get(day,g,q,kind)?.n || 0;
      const limit = settings[kind]?.limit || 1;
      const delta = used < limit ? settings[kind].points : 0;
      const before = this.user(g,q).points;
      if (used < limit) {
        this.db.prepare('INSERT INTO daily(day,g,q,kind,n) VALUES(?,?,?,?,1) ON CONFLICT(day,g,q,kind) DO UPDATE SET n=n+1').run(day,g,q,kind);
        this.db.prepare('UPDATE users SET points=MIN(999999,points+?) WHERE g=? AND q=?').run(delta,g,q);
      }
      const result = { kind, limited: used >= limit, points: this.user(g,q).points, delta: this.user(g,q).points-before, used: Math.min(used+1,limit), limit };
      this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(id,g,q,kind,now,JSON.stringify(result),'settled');
      return result;
    });
  }
  claim(id,g,q,kind) {
    return this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?)').run(id,g,q,kind,Date.now(),'{}','settled').changes > 0;
  }
  finish(id,status) { this.db.prepare('UPDATE events SET status=? WHERE id=?').run(status,id); }
  fortune(g,q,now=Date.now()) {
    const day=chinaDate(now);
    const old=this.db.prepare('SELECT result FROM fortunes WHERE day=? AND g=? AND q=?').get(day,g,q);
    if(old) return JSON.parse(old.result);
    const score=randomInt(1,101);
    const result={ day, score, level: score<=20?'大凶':score<=40?'小凶':score<=60?'平':score<=80?'吉':score<=95?'大吉':'超级幸运',
      color:['黄色','蓝色','绿色','粉色','白色'][randomInt(5)], number:randomInt(1,10),
      event:['和朋友散步','吃一份喜欢的甜点','完成一件小事','好好休息','向朋友表达感谢'][randomInt(5)] };
    this.db.prepare('INSERT OR IGNORE INTO fortunes VALUES(?,?,?,?)').run(day,g,q,JSON.stringify(result));
    return JSON.parse(this.db.prepare('SELECT result FROM fortunes WHERE day=? AND g=? AND q=?').get(day,g,q).result);
  }
  checkin({id,g,q,n},now=Date.now()) {
    return this.transaction(()=>{
      if(this.db.prepare('SELECT id FROM events WHERE id=?').get(id)) return {duplicate:true};
      validateIds(g,q);
      const day=chinaDate(now);
      this.db.prepare('INSERT INTO users(g,q,n) VALUES(?,?,?) ON CONFLICT(g,q) DO UPDATE SET n=excluded.n').run(g,q,n);
      const inserted=this.db.prepare('INSERT OR IGNORE INTO checkins(day,g,q,n,at) VALUES(?,?,?,?,?)').run(day,g,q,n,now).changes>0;
      if(!inserted) this.db.prepare('UPDATE checkins SET n=? WHERE day=? AND g=? AND q=?').run(n,day,g,q);
      const total=this.db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE g=? AND q=?').get(g,q).n;
      const days=this.db.prepare('SELECT day FROM checkins WHERE g=? AND q=? ORDER BY day DESC').all(g,q).map(x=>x.day);
      let streak=0,cursor=new Date(`${day}T00:00:00Z`);
      for(const value of days){if(value!==cursor.toISOString().slice(0,10))break;streak++;cursor=new Date(cursor.getTime()-86400000);}
      const result={kind:'checkin',limited:!inserted,points:this.user(g,q).points,day,total,streak};
      this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(id,g,q,'checkin',now,JSON.stringify(result),'settled');
      return result;
    });
  }
  checkinRank(g,limit=10) {
    if(!/^\d{1,20}$/.test(String(g))) throw new Error('群号无效');
    return this.db.prepare(`SELECT q,MAX(n) AS n,COUNT(*) AS total,MAX(day) AS lastDay
      FROM checkins WHERE g=? GROUP BY q ORDER BY total DESC,lastDay ASC,q LIMIT ?`).all(g,limit);
  }
  checkinUser(g,q,now=Date.now()) {
    validateIds(g,q);
    const day=chinaDate(now);
    const days=this.db.prepare('SELECT day FROM checkins WHERE g=? AND q=? ORDER BY day DESC').all(g,q).map(x=>x.day);
    let streak=0,cursor=new Date(`${day}T00:00:00Z`);
    for(const value of days){if(value!==cursor.toISOString().slice(0,10))break;streak++;cursor=new Date(cursor.getTime()-86400000);}
    return {total:days.length,streak,checkedToday:days[0]===day,lastDay:days[0]||null};
  }
  metric(k) { this.db.prepare('INSERT INTO metrics VALUES(?,?,1) ON CONFLICT(day,k) DO UPDATE SET n=n+1').run(chinaDate(),k); }
  cacheCount(k) {return this.db.prepare('SELECT COUNT(*) AS n FROM cache WHERE k=? AND expires>?').get(k,Date.now()).n;}
  cachePick(k,g,q,recent=5) {
    const pool=this.db.prepare('SELECT * FROM cache WHERE k=? AND expires>? ORDER BY used,id').all(k,Date.now());
    const exclude=Math.min(recent,Math.max(1,pool.length-1));
    const used=this.db.prepare('SELECT cache_id FROM recent WHERE g=? AND q=? ORDER BY at DESC,rowid DESC LIMIT ?').all(g,q,exclude).map(x=>x.cache_id);
    const hit=pool.find(x=>!used.includes(x.id));
    if(!hit)this.metric(pool.length?'missRecent':'missEmptyOrExpired');
    return hit;
  }
  used(entry,g,q) {
    this.db.prepare('UPDATE cache SET used=used+1 WHERE id=?').run(entry.id);
    this.db.prepare('INSERT INTO recent VALUES(?,?,?,?)').run(g,q,entry.id,Date.now());
  }
  cacheAdd(k,messages,cfg) {
    const existing=this.db.prepare('SELECT id FROM cache WHERE k=? AND messages=? AND expires>?').get(k,JSON.stringify(messages),Date.now());
    if(existing)return existing.id;
    const info=this.db.prepare('INSERT INTO cache(k,messages,created,expires) VALUES(?,?,?,?)').run(k,JSON.stringify(messages),Date.now(),Date.now()+cfg.days*86400000);
    if(cfg.files) this.exportCache(Number(info.lastInsertRowid),k,messages);
    this.prune(cfg.maxEntries);
    return Number(info.lastInsertRowid);
  }
  exportCache(id,k,messages) {
    const target=path.join(this.cacheDir,`${id}.json`);
    fs.writeFileSync(target+'.tmp',JSON.stringify({id,key:k,messages}),'utf8');
    fs.renameSync(target+'.tmp',target);
  }
  prune(max=300,all=false) {
    if(all) this.db.exec('DELETE FROM cache; DELETE FROM recent;');
    else {
      this.db.prepare('DELETE FROM cache WHERE expires<=?').run(Date.now());
      this.db.prepare('DELETE FROM cache WHERE id NOT IN (SELECT id FROM cache ORDER BY created DESC LIMIT ?)').run(max);
      this.db.prepare('DELETE FROM recent WHERE at<?').run(Date.now()-30*86400000);
    }
    const ids=new Set(this.db.prepare('SELECT id FROM cache').all().map(x=>`${x.id}.json`));
    for(const name of fs.readdirSync(this.cacheDir)) if(/^\d+\.json(?:\.tmp)?$/.test(name) && !ids.has(name)) fs.unlinkSync(path.join(this.cacheDir,name));
  }
  status() { return { entries:this.db.prepare('SELECT COUNT(*) AS n FROM cache WHERE expires>?').get(Date.now()).n,
    metrics:Object.fromEntries(this.db.prepare('SELECT k,n FROM metrics WHERE day=?').all(chinaDate()).map(x=>[x.k,x.n])),
    groups:this.db.prepare('SELECT DISTINCT g FROM users').all().map(x=>x.g),
    audit:this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 20').all() }; }
  metricCount(k){return this.db.prepare('SELECT n FROM metrics WHERE day=? AND k=?').get(chinaDate(),k)?.n||0;}
  close() { this.db.close(); }
}
