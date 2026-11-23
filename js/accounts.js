/* Sends a saved claim to the accountant's dashboard (the "WFC Claims" inbox: local server or Google web app).
   The claim details go first, then each file one by one, then a "finished" call that makes the claim appear on the dashboard,
   so Agnes never sees a half-sent claim. Saving the same claim again replaces the earlier one.
   Only runs when an address is set (Settings, or the built-in one) and the tick box under Save my claim is on. */
(function (root) {
  'use strict';
  const MAX_FILE = 7 * 1024 * 1024;       // bigger files are left out (the inbox takes about 8 MB a file); they are still in the zip
  const TIMEOUT = 90000;

  async function post(api, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    let res;
    try {
      // text/plain keeps this a "simple" request, so the browser sends it straight away (Google web apps do not answer a pre-flight)
      res = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: ctl.signal, redirect: 'follow' });
    } catch (e) {
      const err = new Error(e && e.name === 'AbortError' ? 'it took too long to answer' : "couldn't connect - check the internet");
      err.retry = true;
      throw err;
    } finally { clearTimeout(timer); }
    let j = null;
    try { j = await res.json(); } catch (e) { /* not JSON */ }
    if (!j) { const err = new Error(`unexpected answer (HTTP ${res.status})`); err.retry = res.status >= 500; throw err; }
    if (!j.ok) throw new Error(j.error || 'the dashboard said no');
    return j;
  }

  async function ping(api) {
    const res = await fetch(api + (api.includes('?') ? '&' : '?') + 'action=ping', { cache: 'no-store' });
    const j = await res.json();
    if (!j || !j.ok) throw new Error('not a WFC Claims address');
    return j;
  }

  async function toBase64(data) {
    let bytes;
    if (data instanceof Uint8Array) bytes = data;
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = new Uint8Array(await (data.arrayBuffer ? data : new Blob([data])).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  const sizeOf = (d) => (d.size != null ? d.size : d.byteLength != null ? d.byteLength : 0);

  /* Working days of a leave application: Monday to Friday from `from` to `to` (both included), without the public holidays.
     holidays: a Map or Set with 'YYYY-MM-DD' keys. The dashboard shows this figure, so it is worked out here where the holiday list is. */
  function leaveDays(from, to, holidays) {
    const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
    if (isNaN(a) || isNaN(b) || b < a) return 0;
    let n = 0;
    for (let t = a; t <= b; t += 864e5) {
      const d = new Date(t), w = d.getUTCDay();
      if (w === 0 || w === 6 || (holidays && holidays.has(d.toISOString().slice(0, 10)))) continue;
      n++;
    }
    return n;
  }

  /* claim: { claimant, month: 'YYYY-MM', lines: [{category, date, name, receiptNo, amount}], from, to, subject }
     leave (a saved leave form, instead of a claim): { claimant, type, start, end, days, reason, signedOn, from, to, subject } (dates 'YYYY-MM-DD')
     files: [{ name, data (Blob | ArrayBuffer | Uint8Array), kind: 'form-pdf' | 'form-xlsx' | 'tng' | 'tollcheck' | 'receipt' | 'other', line }]
     onProgress({ done, total }) -> { id, version, files, skipped: [names left out because they are too big] } */
  async function send({ api, claim, leave, files, onProgress, concurrency = 3 }) {
    const list = files.filter((f) => sizeOf(f.data) <= MAX_FILE);
    const skipped = files.filter((f) => sizeOf(f.data) > MAX_FILE).map((f) => f.name);
    const total = list.length + 1;
    let done = 0;
    const tick = () => { if (onProgress) onProgress({ done, total }); };
    tick();
    const sub = await post(api, leave ? { action: 'submit', leave } : { action: 'submit', claim });

    let next = 0;
    async function worker() {
      while (next < list.length) {
        const i = next++, f = list[i];
        const file = { id: 'f' + String(i + 1).padStart(2, '0'), name: f.name, kind: f.kind || 'other', line: f.line || 0, mime: f.mime || (f.data && f.data.type) || '', data: await toBase64(f.data) };
        const body = { action: 'upload', id: sub.id, token: sub.token, file };
        try { await post(api, body); } catch (e) { if (!e.retry) throw e; await post(api, body); }       // one more try if the connection hiccuped
        done++; tick();
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    const fin = await post(api, { action: 'finish', id: sub.id, token: sub.token });
    done = total; tick();
    return { id: sub.id, version: fin.version, files: fin.files, skipped };
  }

  // receipts claimed before: { claimant, month, lines: [{ ref, category, date, name, receiptNo, amount }] } -> { matches: [{ ref, check, claims: [{ month, monthLabel, status, mine }] }] }
  const seen = (api, body) => post(api, Object.assign({ action: 'seen' }, body));

  const api = { send, ping, seen, leaveDays, MAX_FILE };
  root.Accounts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
