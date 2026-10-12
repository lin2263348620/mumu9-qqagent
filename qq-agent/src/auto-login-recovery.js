const HOUR_MS = 60 * 60 * 1000;

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeQuickList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item?.uin ?? item?.qq ?? item?.user_id ?? item ?? '').trim())
    .filter((uin) => /^\d{5,12}$/.test(uin)))];
}

export class AutoLoginRecovery {
  constructor({ webui, restartNapCat, getConfig, getHealth, getSelfId, getDir, emit = () => {}, log = console.log,
    now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, passwordFallback = null } = {}) {
    this.passwordFallback = passwordFallback;
    this.webui = webui;
    this.restartNapCat = restartNapCat || ((dir) => this.webui.restartNapCat(dir));
    this.getConfig = getConfig;
    this.getHealth = getHealth;
    this.getSelfId = getSelfId;
    this.getDir = getDir;
    this.emit = emit;
    this.log = log;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.running = false;
    this.attempts = [];
    this.totalAttempts = 0;
    this.lastAttemptAt = null;
    this.lastResult = 'idle';
    this.lastError = '';
    this.nextAttemptAt = null;
    this.needsManual = false;
    this.targetQQ = '';
    this.quickTried = false;
  }

  settings() {
    const raw = this.getConfig?.()?.autoRecovery || {};
    return {
      enabled: raw.enabled !== false,
      targetQQ: String(raw.targetQQ || '').replace(/\D/g, ''),
      cooldownMs: clampNumber(raw.cooldownMinutes, 10, 1, 120) * 60 * 1000,
      maxAttemptsPerHour: Math.round(clampNumber(raw.maxAttemptsPerHour, 3, 1, 12)),
      verifyDelayMs: clampNumber(raw.verifyDelaySeconds, 90, 30, 300) * 1000
    };
  }

  pruneAttempts(now = this.now()) {
    this.attempts = this.attempts.filter((at) => now - at < HOUR_MS);
  }

  snapshot() {
    this.pruneAttempts();
    return {
      enabled: this.settings().enabled,
      running: this.running,
      attemptsLastHour: this.attempts.length,
      totalAttempts: this.totalAttempts,
      lastAttemptAt: this.lastAttemptAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      nextAttemptAt: this.nextAttemptAt,
      needsManual: this.needsManual,
      targetQQ: this.targetQQ || this.settings().targetQQ || String(this.getSelfId?.() || '')
    };
  }

  publish() {
    this.emit('auto-recovery', this.snapshot());
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextAttemptAt = null;
  }

  applyConfig() {
    if (!this.settings().enabled) this.stop();
    this.publish();
  }

  suspendForManual(reason = '已手动退出登录，请重新登录') {
    this.stop();
    this.running = false;
    this.needsManual = true;
    this.lastResult = 'manual-required';
    this.lastError = String(reason);
    this.quickTried = false;
    this.publish();
    return this.snapshot();
  }

  onRecovered() {
    this.quickTried = false;
    this.stop();
    this.running = false;
    this.needsManual = false;
    this.lastResult = 'recovered';
    this.lastError = '';
    this.publish();
  }

  schedule(at, reason) {
    if (!this.settings().enabled) return;
    if (this.nextAttemptAt && this.nextAttemptAt <= at) return;
    this.stop();
    const delay = Math.max(1000, at - this.now());
    this.nextAttemptAt = at;
    this.lastResult = reason;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.nextAttemptAt = null;
      this.request('scheduled').catch(() => {});
    }, delay);
    this.timer?.unref?.();
    this.publish();
  }

  async request(reason = 'offline', { force = false } = {}) {
    const settings = this.settings();
    const now = this.now();
    this.pruneAttempts(now);

    if (!settings.enabled && !force) return { ok: false, skipped: 'disabled' };
    if (this.running) return { ok: false, skipped: 'running' };
    if (this.getHealth?.()?.online === true) {
      this.onRecovered();
      return { ok: true, skipped: 'already-online' };
    }
    if (this.needsManual && !force) return { ok: false, skipped: 'manual-required', status: this.snapshot() };
    if (!force && this.attempts.length >= settings.maxAttemptsPerHour) {
      this.needsManual = true;
      this.lastResult = 'manual-required';
      this.lastError = `一小时内已尝试 ${this.attempts.length} 次`;
      this.stop();
      this.publish();
      return { ok: false, skipped: 'hourly-limit', status: this.snapshot() };
    }
    const nextAllowedAt = (this.lastAttemptAt || 0) + settings.cooldownMs;
    if (!force && now < nextAllowedAt) {
      this.schedule(nextAllowedAt, 'cooldown');
      return { ok: false, skipped: 'cooldown', status: this.snapshot() };
    }

    this.stop();
    this.running = true;
    this.needsManual = false;
    this.lastResult = 'checking-cache';
    this.lastError = '';
    this.publish();

    try {
      const dir = this.getDir?.();
      const quick = normalizeQuickList(await this.webui.quickList(dir));
      const configured = settings.targetQQ;
      const current = String(this.getSelfId?.() || '').replace(/\D/g, '');
      const target = configured || (quick.includes(current) ? current : (quick.length === 1 ? quick[0] : ''));

      if (!target || !quick.includes(target) || (this.quickTried && this.getConfig?.()?.autoRecovery?.passwordFallback)) {
        if (this.passwordFallback) {
          this.attempts.push(now); this.totalAttempts++; this.lastAttemptAt=now;
          const result=await this.passwordFallback(configured || current);
          if(result?.attempted) {
            this.running=false;this.targetQQ=result.qq||'';
            this.needsManual=!!result.needsManual;
            this.lastResult=this.needsManual?'manual-required':'password-requested';
            this.lastError=result.error||'';
            if(!this.needsManual) this.schedule(now+settings.verifyDelayMs,'waiting-verification');
            this.publish();return {ok:!this.needsManual,status:this.snapshot()};
          }
        }
        this.needsManual = true;
        this.lastResult = 'manual-required';
        this.lastError = !quick.length
          ? 'NapCat 没有可用的快速登录缓存，请人工登录一次'
          : '存在多个快速登录账号且无法确定目标 QQ，请在功能配置中指定';
        this.running = false;
        this.publish();
        return { ok: false, skipped: 'no-usable-quick-login', quickList: quick, status: this.snapshot() };
      }

      await this.webui.setQuickLogin(target, dir);
      this.quickTried = true;
      this.attempts.push(now);
      this.totalAttempts += 1;
      this.lastAttemptAt = now;
      this.targetQQ = target;
      await this.restartNapCat(dir);
      this.running = false;
      this.lastResult = 'restart-requested';
      this.lastError = '';
      this.log(`[auto-recovery] 已为 QQ ${target} 请求快速登录并重启 NapCat（原因：${reason}）`);
      this.schedule(now + settings.verifyDelayMs, 'waiting-verification');
      return { ok: true, targetQQ: target, status: this.snapshot() };
    } catch (error) {
      this.running = false;
      this.lastResult = 'failed';
      this.lastError = String(error?.message ?? error);
      if (/captcha|verify|risk|ticket|验证码|验证|设备锁|风控/i.test(this.lastError)) {
        this.needsManual=true;this.lastResult='manual-required';this.stop();this.publish();
        return {ok:false,error:this.lastError,status:this.snapshot()};
      }
      this.log('[auto-recovery] 自动恢复失败：' + this.lastError);
      this.schedule(now + settings.cooldownMs, 'retry-scheduled');
      return { ok: false, error: this.lastError, status: this.snapshot() };
    }
  }
}

export { normalizeQuickList };
