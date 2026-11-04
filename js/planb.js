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
  const KEY = 'wfc-claude-key', MODEL = 'wfc-claude-model', DEFAULT_MODEL = 'claude-sonnet-5-5';
  const MODELS = {                      // $ per million tokens, in / out
    'claude-sonnet-5-5': { label: 'Sonnet 5.5 (recommended)', inUsd: 2, outUsd: 10 },
    'claude-haiku-5-5': { label: 'Haiku 5.5 (cheapest)', inUsd: 0.1, outUsd: 0.5 },
    'claude-opus-5-5': { label: 'Opus 5.5 (smartest)', inUsd: 4, outUsd: 20 },
  };
  const KINDS = ['Petrol', 'Medical', 'Parking', 'Accommodation', 'AI tools', 'Other'];
  const MAX_CALLS = 30;                 // per page visit: a pile of unreadable photos cannot run up a bill
  let calls = 0;

  /* ---------- the saved key (this browser only) ---------- */
  const ls = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* private window */ } },
  };
  const apiKey = () => ls.get(KEY);
  const model = () => (MODELS[ls.get(MODEL)] ? ls.get(MODEL) : DEFAULT_MODEL);
  const available = () => !!apiKey() && calls < MAX_CALLS;

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
    if (!r.date) out.push('no date found');
    else {
      const t = Date.parse(r.date + 'T12:00:00Z');
      if (t > today + 2 * DAY) out.push(`the date (${r.date}) looks wrong`);
      else if (t < today - 120 * DAY) out.push(`the date (${r.date}) looks wrong`);
    }
    return out;
  }

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
      confidence: ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'medium',
      notes: str(o.notes, 160),
    };
  }

  /* the normal reading + Claude's -> the reading to use, and a sentence saying what happened (shown on the line) */
  function merge(ocr, c, why) {
    const out = Object.assign({}, ocr), notes = [], hadDateDoubt = (why || []).some((w) => /date|wrong/.test(w));
    if (c.amount) {
      if (ocr.amount && Math.abs(parseFloat(ocr.amount) - parseFloat(c.amount)) < 0.005) notes.push(`Claude agrees with RM${c.amount}.`);
      else { if (ocr.amount) notes.push(`Amount was RM${ocr.amount}, now RM${c.amount}.`); out.amount = c.amount; out.sure = null; out.foreign = null; }
    } else if (c.foreign && !ocr.amount) { out.foreign = c.foreign; }
    if (c.date && (!ocr.date || hadDateDoubt)) { if (ocr.date && ocr.date !== c.date) notes.push(`Date was ${ocr.date}, now ${c.date}.`); out.date = c.date; }
    if (!out.station && c.merchant) out.station = c.merchant;
    if (!out.receiptNo && c.receiptNo) out.receiptNo = c.receiptNo;
    if (!out.category && ['Medical', 'Parking', 'Accommodation', 'AI tools'].includes(c.kind)) out.category = c.kind;
    out.found = !!(out.date || out.amount || out.foreign || out.station || out.receiptNo);
    return { r: out, note: notes.join(' ') };
  }

  /* ---------- the call ---------- */
  const SYSTEM = `You read one photo of a receipt for a Malaysian company's monthly expense claim and answer with ONLY one JSON object, no other text.
{"isReceipt": true or false, "kind": "Petrol" | "Medical" | "Parking" | "Accommodation" | "AI tools" | "Other", "merchant": "shop, station, clinic or hotel name as printed", "date": "YYYY-MM-DD", "amount": number, "currency": "MYR", "receiptNo": "the receipt, invoice or transaction number", "confidence": "high" | "medium" | "low", "notes": "one short sentence, only if something is unclear"}
Rules:
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
  /* one photo -> { reading, usage, costRM } ; throws with .status on an API problem */
  async function read(file, ctx) {
    const key = apiKey(); if (!key) throw new Error('No Claude key saved.');
    calls++;
    const data = await prepare(file), m = model();
    const j = await post({
      model: m, max_tokens: 2000, system: SYSTEM, output_config: { effort: 'low' },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
        { type: 'text', text: `Today is ${(ctx && ctx.today) || new Date().toISOString().slice(0, 10)}.${ctx && ctx.month ? ` The claim is for ${ctx.month}.` : ''} Read this receipt.` }] }],
    }, key);
    if (j.stop_reason === 'refusal') throw new Error('Claude declined to read this photo.');
    const reading = parseReply((j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
    if (!reading) throw new Error('Claude answered, but not in a form the tool could read.');
    return { reading, usage: j.usage, costRM: costRM(m, j.usage) };
  }
  // a one-word question: does the key work with this model?
  async function test() {
    const key = apiKey(); if (!key) throw new Error('No Claude key saved.');
    const t0 = Date.now(), m = model();
    const j = await post({ model: m, max_tokens: 200, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Reply with the single word: ready' }] }, key);
    return { ok: true, model: m, ms: Date.now() - t0, costRM: costRM(m, j.usage) };
  }
  function explain(e) {
    const m = (e && e.message) || String(e), st = e && e.status;
    if (st === 401 || /invalid x-api-key|authentication/i.test(m)) return 'Anthropic rejected the key. Check that you pasted the whole key (it starts with sk-ant-).';
    if (st === 403 || /permission/i.test(m)) return 'This key is not allowed to use that model. Pick another model, or check the key in the Anthropic Console.';
    if (st === 404) return 'That model is not available to this key. Pick another model.';
    if (st === 429 || /credit|billing|balance/i.test(m)) return /credit|billing|balance/i.test(m) ? 'The API account has no credit left. Check Billing in the Anthropic Console.' : 'Too many requests just now. Wait a minute and try again.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Could not reach Anthropic. Check the internet connection.';
    return m;
  }

  return { doubts, parseReply, merge, read, test, explain, available, apiKey, model, MODELS, KEY, MODEL, DEFAULT_MODEL, KINDS, SYSTEM, costRM,
    setKey: (v) => ls.set(KEY, v), setModel: (v) => ls.set(MODEL, v), resetCalls: () => { calls = 0; } };
});
