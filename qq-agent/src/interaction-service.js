import { createHash, randomUUID } from 'node:crypto';
import { InteractionDB } from './interaction-db.js';
import { normalizeInteraction } from './interaction-settings.js';
import { isToolEnabled } from './tool-features.js';
import { affinityTier } from './behavior-policy.js';

export const TOOL_HELP = {
  send_message:['文字回复','@bot 你好'], send_sticker:['发送表情','@bot 发个表情'], list_stickers:['查看表情','@bot 查看可用表情'],
  get_sticker_image:['查看表情图片','@bot 看看这个表情'], sticker_note:['备注表情','@bot 给这个表情备注开心'], collect_sticker:['收藏表情','@bot 收藏这张表情'],
  send_image:['发送图片','@bot 发送这张图片'],get_message_images:['识别图片','发送图片后：@bot 看看这张图'],
  receive_file:['接收文件','发送文件后：@bot 接收这个文件'],send_file:['发送文件','@bot 把完成的文件发给我'],send_poke:['拍一拍','@bot 拍一拍某某'],
  get_recent_messages:['历史消息','@bot 查看最近消息'],get_message_detail:['消息详情','引用消息后：@bot 查看这条消息'],get_active_members:['活跃成员','@bot 查看活跃成员'],
  web_search:['联网搜索','@bot 搜索今天的新闻'],web_fetch:['读取网页','@bot 读取网页 https://example.com'],
  memory_append:['记录记忆','@bot 记住我喜欢甜食'],memory_query:['查询记忆','@bot 查看记忆'],memory_remove:['删除记忆','@bot 忘记这件事'],
  schedule_task:['定时提醒','@bot 明天8点提醒我交作业'],
  dsh_task:['后台制作任务','@bot 帮我制作文档'],report_feedback:['问题反馈','@bot 反馈这个问题'],finish:['结束处理','由机器人自动结束本轮处理']
};
const COMMANDS={ '投喂':'feed','摸摸头':'pet','散步':'walk','签到':'checkin','签到排行榜':'checkinRanking','好感度':'affinity','好感度排行':'ranking','今日运势':'fortune','指令列表':'commandList' };
export function parseCommand(event,selfId) {
  const segments=Array.isArray(event.message)?event.message:null;
  const raw=String(event.raw_message || event.message || '');
  const mentioned=segments ? segments.some(x=>x.type==='at' && String(x.data?.qq)===String(selfId))
    : [...raw.matchAll(/\[CQ:at,qq=(\d+)(?:,[^\]]*)?\]/g)].some(x=>x[1]===String(selfId));
  const text=(segments?segments.filter(x=>x.type==='text').map(x=>x.data?.text||'').join(''):raw.replace(/\[CQ:[^\]]*\]/g,'')).trim();
  const command=COMMANDS[text];
  if(command) return {command,mentioned,text};
  const admin=/^(查询好感度|设置好感度|重置今日次数|清空好感度)\s+(\d{5,12})(?:\s+(\d+))?$/.exec(text);
  if(admin) return {command:'admin',mentioned,text,action:admin[1],qq:admin[2],points:admin[3]===undefined?undefined:Number(admin[3])};
  return null;
}
export function replyRange(settings,points) {
  if(settings.singleReply)return [1,1];
  if(points>settings.highThreshold && settings.multiReply) return [settings.minMessages,settings.maxMessages];
  return points<50?[1,1]:points<100?[1,2]:[2,3];
}
export function checkReplies(messages,range,forbidden=[],maxChars=120) {
  if(!Array.isArray(messages) || messages.length<range[0] || messages.length>range[1]) return false;
  const emoticons=(messages.join('').match(/•▽•|´•ω•|；ω；|>▽</g)||[]).length;
  return emoticons<=1 && messages.every(x=>typeof x==='string' && x.length>0 && x.length<=Number(maxChars||120)
    && !/[\r\n]|\[CQ:|<\/?[a-z]|(.)\1{6}/i.test(x) && !/[(（][^）)]*(?:你|用户|对方)[^）)]*[)）]/.test(x)
    && !forbidden.some(word=>word && x.includes(word)));
}
export class InteractionService {
  constructor({dir,getConfig,generate,sender,log=()=>{},db,canRun=()=>true,wait=ms=>new Promise(r=>setTimeout(r,ms))}) {
    this.canRun=canRun;this.refilling=new Set();
    this.db=db || new InteractionDB(dir); this.getConfig=getConfig; this.generate=generate; this.sender=sender; this.log=log; this.wait=wait;
    this.tail=Promise.resolve(); this.pending=0; this.lastError=''; this.closed=false;
  }
  settings() { return normalizeInteraction(this.getConfig().interaction); }
  enqueue(fn) {
    if(this.closed || this.pending>=30) return Promise.reject(new Error('互动队列已满，请稍后再试'));
    this.pending++;
    const job=this.tail.then(fn);
    this.tail=job.catch(()=>{}).finally(()=>this.pending--);
    return job;
  }
  async handle(kind,g,event,selfId) {
    const parsed=parseCommand(event,selfId); if(!parsed) return false;
    const cfg=this.settings();
    if(kind!=='group') return false;
    const q=String(event.user_id ?? event.sender?.user_id ?? '');
    if(q===String(selfId) || cfg.blockedBots.includes(q)) return true;
    // Recognized but disabled commands must not fall through to the language model.
    if(!cfg.enabled || !isToolEnabled('send_message',this.getConfig()) || !this.canRun() || (cfg.requireAt && !parsed.mentioned && this.getConfig().behavior?.interactionException!==true)) return true;
    const master=String(this.getConfig().persona?.masterQQ||'');
    if((parsed.command==='commandList'||parsed.command==='admin') && (!master || q!==master)) return true;
    const flag=cfg[parsed.command]; if(flag===false || flag?.enabled===false) return true;
    const id=event.message_id!=null ? `${selfId}:${g}:${q}:${event.message_id}` : `${selfId}:${g}:${q}:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}`;
    const data={id,g,q,n:String(event.sender?.card||event.sender?.nickname||q).slice(0,80),kind:parsed.command};
    await this.enqueue(async()=>{
      const current=this.settings();
      if(!this.canRun() || !current.enabled || current[parsed.command]===false || current[parsed.command]?.enabled===false) return;
      if(['admin','commandList'].includes(parsed.command) && String(this.getConfig().persona?.masterQQ||'')!==q) return;
      let result;
      if(['feed','pet','walk'].includes(parsed.command)) result=this.db.settle(data,current);
      else if(parsed.command==='checkin') result=this.db.checkin(data);
      else if(!this.db.claim(id,g,q,parsed.command)) return;
      if(result?.duplicate) return;
      let messages;
      try {
        if(parsed.command==='admin') {
          if(parsed.action==='设置好感度') this.db.change(g,parsed.qq,parsed.points);
          if(parsed.action==='清空好感度') this.db.change(g,parsed.qq,0);
          if(parsed.action==='重置今日次数') this.db.reset(g,parsed.qq);
          messages=[`[管理结果] QQ ${parsed.qq}，好感度 ${this.db.user(g,parsed.qq).points}${parsed.action==='重置今日次数'?'，今日次数已重置':''}`];
        } else if(parsed.command==='affinity') messages=[`[好感度] ${data.n}：${this.db.user(g,q).points}\n今日次数：${this.db.counts(g,q).map(x=>`${{feed:'投喂',pet:'摸头',walk:'散步'}[x.kind]} ${x.n}`).join('，')||'暂无互动'}`];
        else if(parsed.command==='ranking') messages=[`[本群好感度排行]\n${this.db.rank(g,current.rankLimit).map((x,i)=>`${i+1}. ${x.n}（${x.q}） ${x.points}`).join('\n')||'暂无记录'}`];
        else if(parsed.command==='checkinRanking') messages=[`[本群签到排行榜]\n${this.db.checkinRank(g,current.checkinRankLimit).map((x,i)=>`${i+1}. ${x.n}（${x.q}） ${x.total} 天`).join('\n')||'暂无签到记录'}`];
        else if(parsed.command==='commandList') messages=[await this.commandList()];
        else {
          result ||= {kind:'fortune',points:this.db.user(g,q).points,fortune:this.db.fortune(g,q)};
          result.points=this.sender.behavior?.points?.(`group:${g}`,q) ?? result.points;
          result.relation=this.sender.behavior?.relation(q,`group:${g}`)||null;
          const generated=await this.reply(result,g,q);
          messages=generated.messages;
          if(result.kind==='checkin') messages=[`[签到] ${result.limited?'今天已经签到过了':'签到成功'} · 累计 ${result.total} 天 · 连续 ${result.streak} 天`,...messages];
          if(result.fortune) {
            const f=result.fortune;
            messages=[`[今日运势] ${f.day} · ${f.score}/100 · ${f.level}\n幸运颜色：${f.color} · 幸运数字：${f.number}\n今日宜：${f.event}\n仅供娱乐`,...messages];
          }
        }
        // Recheck switches after a potentially slow model request.
        const latest=this.settings();
        if(!this.canRun() || !latest.enabled || latest[parsed.command]===false || latest[parsed.command]?.enabled===false) {this.db.finish(id,'disabled-before-send');return;}
        const tier=affinityTier(this.getConfig(),this.sender.behavior?.points?.(`group:${g}`,q) ?? this.db.user(g,q).points);
        const session={id:`interaction:${id}`,replyMaxChars:tier.maxChars,affinityTier:tier,affinityQQs:[q]};
        const structured=['admin','affinity','ranking','checkinRanking','commandList','checkin','fortune'].includes(parsed.command);
        if(structured)messages=[messages.join('\n')];
        const sent=await this.sender.sendTextBatch(`group:${g}`,messages,{atUserId:q,interactionGapMs:latest.gapMs,session,structured});
        this.db.finish(id,sent.pending?.length?'pending':sent.skipped?'disabled':'sent');
        if(sent.sent.length && !['admin','affinity','ranking','checkinRanking','commandList'].includes(parsed.command))await this.sender.autoSticker?.(`group:${g}`,sent.sent.map(x=>x.text).join('\n'),session);
      } catch(error) {
        this.lastError=String(error.message||error); this.log('[互动] '+this.lastError); this.db.finish(id,'failed');
        await this.sender.sendTextBatch(`group:${g}`,[`[系统提示] ${result?'本次互动已记录，回复暂未生成，请稍后再试。':'操作未完成，请在后台查看互动状态。'}`],{atUserId:q}).catch(()=>{});
      }
    }).catch(error=>{this.lastError=error.message;});
    return true;
  }
  key(result,cfg) {
    return createHash('sha256').update(JSON.stringify({replyPolicy:2,persona:cfg.persona,extra:cfg.extraRules,forbidden:cfg.forbidden,
      kind:result.kind,limited:!!result.limited,range:replyRange(cfg,result.points),affinityMin:cfg.affinityMin,
      fortune:result.fortune||null,maxChars:cfg.messageMaxChars,relation:result.relation||null})).digest('hex');
  }
  async reply(result,g='preview',q='preview',force=false) {
    const base=this.settings(),tier=affinityTier(this.getConfig(),result.points);
    base.persona=base.persona.trim() || String(this.getConfig().persona?.roleText || '').trim();
    if(!base.persona)throw new Error('请先在后台配置默认人设或互动人设');
    const cfg={...base,singleReply:true,affinityMin:tier.min||0,messageMaxChars:tier.maxChars,cache:{...base.cache,target:this.getConfig().behavior?.cache?.target ?? 10}};
    const range=replyRange(cfg,result.points),key=this.key(result,cfg);
    if(cfg.cache.enabled && !force) {
      const hit=this.db.cachePick(key,g,q,cfg.cache.recent);
      if(hit) {
        const messages=JSON.parse(hit.messages);
        if(checkReplies(messages,range,cfg.forbidden,cfg.messageMaxChars)) {this.db.used(hit,g,q);this.db.metric('hits');this.refill(result,key,cfg);return {messages,cached:true};}
      }
    }
    if(force && this.db.metricCount('refillCalls') >= (this.getConfig().behavior?.cache?.dailyBudget ?? 20)) {this.db.metric('budgetSkipped');return {messages:[],budgetSkipped:true,cached:false};}
    const count=cfg.cache.enabled?Math.max(cfg.cache.batch,Math.min(8,cfg.cache.target)):1;
    const scenes={feed:'群友 @bot 投喂甜食。表达收到投喂的开心或感谢，可描述自己吃甜食的小动作。',pet:'群友 @bot 摸摸头。回应被摸头的感受，只描述自己的动作。',walk:'群友 @bot 邀请散步。回应一起散步的期待，可描述自己准备出发的小动作。'};
    const scene=(scenes[result.kind]||'按当前互动场景自然回应。')+(result.limited?'今日次数已用完；温和表达需要休息或稍后再来，不得声称本次成功增加好感度。':'本次互动已记录；不要重复计分，不报具体数值。');
    const system=`${cfg.persona}\n管理员附加规则：${cfg.extraRules}\n本次是标准互动回复，语气必须遵循管理员人设，不预设口头禅。亲密度只影响亲近和高兴程度，不改变权限。只输出JSON：{"replies":[{"messages":["简短回复"]}]}。生成${count}组不同回复，每组仅一条、最多${cfg.messageMaxChars}字，动作也计入。最多一个颜文字。不可写具体数值、次数、日期或编造共同经历。运势评论不得修改事实。不输出工具或Markdown。禁词：${JSON.stringify(cfg.forbidden)}。`;
    let last;
    for(let attempt=0;attempt<=cfg.regeneration;attempt++) {
      try {
        let response;
        for(let retry=0;retry<4;retry++) {
          if(force){if(this.db.metricCount('refillCalls') >= (this.getConfig().behavior?.cache?.dailyBudget ?? 20))throw new Error('缓存补充达到每日预算');this.db.metric('refillCalls');}
          else this.db.metric('missApiCalls');
          this.db.metric('apiCalls');
          try { response=await this.generate({messages:[{role:'system',content:system},{role:'user',content:JSON.stringify({interaction:result.kind,scene,limited:!!result.limited,affinityMin:cfg.affinityMin,affinityStyle:cfg.affinityMin>=200?'非常亲近、高兴，但保持简短':'亲近程度随档位逐渐增加，不改变人设',fortune:result.fortune||null,relation:result.relation?{name:result.relation.name,type:result.relation.type,note:result.relation.note}:null,regenerate:attempt>0})}],tools:null});break; }
          catch(e) { if(!/429/.test(e.message)||retry===3) throw e; await this.wait([2000,5000,12000][retry]); }
        }
        const raw=String(response.message?.content||'').trim().replace(/^```(?:json)?\s*|\s*```$/g,'');
        const groups=JSON.parse(raw).replies;
        if(!Array.isArray(groups)) throw new Error('模型未返回回复数组');
        const accepted=groups.slice(0,10).filter(x=>checkReplies(x?.messages,range,cfg.forbidden,cfg.messageMaxChars));
        if(!accepted.length) throw new Error('回复未通过格式、人设用语或禁词检查');
        const actualChat=/^\d+$/.test(String(g))&&/^\d+$/.test(String(q));
        const freshPoints=actualChat ? this.sender.behavior?.points?.(`group:${g}`,q) ?? result.points : result.points;
        const freshTier=affinityTier(this.getConfig(),freshPoints);
        const latest=this.settings();
        latest.persona=latest.persona.trim() || String(this.getConfig().persona?.roleText || '').trim();
        const fresh={...latest,singleReply:true,affinityMin:freshTier.min||0,messageMaxChars:freshTier.maxChars};
        const freshResult=actualChat ? {...result,points:freshPoints,relation:this.sender.behavior?.relation(q,`group:${g}`)||null} : result;
        if(this.key(freshResult,fresh)!==key) throw new Error('人设已更新，本次旧回复已作废');
        let firstId;
        if(cfg.cache.enabled) for(const group of accepted) {const id=this.db.cacheAdd(key,group.messages,cfg.cache);firstId??=id;}
        if(firstId) this.db.used({id:firstId},g,q);
        this.lastError=''; if(!force)this.refill(result,key,cfg); return {messages:accepted[0].messages,cached:false,generated:accepted.length};
      } catch(e) {last=e; if(/429|401|403|人设已更新/.test(e.message)) break;}
    }
    if (/人设已更新/.test(last?.message || '')) throw last;
    // A recent reply may be reused on service failure, but never from an old persona.
    if(cfg.cache.enabled) {
      const hit=this.db.cachePick(key,g,q,0);
      if(hit && checkReplies(JSON.parse(hit.messages),range,cfg.forbidden,cfg.messageMaxChars)) {this.db.metric('fallbacks');return {messages:JSON.parse(hit.messages),cached:true};}
    }
    throw last;
  }
  refill(result,key,cfg) {
    if(!cfg.cache.enabled || !this.getConfig().behavior?.cache?.refill || this.refilling.has(key) || this.db.cacheCount(key)>=cfg.cache.target || this.closed || this.db.metricCount('refillCalls') >= (this.getConfig().behavior?.cache?.dailyBudget ?? 20))return;
    this.refilling.add(key);
    this.enqueue(async()=>{
      const current=this.settings();
      if(this.getConfig().behavior?.cache?.refill && current.cache.enabled && this.db.cacheCount(key)<cfg.cache.target)
        await this.reply(result,'refill','refill',true);
    }).catch(e=>{this.lastError=e.message;}).finally(()=>this.refilling.delete(key));
  }
  async commandList() {
    const cfg=this.settings(); const lines=['[主人指令列表]'];
    for(const [text,key] of Object.entries(COMMANDS)) if(cfg[key]!==false && cfg[key]?.enabled!==false) lines.push(`${text} @bot${cfg[key]?.limit?`（每天${cfg[key].limit}次）`:''}`);
    const {buildToolDefs}=await import('./tools.js');
    for(const def of buildToolDefs()) if(isToolEnabled(def.name,this.getConfig()) && TOOL_HELP[def.name]) lines.push(`${TOOL_HELP[def.name][0]}：${TOOL_HELP[def.name][1]}${def.masterOnly?'（仅主人）':''}`);
    lines.push('查询好感度 QQ号 @bot','设置好感度 QQ号 999 @bot','重置今日次数 QQ号 @bot','清空好感度 QQ号 @bot','以上管理指令仅主人可用，作用于当前群。原有工具示例需要模型及对应外部服务可用。');
    return lines.join('\n');
  }
  status() {return {...this.db.status(),pending:this.pending,lastError:this.lastError};}
  async close() {this.closed=true;await this.tail;this.db.close();}
}
