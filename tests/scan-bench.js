/* The scanner's test bench (tests/scan-bench.html). Runs the claim tool's own reading steps on every sample in the local test folder
   (Documents/WFC-Tools/scan-tests: samples/ and labels.json - real receipts, never in this repo) and scores each field against the labels.
   Five ways: on this PC only; this PC with Claude when unsure (as the claim tool works) with Sonnet and with Opus; Claude alone with each.
   Served by the local server (http://localhost:5199/WFC%20Claim%20Builder/tests/scan-bench.html), which also serves /scan-tests/. */
(function () {
  'use strict';
  const ROOT = '/scan-tests/';
  const $ = (s) => document.querySelector(s);
  const B = window.BENCH = { results: {}, report: null, log: [], running: false };
  const say = (t) => { B.log.push(t); const el = $('#log'); if (el) { el.textContent = B.log.slice(-14).join('\n'); } };
  const MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
  const isPdf = (n) => /\.pdf$/i.test(n);

  async function listSamples() {
    const html = await (await fetch(ROOT + 'samples/', { cache: 'no-store' })).text();
    return Array.from(html.matchAll(/href="([^"]+)"/g)).map((m) => decodeURIComponent(m[1])).filter((n) => /\.(pdf|jpe?g|png|webp)$/i.test(n) && !n.includes('/'));
  }
  async function fileOf(name) {
    const blob = await (await fetch(ROOT + 'samples/' + encodeURIComponent(name), { cache: 'no-store' })).blob();
    return new File([blob], name, { type: isPdf(name) ? 'application/pdf' : (blob.type || 'image/jpeg') });
  }
  const ctxOf = (label) => ({ month: label && (label.date || label.periodStart) ? String(label.date || label.periodStart).slice(0, 7) : '', today: new Date() });

  /* ---------- the reading steps, exactly as the claim tool takes them ---------- */
  // the station names a regular claimant's browser has saved (the claim tool learns them from past claims)
  const STATIONS = ['KEJAYAAN TEGUH ENTERPRISE'];
  function fromPetrol(p, path) {
    const amt = parseFloat(p.amount);
    const why = PlanB.doubts(p, { category: p.category || 'Petrol' });
    return { path, docType: 'receipt', category: p.category || 'Petrol', vendor: p.station || '', date: p.date || '', number: p.receiptNo || '',
      total: amt > 0 ? amt : p.foreign ? p.foreign.amount : null, currency: amt > 0 ? 'MYR' : p.foreign ? p.foreign.code : '', totalMyr: amt > 0 ? amt : null, unsure: why.length > 0, doubts: why };
  }
  function fromExtract(x, path) {
    return { path, docType: x.docType, category: x.category, vendor: x.vendor, date: x.date, number: x.number, total: x.total, currency: x.currency || 'MYR',
      totalMyr: (!x.currency || x.currency === 'MYR') ? x.total : null, unsure: x.unsure, needsReview: x.needsReview, x };
  }
  async function local(file, label) {
    const ctx = ctxOf(label), opts = { month: ctx.month, stations: STATIONS };
    let text = '';
    if (isPdf(file.name)) {
      const s = await Receipts.readPdf(await file.arrayBuffer());
      if (s.isTng) return { path: 'tng statement', docType: 'statement', category: 'Toll', vendor: "Touch 'n Go", date: '', number: '', total: null, currency: 'MYR', unsure: false, text: s.text };
      if (s.stripe) {
        const f = Petrol.foreignTotal(s.text);
        return { path: 'software invoice', docType: s.stripe.isReceipt ? 'receipt' : 'invoice', category: 'AI tools', vendor: s.stripe.merchant, date: s.stripe.date, number: s.stripe.invoiceNo,
          total: f ? f.amount : s.stripe.amount, currency: f ? f.code : 'MYR', totalMyr: s.stripe.amount, unsure: false, text: s.text };
      }
      if (s.hotel) {
        const hx = Extract.read(s.lines && s.lines.length ? s.lines : s.text, ctx);
        return { path: 'agoda', docType: 'receipt', category: 'Accommodation', vendor: s.hotel.merchant, date: s.hotel.date, number: hx.confidence.number >= 0.6 ? hx.number : '', total: s.hotel.amount, currency: 'MYR', totalMyr: s.hotel.amount, unsure: false, text: s.text };
      }
      text = s.hasText ? s.text : await OCR.readCanvas(await Receipts.renderFirstPage(await file.arrayBuffer()));
      const verdict = Validate.judge(text, s.hasText ? 'pdf' : 'scan');
      if (verdict.status !== 'ok') return { path: 'refused', docType: 'not a receipt', reason: verdict.reason, unsure: false, text };
      const p = Petrol.parse(text, opts), x = Extract.read(s.lines && s.lines.length ? s.lines : text, ctx);
      if (Extract.forGeneral(x, p, text)) return Object.assign(fromExtract(x, 'general'), { text, pdf: true });
      const t = fromPetrol(fillGaps(p, x), 'tuned (pdf)'), twins = p.receiptNo ? Extract.twinsOf(p.receiptNo, text) : [];
      // as the claim tool: a number printed two ways is not sure, and Claude picks the spelling
      if (twins.length) Object.assign(t, { unsure: true, spellings: [p.receiptNo].concat(twins) });
      return Object.assign(t, { text, pdf: true });
    }
    const parts = [];
    text = await OCR.read(file, { collect: parts });
    const r = Petrol.best(parts.length ? parts : [text], opts);
    const verdict = Validate.judge(text, 'photo');
    if (verdict.status !== 'ok' && !(r.amount && verdict.reason === Validate.MSG.noAmount)) {
      // as the claim tool: a photo it cannot read, or with no amount, is tried again with Claude (when Claude is on)
      const canRetry = verdict.reason === Validate.MSG.photoUnreadable || verdict.reason === Validate.MSG.noAmount;
      return { path: 'refused', docType: 'not a receipt', reason: verdict.reason, unsure: canRetry, retry: canRetry, photo: true, r: {}, doubts: ['the normal reader could not read it'], text };
    }
    const x = Extract.read(text, ctx);
    if (!r.category) { const g = x.category; if (['Medical', 'Parking', 'Accommodation'].includes(g)) r.category = g; }
    return Object.assign(Extract.forGeneral(x, r, text) ? fromExtract(x, 'general') : fromPetrol(fillGaps(r, x), 'tuned (photo)'), { text, photo: true, r });
  }
  // the claim tool's gap filling (js/app.js fillGaps), the same rule
  function fillGaps(r, x) {
    if (!r.receiptNo && x.number && x.confidence.number >= 0.6) r.receiptNo = x.number;
    if (!r.station && x.vendor && x.confidence.vendor >= 0.75) r.station = x.vendor;
    if (!r.date && x.date && x.confidence.date >= 0.8) r.date = x.date;
    if (!r.category && ['Medical', 'Parking', 'Accommodation'].includes(x.category)) r.category = x.category;
    return r;
  }
  // Claude's reading in the same shape
  const fromClaude = (c, path) => ({ path, docType: c.isReceipt ? c.docType : 'not a receipt', category: c.category, vendor: c.vendor, date: c.date, number: c.number,
    total: c.total, currency: c.currency || 'MYR', totalMyr: c.totalMyr != null ? c.totalMyr : (c.currency === 'MYR' ? c.total : null), unsure: false, confidence: c.confidence });
  async function claudeAlone(file, label, model, text) {
    const out = await Scan.read(file, { month: ctxOf(label).month, model: MODELS[model], text: text || '' });
    return Object.assign(fromClaude(out.reading, 'claude ' + model), { usage: out.usage, model: out.model });
  }
  // as the claim tool works: Claude only when this PC is unsure (general reader -> the scanner; fuel, clinic, parking, hotel photos -> the photo check)
  async function asTool(file, label, model, loc) {
    if (!loc.unsure) return Object.assign({}, loc, { path: loc.path + ' (no Claude)' });
    if (loc.path === 'general') {
      const out = await Scan.read(file, { month: ctxOf(label).month, model: MODELS[model], text: loc.text });
      if (!out.reading.isReceipt) return fromClaude(out.reading, 'general + claude ' + model);
      const m = Scan.merge(loc.x, out.reading), f = m.fields;
      return { path: 'general + claude ' + model, docType: f.docType || loc.docType, category: f.category, vendor: f.vendor, date: f.date, number: f.number, total: f.total, currency: f.currency || 'MYR',
        totalMyr: f.totalMyr != null ? f.totalMyr : ((f.currency || 'MYR') === 'MYR' ? f.total : null), needsReview: m.needsReview, notes: m.notes };
    }
    if (loc.photo) {
      PlanB.setModel(MODELS[model]);
      const c = (await PlanB.read(file, { month: ctxOf(label).month })).reading;
      if (!c.isReceipt) return { path: 'tuned + claude ' + model, docType: 'not a receipt' };
      const m = PlanB.merge(loc.r || {}, c, loc.doubts || []);
      const known = m.r.station && Petrol.station(m.r.station, STATIONS); if (known) m.r.station = known;
      return Object.assign(fromPetrol(m.r, 'tuned + claude ' + model), { unsure: false, review: m.r.review || [] });
    }
    if (loc.path === 'refused' && !loc.retry) return loc;
    if (loc.spellings) {
      const out = await Scan.read(file, { month: ctxOf(label).month, model: MODELS[model], text: loc.text });
      const key = (v) => String(v || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
      const hit = loc.spellings.find((v) => key(v) === key(out.reading.number));
      return Object.assign({}, loc, { path: loc.path + ' + claude ' + model + ' (number)', number: hit || loc.number, unsure: !hit });
    }
    return Object.assign({}, loc, { path: loc.path + ' (no Claude for PDFs)' });
  }

  /* ---------- scoring ---------- */
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
  const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((w) => w.length >= 3 && !/^(sdn|bhd|inc|ltd|llc|ent|enterprise|the|pte|company)$/.test(w));
  function sameVendor(a, b) {
    if (!a || !b) return false;
    const x = norm(a), y = norm(b);
    if (x.includes(y) || y.includes(x)) return true;
    const wa = words(a), wb = words(b);
    const hit = wa.filter((w) => wb.some((v) => v.startsWith(w) || w.startsWith(v))).length;
    return hit / Math.max(1, Math.min(wa.length, wb.length)) >= 0.5;
  }
  const FIELDS = ['rejected', 'category', 'vendor', 'date', 'number', 'amount'];
  // what each field should be, from the label (null = not scored for this sample)
  function expected(label) {
    const unsure = new Set(label.unsure || []);
    const neg = label.docType === 'not a receipt';
    const amount = label.totalMyr != null ? { v: label.totalMyr, cur: 'MYR' } : label.total != null ? { v: label.total, cur: label.currency || 'MYR' } : null;
    return {
      rejected: neg,
      category: neg ? null : label.category,
      vendor: neg || unsure.has('vendor') ? null : label.vendor,
      date: neg || unsure.has('date') || label.docType === 'statement' ? null : label.date,
      number: neg || unsure.has('number') || label.docType === 'statement' ? null : label.number,
      amount: neg || unsure.has('total') ? null : amount,
    };
  }
  function score(label, res) {
    const e = expected(label), out = {};
    const refused = res.docType === 'not a receipt';
    out.rejected = refused === e.rejected;
    if (e.rejected) return out;
    if (e.category != null) out.category = res.category === e.category;
    if (e.vendor != null) out.vendor = sameVendor(res.vendor, e.vendor) || (label.vendorAlt || []).some((v) => sameVendor(res.vendor, v));
    if (e.date != null) out.date = res.date === e.date || (label.periodStart && res.date === label.periodStart);
    if (e.number != null) out.number = norm(res.number) === norm(e.number);
    if (e.amount != null) {
      const got = e.amount.cur === 'MYR' ? (res.totalMyr != null ? res.totalMyr : (res.currency === 'MYR' ? res.total : null)) : (res.currency === e.amount.cur ? res.total : null);
      out.amount = got != null && Math.abs(got - e.amount.v) < 0.011;
    }
    return out;
  }

  function summarise(labels, names) {
    const rows = {}, fails = {}, byCat = {};
    Object.keys(B.results).forEach((cfg) => {
      const per = {}; FIELDS.forEach((f) => { per[f] = [0, 0]; });
      const cats = {};
      fails[cfg] = [];
      names.forEach((n) => {
        const r = B.results[cfg][n]; if (!r) return;
        const s = r.error ? null : score(labels[n], r);
        const cat = labels[n].category || 'not a receipt';
        cats[cat] = cats[cat] || [0, 0];
        if (!s) { fails[cfg].push({ file: n, error: r.error }); cats[cat][1]++; return; }
        Object.keys(s).forEach((f) => { per[f][1]++; if (s[f]) per[f][0]++; });
        const allOk = Object.values(s).every(Boolean);
        cats[cat][1]++; if (allOk) cats[cat][0]++;
        if (!allOk) fails[cfg].push({ file: n, wrong: Object.keys(s).filter((f) => !s[f]), got: (({ category, vendor, date, number, total, currency, totalMyr, docType, path }) => ({ category, vendor, date, number, total, currency, totalMyr, docType, path }))(r) });
      });
      rows[cfg] = per; byCat[cfg] = cats;
    });
    return { rows, fails, byCat };
  }

  /* ---------- running ---------- */
  async function run(which) {
    if (B.running) return; B.running = true;
    try {
      const labels = await (await fetch(ROOT + 'labels.json', { cache: 'no-store' })).json();
      const names = (await listSamples()).filter((n) => labels[n]);
      const cfgs = which || ['pc', 'tool-sonnet', 'tool-opus', 'claude-sonnet', 'claude-opus'];
      PlanB.resetCalls();
      for (const n of names) {
        const file = await fileOf(n), label = labels[n];
        let loc = null;
        for (const cfg of cfgs) {
          B.results[cfg] = B.results[cfg] || {};
          if (B.results[cfg][n] && !B.results[cfg][n].error) continue;          // already done (a re-run carries on)
          say(`${n}: ${cfg}…`);
          try {
            if (!loc && cfg !== 'claude-sonnet' && cfg !== 'claude-opus') loc = await local(file, label);
            if (cfg === 'pc') B.results[cfg][n] = loc;
            else if (cfg.startsWith('tool-')) B.results[cfg][n] = await asTool(file, label, cfg.slice(5), loc);
            else B.results[cfg][n] = await claudeAlone(file, label, cfg.slice(7), '');
          } catch (e) { B.results[cfg][n] = { error: String((e && e.message) || e).slice(0, 200) }; say(`  ${n} ${cfg}: ${B.results[cfg][n].error}`); }
          if (PlanB.resetCalls) PlanB.resetCalls();
        }
      }
      B.report = summarise(labels, names);
      B.report.names = names; B.report.when = new Date().toISOString();
      paint();
      say('Done.');
    } finally { B.running = false; }
  }

  function paint() {
    const r = B.report; if (!r) return;
    const pct = (a) => (a[1] ? Math.round(a[0] / a[1] * 100) + '% (' + a[0] + '/' + a[1] + ')' : '–');
    const cfgs = Object.keys(r.rows);
    let html = '<h2>Accuracy per field</h2><table><tr><th>Field</th>' + cfgs.map((c) => `<th>${c}</th>`).join('') + '</tr>';
    FIELDS.forEach((f) => { html += `<tr><td>${f}</td>` + cfgs.map((c) => `<td>${pct(r.rows[c][f])}</td>`).join('') + '</tr>'; });
    html += '</table><h2>Samples fully right, per type</h2><table><tr><th>Type</th>' + cfgs.map((c) => `<th>${c}</th>`).join('') + '</tr>';
    const cats = Array.from(new Set(cfgs.flatMap((c) => Object.keys(r.byCat[c]))));
    cats.forEach((t) => { html += `<tr><td>${t}</td>` + cfgs.map((c) => `<td>${pct(r.byCat[c][t] || [0, 0])}</td>`).join('') + '</tr>'; });
    html += '</table><h2>What went wrong</h2>';
    cfgs.forEach((c) => { html += `<h3>${c}</h3><ul>` + (r.fails[c].length ? r.fails[c].map((f) => `<li><b>${f.file}</b>: ${f.error ? 'error: ' + f.error : f.wrong.join(', ') + ' — got ' + JSON.stringify(f.got).replace(/[<>&]/g, '')}</li>`).join('') : '<li>none</li>') + '</ul>'; });
    $('#out').innerHTML = html;
  }

  /* ---------- new samples: Claude reads each one without a label, and the answer is a starting label to check ---------- */
  async function draftLabels() {
    const labels = await (await fetch(ROOT + 'labels.json', { cache: 'no-store' })).json();
    const todo = (await listSamples()).filter((n) => !labels[n]);
    const out = {};
    for (const n of todo) {
      say(`Reading ${n} with Claude to start its label…`);
      try {
        const c = (await Scan.read(await fileOf(n), { model: MODELS.opus })).reading;
        out[n] = { docType: c.isReceipt ? c.docType : 'not a receipt', category: c.isReceipt ? c.category : null, vendor: c.vendor || null, date: c.date || null, dueDate: c.dueDate || null,
          periodStart: c.periodStart || null, periodEnd: c.periodEnd || null, number: c.number || null, numberKind: c.numberKind || null, currency: c.currency || null, subtotal: c.subtotal, tax: c.tax,
          taxType: c.taxType || null, total: c.total, totalMyr: c.totalMyr, paymentMethod: c.paymentMethod || null, last4: c.last4 || null, litres: c.litres, unsure: [], notes: 'Drafted by Claude: check every field before adding.' };
      } catch (e) { out[n] = { error: String(e.message || e) }; }
    }
    $('#draft').value = JSON.stringify(out, null, 2);
    say(todo.length ? `Drafted ${todo.length} label(s): check them, then add them to labels.json.` : 'Every sample already has a label.');
    return out;
  }

  B.run = run; B.paint = paint; B.score = score; B.expected = expected; B.draftLabels = draftLabels;
  document.addEventListener('DOMContentLoaded', () => {
    $('#run').addEventListener('click', () => run());
    $('#runPc').addEventListener('click', () => run(['pc']));
    $('#draftBtn').addEventListener('click', draftLabels);
    // the company Claude connection, as on the claim tool
    const api = 'https://script.google.com/macros/s/AKfycbxMR5cSfFwSgI4D0SWcdwzyle9ardosITFVmX5c3fn0a22eW9XnqrXURVs1VFPHWNcF/exec';
    fetch(api + '?action=ping').then((r) => r.json()).then((j) => { if (j && j.scan) { PlanB.useTeam(api); say('Company Claude connection: ready (scanner on).'); } else say('Company Claude connection: the scanner is not on yet (inbox version ' + (j && j.version) + ').'); }).catch(() => say('Company Claude connection: not reachable.'));
  });
})();
