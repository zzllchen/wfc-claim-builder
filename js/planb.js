/* WFC Claim Builder: plan B. The normal reader (Tesseract, on this PC) always goes first. Only when it cannot read a photo, or what it read does not
   make sense (a RM7.00 fuel receipt, no date, an amount that does not add up), and only when the person has saved an Anthropic key in Settings,
   is the photo sent to Claude for a second reading. No key: nothing is ever sent anywhere.
   Pure parts (doubts, parseReply, merge) work in Node for testing; the network part only runs in the browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.PlanB = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const API_URL = 'https://api.anthropic.com/v1/messages', VERSION = '2023-06-01', RM_PER_USD = 4.4;
  const KEY = 'wfc-claude-key', MODEL = 'wfc-claude-model', FIRST = 'wfc-claude-first', DEFAULT_MODEL = 'claude-sonnet-5-5';
  const MODELS = {                      // $ per million tokens, in / out
    'claude-sonnet-5-5': { label: 'Sonnet 5.5 (recommended)', inUsd: 2, outUsd: 10 },
    'claude-haiku-5-5': { label: 'Haiku 5.5 (cheapest)', inUsd: 0.1, outUsd: 0.5 },
    'claude-opus-5-5': { label: 'Opus 5.5 (smartest)', inUsd: 4, outUsd: 20 },
  };
  const KINDS = ['Petrol', 'Medical', 'Parking', 'Accommodation', 'AI tools', 'Meals', 'Travel', 'Transport', 'Online shopping', 'Supplier invoice', 'Other'];
  const MAX_CALLS = 60;                 // per page visit: a pile of photos cannot run up a bill
  let calls = 0;

  /* ---------- the company's Claude connection (optional) ----------
     When the claims inbox (Google) holds an Anthropic key, every browser can use Claude through it with nothing to paste. The key never
     reaches a page: the inbox adds it, fixes the model, caps the answer and keeps a daily limit for the whole team. A key a person pastes
     in the Claude panel still wins over this. */
  const team = { api: '', on: false };
  const useTeam = (api) => { team.api = String(api || ''); team.on = !!team.api; };

  /* ---------- the saved key (this browser only) ---------- */
  const ls = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* private window */ } },
  };
  const apiKey = () => ls.get(KEY);
  const model = () => (MODELS[ls.get(MODEL)] ? ls.get(MODEL) : DEFAULT_MODEL);

  /* ---------- the same file is never paid for twice ----------
     Claude's answer is kept on this PC under a fingerprint of what was sent (the picture or PDF, the instructions, the model; not today's
     date). The same receipt added again, in another claim or after a reload, is read from here for free. */
  const ANSWERS = 'wfc-claude-answers', ANSWERS_MAX = 120;
  async function answerKey(body, action) {
    try {
      if (typeof crypto === 'undefined' || !crypto.subtle || typeof TextEncoder === 'undefined') return '';
      const s = (action || 'claude') + '|' + JSON.stringify(body).replace(/Today is \d{4}-\d{2}-\d{2}\.?/g, '');
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
      return Array.from(h.slice(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return ''; }
  }
  const answers = () => { try { return JSON.parse(ls.get(ANSWERS) || '{}') || {}; } catch (e) { return {}; } };
  const remembered = (k) => { const a = k && answers()[k]; return a ? a.j : null; };
  function remember(k, j) {
    if (!k || !j || j.stop_reason === 'refusal') return;
    const a = answers(); a[k] = { t: Date.now(), j: { content: j.content, stop_reason: j.stop_reason, model: j.model } };
    Object.keys(a).sort((x, y) => a[y].t - a[x].t).slice(ANSWERS_MAX).forEach((x) => delete a[x]);
    ls.set(ANSWERS, JSON.stringify(a));
  }
  let saved = 0;                        // answers read from this PC instead of paid for, this visit
  const MODE = 'wfc-claude-mode', SPEND = 'wfc-claude-spend', TESTED = 'wfc-claude-tested';
  // when Claude reads: 'first' = camera photos go to Claude first, 'backup' = only when the reader on this PC fails or doubts, 'off' = never
  const mode = () => { const m = ls.get(MODE); return m === 'backup' || m === 'off' || m === 'first' ? m : 'backup'; };          // default: only when the reader on this PC is unsure
  const setMode = (m) => { ls.set(MODE, m); ls.set(FIRST, ''); };
  const available = () => (!!apiKey() || team.on) && mode() !== 'off' && calls < MAX_CALLS;
  // Claude reads every photo first (the default once a key is saved); switched off, it is only asked when the reader on this PC fails or doubts
  const first = () => mode() === 'first';

  /* ---------- when is the normal reading doubtful? ---------- */
  // a believable amount for each kind of claim, in ringgit
  const RANGE = { Petrol: [10, 400], Medical: [5, 3000], Parking: [1, 300], Accommodation: [30, 3000], 'AI tools': [1, 3000] };
  const NAME = { Petrol: 'petrol', Medical: 'clinic', Parking: 'parking', Accommodation: 'hotel', 'AI tools': 'software' };
  const DAY = 86400000;
  /* r = the reading ({ amount, date, foreign, sure }); ctx = { category, today: Date } -> a list of plain reasons, empty when it all makes sense */
  function doubts(r, ctx) {
    ctx = ctx || {}; r = r || {};
    const out = [], cat = ctx.category || 'Petrol', amt = parseFloat(r.amount), today = (ctx.today || new Date()).getTime();
    if (!(amt > 0)) { if (!r.foreign) out.push('no amount found'); }
    else {
      const range = RANGE[cat] || [1, 5000];
      if (amt < range[0]) out.push(`RM${amt.toFixed(2)} looks too small for ${NAME[cat] || cat}`);
      else if (amt > range[1]) out.push(`RM${amt.toFixed(2)} looks too big for ${NAME[cat] || cat}`);
    }
    if (r.sure === false) out.push('the amount may be wrong');
    if (r.invoiceDoubt) out.push(r.receiptNo ? `the invoice number (${r.receiptNo}) may be misread` : 'no invoice number found');
    if (r.station && /[()|\[\]{}<>=_*~^\\]/.test(r.station)) out.push('the shop name may be misread');
    if (!r.station && cat !== 'Petrol') out.push('no name found');          // a clinic, hotel, shop: the name is a box the claim needs (a fuel slip starts with the saved station)
    if (!r.date) out.push('no date found');
    else {
      const t = Date.parse(r.date + 'T12:00:00Z');
      if (t > today + 2 * DAY) out.push(`the date (${r.date}) looks wrong`);
      else if (t < today - 120 * DAY) out.push(`the date (${r.date}) looks wrong`);
    }
    return out;
  }

  /* Is a doubt worth a Claude reading? Not when the only thing missing is the receipt number and the rest is sure (the sums on the slip add up,
     the date was read): the person types the number (or leaves it, a slip may print it only as a QR code), and no credit is spent. */
  const worthAsking = (why, r) => (why || []).length > 0 && !((why || []).every((w) => w === 'no invoice number found') && r && r.sure === true && r.date);

  /* ---------- Claude's answer ---------- */
  const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  function validIso(s) {
    const m = ISO_DATE.exec(String(s || '')); if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 2000 ? s : '';
  }
  /* the reply text -> { isReceipt, kind, merchant, date, amount, foreign, receiptNo, confidence, notes } or null */
  function parseReply(raw) {
    const s = String(raw || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    let o; try { o = JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return n > 0 ? n : 0; };
    const cur = String(o.currency || 'MYR').toUpperCase().replace(/[^A-Z]/g, '');
    const n = num(o.amount), isMyr = !cur || cur === 'MYR' || cur === 'RM';
    const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
    return {
      isReceipt: o.isReceipt !== false,
      kind: KINDS.includes(o.kind) ? o.kind : '',
      merchant: str(o.merchant, 60),
      date: validIso(o.date),
      amount: n && isMyr ? n.toFixed(2) : '',
      foreign: n && !isMyr ? { code: cur, amount: n } : null,
      receiptNo: str(o.receiptNo, 24),
      litres: (() => { const l = num(o.litres); return l > 0 && l < 300 ? Math.round(l * 1000) / 1000 : null; })(),       // fuel only: for the carbon of business travel
      fuelType: /^(petrol|diesel)$/.test(String(o.fuelType || '').toLowerCase()) ? String(o.fuelType).toLowerCase() : '',
      confidence: ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'medium',
      notes: str(o.notes, 160),
    };
  }

  /* Claude's reading as the line's reading (the same shape the reader on this PC gives), with the category from what Claude says it is */
  function asReading(c) {
    const r = merge({}, c, []).r;
    if (c.kind === 'Other' && !r.category) r.category = 'Other';
    return r;
  }
  /* is Claude's reading good enough to use as it is: an amount and a date, Claude is not unsure, and nothing about it looks wrong */
  function clean(c, ctx) {
    if (!c || !c.isReceipt || c.confidence === 'low' || !c.date || !(c.amount || c.foreign)) return false;
    const cat = ['Medical', 'Parking', 'Accommodation', 'AI tools'].includes(c.kind) ? c.kind : (c.kind === 'Other' ? 'Other' : 'Petrol');
    return doubts({ amount: c.amount, foreign: c.foreign, date: c.date, station: c.merchant }, Object.assign({}, ctx, { category: cat })).length === 0;
  }

  /* the normal reading + Claude's -> the reading to use, and a sentence saying what happened (shown on the line) */
  /* When the two readers disagree, Claude's reading wins: it looks at the photo itself, where this PC reads letters it recognised first
     (29OCT read as 02OCT, "Invoice" read as a shop called "Involece"). The field is then marked for review (out.review), never changed silently. */
  const NAME_WORDS = (s) => String(s || '').toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 4 && !/^(SDN|BHD|ENTERPRISE|TRADING|STATION|PETROL|SERVICE|SERVICES|STESEN|MINYAK|BERHAD)$/.test(w));
  const sameName = (a, b) => { const wa = NAME_WORDS(a), wb = NAME_WORDS(b); return wa.some((w) => wb.some((v) => v.startsWith(w) || w.startsWith(v))); };
  function merge(ocr, c, why) {
    const out = Object.assign({}, ocr), notes = [], review = [];
    if (c.amount) {
      if (ocr.amount && Math.abs(parseFloat(ocr.amount) - parseFloat(c.amount)) < 0.005) notes.push(`Claude agrees with RM${c.amount}.`);
      else { if (ocr.amount) { notes.push(`Amount was RM${ocr.amount}, now RM${c.amount}.`); review.push('amount'); } out.amount = c.amount; out.sure = null; out.foreign = null; }
    } else if (c.foreign && !ocr.amount) { out.foreign = c.foreign; }
    if (c.date && c.date !== ocr.date) { if (ocr.date) { notes.push(`Date was ${ocr.date}, now ${c.date}.`); review.push('date'); } out.date = c.date; }
    // the name: Claude's spelling (this PC's may be garbled, "Tram Wawasan Er Terprise"); the claim tool then matches it to a name saved before. A different shop is marked for review
    if (c.merchant && out.station !== c.merchant) { if (out.station && !sameName(out.station, c.merchant)) review.push('name'); out.station = c.merchant; }
    const hex = /^[0-9a-f]{6}$/i.test(String(c.receiptNo || '').trim()) ? String(c.receiptNo).trim().toLowerCase() : '';
    const cNo = hex || String(c.receiptNo || '').trim(), key = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    // the number: where the two differ, Claude's reading is used (a six-character code, or the slip's own Invoice # / Transaction number), marked for review
    if (cNo && key(out.receiptNo) !== key(cNo)) { if (out.receiptNo) { notes.push(`Receipt number was ${out.receiptNo}, now ${cNo}.`); review.push('receiptNo'); } out.receiptNo = cNo; out.invoiceDoubt = false; }
    else if (cNo && key(cNo) === key(out.receiptNo)) out.invoiceDoubt = false;
    if (!out.category && c.kind && c.kind !== 'Petrol' && KINDS.includes(c.kind)) out.category = c.kind;          // a meal, a clinic, a hotel ... (a photo starts as Petrol)
    if (!out.litres && c.litres) { out.litres = c.litres; out.fuelType = c.fuelType || 'petrol'; }
    out.found = !!(out.date || out.amount || out.foreign || out.station || out.receiptNo);
    if (review.length) out.review = review;
    return { r: out, note: notes.join(' ') };
  }

  /* ---------- the call ---------- */
  const SYSTEM = `You read one photo of a receipt for a Malaysian company's monthly expense claim and answer with ONLY one JSON object, no other text.
{"isReceipt": true or false, "kind": "Petrol" | "Medical" | "Parking" | "Accommodation" | "AI tools" | "Meals" | "Travel" | "Transport" | "Online shopping" | "Supplier invoice" | "Other", "merchant": "shop, station, clinic or hotel name as printed", "date": "YYYY-MM-DD", "amount": number, "currency": "MYR", "receiptNo": "the receipt, invoice or transaction number", "litres": number or null, "fuelType": "petrol" | "diesel" | null, "confidence": "high" | "medium" | "low", "notes": "one short sentence, only if something is unclear"}
Rules:
- merchant: on a fuel slip that starts with a brand (PETRONAS, SHELL, CALTEX), the dealer's name on the next line (for example KEJAYAAN TEGUH ENT), never the brand alone.
- receiptNo: the document's own number. Petronas and some Caltex slips print "Invoice No" with six characters, 0-9 and a-f (for example 60770c, 1b0eb6, 00b360): that is it. Otherwise the value after "Invoice #", "Receipt No" or "Bill No"; a slip with none of those (many Caltex slips): its "Transaction number". Never the site, STAN, pump, POS, terminal, approval, company registration (Co. No) or phone number. null only when the slip prints no number at all (only a QR code).
- kind: software, apps, subscriptions, domain names and web hosting are "AI tools". "Supplier invoice" only for a supplier billing the company on an invoice with terms, a due date or a PO; small items paid for at a shop counter (hardware, supplies) are "Online shopping".
- litres and fuelType: only on a fuel receipt, the litres pumped as printed (for example 40.835) and whether it is petrol (RON95, RON97, Primax, V-Power, Techron) or diesel; null on any other receipt.
- If the photo is a phone screenshot of an e-invoice page, read it the same way (invoice number, date, shop, total).
- amount is the FINAL amount actually paid. A fuel receipt with a Budi95 or other subsidy: the TOTAL after the subsidy, never the item line before it. Cash given and change are never the amount. A hotel bill: the SUB TOTAL, never the deposit. A clinic receipt: the amount paid (it may be written in words). MBSJ Flexi Parking: the Payment line.
- currency is the currency printed beside the amount (MYR for RM). Never convert.
- Dates in Malaysia are day/month/year. Use null for any field you cannot read; never guess a number.
- If the photo is not a receipt at all (a form, a certificate, a person, a screen), set isReceipt to false and say what it is in notes.`;
  const costRM = (m, u) => { const p = MODELS[m]; return p && u ? ((u.input_tokens || 0) * p.inUsd + (u.output_tokens || 0) * p.outUsd) / 1e6 * RM_PER_USD : 0; };

  // the photo shrunk to what Claude needs (long side 1568 px, JPEG): smaller to send, cheaper to read
  async function prepare(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }
  async function post(body, key) {
    const send = (b) => fetch(API_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': VERSION, 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify(b) });
    let res = await send(body);
    if (res.status === 400) {           // a model that does not take the effort setting: ask again without it
      const j = await res.clone().json().catch(() => ({}));
      if (/effort|output_config/i.test(JSON.stringify(j))) { const b2 = Object.assign({}, body); delete b2.output_config; res = await send(b2); }
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error((j.error && j.error.message) || ('HTTP ' + res.status)); e.status = res.status; throw e; }
    return j;
  }
  /* the same question, asked through the company inbox: it answers with Claude's reading (content, stop_reason, usage) or says why not */
  async function relay(body, action) {
    const res = await fetch(team.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: action || 'claude', request: body }) });
    const j = await res.json().catch(() => null);
    if (!j || !j.ok) { const e = new Error((j && j.error) || 'The company Claude connection did not answer.'); e.status = j && j.code; e.team = true; throw e; }
    return j.reply;
  }
  /* one photo -> { reading, usage, costRM } ; throws with .status on an API problem. ctx._data lets a test hand in the photo already prepared */
  async function read(file, ctx) {
    const key = apiKey(); if (!key && !team.on) throw new Error('No Claude key saved.');
    const data = (ctx && ctx._data) || await prepare(file), m = model();
    const body = {
      model: m, max_tokens: 2000, system: SYSTEM, output_config: { effort: 'low' },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
        { type: 'text', text: `Today is ${(ctx && ctx.today) || new Date().toISOString().slice(0, 10)}.${ctx && ctx.month ? ` The claim is for ${ctx.month}.` : ''} Read this receipt.` }] }],
    };
    const k = await answerKey(body, key ? 'own' : 'claude'), known = remembered(k);
    let j = known, rm = 0;
    if (known) saved++;
    else { calls++; j = await (key ? post(body, key) : relay(body)); }
    if (j.stop_reason === 'refusal') throw new Error('Claude declined to read this photo.');
    const reading = parseReply((j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
    if (!reading) throw new Error('Claude answered, but not in a form the tool could read.');
    if (!known) { rm = costRM(key ? m : (MODELS[j.model] ? j.model : m), j.usage); addSpend(rm); remember(k, j); }
    return { reading, usage: known ? null : j.usage, costRM: rm, remembered: !!known };
  }
  /* any request to Claude, with the saved key or through the company inbox (action: 'claude' for the photo check, 'scan' for the receipt scanner).
     Counts towards the per-visit limit and the cost shown in the Claude panel. */
  async function send(body, action) {
    const key = apiKey(); if (!key && !team.on) throw new Error('No Claude key saved.');
    const k = await answerKey(body, (key ? 'own:' : '') + (action || 'claude')), known = remembered(k);
    if (known) { saved++; return Object.assign({ remembered: true }, known); }        // the same file, read before: free
    if (calls >= MAX_CALLS) throw new Error('Claude has read enough files for one visit. Reload the page to read more.');
    calls++;
    const j = key ? await post(body, key) : await relay(body, action);
    addSpend(costRM(MODELS[j.model] ? j.model : body.model, j.usage));
    remember(k, j);
    return j;
  }
  // a one-word question: does the key work with this model?
  async function test() {
    const key = apiKey(); if (!key) throw new Error('No Claude key saved.');
    const t0 = Date.now(), m = model();
    const j = await post({ model: m, max_tokens: 200, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Reply with the single word: ready' }] }, key);
    const rm = costRM(m, j.usage); addSpend(rm);
    return { ok: true, model: m, ms: Date.now() - t0, costRM: rm };
  }
  // what Claude has cost this month on this PC (an estimate from the token counts), the last test of the key, and the state of the connection
  const monthKey = () => new Date().toISOString().slice(0, 7);
  function spend() { try { const o = JSON.parse(ls.get(SPEND) || '{}'); return o.m === monthKey() ? (+o.rm || 0) : 0; } catch (e) { return 0; } }
  function addSpend(rm) { if (rm > 0) ls.set(SPEND, JSON.stringify({ m: monthKey(), rm: spend() + rm })); }
  const resetSpend = () => ls.set(SPEND, '');
  function tested() { try { return JSON.parse(ls.get(TESTED) || 'null'); } catch (e) { return null; } }
  const tail = () => apiKey().slice(-4);
  // 'none' no key, 'off' switched off, 'saved' key not tested (with this model), 'ok' last test passed, 'bad' last test failed
  function state() {
    if (!apiKey()) return team.on ? (mode() === 'off' ? 'off' : 'team') : 'none';        // 'team': connected through the company
    if (mode() === 'off') return 'off';
    const t = tested();
    if (!t || t.tail !== tail() || t.model !== model()) return 'saved';
    return t.ok ? 'ok' : 'bad';
  }
  async function runTest() {
    try { const r = await test(); ls.set(TESTED, JSON.stringify({ ok: true, at: Date.now(), ms: r.ms, model: r.model, tail: tail() })); return r; }
    catch (e) { ls.set(TESTED, JSON.stringify({ ok: false, at: Date.now(), msg: explain(e), model: model(), tail: tail() })); throw e; }
  }
  function explain(e) {
    const m = (e && e.message) || String(e), st = e && e.status;
    if (e && e.team) return /limit for today/i.test(m) ? "The company's Claude limit for today is used up, so this computer reads the photo instead." : m;       // the inbox already speaks plainly
    if (st === 401 || /invalid x-api-key|authentication/i.test(m)) return 'Anthropic rejected the key. Check that you pasted the whole key (it starts with sk-ant-).';
    if (st === 403 || /permission/i.test(m)) return 'This key is not allowed to use that model. Pick another model, or check the key in the Anthropic Console.';
    if (st === 404) return 'That model is not available to this key. Pick another model.';
    if (st === 429 || /credit|billing|balance/i.test(m)) return /credit|billing|balance/i.test(m) ? 'The API account has no credit left. Check Billing in the Anthropic Console.' : 'Too many requests just now. Wait a minute and try again.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Could not reach Anthropic. Check the internet connection.';
    return m;
  }

  return { send, savedCount: () => saved, worthAsking, doubts, parseReply, merge, asReading, clean, read, test, runTest, explain, available, first, mode, setMode, spend, addSpend, resetSpend, tested, state, apiKey, model, useTeam, teamOn: () => team.on, MODELS, KEY, MODEL, DEFAULT_MODEL, KINDS, SYSTEM, costRM,
    setKey: (v) => ls.set(KEY, v), setModel: (v) => ls.set(MODEL, v), resetCalls: () => { calls = 0; } };
});
