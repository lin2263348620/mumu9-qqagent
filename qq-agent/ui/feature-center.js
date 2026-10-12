window.FeatureCenter = (() => {
  const categories=[['response','消息与响应'],['interaction','互动与娱乐'],['relations','关系与好感度'],['images','图片与表情'],['cache','记忆与缓存'],['tools','查询与工具'],['tasks','管理与任务']];
  const toolsByArea={response:['send_message'],images:['send_image','get_message_images','send_sticker','list_stickers','get_sticker_image','sticker_note','collect_sticker'],cache:['memory_append','memory_query','memory_remove'],tools:['send_poke','send_file','receive_file','get_recent_messages','get_message_detail','get_active_members','web_search','web_fetch'],tasks:['schedule_task','dsh_task','report_feedback']};
  const field=(id,label,value,type='number',extra='')=>`<label class="center-field">${label}<input id="${id}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const toggle=(id,label,value)=>`<label class="center-toggle"><span>${label}</span><input id="${id}" type="checkbox" ${value?'checked':''}></label>`;
  function toolRows(cap,c,area){
    return (cap?.tools||[]).filter(t=>(toolsByArea[area]||[]).includes(t.name)).map(t=>{
      const ready=!t.masterOnly||!!c.persona.masterQQ;
      return `<div class="center-tool-row"><div class="center-tool-copy"><strong>${esc(t.label)}</strong><span class="center-instruction">${esc(t.example)}</span><span class="center-prerequisite">${ready?'': '未配置主人 QQ'}${!c.api.model?' · 未选择模型':''}</span></div><label class="center-toggle center-tool-switch"><span data-tool-status="${esc(t.name)}">${t.enabled?'已启用':'已关闭'}</span><input type="checkbox" data-center-tool="${esc(t.name)}" aria-label="${esc(t.label)}" ${t.enabled?'checked':''}></label></div>`;
    }).join('');
  }
  function render(c,cap,area='response'){
    let body='';
    if(area==='response')body=`
      <section class="center-band"><h3>群聊接入</h3>
      ${toggle('cfg-feature-group-enabled','允许响应群消息',c.groupResponse.enabled)}
      ${toggle('cfg-feature-group-keyword-only','仅响应关键词或 @bot',c.groupResponse.keywordOnly)}
      ${field('cfg-feature-group-keywords','额外触发关键词（逗号分隔）',c.groupResponse.keywords.join(', '),'text')}
      </section>${window.BehaviorPanel.render(c,'response')}
      <section class="center-band">${renderAllowSection(c)}</section>`;
    if(area==='interaction')body=renderBotSettings(c,'interaction');
    if(area==='relations')body=window.BehaviorPanel.render(c,'relations')+renderBotSettings(c,'relations');
    if(area==='images')body=`<section class="center-band"><h3>回复表情</h3><div class="center-grid">
      ${field('cfg-sticker-probability','默认表情概率（%）',c.sticker.replyProbability,'number','min="0" max="100"')}
      ${field('cfg-sticker-cooldown','同一聊天冷却（秒）',c.sticker.cooldownSeconds,'number','min="0" max="3600"')}
      ${field('cfg-sticker-prompt-limit','提示词最多携带素材',c.sticker.promptMaxStickers,'number','min="1" max="50"')}
      ${field('cfg-sticker-collect-limit','每小时收藏上限',c.sticker.maxCollectPerHour,'number','min="0" max="100"')}
      </div>${toggle('cfg-collect-enabled','允许自动收藏素材',c.sticker.collectEnabled)}
      ${toggle('cfg-vision','模型支持图片输入',c.api.vision)}
      <div class="center-note">亲密度规则启用时，以关系与好感度中的档位概率为准。</div>
      </section>${renderBotSettings(c,'images')}`;
    if(area==='cache')body=window.BehaviorPanel.render(c,'cache')+renderBotSettings(c,'cache')+`<section class="center-band"><h3>记忆整理</h3>
      ${toggle('cfg-memory-consolidate','自动合并与整理长期记忆',c.memory.consolidateEnabled)}
      ${field('cfg-memory-interval','整理冷却（小时）',c.memory.consolidateMinIntervalMs/3600000,'number','min="1" max="168"')}</section>`;
    if(area==='tools')body=`<section class="center-band"><h3>联网搜索</h3>    <div class="field"><label>搜索引擎</label>
      <select id="cfg-searchprovider">
        <option value="auto" ${(c.webSearch?.provider || 'auto') === 'auto' ? 'selected' : ''}>自动（优先 AnySearch，失败回退 Bing）— 推荐</option>
        <option value="anysearch" ${c.webSearch?.provider === 'anysearch' ? 'selected' : ''}>AnySearch（需配置 API key，结果更全）</option>
        <option value="bing" ${c.webSearch?.provider === 'bing' ? 'selected' : ''}>Bing 网页抓取（免 key）</option>
      </select>
      <div class="hint" style="margin-top:4px">未配置 key 时，自动模式会回退到 Bing 网页抓取。</div></div>
    <div class="field"><label>AnySearch API Key</label>
      <div id="search-key-rows"></div>
      <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
        <button class="btn btn-small" type="button" id="add-search-key-btn">+ 添加一个 Key</button>
        <button class="btn btn-small btn-primary" type="button" id="save-search-keys-btn">保存 Key</button>
        <span id="search-key-result" class="muted"></span>
      </div>
      <div class="hint" style="margin-top:4px">支持多个 Key 轮换（某个额度用尽时自动换下一个）。已保存的 Key 只显示首尾，重新填写才会覆盖；环境变量注入的 Key 优先且不在此显示。</div></div>
    <div class="field"><label>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>



</section>`;
    if(area==='tasks')body=`<section class="center-band"><h3>主人与权限</h3>
      ${field('cfg-feature-masterqq','主人 QQ 号',c.persona.masterQQ,'text','inputmode="numeric" maxlength="12"')}
      </section><section class="center-band"><h3>冷场主动开话题</h3>
      ${toggle('cfg-proactive','启用冷场话题调度',c.proactive.enabled)}<div class="center-grid">
      ${field('cfg-pro-min','最小检查间隔（毫秒）',c.proactive.checkIntervalMinMs)}
      ${field('cfg-pro-max','最大检查间隔（毫秒）',c.proactive.checkIntervalMaxMs)}
      ${field('cfg-pro-prob','触发概率（0–1）',c.proactive.probability,'number','min="0" max="1" step="0.05"')}
      ${field('cfg-pro-idle','冷场判定（毫秒）',c.proactive.idleThresholdMs)}
      </div></section>${window.BehaviorPanel.render(c,'tasks')}`;
    return `<div class="feature-center"><div class="center-tabs" role="tablist" aria-label="功能分类">${categories.map(([key,label])=>`<button type="button" role="tab" aria-selected="${key===area}" class="center-tab ${key===area?'active':''}" data-center-area="${key}">${label}</button>`).join('')}</div>
      <div class="center-category-head"><h2>${categories.find(([key])=>key===area)?.[1]||''}</h2><span class="center-summary">${cap?.enabledTotal??0} / ${cap?.total??0} 项工具启用</span></div>
      <div id="center-result" role="status" aria-live="polite"></div>
      ${toolRows(cap,c,area)}${body}</div>`;
  }
  function login(c){
    const recovery=state.status?.autoRecovery||{};
    return `${renderBotSettings(c,'login')}<section class="center-band">    <h3>QQ 掉线自动恢复</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-feature-recovery-enabled" ${c.autoRecovery?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-feature-recovery-enabled">检测到 QQ 掉线后自动使用 NapCat 快速登录恢复</label></div>
    <div class="field"><label>恢复目标 QQ（留空时自动识别）</label>
      <input type="text" id="cfg-feature-recovery-qq" inputmode="numeric" maxlength="12" placeholder="通常留空即可" value="${esc(c.autoRecovery?.targetQQ || '')}" /></div>
    <div class="field-row">
      <div class="field"><label>连续离线确认次数</label><input type="number" id="cfg-feature-recovery-confirmations" min="2" max="10" value="${Number(c.autoRecovery?.offlineConfirmations) || 3}" /></div>
      <div class="field"><label>重试冷却（分钟）</label><input type="number" id="cfg-feature-recovery-cooldown" min="1" max="120" value="${Number(c.autoRecovery?.cooldownMinutes) || 10}" /></div>
      <div class="field"><label>每小时最多尝试</label><input type="number" id="cfg-feature-recovery-max" min="1" max="12" value="${Number(c.autoRecovery?.maxAttemptsPerHour) || 3}" /></div>
    </div>
    <div class="snowluma-actions">
      <button type="button" class="btn btn-small" id="run-auto-recovery-btn">立即尝试恢复</button>
      <span class="hint" id="auto-recovery-result">${recovery.needsManual
        ? `需要人工处理：${esc(recovery.lastError || '快速登录无法恢复')}`
        : recovery.running
          ? '正在执行恢复…'
          : recovery.nextAttemptAt
            ? `等待下次尝试：${esc(fmtTime(recovery.nextAttemptAt))}`
            : `状态：${esc(recovery.lastResult || '等待检测')} · 本小时 ${Number(recovery.attemptsLastHour) || 0} 次`}</span>
    </div>
    <div class="hint">优先使用 NapCat 快速登录缓存；可在上方“QQ 登录凭据与验证”允许加密凭据回退。需要验证码或设备验证时暂停自动重试，请打开 QQ 登录页人工处理。</div>

</section>`;
  }
  function sync(){
    document.querySelectorAll('[data-center-tool]').forEach(el=>{
      const tool=state.capabilities?.tools?.find(t=>t.name===el.dataset.centerTool);
      if(tool){el.checked=tool.enabled;const label=document.querySelector('[data-tool-status="'+tool.name+'"]');if(label)label.textContent=tool.enabled?'已启用':'已关闭';}
    });
    const summary=document.querySelector('.center-summary');
    if(summary)summary.textContent=(state.capabilities?.enabledTotal??0)+' / '+(state.capabilities?.total??0)+' 项工具启用';
  }
  async function bind(){
    document.querySelectorAll('[data-center-area]').forEach(button=>button.onclick=async()=>{
      if(settingsDirty()&&!confirm('当前有未保存的设置，放弃本页修改？'))return;
      state.featureCategory=button.dataset.centerArea;renderSettings();
    });
    document.querySelectorAll('[data-center-tool]').forEach(input=>input.onchange=async()=>{
      const desired=input.checked;input.disabled=true;
      try{
        const data=await api('/api/capabilities',{method:'POST',body:JSON.stringify({tool:input.dataset.centerTool,enabled:desired})});
        state.config=data.config;
        state.capabilities=await api('/api/capabilities');
        sync();
        const out=document.querySelector('#center-result');if(out)out.textContent='开关已保存';
      }catch(error){input.checked=!desired;const out=document.querySelector('#center-result');if(out)out.textContent=error.message;}
      finally{input.disabled=false;}
    });
  }
  return {render,login,bind,sync};
})();

