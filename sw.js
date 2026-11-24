/* Flow's service worker: the page keeps working with no signal.
   - The page, its scripts, styles and icons are saved on the phone the first time it opens (and again whenever a new version is installed).
   - The big libraries and the receipt-reading engine are saved once, so a photo can be snapped AND read in a lift or a petrol station with no signal.
   - Online, the page itself always comes from the internet first (so an update is never missed); the saved copy is only used when that fails.
   - Every script address carries ?v=NNN, so a saved copy of an address is always the right one; a new version has new addresses.
   It never touches Google, Microsoft, the accountant's dashboard or Claude: those calls always go straight out, and fail plainly when offline.
   The same worker shows the monthly claim reminders (see the push handler at the bottom). */
'use strict';

const SHELL = 'flow-shell-1';        // page, scripts, styles, icons: cleaned of old versions on every install
const VENDOR = 'flow-vendor-1';      // libraries and the reading engine: kept (rename to force a fresh copy)
const LAZY = ['vendor/pdf.min.js', 'vendor/jspdf.umd.min.js', 'vendor/jszip.min.js', 'assets/claim-base.js', 'assets/leave-base.js'];   // js/lazy.js adds ?v= to these
const FIXED = ['vendor/pdf.worker.min.js'];
const here = new URL(self.registration.scope);
const at = (p) => new URL(p, here).href;
const isVendor = (u) => u.pathname.indexOf('/vendor/') >= 0;

/* ---------- install: keep the page and everything it names ---------- */
async function precache() {
  const res = await fetch(new Request(at('index.html'), { cache: 'reload' }));
  if (!res.ok) throw new Error('index.html ' + res.status);
  const html = await res.clone().text();
  const urls = new Set([at('index.html'), at('manifest.webmanifest'), at('icons/icon-192.png'), at('icons/apple-touch-icon.png')]);
  html.replace(/(?:src|href)="([^"#]+)"/g, (m, u) => { if (!/^(?:[a-z]+:)?\/\//i.test(u) && !/^(?:data|mailto|javascript):/i.test(u) && u !== './') urls.add(at(u)); return m; });
  const v = (html.match(/lazy\.js\?v=([\w.-]+)/) || [])[1];
  LAZY.forEach((p) => urls.add(at(p + (v ? '?v=' + v : ''))));
  FIXED.forEach((p) => urls.add(at(p)));
  const shell = await caches.open(SHELL), vendor = await caches.open(VENDOR);
  await shell.put(at('index.html'), res);
  await Promise.all(Array.from(urls).filter((u) => u !== at('index.html')).map(async (u) => {
    const target = isVendor(new URL(u)) ? vendor : shell;
    try {
      if (await target.match(u)) return;
      const r = await fetch(new Request(u, { cache: 'reload' }));
      if (r.ok) await target.put(u, r);
    } catch (e) { /* one missing file must not stop the rest; it is fetched when first needed */ }
  }));
  // old versions of the page's own files go (the libraries stay)
  for (const k of await shell.keys()) if (!urls.has(k.url)) await shell.delete(k);
  for (const k of await vendor.keys()) if (new URL(k.url).searchParams.has('v') && !urls.has(k.url)) await vendor.delete(k);
}

self.addEventListener('install', (e) => { e.waitUntil(precache().then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== VENDOR && k.indexOf('flow-') === 0) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* ---------- fetch ---------- */
const OFFLINE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flow is offline</title>' +
  '<body style="font:16px/1.5 system-ui,sans-serif;max-width:30em;margin:15vh auto;padding:0 24px;color:#0d1b3e"><h1 style="font-size:22px">No signal</h1>' +
  '<p>Flow needs to be opened once with internet before it can work without signal. Please try again when you are connected.</p>';

async function page(req) {
  const shell = await caches.open(SHELL);
  const path = new URL(req.url).pathname;
  const isApp = /\/(?:index\.html)?$/.test(path);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 5000);       // bad signal: after 5 s use the saved page
  try {
    const res = await fetch(req, { signal: ctl.signal });
    clearTimeout(timer);
    if (isApp && res.ok && res.type === 'basic') shell.put(at('index.html'), res.clone());
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (isApp) { const hit = await shell.match(at('index.html')); if (hit) return hit; }
    return new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

// keep a file, and drop the same file saved under an older ?v= number (so the phone does not collect every version ever shown)
async function remember(cache, req, res) {
  await cache.put(req, res);
  const u = new URL(req.url);
  if (!u.searchParams.has('v')) return;
  for (const k of await cache.keys()) { const o = new URL(k.url); if (o.pathname === u.pathname && o.search !== u.search) await cache.delete(k); }
}

async function asset(e) {
  const req = e.request, url = new URL(req.url);
  const cache = await caches.open(isVendor(url) ? VENDOR : SHELL);
  const hit = await cache.match(req);
  // a ?v= address or a library never changes under the same address: the saved copy is right
  if (hit && (url.searchParams.has('v') || isVendor(url))) return hit;
  const fresh = fetch(req).then((res) => { if (res.ok && res.type === 'basic') remember(cache, req, res.clone()); return res; });
  if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }                          // an address with no version: show the saved copy, refresh it quietly
  return fresh;
}

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== here.origin || url.pathname.indexOf(here.pathname) !== 0) return;
  if (/\/(?:tests|\.git)\//.test(url.pathname) || req.headers.has('range')) return;
  if (req.mode === 'navigate') e.respondWith(page(req)); else e.respondWith(asset(e));
});

/* ---------- monthly claim reminders (push) ----------
   The sender (the accountant dashboard's Google script) pushes with no text at all; this decides what to say from today's date, so the words
   can be changed here without touching the sender. Claims are made the month after: on 1-15 November the claim is for October. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function reminderText(now) {
  const my = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);         // Malaysia time, wherever the phone is
  const day = my.getDate(), last = MONTHS[(my.getMonth() + 11) % 12], due = '15 ' + MONTHS[my.getMonth()];
  if (day <= 7) return { title: `Time to claim your ${last} expenses`, body: `Flow is ready. It takes about 5 minutes, and your snapped receipts are waiting. Due ${due}.`, tag: 'start' };
  if (day <= 12) return { title: `Friendly reminder: ${last} claim`, body: `Not sent yet? Open Flow and finish it today. Due ${due}.`, tag: 'nudge' };
  if (day <= 14) return { title: `${last} claims close in ${15 - day} day${15 - day === 1 ? '' : 's'}`, body: 'A few minutes now saves the rush. Open Flow and send it.', tag: 'soon' };
  return { title: `Last day for ${last} claims`, body: 'Today is the deadline. Open Flow and send your claim.', tag: 'last' };
}
self.reminderText = reminderText;

self.addEventListener('push', (e) => {
  let t = reminderText(new Date());
  try { const j = e.data && e.data.json(); if (j && j.title) t = { title: String(j.title).slice(0, 80), body: String(j.body || '').slice(0, 200), tag: j.tag || t.tag }; } catch (err) { /* no text: the date decides */ }
  e.waitUntil(self.registration.showNotification(t.title, {
    body: t.body, tag: 'flow-claim', renotify: true, icon: at('icons/icon-192.png'), badge: at('icons/favicon-32.png'),
    silent: false, data: { url: at('./?from=reminder') },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || at('./');
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => c.url.indexOf(here.href) === 0);
    if (open) { try { await open.focus(); open.postMessage({ type: 'reminder-open' }); return; } catch (err) { /* fall through and open a window */ } }
    await self.clients.openWindow(target);
  })());
});
