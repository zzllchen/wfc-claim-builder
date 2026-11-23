/* "My receipts": receipts snapped with the phone, kept until they are claimed.
   Each receipt is kept on this device (the browser's IndexedDB, so it works with no signal) and, for someone signed in with Google, in a
   "WFC Receipts" folder in their own Google Drive (so it is on the laptop too, and safe when the phone is lost or the browser is cleared).
   The Drive permission is drive.file: the tool sees only the files it made itself, nothing else in that Drive. Nothing goes to the company
   until the receipt is added to a claim and the claim is sent.
   A receipt: { id, owner, createdAt, month, name, type, file (Blob), thumb (data URL), reading {category, name, date, receiptNo, amount, ...},
   status 'new' | 'claimed', claimedIn 'YYYY-MM', driveId, synced } */
(function (root) {
  'use strict';
  const DB = 'wfc-receipts', STORE = 'receipts';
  const FOLDER = 'WFC Receipts', SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const DRIVE = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const READ_KEYS = ['category', 'name', 'date', 'receiptNo', 'amount', 'litres', 'fuel', 'planB', 'hint', 'review', 'auto', 'scan', 'fx', 'askedClaude'];

  /* ---------- small pure helpers (tested in node) ---------- */
  const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const monthOf = (iso) => (/^\d{4}-\d{2}/.test(iso || '') ? iso.slice(0, 7) : '');
  // the month a receipt belongs to: the date printed on it, else the day it was snapped
  const monthFor = (rec) => monthOf(rec.reading && rec.reading.date) || monthOf(rec.createdAt);
  const money = (n) => (Number(n) || 0).toFixed(2);
  // "2026-11-03 Petrol - Shell - RM50.00.jpg": readable in Drive, sorts by date
  function fileName(rec) {
    const r = rec.reading || {}, bits = [r.date || String(rec.createdAt || '').slice(0, 10), r.category, r.name, r.amount ? 'RM' + money(r.amount) : ''].filter(Boolean);
    return (bits.join(' - ').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 110) || 'Receipt') + '.jpg';
  }
  // what is kept with the file in Drive: the reading (short) and the state, so another device can show and claim it without reading again
  function describe(rec) {
    const r = {};
    READ_KEYS.forEach((k) => { const v = rec.reading && rec.reading[k]; if (v != null && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) r[k] = v; });
    return JSON.stringify({ v: 1, id: rec.id, createdAt: rec.createdAt, reading: r }).slice(0, 3500);
  }
  function fromDrive(f) {
    let d = {};
    try { d = JSON.parse(f.description || '{}') || {}; } catch (e) { d = {}; }
    const p = f.appProperties || {};
    const rec = { id: p.wfcId || d.id || 'd' + f.id, owner: '', createdAt: d.createdAt || f.createdTime || '', name: f.name || 'Receipt.jpg', type: f.mimeType || 'image/jpeg',
      file: null, thumb: '', reading: d.reading || {}, status: p.status === 'claimed' ? 'claimed' : 'new', claimedIn: p.claimedIn || '', driveId: f.id, synced: true };
    rec.month = monthFor(rec);
    return rec;
  }
  /* local and Drive lists together: one entry per receipt (the local one, with what Drive knows added), newest first, removed ones left out */
  function merge(local, remote) {
    const by = new Map(local.map((r) => [r.id, r]));
    remote.forEach((d) => {
      const l = by.get(d.id);
      if (!l) { by.set(d.id, d); return; }
      l.driveId = l.driveId || d.driveId; l.synced = true;
      if (d.status === 'claimed' && l.status !== 'claimed') { l.status = 'claimed'; l.claimedIn = d.claimedIn; }        // claimed on another device
    });
    return Array.from(by.values()).filter((r) => !r.removed).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  // grouped by month, newest month first: [{ month, items }]
  function byMonth(list) {
    const g = new Map();
    list.forEach((r) => { const m = r.month || monthFor(r) || 'unknown'; if (!g.has(m)) g.set(m, []); g.get(m).push(r); });
    return Array.from(g.entries()).sort((a, b) => b[0].localeCompare(a[0])).map(([month, items]) => ({ month, items }));
  }
  // the reading worth keeping from a claim line (the claim tool's item)
  function readingOf(item) {
    const r = {};
    READ_KEYS.forEach((k) => { if (item[k] != null && item[k] !== '') r[k] = JSON.parse(JSON.stringify(item[k])); });
    return r;
  }
  // multipart body for a Drive upload (metadata + the photo)
  function multipart(meta, blob, boundary) {
    const b = boundary || 'wfc' + Math.random().toString(36).slice(2);
    return { type: 'multipart/related; boundary=' + b, body: new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${blob.type || 'image/jpeg'}\r\n\r\n`, blob, `\r\n--${b}--`]) };
  }

  /* ---------- this device: IndexedDB ---------- */
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { const s = req.result.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('owner', 'owner'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  }));
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode), req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
    });
  }
  const put = (rec) => tx('readwrite', (s) => s.put(rec));
  const get = (id) => tx('readonly', (s) => s.get(id));
  // this person's receipts on this device ('' = not signed in: those belong to whoever uses this browser)
  const localAll = async (owner) => ((await tx('readonly', (s) => s.getAll())) || []).filter((r) => (r.owner || '') === (owner || '') || (!r.owner && owner));
  // ask the browser to keep this data (no clearing when the phone runs low on space); harmless where it is not supported
  function persist() { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* older browser */ } }

  /* the photo kept small: long side 1600 px, JPEG (a phone photo of 3-5 MB becomes about 250 KB), and a 240 px thumbnail */
  async function shrink(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const draw = (max, q) => {
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
      return { c, q };
    };
    const big = draw(1600), small = draw(240);
    const blob = await new Promise((res) => big.c.toBlob(res, 'image/jpeg', 0.86));
    return { blob, thumb: small.c.toDataURL('image/jpeg', 0.7) };
  }

  /* Is the photo good enough to read? Sharpness (how much the picture changes from one pixel to the next: a blurred photo changes little) and
     light, on a small grey copy. Only clear cases are flagged: the reading itself is the real test. -> { ok, problem: 'blurry' | 'dark' | 'small' | '' } */
  async function quality(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (Math.max(bmp.width, bmp.height) < 500) return { ok: false, problem: 'small' };
      const W = 360, H = Math.max(1, Math.round(bmp.height * W / bmp.width)), c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data, n = W * H, grey = new Float32Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) { grey[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114; sum += grey[i]; }
      const mean = sum / n;
      let lap = 0, lap2 = 0, m = 0;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x, v = 4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - W] - grey[i + W];
        lap += v; lap2 += v * v; m++;
      }
      const sharp = lap2 / m - (lap / m) ** 2;
      return { ok: !(mean < 55 || sharp < SHARP_MIN), problem: mean < 55 ? 'dark' : sharp < SHARP_MIN ? 'blurry' : '', sharp: Math.round(sharp), light: Math.round(mean) };
    } catch (e) { return { ok: true, problem: '' }; }
  }
  const SHARP_MIN = 80;            // readable test photos score 394 and up; the same photos blurred score 9-258

  /* ---------- Google Drive (the person's own) ---------- */
  const drive = { token: '', until: 0, folder: '', email: '' };
  const connected = () => !!drive.token && Date.now() < drive.until;
  const FOLDER_KEY = (email) => 'wfc-receipts-folder:' + (email || '');
  /* Call straight from a click (the Google window must open inside it). The first time Google asks the person to allow "the files this app makes". */
  function connect(clientId, email) {
    return new Promise((resolve, reject) => {
      if (connected() && drive.email === (email || '')) { resolve(true); return; }
      const g = root.google && root.google.accounts && root.google.accounts.oauth2;
      if (!g) { reject(new Error('Google sign-in is still loading - try again in a moment.')); return; }
      const client = g.initTokenClient({
        client_id: clientId, scope: SCOPE, hint: email || undefined, include_granted_scopes: true,
        callback: (r) => {
          if (r.error) { reject(new Error(r.error === 'access_denied' ? 'Google Drive was not allowed, so receipts stay on this device.' : r.error_description || r.error)); return; }
          if (r.scope && r.scope.indexOf('drive.file') < 0) { reject(new Error('Google Drive was not allowed, so receipts stay on this device.')); return; }
          drive.token = r.access_token; drive.email = email || ''; drive.until = Date.now() + Math.max(60, (Number(r.expires_in) || 3600) - 60) * 1000;
          resolve(true);
        },
        error_callback: (e) => reject(new Error(e && e.type === 'popup_closed' ? 'The Google window was closed before it finished.' : 'Google Drive could not be reached.')),
      });
      client.requestAccessToken();
    });
  }
  async function call(url, init) {
    const res = await fetch(url, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + drive.token }, init && init.headers) }));
    if (res.status === 401) { drive.token = ''; throw new Error('Google Drive needs you to connect again.'); }
    if (!res.ok) { let m = ''; try { m = (await res.json()).error.message; } catch (e) { /* none */ } throw new Error(m || `Google Drive said no (HTTP ${res.status}).`); }
    return init && init.blob ? res.blob() : res.status === 204 ? null : res.json();
  }
  async function folder() {
    if (drive.folder) return drive.folder;
    let id = '';
    try { id = localStorage.getItem(FOLDER_KEY(drive.email)) || ''; } catch (e) { id = ''; }
    if (id) {
      try { const f = await call(`${DRIVE}/files/${id}?fields=id,trashed`); if (f && !f.trashed) return (drive.folder = id); } catch (e) { /* gone: find or make it again */ }
    }
    const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = await call(`${DRIVE}/files?q=${q}&fields=files(id)&spaces=drive&pageSize=5`);
    id = found.files && found.files[0] ? found.files[0].id : (await call(`${DRIVE}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) })).id;
    try { localStorage.setItem(FOLDER_KEY(drive.email), id); } catch (e) { /* private window */ }
    return (drive.folder = id);
  }
  async function upload(rec) {
    const parent = await folder();
    const meta = { name: fileName(rec), parents: [parent], mimeType: rec.type || 'image/jpeg', description: describe(rec), appProperties: { wfcId: rec.id, status: rec.status, claimedIn: rec.claimedIn || '' } };
    const mp = multipart(meta, rec.file);
    const f = await call(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.body });
    rec.driveId = f.id; rec.synced = true;
    await put(rec);
  }
  const patchDrive = (rec, meta) => call(`${DRIVE}/files/${rec.driveId}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
  async function remoteAll() {
    const parent = await folder(), out = [];
    let page = '';
    do {
      const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
      const j = await call(`${DRIVE}/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,description,appProperties,createdTime)&pageSize=200&orderBy=createdTime desc${page ? '&pageToken=' + page : ''}`);
      (j.files || []).forEach((f) => out.push(fromDrive(f)));
      page = j.nextPageToken || '';
    } while (page && out.length < 1000);
    return out;
  }
  /* send what is only on this device, and bring in what another device added. -> { list, sent, errors } */
  async function sync(owner) {
    const local = await localAll(owner);
    if (!connected()) return { list: merge(local, []), sent: 0, errors: [] };
    let sent = 0;
    const errors = [];
    for (const r of local) {
      if (r.removed && r.driveId) { try { await patchDrive(r, { trashed: true }); await tx('readwrite', (s) => s.delete(r.id)); } catch (e) { errors.push(e.message); } continue; }
      if (r.removed) { await tx('readwrite', (s) => s.delete(r.id)); continue; }
      if (!r.driveId && r.file) { try { await upload(r); sent++; } catch (e) { errors.push(e.message); } }
      else if (r.driveId && r.dirty) { try { await patchDrive(r, { appProperties: { status: r.status, claimedIn: r.claimedIn || '' } }); r.dirty = false; await put(r); } catch (e) { errors.push(e.message); } }
    }
    let remote = [];
    try { remote = await remoteAll(); } catch (e) { errors.push(e.message); }
    return { list: merge(await localAll(owner), remote), sent, errors };
  }
  /* the photo of a receipt that is only in Drive (snapped on another device): fetched once, then kept here */
  async function photo(rec) {
    if (rec.file) return rec.file;
    if (!rec.driveId || !connected()) return null;
    const blob = await call(`${DRIVE}/files/${rec.driveId}?alt=media`, { blob: true });
    rec.file = blob; rec.owner = rec.owner || drive.email;
    try { rec.thumb = rec.thumb || (await shrink(blob)).thumb; } catch (e) { /* no thumbnail */ }
    await put(rec);
    return blob;
  }

  /* ---------- the claim tool's calls ---------- */
  async function add(file, owner, reading) {
    const s = await shrink(file);
    const rec = { id: uid(), owner: owner || '', createdAt: new Date().toISOString(), name: file.name || 'Receipt.jpg', type: 'image/jpeg', file: s.blob, thumb: s.thumb,
      reading: reading || {}, status: 'new', claimedIn: '', driveId: '', synced: false };
    rec.month = monthFor(rec);
    await put(rec);
    persist();
    return rec;
  }
  async function setReading(id, reading) {
    const rec = await get(id); if (!rec) return null;
    rec.reading = reading || {}; rec.month = monthFor(rec);
    if (rec.driveId) rec.dirty = true;
    await put(rec);
    if (rec.driveId && connected()) { try { await patchDrive(rec, { name: fileName(rec), description: describe(rec) }); rec.dirty = false; await put(rec); } catch (e) { /* next sync */ } }
    return rec;
  }
  /* after a claim is saved: these receipts are claimed in that month (and can't be picked again) */
  async function markClaimed(ids, month) {
    for (const id of ids || []) {
      const rec = await get(id); if (!rec) continue;
      rec.status = 'claimed'; rec.claimedIn = month; rec.dirty = !!rec.driveId;
      await put(rec);
    }
  }
  async function unclaim(id) {
    const rec = await get(id); if (!rec) return;
    rec.status = 'new'; rec.claimedIn = ''; rec.dirty = !!rec.driveId;
    await put(rec);
  }
  async function remove(id) {
    const rec = await get(id); if (!rec) return;
    if (rec.driveId) { rec.removed = true; rec.file = null; await put(rec); } else await tx('readwrite', (s) => s.delete(id));
  }
  // a receipt known only from Drive, kept here once it is used
  const keep = (rec) => put(rec);

  const api = { add, setReading, markClaimed, unclaim, remove, keep, localAll, sync, photo, connect, connected, quality, shrink,
    monthFor, fileName, describe, fromDrive, merge, byMonth, readingOf, multipart, SCOPE, FOLDER };
  root.Wallet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
