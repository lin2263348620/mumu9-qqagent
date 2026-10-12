import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {prepareWindows,projectId,readJson,writeJson,powershell} from './windows-deployment.mjs';
import {stopOwnedChild} from './windows-process.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<13))throw new Error('Node.js >=22.13.0 is required.');
if(process.platform!=='win32')throw new Error('Use the separate Linux distribution on Linux.');
process.chdir(root);
const data=path.join(root,'data');fs.mkdirSync(data,{recursive:true});
const existing=readJson(path.join(data,'windows-deployment.json'),null);
const currentPort=existing?.ports.web;
let running=false;
if(currentPort){
  try{
    const health=await(await fetch(`http://127.0.0.1:${currentPort}/_health`,{signal:AbortSignal.timeout(1500)})).json();
    running=health.instanceId===projectId(root);
  }catch{}
}
if(running){
  console.log('This project is already running. Opening the admin console without starting duplicate services.');
  if(process.env.BOT_OPEN_BROWSER!=='0'){
    const helper=spawn(process.execPath,[path.join(root,'scripts','open-browser.mjs')],{stdio:'inherit',windowsHide:true,
      env:{...process.env,PORT:String(currentPort),QQ_AGENT_PORT:String(existing.ports.agent)}});
    const [code]=await once(helper,'exit');process.exitCode=code||0;
  }
}else{
  const lockFile=path.join(data,'windows-launch.lock');
  const lock=readJson(lockFile,null);
  if(lock){
    let alive=false;try{process.kill(lock.pid,0);alive=true;}catch{}
    if(alive)throw new Error('Another deployment is starting. Wait for its window to finish; no duplicate process was launched.');
    fs.unlinkSync(lockFile);
  }
  const nonce=crypto.randomUUID();
  const fd=fs.openSync(lockFile,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,nonce}));fs.closeSync(fd);
  const children=[];let stopping=false,stopPromise;
  const stop=()=>{
    if(stopPromise)return stopPromise;stopping=true;
    stopPromise=Promise.all(children.map(stopOwnedChild));
    return stopPromise;
  };
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stop().catch(console.error);});
  const childExit=child=>new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
  try{
    const agent=path.join(root,'qq-agent');
    if(!fs.existsSync(path.join(agent,'node_modules','ws','package.json'))){
      console.log('Installing production dependencies...');
      const npm=spawn(process.env.ComSpec||'cmd.exe',['/d','/c','npm ci --omit=dev --ignore-scripts --no-audit --no-fund'],{cwd:agent,stdio:'inherit',windowsHide:true});
      const [code]=await once(npm,'exit');if(code!==0)throw new Error('npm dependency installation failed. Check network access.');
    }
    const {Agent,setGlobalDispatcher}=await import('../qq-agent/node_modules/undici/index.js');
    setGlobalDispatcher(new Agent({connect:{timeout:30000}}));
    const deployment=await prepareWindows(root,{skipProtocol:process.env.BOT_SKIP_PROTOCOL==='1'});
    const env={...process.env,TZ:process.env.TZ||'Asia/Shanghai',QQ_AGENT_DATA_DIR:data,
      QQ_AGENT_HOST:'127.0.0.1',QQ_AGENT_PORT:String(deployment.ports.agent),HOST:process.env.HOST||'127.0.0.1',
      PORT:String(deployment.ports.web),BOT_INSTANCE_ID:deployment.projectId,
      BOT_FIXED_PORTS:'1',
      NAPCAT_DIR:deployment.skipProtocol?'':deployment.napcatDir,
      NAPCAT_WINDOWS_RUNTIME:deployment.skipProtocol?'':deployment.runtime,
      BOT_QQ_DATA_DIR:path.join(data,'qq-profile')};
    for(const entry of [path.join(agent,'src','server.js'),path.join(root,'gateway.js')]){
      const child=spawn(process.execPath,[entry],{env,stdio:'inherit',windowsHide:true});children.push(child);
      child.on('error',error=>{console.error(error.message);process.exitCode=1;stop();});
      child.on('exit',code=>{if(!stopping){process.exitCode=code||1;stop();}});
    }
    let ready=false;
    for(let i=0;i<120;i++){
      if(stopping)break;
      try{
        const health=await(await fetch(`http://127.0.0.1:${env.PORT}/_health`,{signal:AbortSignal.timeout(1000)})).json();
        const agentReady=(await fetch(`http://127.0.0.1:${env.QQ_AGENT_PORT}/api/config`,{signal:AbortSignal.timeout(1000)})).ok;
        let protocolReady=deployment.skipProtocol;
        if(!protocolReady){
          const login=await(await fetch(`http://127.0.0.1:${env.QQ_AGENT_PORT}/api/snowluma/login/status`,{signal:AbortSignal.timeout(3000)})).json();
          protocolReady=login.ok===true;
        }
        if(health.instanceId===deployment.projectId&&agentReady&&protocolReady){ready=true;break;}
      }catch{}
      await new Promise(r=>setTimeout(r,1000));
    }
    if(!ready)throw new Error('QQ/admin services did not become ready. Check the QQ logs above; deployment was not marked successful.');
    try{
      await powershell(path.join(root,'scripts','create-shortcut.ps1'),['-ProjectRoot',root,'-ShortcutName','bot管理后台.lnk']);
    }catch(error){console.error('Desktop shortcut could not be created: '+error.message+'; use 启动管理后台.cmd in the project folder.');}
    writeJson(path.join(data,'windows-ready.json'),{projectId:deployment.projectId,ports:deployment.ports,qqLoginReady:!deployment.skipProtocol,readyAt:new Date().toISOString()});
    console.log('部署完成。管理后台：http://127.0.0.1:'+env.PORT+'/qqbot/#qq-login');
    console.log('管理密码保存在 data/admin-password.txt。关闭此运行窗口会停止 bot 服务。');
    if(!deployment.skipProtocol)console.log('QQ 登录服务已就绪，请在后台扫码或完成验证；未登录不会显示账号在线。');
    if(process.env.BOT_OPEN_BROWSER!=='0'){
      const helper=spawn(process.execPath,[path.join(root,'scripts','open-browser.mjs')],{env,stdio:'inherit',windowsHide:true});
      helper.on('error',e=>console.error('Automatic browser opening failed: '+e.message));children.push(helper);
    }
    await Promise.all(children.map(child=>child.exitCode===null?childExit(child):Promise.resolve()));
  }finally{
    await stop();
    if(readJson(lockFile,null)?.nonce===nonce)fs.unlinkSync(lockFile);
  }
}
