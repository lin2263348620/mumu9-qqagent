export class StickerPolicy {
  constructor({random=Math.random,now=Date.now}={}) {
    this.random=random;this.now=now;this.rounds=new WeakMap();this.recent=new Map();
  }
  check(chatKey,session,settings={}) {
    if(settings.enabled===false)return '表情包已关闭';
    let round=this.rounds.get(session);
    if(!round){round={allowed:this.random()*100<Number(settings.replyProbability ?? 30),sent:false};this.rounds.set(session,round);}
    if(!round.allowed)return '本轮未命中表情包概率，请继续文字回复，不要重试表情工具';
    if(round.sent)return '本轮已发送表情包，请勿重复发送';
    const key=String(chatKey).split(':').slice(0,2).join(':');
    const last=this.recent.get(key);
    if(Number(settings.replyProbability ?? 30)<100&&last!==undefined&&this.now()-last<Number(settings.cooldownSeconds ?? 120)*1000)return '当前对话正在表情冷却期，请使用文字回复';
    return '';
  }
  sent(chatKey,session) {
    const round=this.rounds.get(session);if(round)round.sent=true;
    this.recent.set(String(chatKey).split(':').slice(0,2).join(':'),this.now());
    if(this.recent.size>2000)this.recent.delete(this.recent.keys().next().value);
  }
}
