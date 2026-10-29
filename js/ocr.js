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

  function worker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        if (!root.Tesseract) await loadScript('vendor/tesseract/tesseract.min.js');
        const w = await root.Tesseract.createWorker('eng', 1, {
          workerPath: abs('vendor/tesseract/worker.min.js'),
          corePath: abs('vendor/tesseract'),
          langPath: abs('vendor/tesseract/lang'),
          gzip: true,
        });
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
    // black point = the darkest 0.3% (ink is only a sliver of the picture); white point = the middle of the picture,
    // which is paper or table. Using a high percentile for "white" and a high one for "black" turned a photo that is
    // all paper into a black page.
    const at = (frac) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * frac) return v; } return 255; };
    let lo = at(0.003);
    const hi = at(0.55);
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
    const scale = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, c.width, c.height);
    return enhance(c);
  }

  /* If opts.good(text) says a pass missed what we need (the amount, say), tries other page layouts and returns the
     first good pass, or every pass joined together so the parser can pick from all of them. */
  async function recognize(canvas, opts) {
    const w = await worker();
    const texts = [];
    for (const psm of ['4', '6', '11']) {
      await w.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await w.recognize(canvas);
      texts.push(data.text || '');
      if (!opts.good || opts.good(texts[texts.length - 1])) return texts[texts.length - 1];
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

  root.OCR = { read, readCanvas };
})(window);
