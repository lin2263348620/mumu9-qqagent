import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG} from '../src/config.js';
import {normalizeInteraction} from '../src/interaction-settings.js';
import {PERSONAS} from '../src/personas.js';
import {checkReplies} from '../src/interaction-service.js';
import {InteractionService} from '../src/interaction-service.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('defaults contain no accounts, credentials, providers, persona or profile',()=>{
  assert.equal(DEFAULT_CONFIG.persona.botName,'bot');
  for(const value of [DEFAULT_CONFIG.api.baseUrl,DEFAULT_CONFIG.api.apiKey,DEFAULT_CONFIG.api.model,DEFAULT_CONFIG.persona.masterQQ,DEFAULT_CONFIG.persona.roleText,DEFAULT_CONFIG.interaction.persona,DEFAULT_CONFIG.autoRecovery.targetQQ])assert.equal(value,'');
  assert.deepEqual(DEFAULT_CONFIG.providers,[]);assert.deepEqual(DEFAULT_CONFIG.customPersonas,[]);
  assert.deepEqual(DEFAULT_CONFIG.personaProfiles,{});assert.deepEqual(DEFAULT_CONFIG.allow,{groups:[],private:[]});
  assert.equal(DEFAULT_CONFIG.allowAllWhenEmpty,false);
});
test('empty persona can be saved without reintroducing a template',()=>{
  assert.equal(normalizeInteraction({persona:''}).persona,'');
  assert.deepEqual(PERSONAS,{blank:{name:'bot（空白模板）',text:''}});
});
test('interaction replies have no forced persona catchphrase',()=>{
  assert.ok(checkReplies(['谢谢你的投喂！'],[1,1],[],50));
  assert.ok(checkReplies(['一起出发吧。'],[1,1],[],50));
  assert.equal(checkReplies(['不要使用禁词'],[1,1],['禁词'],50),false);
});
test('feeding and walking use a custom persona, settle affinity and deduplicate',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bot-interaction-test-'));
  const cfg=structuredClone(DEFAULT_CONFIG);cfg.persona.roleText='使用简洁普通中文，按实际互动回应。';
  cfg.interaction.cache.enabled=false;cfg.behavior.cache.refill=false;
  const sent=[];let calls=0;
  const service=new InteractionService({dir,getConfig:()=>cfg,generate:async request=>{
    calls++;const scenario=JSON.parse(request.messages[1].content);
    assert.ok(request.messages[0].content.includes(cfg.persona.roleText));
    return {message:{content:JSON.stringify({replies:[{messages:[scenario.interaction==='feed'?'谢谢你的投喂！':'一起出发吧。']}]})}};
  },sender:{sendTextBatch:async(chat,messages)=>{sent.push(...messages);return {sent:messages.map(text=>({text})),pending:[]};}},wait:async()=>{}});
  const event=(text,id)=>({user_id:22222,message_id:id,sender:{nickname:'测试成员'},message:[{type:'text',data:{text}},{type:'at',data:{qq:'99999'}}]});
  try{
    await service.handle('group','11111',event('投喂',1),'99999');
    await service.handle('group','11111',event('投喂',1),'99999');
    await service.handle('group','11111',event('散步',2),'99999');
    assert.equal(calls,2);assert.deepEqual(sent,['谢谢你的投喂！','一起出发吧。']);assert.equal(service.db.user('11111','22222').points,5);
    cfg.interaction.feed.enabled=false;await service.handle('group','11111',event('投喂',3),'99999');assert.equal(calls,2);
  }finally{await service.close();}
});
