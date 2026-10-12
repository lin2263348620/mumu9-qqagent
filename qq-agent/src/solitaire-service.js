import { createHash } from 'node:crypto';
export function identifySolitaire(event) {
  const segments=Array.isArray(event.message)?event.message:[];
  if(segments.some(s=>['json','xml','ark','light_app'].includes(s.type) && /接龙|solitaire|group[_-]?relay/i.test(JSON.stringify(s.data)))) return {native:true};
  const text=segments.length?segments.filter(s=>s.type==='text').map(s=>s.data?.text||'').join(''):String(event.raw_message||event.message||'');
  if(!/接龙/.test(text)||/排行榜|好感度|指令列表/.test(text))return null;
  const lines=text.trim().split(/\r?\n/);
  const numbered=lines.map(line=>/^\s*(\d+)[.、．）)]\s*(.+)$/.exec(line)).filter(Boolean);
  if(!numbered.length)return null;
  const title=lines.filter(line=>!/^\s*\d+[.、．）)]/.test(line)).join('\n');
  return {native:false,text,title,next:Math.max(...numbered.map(x=>Number(x[1])))+1,items:numbered.map(x=>x[2])};
}
export function repeatText(event) {
  if(Array.isArray(event.message)) {
    if(!event.message.length || event.message.some(s=>s.type!=='text'))return null;
    return event.message.map(s=>String(s.data?.text??'')).join('');
  }
  const text=String(event.raw_message??event.message??'');
  return /\[CQ:/.test(text)?null:text;
}
export async function handleRepeatFollow({event,chat,state,sender,settings,cfg,selfId,paused=false,onClaim=()=>{},log=console.info,now=Date.now()}) {
  const q=String(event.user_id??event.sender?.user_id??'');
  const id=chat.split(':')[1],whitelist=cfg.allow?.groups||cfg.allow?.group||[];
  const denied=cfg.deny?.groups||cfg.deny?.group||[];
  if(!settings.enabled || paused || cfg.groupResponse?.enabled===false || !whitelist.map(String).includes(id) || denied.map(String).includes(id))return {handled:false};
  if(!q || q===String(selfId) || (cfg.botIds||[]).map(String).includes(q))return {handled:false};
  const text=repeatText(event),at=event.time?Number(event.time)*1000:now;
  if(text==null || !text.trim() || Array.from(text).length>settings.maxChars || !Number.isFinite(at) || at<now-settings.windowSeconds*1000 || at>now+5000)return {handled:false};
  const key=createHash('sha256').update(JSON.stringify([String(selfId),chat,text])).digest('hex');
  if(state.solitaireState(key))return {handled:true,status:'skipped',reason:'相同文字已经跟发或提交过，本地去重'};
  const count=state.countRepeat(key,q,Math.min(at,now),settings.windowSeconds*1000,now);
  if(count<3)return {handled:false,count};
  if(!state.claimSolitaire(key))return {handled:true,status:'skipped',reason:'相同文字已处理'};
  onClaim(text);
  try {
    const result=await sender.sendTextBatch(chat,text,{roundId:`repeat:${key}`,structured:true,exactText:true,
      canSend:()=>sender.repeatAllowed?.(chat)!==false});
    const status=result.pending?.length?'pending':result.skipped?'skipped':'done';
    state.finishSolitaire(key,status);
    return {handled:true,status,reason:status==='pending'?`delivery:${result.pending[0].deliveryId}`:status==='skipped'?'跟发被发送开关拦截':'三位不同用户发送相同文字，已原样跟发一次'};
  } catch(error){state.finishSolitaire(key,'failed');log('[repeat] 跟发失败：'+error.message);return {handled:true,status:'error',reason:'跟发失败：'+error.message};}
}
