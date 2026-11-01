/* Reads text from a receipt photo (or a scanned PDF page), on this device (Tesseract.js). The engine (about 11 MB)
   loads the first time it is needed, then the browser keeps it. Jobs are queued and run one at a time. */
(function (root) {
  'use strict';
  const abs = (p) => new URL(p, document.baseURI).href;
  let workerPromise = null;
  let chain = Promise.resolve();

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.append(s);
    });
  }

  /* Safe mode: some browsers, antivirus or networks refuse a worker that imports the engine by address ("Failed to execute
     'importScripts'"). Then the page downloads the two script files itself and hands the worker local copies. It is switched
     on automatically after a failure, so the usual path stays the fast one. */
  let safeMode = false;
  const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
  const hasSimd = () => { try { return WebAssembly.validate(SIMD_PROBE); } catch (e) { return false; } };
  async function localCopy(path) {
    const res = await fetch(abs(path));
    if (!res.ok) throw new Error(`${path} could not be downloaded (HTTP ${res.status})`);
    return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'text/javascript' }));
  }

  function worker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        if (!root.Tesseract) await loadScript('vendor/tesseract/tesseract.min.js');
        const cfg = {
          workerPath: abs('vendor/tesseract/worker.min.js'),
          corePath: abs('vendor/tesseract'),
          langPath: abs('vendor/tesseract/lang'),
          gzip: true,
        };
        if (safeMode) {
          cfg.workerPath = await localCopy('vendor/tesseract/worker.min.js');
          cfg.corePath = (await localCopy('vendor/tesseract/' + (hasSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'))) + '#core.js';
        }
        const w = await root.Tesseract.createWorker('eng', 1, cfg);
        await w.setParameters({ tessedit_pageseg_mode: '4', preserve_interword_spaces: '1' });   // one column of text
        return w;
      })().catch((e) => { workerPromise = null; throw e; });
    }
    return workerPromise;
  }

  /* grey, stretched contrast: thermal paper photos are faint */
  function enhance(c) {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data, hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; d[i] = g; hist[g]++; }
    const total = c.width * c.height;
    // black point = the darkest 2%, white point = the brightest 20%. If the ink is only a sliver of the picture (a close-up
    // where the paper fills the frame) those two land on the same grey and the page goes black, so then take the black
    // point from the darkest 0.3% instead.
    const at = (frac) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * frac) return v; } return 255; };
    let lo = at(0.02);
    const hi = at(0.8);
    if (hi - lo < 50) lo = at(0.003);
    if (hi - lo < 50) lo = Math.max(0, hi - 50);
    const span = Math.max(50, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  async function prepare(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { throw Object.assign(new Error('decode'), { code: 'decode' }); }       // e.g. HEIC in Chrome
    // big photos are shrunk, small ones (a screenshot, a forwarded chat copy) are enlarged: the engine reads best at about this size
    const longest = Math.max(bmp.width, bmp.height);
    const scale = longest > 2200 ? 2200 / longest : longest < 1600 ? Math.min(3, 2200 / longest) : 1;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, c.width, c.height);
    return enhance(c);
  }

  /* If opts.good(text) says a pass missed what we need (the amount, say), tries other page layouts and returns the
     first good pass, or every pass joined together so the parser can pick from all of them. */
  async function pass(canvas, psm) {
    const w = await worker();
    await w.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await w.recognize(canvas);
    return data.text || '';
  }

  async function resetWorker() {
    const p = workerPromise;
    workerPromise = null;
    try { const w = await p; if (w) await w.terminate(); } catch (e) { /* already gone */ }
  }

  async function recognize(canvas, opts) {
    const texts = [];
    for (const psm of ['4', '6', '11']) {
      let text;
      try { text = await pass(canvas, psm); }
      catch (e) {
        safeMode = true;                           // the engine failed to load or crashed: retry the careful way
        await resetWorker();                       // a crashed engine would fail every later photo too
        if (texts.length) break;                   // keep what the earlier layouts already read
        text = await pass(canvas, psm);            // one retry on a fresh engine
      }
      texts.push(text);
      if (!opts.good || opts.good(text)) return text;
    }
    return texts.join('\n');
  }

  function queue(task, opts) {
    const job = chain.then(async () => { if (opts && opts.onStart) opts.onStart(); return task(); });
    chain = job.catch(() => {});     // one failure must not block the queue
    return job;
  }

  /* photo file -> recognised text */
  const read = (file, opts) => queue(async () => recognize(await prepare(file), opts || {}), opts);
  /* a canvas (e.g. a rendered PDF page) -> recognised text */
  const readCanvas = (canvas, opts) => queue(async () => recognize(enhance(canvas), opts || {}), opts);

  root.OCR = { read, readCanvas, setSafeMode: (on) => { safeMode = !!on; return resetWorker(); } };
})(window);
