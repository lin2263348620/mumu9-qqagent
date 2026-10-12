import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const hash = value => createHash('sha256').update(String(value)).digest('hex');
export class BehaviorState {
  constructor(dir) {
    fs.mkdirSync(dir,{recursive:true});
    this.db = new DatabaseSync(path.join(dir,'behavior.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS relations(q TEXT,scope TEXT,name TEXT,type TEXT,note TEXT,enabled INTEGER,updated INTEGER,PRIMARY KEY(q,scope));
      CREATE TABLE IF NOT EXISTS global_affinity(q TEXT PRIMARY KEY,points INTEGER NOT NULL,updated INTEGER);
      CREATE TABLE IF NOT EXISTS delivery(id TEXT PRIMARY KEY,chat TEXT,round TEXT,text TEXT,state TEXT,at INTEGER,mid TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS incoming(k TEXT PRIMARY KEY,at INTEGER);
      CREATE TABLE IF NOT EXISTS summaries(chat TEXT PRIMARY KEY,text TEXT,at INTEGER);
      CREATE TABLE IF NOT EXISTS images(k TEXT PRIMARY KEY,text TEXT,expires INTEGER);
      CREATE TABLE IF NOT EXISTS solitaire(k TEXT PRIMARY KEY,at INTEGER,state TEXT);
      CREATE TABLE IF NOT EXISTS repeat_users(k TEXT,q TEXT,at INTEGER,PRIMARY KEY(k,q));
      CREATE INDEX IF NOT EXISTS repeat_users_at ON repeat_users(at);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,chat TEXT,at INTEGER,body TEXT,status TEXT,reason TEXT,session TEXT,updated INTEGER);
      CREATE INDEX IF NOT EXISTS receipts_at ON receipts(at DESC);
      CREATE INDEX IF NOT EXISTS receipts_session ON receipts(session);
      CREATE TABLE IF NOT EXISTS metrics(day TEXT,k TEXT,n INTEGER,PRIMARY KEY(day,k));`);
    this.db.prepare("UPDATE delivery SET state='pending' WHERE state='sending'").run();
    this.db.prepare("UPDATE receipts SET status='waiting',reason='服务重启，等待恢复处理' WHERE status IN ('received','waiting','running') AND session IS NULL").run();
    this.affinityReader=()=>0;
  }
  day(now=Date.now()){return new Date(now+8*3600000).toISOString().slice(0,10);}
  metric(k, n=1){this.db.prepare('INSERT INTO metrics VALUES(?,?,?) ON CONFLICT(day,k) DO UPDATE SET n=n+excluded.n').run(this.day(),k,n);}
  metrics(){return Object.fromEntries(this.db.prepare('SELECT k,n FROM metrics WHERE day=?').all(this.day()).map(x=>[x.k,x.n]));}
  incomingKey(account,chat,mid){return mid==null ? '' : `${account}:${chat}:${mid}`;}
  seen(account,chat,mid){const k=this.incomingKey(account,chat,mid);return k && !!this.db.prepare('SELECT 1 FROM incoming WHERE k=?').get(k);}
  remember(account,chat,mid){const k=this.incomingKey(account,chat,mid);if(k)this.db.prepare('INSERT OR IGNORE INTO incoming VALUES(?,?)').run(k,Date.now());}
  receipt(account,chat,event) {
    const mid=event.message_id;
    const id='receipt-'+hash(mid==null ? `${account}|${chat}|${Date.now()}|${Math.random()}` : `${account}|${chat}|${mid}`);
    const segments=Array.isArray(event.message)?event.message:null;
    const text=segments ? segments.map(s=>s.type==='text'?s.data?.text||'':`[${s.type}]`).join('') : String(event.raw_message ?? event.message ?? '');
    const body={text,mid:mid??null,senderId:String(event.user_id??event.sender?.user_id??''),senderName:String(event.sender?.card||event.sender?.nickname||event.user_id||''),source:event.recovered?'history':'live'};
    const at=event.time?Number(event.time)*1000:Date.now();
    this.db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?,?,?,?)').run(id,chat,Number.isFinite(at)?at:Date.now(),JSON.stringify(body),'received','消息已收到',null,Date.now());
    return id;
  }
  receiptStatus(id,status,reason,session=null){if(id)this.db.prepare('UPDATE receipts SET status=?,reason=?,session=COALESCE(?,session),updated=? WHERE id=?').run(status,String(reason||''),session,Date.now(),id);}
  receiptGet(id){const row=this.db.prepare('SELECT * FROM receipts WHERE id=?').get(id);return row?{...row,body:JSON.parse(row.body)}:null;}
  receiptRows(limit=80,offset=0){return this.db.prepare('SELECT * FROM receipts ORDER BY at DESC,id DESC LIMIT ? OFFSET ?').all(limit,offset).map(row=>({...row,body:JSON.parse(row.body)}));}
  receiptCount(){return this.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;}
  hasReceiptSession(id){return !!this.db.prepare('SELECT 1 FROM receipts WHERE session=? LIMIT 1').get(id);}
  countRepeat(key,q,at,windowMs,now=Date.now()) {
    this.db.prepare('DELETE FROM repeat_users WHERE at<?').run(now-600000);
    this.db.prepare('INSERT INTO repeat_users VALUES(?,?,?) ON CONFLICT(k,q) DO UPDATE SET at=MAX(at,excluded.at)').run(key,q,at);
    return this.db.prepare('SELECT COUNT(*) AS n FROM repeat_users WHERE k=? AND at>=? AND at<=?').get(key,now-windowMs,now).n;
  }
  solitaireState(k){return this.db.prepare('SELECT state FROM solitaire WHERE k=?').get(k)?.state;}
  relations(){return this.db.prepare('SELECT r.*,a.points AS affinity FROM relations r LEFT JOIN global_affinity a ON a.q=r.q ORDER BY r.updated DESC').all();}
  relation(q,scope){return this.db.prepare("SELECT * FROM relations WHERE q=? AND enabled=1 AND scope IN (?, '*') ORDER BY CASE WHEN scope='*' THEN 1 ELSE 0 END LIMIT 1").get(String(q),String(scope));}
  saveRelation(row){
    const q=String(row.q||'').trim(),scope=String(row.scope||'*').trim();
    if(!/^\d{5,12}$/.test(q)||!(scope==='*'||/^group:\d+$/.test(scope)))throw new Error('QQ号或群范围无效');
    for(const k of ['name','note'])if(typeof row[k]!=='string'||row[k].length>(k==='note'?1000:80))throw new Error('关系字段无效');
    const type=row.type ?? this.db.prepare('SELECT type FROM relations WHERE q=? AND scope=?').get(q,scope)?.type ?? '';
    if(typeof type!=='string'||type.length>80)throw new Error('关系字段无效');
    if(Object.hasOwn(row,'affinity') && row.affinity!==null && (!Number.isInteger(row.affinity)||row.affinity<0||row.affinity>999999))throw new Error('全局好感度范围为 0–999999，留空为原有好感度');
    if(row.enabled!==undefined && typeof row.enabled!=='boolean')throw new Error('关系启用状态无效');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR REPLACE INTO relations VALUES(?,?,?,?,?,?,?)').run(q,scope,row.name.trim(),type.trim(),row.note.trim(),row.enabled===false?0:1,Date.now());
      if(Object.hasOwn(row,'affinity')) {
        if(row.affinity===null)this.db.prepare('DELETE FROM global_affinity WHERE q=?').run(q);
        else this.db.prepare('INSERT OR REPLACE INTO global_affinity VALUES(?,?,?)').run(q,row.affinity,Date.now());
      }
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
    return this.relation(q,scope);
  }
  deleteRelation(q,scope){this.db.prepare('DELETE FROM relations WHERE q=? AND scope=?').run(String(q),String(scope));this.db.prepare('DELETE FROM global_affinity WHERE q=? AND NOT EXISTS (SELECT 1 FROM relations WHERE q=?)').run(String(q),String(q));}
  globalAffinity(q){return this.db.prepare('SELECT a.points FROM global_affinity a WHERE a.q=? AND EXISTS (SELECT 1 FROM relations r WHERE r.q=a.q AND r.enabled=1)').get(String(q))?.points;}
  points(chat,q){const global=this.globalAffinity(q);if(global!==undefined)return global;try{return Number(this.affinityReader(chat,q))||0;}catch{return 0;}}
  begin(chat,round,text){
    const id=hash(`${chat}|${round}|${text.replace(/\s+/g,'')}`);
    const existing=this.db.prepare('SELECT * FROM delivery WHERE id=?').get(id);
    if(existing)return {existing};
    this.db.prepare('INSERT INTO delivery VALUES(?,?,?,?,?,?,?,?)').run(id,chat,round,text,'sending',Date.now(),null,'');
    return {id};
  }
  finish(id,state,mid=null,error=''){
    this.db.prepare("UPDATE delivery SET state=?,mid=?,error=? WHERE id=? AND NOT (state='sent' AND ?='pending')").run(state,mid==null?null:String(mid),String(error).slice(0,500),id,state);
    return this.db.prepare('SELECT * FROM delivery WHERE id=?').get(id);
  }
  reconcile(chat,text,mid,now=Date.now()){
    const rows=this.db.prepare("SELECT * FROM delivery WHERE chat=? AND state IN ('sending','pending') AND at>=? ORDER BY at").all(chat,now-86400000);
    const row=rows.find(r=>r.text.replace(/\s+/g,'')===String(text).replace(/\s+/g,''));
    if(row){this.finish(row.id,'sent',mid);return row;}return null;
  }
  pending(chat){return this.db.prepare("SELECT * FROM delivery WHERE state='pending' AND chat=? ORDER BY at DESC").all(chat);}
  deliveries(){return this.db.prepare('SELECT * FROM delivery ORDER BY at DESC LIMIT 100').all();}
  summary(chat){return this.db.prepare('SELECT text FROM summaries WHERE chat=?').get(chat)?.text||'';}
  summarize(chat,entries){
    const lines=entries.filter(e=>e.relevant).map(e=>`${e.senderName||e.senderId}：${String(e.text).slice(0,120)}`);
    if(lines.length)this.db.prepare('INSERT OR REPLACE INTO summaries VALUES(?,?,?)').run(chat,(this.summary(chat)+'\n'+lines.join('\n')).split('\n').slice(-12).join('\n').slice(-1200),Date.now());
  }
  imageKey(content,model){return hash(`${model}|${content}`);}
  imageGet(k){const row=this.db.prepare('SELECT text FROM images WHERE k=? AND expires>?').get(k,Date.now());this.metric(row?'imageHits':'imageMisses');return row?.text;}
  imagePut(k,text){this.db.prepare('INSERT OR REPLACE INTO images VALUES(?,?,?)').run(k,text,Date.now()+7*86400000);this.db.prepare('DELETE FROM images WHERE expires<=?').run(Date.now());}
  claimSolitaire(k){const row=this.db.prepare('SELECT 1 FROM solitaire WHERE k=?').get(k);if(row)return false;this.db.prepare('INSERT INTO solitaire VALUES(?,?,?)').run(k,Date.now(),'processing');return true;}
  finishSolitaire(k,state){this.db.prepare('UPDATE solitaire SET state=? WHERE k=?').run(state,k);}
  close(){this.db.close();}
}
