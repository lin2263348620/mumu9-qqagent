export class ReceiveMonitor {
  constructor(){this.counts={group:0,private:0,stored:0,filtered:0,duplicate:0,unsupported:0,error:0,enrichmentFailed:0,self:0};this.lastReceivedAt=0;this.lastStoredAt=0;this.recent=[];}
  received(kind){if(kind==='group'||kind==='private')this.counts[kind]++;this.lastReceivedAt=Date.now();}
  record(result){if(!(result in this.counts))return;this.counts[result]++;if(result==='stored')this.lastStoredAt=Date.now();this.recent.unshift({at:Date.now(),result});this.recent=this.recent.slice(0,12);}
  snapshot(){return {counts:{...this.counts},lastReceivedAt:this.lastReceivedAt,lastStoredAt:this.lastStoredAt,recent:[...this.recent]};}
}
