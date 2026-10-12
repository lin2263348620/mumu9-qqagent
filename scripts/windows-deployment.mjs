import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';

export const NAPCAT_RELEASE={
  version:'4.18.37',bytes:124074962,
  url:'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.37/NapCat.Shell.Windows.Node.zip',
  alternateUrl:'https://api.github.com/repos/NapNeko/NapCatQQ/releases/assets/626888548',
  sha256:'05c79761361321f6af4358aef92f80a7f8e319b6459c260ebf9a159615e96fe4'
};
export function projectId(root){return crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0,24);}
export function readJson(file,fallback={}){
  if(!fs.existsSync(file))return fallback;
  return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
export function writeJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n');fs.renameSync(temp,file);
}
export function powershell(script,args=[]){
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',script,...args],{stdio:'inherit',windowsHide:true});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(path.basename(script)+' failed with exit code '+code)));
  });
}
export async function hashFile(file){
  const hash=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
export async function downloadChecked(url,file,expected,{bytes,fetcher=fetch,log=console.log}={}){
  if(fs.existsSync(file)&&(await hashFile(file))===expected){log('Using verified cached download.');return;}
  const partial=file+'.'+crypto.randomUUID()+'.partial';
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{
    const response=await fetcher(url,{signal:AbortSignal.timeout(20*60*1000),headers:{'User-Agent':'bot-windows-deployment','Accept':'application/octet-stream'}});
    if(!response.ok||!response.body)throw new Error('Download failed: HTTP '+response.status);
    let received=0,last=0;const total=Number(response.headers.get('content-length'))||bytes;
    const stream=Readable.fromWeb(response.body);
    stream.on('data',chunk=>{
      received+=chunk.length;
      if(Date.now()-last>3000){last=Date.now();log('Download: '+Math.floor(received/1048576)+' MB'+(total?' / '+Math.ceil(total/1048576)+' MB':''));}
    });
    await pipeline(stream,fs.createWriteStream(partial,{flags:'wx'}));
    if((await hashFile(partial))!==expected)throw new Error('Downloaded archive failed SHA256 verification; it will not be extracted or executed.');
    if(fs.existsSync(file))fs.renameSync(file,file+'.invalid-'+Date.now());
    fs.renameSync(partial,file);
  }finally{if(fs.existsSync(partial))fs.unlinkSync(partial);}
}
export function isolateQQData(source){
  let count=0;
  const result=source.replace(/[\w.]+\.NodeQQNTWrapperUtil\.getNTUserDataInfoConfig\(\)/g,()=>{count++;return 'process.env.BOT_QQ_DATA_DIR';});
  if(count!==2)throw new Error('NapCat data-path contract changed; refusing to use the existing desktop QQ profile.');
  return 'if (!process.env.BOT_QQ_DATA_DIR) throw new Error("Isolated QQ profile is required");\n'+result;
}
export async function freePort(wanted,used=new Set()){
  for(let port=Number(wanted);port<Number(wanted)+50&&port<=65535;port++){
    if(used.has(port))continue;
    const server=net.createServer();
    try{
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
      await new Promise(r=>server.close(r));used.add(port);return port;
    }catch(error){if(error.code!=='EADDRINUSE')throw error;}
  }
  throw new Error('No available local port near '+wanted);
}
export async function prepareWindows(root,{skipProtocol=false}={}){
  const data=path.join(root,'data');fs.mkdirSync(data,{recursive:true});
  const stateFile=path.join(data,'windows-deployment.json');
  const existing=readJson(stateFile,null);
  if(existing&&existing.projectId!==projectId(root)){
    throw new Error('Project directory moved after deployment. Restore the original directory or redeploy a fresh blank copy.');
  }
  const used=new Set();
  const ports=existing?.ports||{
    web:await freePort(process.env.PORT||process.env.SERVER_PORT||process.env.HTTP_PORT||8080,used),
    agent:await freePort(process.env.QQ_AGENT_PORT||3210,used),
    http:await freePort(3000,used),ws:await freePort(3001,used),webui:await freePort(6099,used)
  };
  const runtime=path.join(root,'.runtime','napcat');
  const napcatDir=path.join(runtime,'napcat');
  if(!skipProtocol){
    await powershell(path.join(root,'scripts','prepare-vcredist.ps1'));
    const marker=readJson(path.join(runtime,'bot-runtime.json'),null);
    const required=['node.exe','index.js','wrapper.node','napcat/napcat.mjs'];
    if(!marker||marker.sha256!==NAPCAT_RELEASE.sha256||required.some(f=>!fs.existsSync(path.join(runtime,f)))){
      if(fs.existsSync(runtime))throw new Error('Incomplete QQ runtime exists. Rename .runtime/napcat and retry; existing data was not deleted.');
      const download=path.join(root,'.runtime','downloads','napcat-'+NAPCAT_RELEASE.version+'.zip');
      console.log('Downloading official NapCat Windows runtime (includes QQ core; about 119 MB)...');
      let error;
      for(let attempt=0;attempt<3;attempt++){
        try{await downloadChecked(attempt===1?NAPCAT_RELEASE.alternateUrl:NAPCAT_RELEASE.url,download,NAPCAT_RELEASE.sha256,{bytes:NAPCAT_RELEASE.bytes});error=null;break;}
        catch(e){error=e;console.error('Download attempt '+(attempt+1)+' failed: '+e.message);if(attempt<2)await new Promise(r=>setTimeout(r,2000*(attempt+1)));}
      }
      if(error)throw error;
      const staging=path.join(root,'.runtime','qq-tmp-'+crypto.randomBytes(4).toString('hex'));
      await powershell(path.join(root,'scripts','extract-archive.ps1'),['-Archive',download,'-Destination',staging]);
      const main=path.join(staging,'napcat','napcat.mjs');
      fs.writeFileSync(main,isolateQQData(fs.readFileSync(main,'utf8')));
      for(const file of required)if(!fs.existsSync(path.join(staging,file)))throw new Error('Official runtime is missing '+file);
      writeJson(path.join(staging,'bot-runtime.json'),{version:NAPCAT_RELEASE.version,sha256:NAPCAT_RELEASE.sha256,isolatedProfile:true});
      fs.renameSync(staging,runtime);
    }
    const configDir=path.join(napcatDir,'config');fs.mkdirSync(configDir,{recursive:true});
    const webuiFile=path.join(configDir,'webui.json');
    if(!fs.existsSync(webuiFile))writeJson(webuiFile,{host:'127.0.0.1',port:ports.webui,token:crypto.randomBytes(24).toString('hex'),disableWebUI:false,autoLoginAccount:''});
    const protocolFile=path.join(configDir,'onebot11.json');
    if(!fs.existsSync(protocolFile)){
      const template=readJson(path.join(root,'onebot','onebot11.json'));
      const token=crypto.randomBytes(24).toString('hex');
      Object.assign(template.network.httpServers[0],{port:ports.http,token});
      Object.assign(template.network.websocketServers[0],{port:ports.ws,token});
      writeJson(protocolFile,template);
    }
    const protocol=readJson(protocolFile);
    const configFile=path.join(data,'config.json');const config=readJson(configFile);
    if(!existing||existing.skipProtocol){
      config.snowluma={...config.snowluma,dir:napcatDir,autoLaunch:true,
        httpUrl:'http://127.0.0.1:'+ports.http,wsUrl:'ws://127.0.0.1:'+ports.ws,
        accessToken:protocol.network.websocketServers[0].token,httpAccessToken:protocol.network.httpServers[0].token};
      writeJson(configFile,config);
    }
    fs.mkdirSync(path.join(data,'qq-profile'),{recursive:true});
  }
  const deployment={projectId:projectId(root),ports,napcatDir,runtime,skipProtocol,createdAt:existing?.createdAt||new Date().toISOString()};
  writeJson(stateFile,deployment);
  return deployment;
}
