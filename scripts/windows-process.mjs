import {spawn} from 'node:child_process';
export async function stopOwnedChild(child){
  if(!child||child.exitCode!==null||!Number.isInteger(child.pid)||child.pid<=0)return;
  if(process.platform!=='win32'){child.kill();return;}
  await new Promise(resolve=>{
    const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    killer.once('error',()=>{child.kill();resolve();});killer.once('exit',resolve);
  });
}
