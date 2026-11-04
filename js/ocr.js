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
          langPath: abs('vendor/tesseract/lang-best'),     // the high-accuracy model; a new folder so no browser serves the old small one from its cache
          gzip: true,
          cachePath: 'wfc-eng-best-1',               // the model is the high-accuracy one; a new cache name so browsers drop the old small model
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
    const crop = paperCrop(bmp, c);               // the paper alone, cut from the full-size photo, straightened, everything else whitened
    return { full: enhance(c), crop: crop ? enhance(crop) : null };
  }

  const newCanvas = (w, h) => { const r = document.createElement('canvas'); r.width = Math.max(1, Math.round(w)); r.height = Math.max(1, Math.round(h)); return r; };

  /* Finds the paper in a photo: a receipt on a keyboard, a desk or a lap is the biggest bright, compact patch. Works on a small
     copy: split bright from dark (Otsu), shave thin links with two erosions, take the biggest paper-shaped patch, grow it back.
     Returns { maskCanvas, W, H, box, tilt } in small-copy coordinates, or null when there is no clear paper (a plain photo of
     paper fills the frame, a scan has no background). */
  function findPaper(c) {
    const W = 300, H = Math.max(1, Math.round((c.height * W) / c.width)), n = W * H;
    const s = newCanvas(W, H), sc = s.getContext('2d', { willReadFrequently: true });
    sc.drawImage(c, 0, 0, W, H);
    const d = sc.getImageData(0, 0, W, H).data, g = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) { g[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0; hist[g[i]]++; }
    let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
    let wB = 0, sumB = 0, best = 0, thr = 128;
    for (let v = 0; v < 256; v++) {
      wB += hist[v]; if (!wB) continue;
      const wF = n - wB; if (!wF) break;
      sumB += v * hist[v];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = v; }
    }
    const bright = new Uint8Array(n); for (let i = 0; i < n; i++) bright[i] = g[i] > thr ? 1 : 0;
    const shave = (a) => { const b = new Uint8Array(n); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; b[i] = a[i] && a[i - 1] && a[i + 1] && a[i - W] && a[i + W] ? 1 : 0; } return b; };
    const grow = (a, within) => { const b = new Uint8Array(n); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; b[i] = (a[i] || a[i - 1] || a[i + 1] || a[i - W] || a[i + W]) && (!within || within[i]) ? 1 : 0; } return b; };
    const core = shave(shave(bright));
    // label the patches
    const lab = new Int32Array(n), stack = new Int32Array(n), parts = [];
    for (let i0 = 0; i0 < n; i0++) {
      if (!core[i0] || lab[i0]) continue;
      const id = parts.length + 1; let sp = 0, area = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
      stack[sp++] = i0; lab[i0] = id;
      while (sp) {
        const i = stack[--sp]; area++; const x = i % W, y = (i / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
        for (const j of nb) if (j >= 0 && core[j] && !lab[j]) { lab[j] = id; stack[sp++] = j; }
      }
      parts.push({ id, area, x0, x1, y0, y1 });
    }
    // the biggest bright patch that is not the whole picture
    const pick = parts.filter((p) => p.area >= n * 0.05).sort((a, b) => b.area - a.area)[0];
    if (!pick || pick.area > n * 0.9) return null;
    let mask = new Uint8Array(n); for (let i = 0; i < n; i++) mask[i] = lab[i] === pick.id ? 1 : 0;
    for (let k = 0; k < 3; k++) mask = grow(mask, bright);        // back to the true edge of the paper
    // holes inside the paper (a QR code, a stamp) belong to it: whatever dark area the picture border cannot reach
    const reach = new Uint8Array(n), st2 = new Int32Array(n); let sp2 = 0;
    const seed = (i) => { if (!mask[i] && !reach[i]) { reach[i] = 1; st2[sp2++] = i; } };
    for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
    while (sp2) {
      const i = st2[--sp2], x = i % W, y = (i / W) | 0;
      if (x > 0) seed(i - 1); if (x < W - 1) seed(i + 1); if (y > 0) seed(i - W); if (y < H - 1) seed(i + W);
    }
    for (let i = 0; i < n; i++) if (!mask[i] && !reach[i]) mask[i] = 1;
    // trim what clings to the paper (a sticker, a desk edge): keep the columns, then rows, that the paper mostly fills
    {
      let bx0 = W, bx1 = 0, by0 = H, by1 = 0;
      for (let i = 0; i < n; i++) if (mask[i]) { const x = i % W, y = (i / W) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
      const bh = by1 - by0 + 1; let L = -1, R = -1;
      for (let x = bx0; x <= bx1; x++) { let k = 0; for (let y = by0; y <= by1; y++) if (mask[y * W + x]) k++; if (k / bh >= 0.5) { if (L < 0) L = x; R = x; } }
      if (L < 0) return null;
      let T = -1, B = -1;
      for (let y = by0; y <= by1; y++) { let k = 0; for (let x = L; x <= R; x++) if (mask[y * W + x]) k++; if (k / (R - L + 1) >= 0.5) { if (T < 0) T = y; B = y; } }
      if (T < 0) return null;
      for (let i = 0; i < n; i++) { const x = i % W, y = (i / W) | 0; if (mask[i] && (x < L || x > R || y < T || y > B)) mask[i] = 0; }
    }
    for (let k = 0; k < 2; k++) mask = grow(mask, null);           // and a little beyond, so no paper edge is cut
    // box and long axis (the tilt of a long strip)
    let cnt = 0, mx = 0, my = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (let i = 0; i < n; i++) if (mask[i]) { const x = i % W, y = (i / W) | 0; cnt++; mx += x; my += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (cnt < n * 0.05) return null;
    mx /= cnt; my /= cnt;
    let cxx = 0, cyy = 0, cxy = 0;
    for (let i = 0; i < n; i++) if (mask[i]) { const x = (i % W) - mx, y = ((i / W) | 0) - my; cxx += x * x; cyy += y * y; cxy += x * y; }
    const theta = (0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180) / Math.PI;       // long axis, degrees from the x axis (y down)
    const half = (cxx + cyy) / 2, spread = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
    const longness = Math.sqrt((half + spread) / Math.max(1e-6, half - spread));
    let tilt = 0;
    if (longness >= 1.6) { tilt = ((theta + 45 + 360) % 90) - 45; if (Math.abs(tilt) < 2 || Math.abs(tilt) > 35) tilt = 0; }   // only a long strip, only a real tilt
    const maskCanvas = newCanvas(W, H), mctx = maskCanvas.getContext('2d');
    const md = mctx.createImageData(W, H);
    for (let i = 0; i < n; i++) { const v = mask[i] ? 0 : 255; md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = v; md.data[i * 4 + 3] = 255; }
    mctx.putImageData(md, 0, 0);                  // white outside the paper, black on it
    const mg = 2, bx = Math.max(0, x0 - mg), by = Math.max(0, y0 - mg);
    return { maskCanvas, W, H, box: { x: bx, y: by, w: Math.min(W, x1 + mg) - bx, h: Math.min(H, y1 + mg) - by }, tilt };
  }

  /* The paper cut out of the original full-size photo: enlarged or shrunk so the print is about the size the engine reads best,
     everything that is not paper painted white, and a tilted strip turned upright. */
  function paperCrop(bmp, c) {
    const f = findPaper(c); if (!f) return null;
    const kx = bmp.width / f.W, ky = bmp.height / f.H;
    const sx = f.box.x * kx, sy = f.box.y * ky, sw = f.box.w * kx, sh = f.box.h * ky;
    const up = Math.min(2.5, 2800 / Math.max(sw, sh));
    let r = newCanvas(sw * up, sh * up);
    const ctx = r.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, r.width, r.height);
    ctx.globalCompositeOperation = 'lighten';      // the lighter of photo and mask: outside the paper becomes white, the paper is untouched
    ctx.drawImage(f.maskCanvas, f.box.x, f.box.y, f.box.w, f.box.h, 0, 0, r.width, r.height);
    ctx.globalCompositeOperation = 'source-over';
    if (f.tilt) {
      const rad = (-f.tilt * Math.PI) / 180, cs = Math.abs(Math.cos(rad)), sn = Math.abs(Math.sin(rad));
      const t = newCanvas(r.width * cs + r.height * sn, r.width * sn + r.height * cs), tctx = t.getContext('2d', { willReadFrequently: true });
      tctx.fillStyle = '#fff'; tctx.fillRect(0, 0, t.width, t.height);
      tctx.translate(t.width / 2, t.height / 2); tctx.rotate(rad); tctx.drawImage(r, -r.width / 2, -r.height / 2);
      r = t;
    }
    return r;
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
    const texts = opts.collect || [];             // the caller may want every reading, not only the text returned
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
    const order = prep.crop ? ['6', '4', '11'] : ['4', '6', '11'];     // on a clean cut-out the block layout reads best
    const first = await attempt(cv, order[0]);
    texts.push(first.text);
    if (ok(first.text)) return first.text;
    if (prep.turnable !== false && (first.conf < 60 || alnumCount(first.text) < 60)) {      // a poor first look of a PHOTO: the paper may be sideways or upside down in the frame
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
    for (const psm of order.slice(1)) {
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
  const readCanvas = (canvas, opts) => queue(async () => recognize({ full: enhance(canvas), crop: null, turnable: false }, opts || {}), opts);

  root.OCR = { read, readCanvas, setSafeMode: (on) => { safeMode = !!on; return resetWorker(); } };
})(window);
