/* "Where do I save?" - each person picks a folder on their own PC once; the app remembers it
   (the handle lives in this browser's IndexedDB) and writes each month's folder under it.
   Needs the File System Access API (Chrome / Edge on desktop); elsewhere the zip is downloaded instead. */
(function (root) {
  'use strict';
  const supported = typeof root.showDirectoryPicker === 'function';
  const DB = 'wfc-claim-builder', STORE = 'kv', MANIFEST = '.wfc-claim-builder.json';
  let injected = null;   // lets tests supply a folder without the native picker

  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function kv(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  const getSaved = () => (injected ? Promise.resolve(injected) : kv('readonly', (s) => s.get('root')).catch(() => null));
  const forget = () => { injected = null; return kv('readwrite', (s) => s.delete('root')).catch(() => {}); };

  async function pick() {
    const handle = await root.showDirectoryPicker({ id: 'wfc-claims', mode: 'readwrite' });
    await kv('readwrite', (s) => s.put(handle, 'root'));
    return handle;
  }

  async function allowed(handle) {
    const opts = { mode: 'readwrite' };
    if (!handle.queryPermission) return true;
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  /* A folder that is ready to write to, or null (unsupported / cancelled).
     Call this straight from a click: the first time it opens the folder picker. */
  async function ready() {
    if (injected) return injected;
    if (!supported) return null;
    const saved = await getSaved();
    if (saved) { try { if (await allowed(saved)) return saved; } catch (e) { /* handle went stale */ } }
    try { return await pick(); } catch (e) { return null; }
  }

  async function sub(dir, parts) {
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
    return dir;
  }
  async function writeFile(dir, name, data) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }
  async function oldFiles(dir) {
    try { return JSON.parse(await (await (await dir.getFileHandle(MANIFEST)).getFile()).text()).files || []; } catch (e) { return []; }
  }

  /* Writes files [{ name, data }] into <root>/<parts...>/. Files this app wrote last time that are no
     longer part of the claim are removed; anything else in the folder is left alone. */
  async function saveFiles(rootHandle, parts, files) {
    const dir = await sub(rootHandle, parts);
    const names = new Set(files.map((f) => f.name));
    for (const n of await oldFiles(dir)) if (!names.has(n)) { try { await dir.removeEntry(n); } catch (e) { /* already gone */ } }
    for (const f of files) await writeFile(dir, f.name, f.data);
    await writeFile(dir, MANIFEST, JSON.stringify({ files: Array.from(names), savedAt: new Date().toISOString() }));
    return dir;
  }

  root.Folder = { supported, getSaved, pick, forget, ready, saveFiles, writeFile,
    _inject: (h) => { injected = h; } };
})(window);
