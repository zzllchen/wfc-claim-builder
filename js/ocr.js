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
    const box = paperBox(c);
    let crop = null;
    if (box) {                                   // the paper alone, so keys, a desk or a sticker beside it are never read as receipt text
      crop = document.createElement('canvas');
      // cut from the original photo, not the shrunken copy, so thin dot-matrix print keeps its detail
      const k = bmp.width / c.width, sw = box.w * k, sh = box.h * k;
      const up = Math.min(2.5, 2800 / Math.max(sw, sh));                         // below 1 shrinks a huge crop, above 1 enlarges a small one
      crop.width = Math.round(sw * up); crop.height = Math.round(sh * up);
      crop.getContext('2d', { willReadFrequently: true }).drawImage(bmp, box.x * k, box.y * k, sw, sh, 0, 0, crop.width, crop.height);
      enhance(crop);
    }
    return { full: enhance(c), crop };
  }

  /* Where the paper is: a receipt photographed on a keyboard or a desk is a bright strip in a darker picture. Looks at a small
     copy, finds the longest run of mostly-bright columns, then of rows inside it. Returns null unless that is clearly a part
     of the picture (not nearly all of it, not a sliver), so a plain photo of paper is left whole. */
  function paperBox(c) {
    const W = 240, H = Math.max(1, Math.round((c.height * W) / c.width));
    const s = document.createElement('canvas'); s.width = W; s.height = H;
    const sc = s.getContext('2d', { willReadFrequently: true });
    sc.drawImage(c, 0, 0, W, H);
    const d = sc.getImageData(0, 0, W, H).data, g = new Uint8Array(W * H), hist = new Uint32Array(256);
    for (let i = 0; i < W * H; i++) { g[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0; hist[g[i]]++; }
    // Otsu: the grey that best splits the picture into dark and bright
    let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
    let wB = 0, sumB = 0, best = 0, thr = 128;
    for (let v = 0; v < 256; v++) {
      wB += hist[v]; if (!wB) continue;
      const wF = W * H - wB; if (!wF) break;
      sumB += v * hist[v];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = v; }
    }
    const run = (frac, len) => {                  // longest stretch where frac[i] >= 0.4
      let bestS = -1, bestL = 0, st = -1;
      for (let i = 0; i <= len; i++) {
        const on = i < len && frac[i] >= 0.4;
        if (on && st < 0) st = i;
        if (!on && st >= 0) { if (i - st > bestL) { bestL = i - st; bestS = st; } st = -1; }
      }
      return bestL ? [bestS, bestS + bestL] : null;
    };
    const col = new Float32Array(W);
    for (let x = 0; x < W; x++) { let n = 0; for (let y = 0; y < H; y++) if (g[y * W + x] > thr) n++; col[x] = n / H; }
    const cx = run(col, W); if (!cx) return null;
    const row = new Float32Array(H);
    for (let y = 0; y < H; y++) { let n = 0; for (let x = cx[0]; x < cx[1]; x++) if (g[y * W + x] > thr) n++; row[y] = n / (cx[1] - cx[0]); }
    const ry = run(row, H); if (!ry) return null;
    const area = ((cx[1] - cx[0]) * (ry[1] - ry[0])) / (W * H);
    if (area < 0.12 || area > 0.8 || cx[1] - cx[0] < W * 0.15) return null;
    const mx = Math.round(W * 0.03), my = Math.round(H * 0.03), k = c.width / W;
    const x0 = Math.max(0, cx[0] - mx), x1 = Math.min(W, cx[1] + mx), y0 = Math.max(0, ry[0] - my), y1 = Math.min(H, ry[1] + my);
    return { x: Math.round(x0 * k), y: Math.round(y0 * k), w: Math.round((x1 - x0) * k), h: Math.round((y1 - y0) * k) };
  }

  /* One reading of the picture at one page layout: the text and how sure the engine is (0-100). */
  async function pass(canvas, psm) {
    const w = await worker();
    await w.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await w.recognize(canvas);
    return { text: data.text || '', conf: data.confidence || 0 };
  }

  /* the picture turned by 90, 180 or 270 degrees: a receipt held sideways in the frame reads as gibberish until it is turned */
  function turned(c, deg) {
    const r = document.createElement('canvas');
    const sideways = deg === 90 || deg === 270;
    r.width = sideways ? c.height : c.width; r.height = sideways ? c.width : c.height;
    const ctx = r.getContext('2d', { willReadFrequently: true });
    ctx.translate(r.width / 2, r.height / 2); ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(c, -c.width / 2, -c.height / 2);
    return r;
  }
  const alnumCount = (t) => (t.match(/[A-Za-z0-9]/g) || []).length;

  async function resetWorker() {
    const p = workerPromise;
    workerPromise = null;
    try { const w = await p; if (w) await w.terminate(); } catch (e) { /* already gone */ }
  }

  /* If opts.good(text) says a pass missed what we need (the amount, say), tries other page layouts and returns the first
     good pass, or every pass joined together so the parser can pick from all of them. */
  async function recognize(prep, opts) {
    const canvas = prep.crop || prep.full;       // the paper alone when it could be found, else the whole picture
    const texts = [];
    const ok = (t) => !opts.good || opts.good(t);
    const attempt = async (cv, psm) => {
      try { return await pass(cv, psm); }
      catch (e) {
        safeMode = true;                           // the engine failed to load or crashed: retry the careful way
        await resetWorker();                       // a crashed engine would fail every later photo too
        if (texts.length) return null;             // keep what the earlier layouts already read
        return pass(cv, psm);                      // one retry on a fresh engine
      }
    };
    let cv = canvas;
    const first = await attempt(cv, '4');
    texts.push(first.text);
    if (ok(first.text)) return first.text;
    if (first.conf < 60 || alnumCount(first.text) < 60) {      // a poor first look: the paper may be sideways or upside down in the frame
      let best = { cv: canvas, conf: first.conf };
      for (const deg of [90, 270, 180]) {
        const r = turned(canvas, deg);
        const res = await attempt(r, '4');
        if (!res) break;
        texts.push(res.text);
        if (ok(res.text)) return res.text;
        if (res.conf > best.conf + 8) best = { cv: r, conf: res.conf };
      }
      cv = best.cv;                                             // carry on with the way up that read best
    }
    for (const psm of ['6', '11']) {
      const res = await attempt(cv, psm);
      if (!res) break;
      texts.push(res.text);
      if (ok(res.text)) return res.text;
    }
    if (prep.crop) {                              // the crop may have cut something off: one look at the whole picture too
      const res = await attempt(prep.full, '4');
      if (res) { texts.push(res.text); if (ok(res.text)) return res.text; }
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
  const readCanvas = (canvas, opts) => queue(async () => recognize({ full: enhance(canvas), crop: null }, opts || {}), opts);

  root.OCR = { read, readCanvas, setSafeMode: (on) => { safeMode = !!on; return resetWorker(); } };
})(window);
