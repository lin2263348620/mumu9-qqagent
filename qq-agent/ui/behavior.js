window.BehaviorPanel = (() => {
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fields=[['activeProbability','活跃型普通消息响应概率（%）',0,100],['contextSeconds','相关对话有效期（秒）',10,600],['batchMs','聚合窗口（毫秒）',500,10000],['maxWaitMs','最长等待（毫秒）',1000,30000]];
  const input=(id,label,value,type='number',extra='')=>`<label>${label}<input id="${id}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const toggle=(id,label,v)=>`<label class="behavior-toggle"><input id="${id}" type="checkbox" ${v?'checked':''}>${label}</label>`;
  function render(c, area){const b=c.behavior;const markup= `<div class="behavior-panel">
    <section data-area="response"><h3>响应模式</h3><div class="behavior-grid"><label>模式<select id="behavior-mode">${[['inherit','跟随人设参与度'],['low','安静型'],['medium','均衡型'],['high','活跃型']].map(([v,t])=>`<option value="${v}" ${b.mode===v?'selected':''}>${t}</option>`).join('')}</select></label>
    ${input('behavior-words','呼叫词（逗号分隔）',b.callWords.join(', '),'text')}${fields.map(([k,l,min,max])=>input(`behavior-${k}`,l,b[k],'number',`min="${min}" max="${max}"`)).join('')}</div>
    ${toggle('behavior-interaction','允许中文互动指令例外触发',b.interactionException)}${toggle('behavior-comfort','回应明确的难过情绪',b.comfort)}</section>
    <section data-area="response"><h3>普通群聊参与</h3>${['low','medium'].map(mode=>`${toggle(`behavior-${mode}-participate`,`${mode==='low'?'安静型':'均衡型'}参与普通群聊`,b.participation[mode].enabled)}${input(`behavior-${mode}-probability`,`${mode==='low'?'安静型':'均衡型'}每批参与概率（%）`,b.participation[mode].probability,'number','min="0" max="100"')}`).join('')}</section>
    <section data-area="response"><h3>主动破冰 · 北京时间</h3>${toggle('behavior-ice','活跃型主动破冰',b.icebreaker.enabled)}<div class="behavior-grid">
    ${input('behavior-sleep-start','睡觉开始',b.icebreaker.sleepStart,'time')}${input('behavior-sleep-end','睡觉结束',b.icebreaker.sleepEnd,'time')}
    ${input('behavior-ice-interval','检查间隔（分钟）',b.icebreaker.intervalMinutes,'number','min="5" max="1440"')}${input('behavior-ice-probability','破冰概率（%）',b.icebreaker.probability,'number','min="0" max="100"')}</div></section>
    <section data-area="relations"><h3>亲密度与回复长度</h3>${toggle('behavior-affinity','亲密度控制回复长度与表情概率',b.affinity.enabled)}<div class="behavior-table-wrap"><table id="affinity-length-table"><thead><tr><th>亲密度区间</th><th>单轮回复字数上限</th><th>表情概率（%）</th></tr></thead><tbody>
    ${b.affinity.tiers.map((t,i)=>`<tr><td>${i===5?'≥200':`${t.min}–${t.min+39}`}</td><td><input aria-label="${t.min}档文字上限" id="behavior-chars-${i}" type="number" min="5" max="500" value="${t.maxChars}"></td><td><input aria-label="${t.min}档表情概率" id="behavior-sticker-${i}" type="number" min="0" max="100" value="${t.probability}"></td></tr>`).join('')}</tbody></table></div></section>
    <section data-area="cache"><h3>互动缓存</h3>${toggle('behavior-refill','库存不足时补充缓存',b.cache.refill)}<div class="behavior-grid">${input('behavior-cache-target','每类目标库存',b.cache.target,'number','min="6" max="30"')}${input('behavior-cache-budget','每日补充调用上限',b.cache.dailyBudget,'number','min="0" max="200"')}</div><div id="behavior-metrics" class="behavior-status" role="status"></div></section>
    <section data-area="response"><h3>群聊相同文字跟发</h3>${toggle('behavior-solitaire','白名单群三位不同用户发送相同文字后跟发一次',b.solitaire.enabled)}<div class="behavior-grid">${input('behavior-solitaire-window','统计窗口（秒）',b.solitaire.windowSeconds,'number','min="10" max="600"')}${input('behavior-solitaire-max','跟发文字最大字数',b.solitaire.maxChars,'number','min="200" max="4000"')}</div></section>
    <section data-area="relations"><h3>关系管理</h3><div class="behavior-grid">${input('relation-qq','QQ号','','text','inputmode="numeric" maxlength="12"')}${input('relation-scope','群号（留空为全局）','','text','inputmode="numeric"')}${input('relation-name','称呼','','text','maxlength="80"')}${input('relation-affinity','全局好感度','','number','min="0" max="999999" step="1" placeholder="留空使用原有好感度"')}</div>
    <label>关系备注<textarea id="relation-note" rows="3" maxlength="1000"></textarea></label>${toggle('relation-enabled','启用关系',true)}<div class="behavior-actions"><button type="button" class="btn btn-primary" id="relation-save">保存关系</button><button type="button" class="btn" id="relation-reset">新增关系</button><button type="button" class="btn" id="behavior-refresh">刷新状态</button><span id="behavior-result" role="status"></span></div>
    <div class="behavior-table-wrap"><table><thead><tr><th>QQ号</th><th>关系范围</th><th>称呼</th><th>全局好感度</th><th>状态</th><th>操作</th></tr></thead><tbody id="relation-list"></tbody></table></div></section>
    <section data-area="tasks"><h3>发送记录</h3><div class="behavior-table-wrap"><table><thead><tr><th>时间</th><th>会话</th><th>状态</th><th>内容</th></tr></thead><tbody id="delivery-list"></tbody></table></div></section></div>`;
    if(!area)return markup;
    const template=document.createElement('template');template.innerHTML=markup;
    template.content.querySelectorAll('[data-area]').forEach(el=>{if(el.dataset.area!==area)el.remove();});
    return template.innerHTML;
  }
  function values(c){
    const out={},node=id=>document.getElementById(id);
    const set=(id,path,kind='number')=>{const el=node(id);if(!el)return;let target=out;const keys=path.split('.');for(const k of keys.slice(0,-1))target=target[k]||={};target[keys.at(-1)]=kind==='boolean'?el.checked:kind==='words'?el.value.split(/[,，]/).map(x=>x.trim()).filter(Boolean):kind==='string'?el.value:Number(el.value);};
    fields.forEach(([k])=>set('behavior-'+k,k));
    set('behavior-mode','mode','string');set('behavior-words','callWords','words');
    set('behavior-interaction','interactionException','boolean');set('behavior-comfort','comfort','boolean');
    ['low','medium'].forEach(m=>{set('behavior-'+m+'-participate','participation.'+m+'.enabled','boolean');set('behavior-'+m+'-probability','participation.'+m+'.probability');});
    [['ice','enabled','boolean'],['sleep-start','sleepStart','string'],['sleep-end','sleepEnd','string'],['ice-interval','intervalMinutes'],['ice-probability','probability']].forEach(([id,k,type])=>set('behavior-'+id,'icebreaker.'+k,type));
    set('behavior-affinity','affinity.enabled','boolean');
    if(node('behavior-chars-0'))out.affinity.tiers=c.behavior.affinity.tiers.map((t,i)=>({min:t.min,maxChars:Number(node('behavior-chars-'+i).value),probability:Number(node('behavior-sticker-'+i).value)}));
    set('behavior-refill','cache.refill','boolean');set('behavior-cache-target','cache.target');set('behavior-cache-budget','cache.dailyBudget');
    set('behavior-solitaire','solitaire.enabled','boolean');set('behavior-solitaire-window','solitaire.windowSeconds');set('behavior-solitaire-max','solitaire.maxChars');
    return out;
  }
  async function bind(api){
    if(!document.querySelector('.behavior-panel'))return;
    const node=id=>document.getElementById(id),result=node('behavior-result');
    const run=async fn=>{try{await fn();if(result?.isConnected)result.textContent='已保存';}catch(e){if(result?.isConnected)result.textContent=e.message;}};
    let relations=[];
    const refresh=async()=>{
      const [data,interaction,status]=await Promise.all([api('/api/behavior'),api('/api/interactions'),api('/api/status')]);
      relations=data.relations;const states={sending:'发送中',pending:'结果待确认',sent:'成功',failed:'明确失败'};
      if(node('relation-list'))node('relation-list').innerHTML=relations.map((r,i)=>`<tr><td>${esc(r.q)}</td><td>${esc(r.scope==='*'?'全局':r.scope.replace('group:','群 '))}</td><td>${esc(r.name)}</td><td>${r.affinity==null?'原有好感度':esc(r.affinity)}</td><td>${r.enabled?'启用':'关闭'}</td><td><div class="behavior-actions"><button class="btn" data-edit="${i}">编辑</button><button class="btn" data-delete="${i}">删除</button></div></td></tr>`).join('')||'<tr><td colspan="6">暂无关系</td></tr>';
      if(node('delivery-list'))node('delivery-list').innerHTML=data.deliveries.slice(0,30).map(r=>`<tr><td>${esc(new Date(r.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}))}</td><td>${esc(r.chat)}</td><td>${states[r.state]||esc(r.state)}</td><td>${esc(r.text)}</td></tr>`).join('')||'<tr><td colspan="4">暂无发送记录</td></tr>';
      const m=interaction.metrics||{},usage=status.today||status.usage||status.todayUsage||{};
      if(node('behavior-metrics'))node('behavior-metrics').textContent=`今日缓存命中 ${m.hits||0} · 空库存/过期 ${m.missEmptyOrExpired||0} · 重复排除 ${m.missRecent||0} · 补充调用 ${m.refillCalls||0} · 识图缓存命中 ${data.metrics.imageHits||0} · 模型调用前跳过 ${data.metrics.skippedBeforeModel||0} · 服务商缓存输入 ${usage.cacheUsageReported?`${usage.cachedInputTokens||0} token`:'未返回统计'}`;
      node('relation-list')?.querySelectorAll('[data-edit]').forEach(button=>button.onclick=()=>{
        const r=relations[Number(button.dataset.edit)];for(const [id,k] of [['relation-qq','q'],['relation-name','name'],['relation-affinity','affinity'],['relation-note','note']])node(id).value=r[k]??'';node('relation-scope').value=r.scope==='*'?'':r.scope.replace('group:','');node('relation-enabled').checked=!!r.enabled;node('relation-qq').readOnly=true;node('relation-scope').readOnly=true;node('relation-qq').focus();
      });
      node('relation-list')?.querySelectorAll('[data-delete]').forEach(button=>button.onclick=()=>run(async()=>{const r=relations[Number(button.dataset.delete)];if(!confirm(`删除QQ ${r.q}的这条关系？`))return;await api('/api/relations',{method:'DELETE',body:JSON.stringify({q:r.q,scope:r.scope})});await refresh();}));
    };
    if(node('relation-reset'))node('relation-reset').onclick=()=>{for(const id of ['relation-qq','relation-scope','relation-name','relation-affinity','relation-note']){node(id).value='';node(id).readOnly=false;}node('relation-enabled').checked=true;result.textContent='';};
    if(node('relation-save'))node('relation-save').onclick=()=>run(async()=>{const group=node('relation-scope').value.trim(),rawAffinity=node('relation-affinity').value.trim();await api('/api/relations',{method:'POST',body:JSON.stringify({q:node('relation-qq').value.trim(),scope:group?`group:${group}`:'*',name:node('relation-name').value,affinity:rawAffinity===''?null:Number(rawAffinity),note:node('relation-note').value,enabled:node('relation-enabled').checked})});await refresh();});
    if(node('behavior-refresh'))node('behavior-refresh').onclick=()=>run(refresh);
    try{await refresh();}catch(e){if(result?.isConnected)result.textContent=e.message;}
  }
  return {render,values,bind};
})();
