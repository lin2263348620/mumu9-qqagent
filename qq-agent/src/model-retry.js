import { setTimeout as delay } from 'node:timers/promises';
export async function requestWithRetry(url, options) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, options);
    if (![429, 502, 503, 504].includes(response.status) || attempt === 2) return response;
    await response.body?.cancel();
    const header = response.headers.get('retry-after');
    const seconds = header?.trim() ? Number(header) : NaN;
    const date = Number.isFinite(seconds) ? NaN : Date.parse(header || '');
    const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 :
      Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000 * 2 ** attempt;
    await delay(Math.max(250, wait), undefined, { signal: options.signal });
  }
}
