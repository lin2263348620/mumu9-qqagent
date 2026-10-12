import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port=process.env.PORT||process.env.SERVER_PORT||process.env.HTTP_PORT||'8080';
const agentPort=process.env.QQ_AGENT_PORT||'3210';
const origin=`http://127.0.0.1:${port}`;
let ready=false;
for(let i=0;i<180;i++){
  try{
    const responses=await Promise.all([fetch(origin+'/_health',{signal:AbortSignal.timeout(1500)}),
      fetch(`http://127.0.0.1:${agentPort}/api/config`,{signal:AbortSignal.timeout(1500)})]);
    if(responses.every(r=>r.ok)){ready=true;break;}
  }catch{}
  await new Promise(r=>setTimeout(r,1000));
}
if(!ready){console.error('Automatic browser opening skipped: services are not ready. Check startup logs.');process.exitCode=1;}
else {
  console.log('Local admin URL: '+origin+'/qqbot/');
  console.log('Read the login password from data/admin-password.txt (keep it private).');
  const open=target=>{
    const args=process.platform==='win32'?['rundll32.exe',['url.dll,FileProtocolHandler',target]]:['xdg-open',[target]];
    const child=spawn(args[0],args[1],{stdio:'ignore',windowsHide:true});
    child.on('error',e=>console.error('Could not open automatically: '+e.message));
  };
  open(origin+'/qqbot/');
  const passwordFile=path.join(root,'data','admin-password.txt');
  if(!process.env.ADMIN_PASSWORD&&fs.existsSync(passwordFile)){
    if(process.platform==='win32'){
      const child=spawn('notepad.exe',[passwordFile],{stdio:'ignore',windowsHide:false});
      child.on('error',e=>console.error('Read data/admin-password.txt manually: '+e.message));
    }
  }
}
