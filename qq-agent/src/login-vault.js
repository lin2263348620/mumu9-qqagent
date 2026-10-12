import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

export class LoginVault {
  constructor(dir) {this.dir=dir;this.file=path.join(dir,'qq-login.enc');this.keyFile=path.join(dir,'qq-login.key');}
  key(create=false) {
    if(process.env.QQ_LOGIN_ENCRYPTION_KEY) return createHash('sha256').update(process.env.QQ_LOGIN_ENCRYPTION_KEY).digest();
    if(!fs.existsSync(this.keyFile)) {
      if(!create) throw new Error('登录密钥不存在');
      fs.mkdirSync(this.dir,{recursive:true});fs.writeFileSync(this.keyFile,randomBytes(32),{mode:0o600,flag:'wx'});
    }
    const key=fs.readFileSync(this.keyFile);if(key.length!==32) throw new Error('登录密钥无效');return key;
  }
  save(qq,password) {
    if(!/^\d{5,12}$/.test(qq)||typeof password!=='string'||!password||password.length>256) throw new Error('QQ 号或密码无效');
    const key=this.key(true),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    const secret={qq,passwordMd5:createHash('md5').update(password).digest('hex')};
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(secret),'utf8'),cipher.final()]);
    fs.writeFileSync(this.file+'.tmp',JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')}),{mode:0o600});
    fs.renameSync(this.file+'.tmp',this.file);return this.status();
  }
  read() {
    if(!fs.existsSync(this.file)) return null;
    const doc=JSON.parse(fs.readFileSync(this.file,'utf8'));
    const decipher=createDecipheriv('aes-256-gcm',this.key(),Buffer.from(doc.iv,'base64'));
    decipher.setAuthTag(Buffer.from(doc.tag,'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(doc.data,'base64')),decipher.final()]).toString('utf8'));
  }
  status() {try {const v=this.read();return {saved:!!v,qq:v?.qq||'',keySource:process.env.QQ_LOGIN_ENCRYPTION_KEY?'环境变量':'本机独立密钥'};}catch{return {saved:true,unreadable:true,qq:'',error:'凭据无法解密，请重新保存'};}}
  resolve(qq,hash) {
    if(hash!=='__server_saved__') return hash;
    const saved=this.read();
    if(!saved || saved.qq!==String(qq)) throw new Error('没有该 QQ 的服务器登录凭据');
    return saved.passwordMd5;
  }
  clear() {if(fs.existsSync(this.file)) fs.unlinkSync(this.file);return {saved:false,qq:''};}
}
