/* WFC Claim Builder: keeps an unfinished claim on this computer, so a refresh (or a closed tab) does not lose the files and lines.
   One draft in the browser's IndexedDB, files included (the same database the save folder uses). It is removed by Start over, and after 30 days. */
(function (root) {
  'use strict';
  const DB = 'wfc-claim-builder', STORE = 'kv', KEY = 'draft', MAX_AGE = 30 * 86400000;
  const db = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function kv(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const save = (snap) => kv('readwrite', (s) => s.put(snap, KEY)).catch((e) => { console.warn('Could not keep the draft', e); });
  const clear = () => kv('readwrite', (s) => s.delete(KEY)).catch(() => {});
  async function load() {
    try {
      const d = await kv('readonly', (s) => s.get(KEY));
      if (!d || !d.savedAt) return null;
      if (Date.now() - d.savedAt > MAX_AGE) { clear(); return null; }
      return d;
    } catch (e) { return null; }
  }
  // build() returns the snapshot, or null when there is nothing to keep (then any old draft is removed)
  let timer = null;
  const put = (build) => Promise.resolve().then(() => build()).then((snap) => (snap === undefined ? undefined : snap ? save(snap) : clear()));
  function schedule(build, ms) { clearTimeout(timer); timer = setTimeout(() => { put(build); }, ms == null ? 700 : ms); }
  function flush(build) { clearTimeout(timer); return put(build); }
  function cancel() { clearTimeout(timer); }

  root.Draft = { save, load, clear, schedule, flush, cancel, MAX_AGE };
})(window);
