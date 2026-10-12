function renderBotSettings(c, area='interaction') {
  const d=c.interaction||{};
  const toggle=(key,label,value)=>`<label class="bot-toggle"><span>${label}</span><input type="checkbox" data-bot="${key}" ${value?'checked':''}></label>`;
  const number=(key,label,value,min,max)=>`<label class="bot-field">${label}<input type="number" data-bot="${key}" value="${Number(value)}" min="${min}" max="${max}" step="1"></label>`;
  const actions=[['feed','投喂',3,2],['pet','摸摸头',1,1],['walk','散步',1,3]];
  const markup=`<section class="bot-section" id="bot-settings">
    <div class="bot-heading"><div><span class="bot-eyebrow">BOT / 互动与娱乐</span><h3>bot互动</h3></div><span class="bot-status" id="bot-db-status">正在读取本地数据</span></div>
    <div class="bot-metrics" id="bot-metrics"></div>
    ${toggle('enabled','启用互动系统',d.enabled!==false)}
    ${toggle('requireAt','群内指令必须 @机器人',d.requireAt!==false)}
    <div class="bot-command-list">${actions.map(([key,label,limit,points])=>`<div class="bot-command">
      ${toggle(key+'.enabled',label,d[key]?.enabled!==false)}
      <div class="bot-example">指令：${label} @bot　或　@bot ${label}</div>
      <div class="bot-fields">${number(key+'.limit','每日次数',d[key]?.limit??limit,1,100)}${number(key+'.points','每次好感度',d[key]?.points??points,0,1000)}</div>
      </div>`).join('')}</div>
    <details class="bot-details" open><summary>好感度与今日运势</summary>
      ${toggle('affinity','好感度查询',d.affinity!==false)}<p class="bot-example">好感度 @bot：查看本群好感度及今日互动次数。</p>
      ${toggle('ranking','群好感度排行',d.ranking!==false)}<p class="bot-example">好感度排行 @bot：查看当前群排行。</p>
      ${number('rankLimit','排行人数',d.rankLimit??10,1,50)}
      ${toggle('fortune','今日运势',d.fortune!==false)}<p class="bot-example">今日运势 @bot：返回1–100运势，同一群同一天结果不变。</p>
      ${toggle('checkin','每日签到',d.checkin!==false)}<p class="bot-example">签到 @bot：每天一次，本地记录累计和连续签到天数。</p>
      ${toggle('checkinRanking','群签到排行榜',d.checkinRanking!==false)}<p class="bot-example">签到排行榜 @bot：查询当前群累计签到排行。</p>
      ${number('checkinRankLimit','签到排行人数',d.checkinRankLimit??10,1,50)}
      ${toggle('commandList','主人指令列表',d.commandList!==false)}<p class="bot-example">指令列表 @bot：仅后台指定的主人 QQ 可以查看。普通互动仍对允许聊天的群成员开放。</p>
    </details>
    <details class="bot-details"><summary>QQ 原生接龙兼容</summary>
      <p class="bot-example">当前 NapCat/OneBot 没有公开的原生“接龙 +1”动作。开启后会识别并在服务器本地保存真实接龙卡片结构，用于确认后续能否兼容；不会用普通文字冒充加入成功。</p>
      <label class="bot-toggle"><span>记录 QQ 原生接龙结构</span><input type="checkbox" id="bot-solitaire-capture" ${c.nativeSolitaire?.capture!==false?'checked':''}></label>
      <p class="bot-result" id="bot-solitaire-status">正在读取兼容状态…</p>
    </details>
    <details class="bot-details" open><summary>设置指定 QQ 的好感度</summary>
      <div class="bot-fields"><label class="bot-field">群号<input id="bot-manage-group" inputmode="numeric" placeholder="输入群号" list="bot-groups"></label>
      <datalist id="bot-groups"></datalist><label class="bot-field">QQ 号<input id="bot-manage-qq" inputmode="numeric" placeholder="输入目标 QQ 号"></label>
      <label class="bot-field">目标好感度<input id="bot-manage-points" type="number" min="0" max="999999" value="999"></label></div>
      <div class="bot-actions"><button class="btn" type="button" data-bot-action="query">查询</button><button class="btn btn-primary" type="button" data-bot-action="set">设置好感度</button><button class="btn" type="button" data-bot-action="reset-daily">重置今日次数</button><button class="btn" type="button" data-bot-action="zero">好感度归零</button><button class="btn btn-danger" type="button" data-bot-action="clear-group">清空本群排行</button></div>
      <p id="bot-manage-result" class="bot-result" role="status"></p>
    </details>
    <details class="bot-details"><summary>人设与回复校验</summary>
      <label class="bot-field">bot完整人设<textarea data-bot="persona" rows="14">${esc(d.persona||'')}</textarea></label>
      <label class="bot-field">附加规则<textarea data-bot="extraRules" rows="3">${esc(d.extraRules||'')}</textarea></label>
      <label class="bot-field">禁用字符串（每行一条）<textarea data-bot="forbidden" data-array="true" rows="3">${esc((d.forbidden||[]).join('\n'))}</textarea></label>
      <label class="bot-field">其他机器人 QQ（每行一个）<textarea data-bot="blockedBots" data-array="true" rows="2">${esc((d.blockedBots||[]).join('\n'))}</textarea></label>
      <div class="bot-fields">${number('regeneration','格式失败重新生成次数',d.regeneration??1,0,2)}</div>
      <p class="bot-example">仅影响bot说话方式，不改变权限、每日次数或运势。修改人设后，旧版本缓存立即停止使用。</p>
    </details>
    <details class="bot-details"><summary>本地缓存与回复测试</summary>
      ${toggle('cache.enabled','使用数据库回复缓存',d.cache?.enabled!==false)}
      ${toggle('cache.files','同步保存目录缓存',d.cache?.files!==false)}
      <div class="bot-fields">${number('cache.batch','一次生成组数',d.cache?.batch??3,1,10)}${number('cache.days','有效天数',d.cache?.days??7,1,90)}${number('cache.maxEntries','容量上限（组）',d.cache?.maxEntries??300,10,10000)}${number('cache.recent','避开最近几组',d.cache?.recent??5,0,30)}</div>
      <div class="bot-fields"><label class="bot-field">测试场景<select id="bot-test-kind"><option value="feed">投喂</option><option value="pet">摸摸头</option><option value="walk">散步</option><option value="checkin">签到</option></select></label><label class="bot-field">测试好感度<input id="bot-test-points" type="number" value="999" min="0" max="999999"></label></div>
      <label class="bot-toggle"><span>测试已达每日上限</span><input type="checkbox" id="bot-test-limited"></label>
      <div class="bot-actions"><button type="button" class="btn btn-primary" data-cache-action="preview">保存并测试回复</button><button type="button" class="btn" data-cache-action="generate">补充此场景缓存</button><button type="button" class="btn" data-cache-action="prune">清理过期缓存</button><button type="button" class="btn btn-danger" data-cache-action="clear">清空回复缓存</button></div>
      <pre id="bot-preview" class="bot-result" role="status"></pre>
    </details>
    <details class="bot-details"><summary>QQ 登录凭据与验证</summary>
      <p class="bot-example" id="bot-vault-status">读取凭据状态…</p>
      <div class="bot-fields"><label class="bot-field">QQ 号<input id="bot-vault-qq" inputmode="numeric" autocomplete="off"></label><label class="bot-field">QQ 密码<input id="bot-vault-password" type="password" autocomplete="new-password"></label></div>
      <label class="bot-toggle"><span>允许服务器加密保存登录凭据，用于掉线恢复</span><input id="bot-vault-consent" type="checkbox"></label>
      <label class="bot-toggle"><span>快速登录缓存不可用时，尝试保存的凭据</span><input id="bot-password-fallback" type="checkbox" ${c.autoRecovery?.passwordFallback?'checked':''}></label>
      <div class="bot-actions"><button type="button" class="btn" id="bot-vault-save">保存登录凭据</button><button type="button" class="btn btn-danger" id="bot-vault-clear">清除登录凭据</button><button type="button" class="btn" id="bot-open-login">打开 QQ 登录与人工验证</button></div>
      <p class="bot-example">遇到滑块、新设备或风险验证时停止自动重试。请在 QQ 登录页手动完成；保存凭据不代表能够跳过验证。凭据与独立密钥均需保护，远程管理请使用 HTTPS。</p>
      <p id="bot-vault-result" class="bot-result" role="status"></p>
    </details>
    <details class="bot-details"><summary>近期管理记录</summary><div id="bot-audit" class="bot-result"></div></details>
    <details class="bot-details"><summary>全部能力中文使用说明</summary><div id="bot-tool-help"></div></details>
  </section>`;
  const template=document.createElement('template');template.innerHTML=markup;
  const root=template.content.firstElementChild;
  const areas={
    interaction:['好感度与今日运势'],relations:['设置指定 QQ 的好感度','近期管理记录'],
    cache:['本地缓存与回复测试'],images:['QQ 原生接龙兼容'],
    persona:['人设与回复校验'],login:['QQ 登录凭据与验证']
  };
  root.querySelectorAll(':scope > details').forEach(el=>{
    if(!(areas[area]||[]).includes(el.querySelector('summary').textContent))el.remove();else el.open=true;
  });
  root.querySelectorAll(':scope > .bot-toggle,:scope > .bot-command-list').forEach(el=>{if(area!=='interaction')el.remove();});
  if(area!=='cache'){root.querySelector('.bot-metrics')?.remove();}
  root.querySelector('.bot-heading')?.remove();
  return template.innerHTML;
}

function collectBotSettings() {
  const result={};
  document.querySelectorAll('[data-bot]').forEach(el=>{
    const keys=el.dataset.bot.split('.');let target=result;
    for(const key of keys.slice(0,-1)) target=target[key] ||= {};
    target[keys.at(-1)]=el.type==='checkbox'?el.checked:el.type==='number'?Number(el.value):el.dataset.array?el.value.split('\n').map(x=>x.trim()).filter(Boolean):el.value;
  });
  return result;
}
async function refreshBotPanel() {
  if(!document.querySelector('#bot-settings')) return;
  const data=await api('/api/interactions');
  const put=(id,text)=>{const node=document.getElementById(id);if(node)node.textContent=text;};
  put('bot-db-status','SQLite · 本地持久化');
  const metrics=document.getElementById('bot-metrics');
  if(metrics) metrics.innerHTML=[['有效缓存',data.entries],['今日缓存命中',data.metrics.hits||0],['今日 API 请求',data.metrics.apiCalls||0],['排队任务',data.pending]].map(([label,value])=>`<div><strong>${Number(value)}</strong><span>${label}</span></div>`).join('');
  put('bot-vault-status',data.login.unreadable?'凭据无法解密，请重新保存':data.login.saved?`已保存 QQ ${data.login.qq} · ${data.login.keySource}`:'尚未保存服务器登录凭据');
  put('bot-vault-result',data.recovery.needsManual?`需要人工处理：${data.recovery.lastError}`:'');
  put('bot-solitaire-status',data.nativeSolitaire?.captures?`已记录 ${data.nativeSolitaire.captures} 条疑似接龙结构；最近群 ${data.nativeSolitaire.latest?.groupId||'-'}。原生 +1 尚未确认支持。`:'尚未捕获真实 QQ 原生接龙结构；原生 +1 暂不可用。');
  put('bot-audit',data.audit.map(x=>`${new Date(x.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · 群 ${x.g} · QQ ${x.q||'-'} · ${{set:'设置好感度','reset-daily':'重置今日次数','clear-ranking':'清空排行'}[x.action]||x.action} · ${x.before_value??'-'} → ${x.after_value??'-'}`).join('\n')||'暂无管理记录');
  const groups=document.getElementById('bot-groups');if(groups)groups.innerHTML=data.groups.map(g=>`<option value="${esc(g)}">`).join('');
  const help=document.getElementById('bot-tool-help');if(help)help.innerHTML=Object.values(data.toolHelp).map(([name,example])=>`<div class="bot-help"><strong>${esc(name)}</strong><span>${esc(example)}</span></div>`).join('');
  if(data.lastError)put('bot-db-status','最近回复失败，展开缓存区可测试');
}
function bindBotSettings() {
  if(!document.querySelector('#bot-settings'))return;
  refreshBotPanel().catch(e=>{const out=document.querySelector('#bot-db-status');if(out)out.textContent='读取失败：'+e.message;});
  const run=async(button,out,fn)=>{button.disabled=true;out.textContent='处理中…';try {await fn();}catch(e){out.textContent='失败：'+e.message;}finally{button.disabled=false;}};
  document.querySelectorAll('[data-bot-action]').forEach(button=>button.onclick=()=>run(button,document.querySelector('#bot-manage-result'),async()=>{
    const group=document.querySelector('#bot-manage-group').value.trim(),qq=document.querySelector('#bot-manage-qq').value.trim(),action=button.dataset.botAction;
    let result;
    if(action==='query')result=await api(`/api/interactions/user?group=${encodeURIComponent(group)}&qq=${encodeURIComponent(qq)}`);
    else {
      if(['zero','clear-group','reset-daily'].includes(action)&&!confirm('确认执行此操作？群号：'+group+'，QQ：'+qq))return;
      const confirmation=action==='clear-group'?prompt('请输入群号确认清空本群好感度排行'):'';
      result=await api('/api/interactions/manage',{method:'POST',body:JSON.stringify({group,qq,action:action==='zero'?'set':action,points:action==='zero'?0:Number(document.querySelector('#bot-manage-points').value),confirm:confirmation})});
    }
    document.querySelector('#bot-manage-result').textContent=`群 ${group} · QQ ${qq} · 好感度 ${result.user.points}`;
    await refreshBotPanel();
  }));
  document.querySelectorAll('[data-cache-action]').forEach(button=>button.onclick=()=>run(button,document.querySelector('#bot-preview'),async()=>{
    const action=button.dataset.cacheAction;
    if(action==='clear'&&!confirm('清空全部回复缓存？好感度和运势数据会保留。'))return;
    if(['generate','preview'].includes(action))await saveConfig({quiet:true});
    const data=await api('/api/interactions/cache',{method:'POST',body:JSON.stringify({action,kind:document.querySelector('#bot-test-kind').value,points:Number(document.querySelector('#bot-test-points').value),limited:document.querySelector('#bot-test-limited').checked})});
    document.querySelector('#bot-preview').textContent=data.messages?data.messages.map((x,i)=>`${i+1}. ${x}`).join('\n\n'):'缓存已更新';await refreshBotPanel();
  }));
  if(document.querySelector('#bot-vault-save'))document.querySelector('#bot-vault-save').onclick=function(){run(this,document.querySelector('#bot-vault-result'),async()=>{
    if(!document.querySelector('#bot-vault-consent').checked)throw new Error('请先勾选允许保存登录凭据');
    await api('/api/login-vault',{method:'POST',body:JSON.stringify({qq:document.querySelector('#bot-vault-qq').value.trim(),password:document.querySelector('#bot-vault-password').value})});
    document.querySelector('#bot-vault-password').value='';await refreshBotPanel();document.querySelector('#bot-vault-result').textContent='登录凭据已加密保存';
  });};
  if(document.querySelector('#bot-vault-clear'))document.querySelector('#bot-vault-clear').onclick=function(){run(this,document.querySelector('#bot-vault-result'),async()=>{
    if(!confirm('清除服务器保存的 QQ 登录凭据？'))return;
    await api('/api/login-vault',{method:'POST',body:JSON.stringify({action:'clear'})});await refreshBotPanel();
  });};
  if(document.querySelector('#bot-open-login'))document.querySelector('#bot-open-login').onclick=()=>switchTab('snowluma');
}
