/* Flow as a phone app: works with no signal, sits on the home screen, keeps its data.
   - registers the service worker (sw.js) that saves the page and the receipt-reading engine on the phone;
   - tells the page when the signal goes and comes back (Pwa.on('offline' | 'online', fn)) and shows the slim bar for it;
   - "Add to home screen": the steps for iPhone (Share > Add to Home Screen) and a one-tap Install on Android;
   - asks the phone to keep the saved receipts for good (storage.persist), which an installed app is given and a browser tab often is not.
   Nothing here needs the internet except the first visit. */
(function (root) {
  'use strict';
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } } };
  const UA = (root.navigator && navigator.userAgent) || '';
  const isIos = () => /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = () => /Android/.test(UA);
  const isPhone = () => isIos() || isAndroid();
  const inAppBrowser = () => /FBAN|FBAV|Instagram|Line\/|MicroMessenger|WhatsApp|GSA\/|Messenger/i.test(UA);
  const standalone = () => !!(navigator.standalone || (root.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches)));
  const online = () => navigator.onLine !== false;

  /* ---------- the engine files kept for offline use (the reading engine is about 17 MB; fetched once, kept) ---------- */
  const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
  const hasSimd = () => { try { return WebAssembly.validate(SIMD_PROBE); } catch (e) { return false; } };
  const engineFiles = () => ['vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js',
    'vendor/tesseract/' + (hasSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'), 'vendor/tesseract/lang-best/eng.traineddata.gz', 'vendor/pdf.worker.min.js']
    .map((p) => new URL(p, document.baseURI).href);
  async function haveEngine() {
    if (!root.caches) return false;
    try { const c = await caches.open('flow-vendor-1'); const hits = await Promise.all(engineFiles().map((u) => c.match(u))); return hits.every(Boolean); } catch (e) { return false; }
  }
  let warming = null;
  /* once the page has settled and there is a signal (and the person is not on a data saver), save the engine so the first snap offline can be read too */
  function warm() {
    if (warming) return warming;
    warming = (async () => {
      if (!root.caches || !navigator.serviceWorker || !navigator.serviceWorker.controller) return false;
      if (await haveEngine()) return true;
      const conn = navigator.connection;
      if (conn && (conn.saveData || /^(?:slow-)?2g$/.test(conn.effectiveType || ''))) return false;
      for (const u of engineFiles()) {
        if (!online()) return false;
        try { const r = await fetch(u); if (r.ok) await r.blob(); } catch (e) { return false; }
      }
      const ok = await haveEngine();
      if (ok) bus.emit('ready');
      return ok;
    })().finally(() => { warming = null; });
    return warming;
  }

  /* ---------- a tiny event bus ---------- */
  const bus = (() => { const m = {}; return { on(n, f) { (m[n] = m[n] || []).push(f); }, emit(n, a) { (m[n] || []).forEach((f) => { try { f(a); } catch (e) { console.warn(e); } }); } }; })();

  /* ---------- the slim bar under the header ---------- */
  let barTimer = 0;
  function bar(text, opts) {
    const el = document.getElementById('netBar'); if (!el) return;
    clearTimeout(barTimer);
    el.textContent = '';
    if (!text) { el.hidden = true; return; }
    opts = opts || {};
    el.className = 'netbar ' + (opts.kind || '');
    el.append(Object.assign(document.createElement('span'), { textContent: text }));
    if (opts.action) { const b = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: opts.action.label }); b.addEventListener('click', opts.action.run); el.append(b); }
    el.hidden = false;
    if (opts.seconds) barTimer = setTimeout(() => { el.hidden = true; }, opts.seconds * 1000);
  }

  let wasOffline = !online();
  function netChanged() {
    const on = online();
    if (!on) { wasOffline = true; bar('No signal. You can still snap receipts: they are saved on your phone.', { kind: 'off' }); bus.emit('offline'); }
    else { const back = wasOffline; wasOffline = false; if (back) bar('You are back online.', { kind: 'on', seconds: 5 }); else bar(''); bus.emit('online', { back }); warm(); }
  }

  /* ---------- put it on the home screen ---------- */
  let deferred = null;
  root.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; bus.emit('installable'); });
  root.addEventListener('appinstalled', () => { deferred = null; ls.set('wfc-installed', '1'); bus.emit('installed'); });
  const canPrompt = () => !!deferred;
  async function prompt() { if (!deferred) return false; const d = deferred; deferred = null; d.prompt(); try { const r = await d.userChoice; return r.outcome === 'accepted'; } catch (e) { return false; } }
  /* worth offering? a phone, not installed yet, not in a chat app's page */
  const installable = () => isPhone() && !standalone();

  /* ---------- start ---------- */
  function init() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* older browser */ }
    root.addEventListener('online', netChanged); root.addEventListener('offline', netChanged);
    if (!online()) netChanged();
    const okHost = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!('serviceWorker' in navigator) || !okHost) return;
    navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).then(() => navigator.serviceWorker.ready).then(() => {
      const go = () => { warm().catch(() => {}); };
      (root.requestIdleCallback || ((f) => setTimeout(f, 3000)))(() => setTimeout(go, 4000));
    }).catch((e) => console.warn('Offline mode could not start', e));
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type) bus.emit(e.data.type, e.data); });
  }
  init();

  root.Pwa = { on: bus.on, online, standalone, isIos, isAndroid, isPhone, inAppBrowser, installable, canPrompt, prompt, bar, warm, haveEngine, engineFiles };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Pwa;
})(typeof window !== 'undefined' ? window : globalThis);
