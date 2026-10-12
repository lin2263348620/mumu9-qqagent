import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

const root=path.dirname(fileURLToPath(import.meta.url));
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<13))throw new Error('Node.js >=22.13.0 is required.');
process.chdir(root);
if(process.platform!=='win32'){
  const child=spawn('sh',[path.join(root,'一键部署启动.sh')],{stdio:'inherit'});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
  const [code]=await once(child,'exit');process.exitCode=code??1;
}else{
  const agent=path.join(root,'qq-agent');
  const data=path.join(root,'data');
  fs.mkdirSync(data,{recursive:true});
  if(!fs.existsSync(path.join(agent,'node_modules','ws','package.json'))){
    console.log('Installing production dependencies...');
    const npm=spawn(process.env.ComSpec||'cmd.exe',['/d','/c','npm ci --omit=dev --ignore-scripts --no-audit --no-fund'],{cwd:agent,stdio:'inherit',windowsHide:true});
    const [code]=await once(npm,'exit');
    if(code!==0)throw new Error('Dependency installation failed. Check npm output and network access.');
  }
  const env={...process.env,TZ:process.env.TZ||'Asia/Shanghai',QQ_AGENT_DATA_DIR:data,
    QQ_AGENT_HOST:'127.0.0.1',QQ_AGENT_PORT:process.env.QQ_AGENT_PORT||'3210',
    HOST:process.env.HOST||'127.0.0.1',PORT:process.env.PORT||process.env.SERVER_PORT||'8080'};
  const children=[];
  let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;for(const child of children)if(child.exitCode===null)child.kill();};
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
  try{
    for(const entry of [path.join(agent,'src','server.js'),path.join(root,'gateway.js')]){
      const child=spawn(process.execPath,[entry],{env,stdio:'inherit',windowsHide:true});
      children.push(child);
      child.on('error',error=>{console.error(error.message);process.exitCode=1;stop();});
      child.on('exit',code=>{if(!stopping){process.exitCode=code||1;stop();}});
    }
    console.log('Open http://'+env.HOST+':'+env.PORT+'/qqbot/');
    console.log('Admin password: set ADMIN_PASSWORD or read data/admin-password.txt after startup.');
    console.log('Connect a separate Windows NapCat / OneBot v11 service in the admin settings.');
    if(process.env.BOT_OPEN_BROWSER==='1'){
      const helper=spawn(process.execPath,[path.join(root,'scripts','open-browser.mjs')],{env,stdio:'inherit',windowsHide:true});
      children.push(helper);
      helper.on('error',error=>console.error('Browser helper: '+error.message));
    }
    await Promise.all(children.map(child=>once(child,'exit')));
  }finally{stop();}
}
