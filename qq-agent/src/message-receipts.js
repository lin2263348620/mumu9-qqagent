export function receiptView(row, sessions, state) {
  if (!row) return null;
  const linked=row.session ? sessions.get(row.session) : null;
  const view=linked ? {...linked} : {messages:[],sent:[],rounds:0,usage:null,model:''};
  let status=row.status==='skipped'?row.status:linked?.status || row.status, reason=row.reason;
  if (row.session && !linked && row.status==='running') {status='aborted';reason='处理会话已中断或详细记录已过期';}
  if (status==='pending' && !linked && row.reason.startsWith('delivery:')) {
    const delivery=state.db.prepare('SELECT state FROM delivery WHERE id=?').get(row.reason.slice(9));
    if (delivery?.state==='sent') {status='done';reason='相同文字跟发已确认';}
  }
  return {...view,id:row.id,chatKey:row.chat,startedAt:row.at,endedAt:linked?.endedAt??(['received','waiting','running'].includes(status)?null:row.updated),status,
    trigger:`${row.body.senderName || row.body.senderId}：${row.body.text}`,
    triggerSummary:`${row.body.senderName || row.body.senderId}：${row.body.text}`,
    receipt:{...row.body,reason:reason.startsWith('delivery:')?'跟发结果待确认，禁止重复提交':reason,updated:row.updated,sessionId:row.session}};
}
export function listMessageRecords(state,sessions,limit=80,offset=0) {
  const old=sessions.listSummaries(1000).filter(s=>!state.hasReceiptSession(s.id));
  const total=state.receiptCount()+old.length;
  const rows=state.receiptRows(offset+limit).map(row=>receiptView(row,sessions,state));
  const all=[...rows,...old].sort((a,b)=>b.startedAt-a.startedAt);
  return {sessions:all.slice(offset,offset+limit),total};
}
