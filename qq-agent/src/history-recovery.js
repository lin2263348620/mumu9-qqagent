// Query local OneBot history; never call a model merely to check for missing messages.
export class HistoryRecovery {
  constructor({ onebot, targets, ingest, selfIngest = async()=>{}, log = () => {}, intervalMs = 30000, now = () => Date.now() }) {
    Object.assign(this, { onebot, targets, ingest, selfIngest, log, intervalMs, now });
    this.retryState = new Map(); this.account = '';
    this.timer = null; this.running = null; this.stopped = true; this.cursor = 0;
    this.stats = { lastCheckAt: 0, recovered: 0, failures: 0, lastError: '' };
  }
  snapshot() { return { ...this.stats, running: !!this.running, deferred: this.retryState.size,
    nextRetryAt: this.retryState.size ? Math.min(...[...this.retryState.values()].map(x=>x.nextAt)) : 0 }; }
  start() {
    this.stopped = false;
    this.timer = setInterval(() => this.run(), this.intervalMs);
    void this.run();
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.running; }
  run() {
    if (this.stopped || this.running || !this.onebot.connected || !this.onebot.selfId) return this.running;
    this.running = this.sweep().catch(() => {
      this.stats.failures++; this.stats.lastError = 'History recovery failed';
    }).finally(() => { this.running = null; });
    return this.running;
  }
  async sweep() {
    const account = this.onebot.selfId;
    if (account !== this.account) { this.retryState.clear(); this.account = account; }
    const keys = [...new Set(this.targets())].filter(key => /^(group|private):\d+$/.test(key));
    for (const key of this.retryState.keys()) if (!keys.includes(key)) this.retryState.delete(key);
    // Rotate bounded batches so a large allow-list cannot monopolize the HTTP API.
    const batch = Array.from({ length: Math.min(keys.length, 20) }, (_, i) => keys[(this.cursor + i) % keys.length]);
    this.cursor = keys.length ? (this.cursor + batch.length) % keys.length : 0;
    for (const key of batch) {
      if (this.stopped || !this.onebot.connected || account !== this.onebot.selfId) break;
      const [kind, id] = key.split(':');
      if ((this.retryState.get(key)?.nextAt || 0) > this.now()) continue;
      try {
        const data = await this.onebot.call(kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history', {
          [kind === 'group' ? 'group_id' : 'user_id']: String(id), count: 100,
          parse_mult_msg: false
        }, 5000);
        if (!Array.isArray(data?.messages)) throw new Error('Unsupported history response');
        if (this.stopped || account !== this.onebot.selfId) break;
        for (const message of [...data.messages].sort((a, b) => Number(a.time) - Number(b.time))) {
          if (this.stopped || !this.onebot.connected || account !== this.onebot.selfId) break;
          const ts = Number(message.time) * 1000;
          const sender = message.user_id ?? message.sender?.user_id;
          // Do not replay unknown-age events, own replies, or more than one day of old traffic.
          if (!Number.isFinite(ts) || ts < Date.now() - 86400000 || ts > Date.now() + 60000 ||
              message.message_id == null || sender == null) continue;
          if(String(sender)===String(account)){await this.selfIngest({...message,message_type:kind,target_id:id,...(kind==='group'?{group_id:id}:{})});continue;}
          const event = { ...message, post_type: 'message', message_type: kind, self_id: Number(account),
            user_id: sender, ...(kind === 'group' ? { group_id: Number(id) } : {}) };
          const saved = await this.ingest(kind, id, event, { recovered: true, archiveOnly: Date.now() - ts > 300000 });
          if (saved) this.stats.recovered++;
        }
        this.retryState.delete(key);
      } catch (error) {
        this.stats.failures++;
        const empty = /消息(?:undefined|0)?不存在/.test(String(error?.message || ''));
        const reason = empty ? 'NapCat returned no history; delivery cannot be confirmed' :
          /Unsupported history response/.test(String(error?.message || '')) ? 'Unsupported history response' : 'History request or ingestion failed';
        const attempts = (this.retryState.get(key)?.attempts || 0) + 1;
        const delay = Math.min(900000, 60000 * 2 ** Math.min(attempts - 1, 4));
        this.retryState.set(key, { attempts, nextAt: this.now() + delay, reason });
        this.log(`[history] ${new Date().toISOString()} ${key}: ${reason}; retry in ${delay / 1000}s`);
      }
    }
    this.stats.lastError = this.retryState.size ? [...this.retryState.values()][0].reason : '';
    this.stats.lastCheckAt = Date.now();
  }
}
