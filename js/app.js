/* WFC Claim Builder - everything runs in the browser; files are never uploaded. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const pad = (n) => String(n).padStart(2, '0');
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // file-name style the team already uses: WFC - JUNE Claim form
  const MONTH_TAG = ['JAN', 'FEB', 'MAR', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const CATEGORIES = ['Petrol', 'AI tools', 'Accommodation', 'Medical', 'Parking', 'Toll', 'Meals', 'Stationery', 'Travel', 'Transport', 'Online shopping', 'Supplier invoice', 'Other'];
  const round2 = TNG.round2;
  const money = ClaimPdf.money;

  // (the PDF reader, PDF maker, zip maker and form templates are loaded after the page is up: see js/lazy.js)

  /* ---------- tiny helpers ---------- */
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      const v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'value' || k === 'checked' || k === 'disabled') e[k] = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach((c) => { if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c)); });
    return e;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const uid = (() => { let n = 0; const t = Date.now().toString(36); return () => 'i' + t + (++n); })();
  const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const safe = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
  const ext = (name) => ((name.match(/\.([A-Za-z0-9]+)$/) || [, 'jpg'])[1]).toLowerCase();
  const sizeText = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  /* ---------- settings + state ---------- */
  const DEFAULTS = {
    claimant: '', signature: '', fromEmail: '', toEmail: 'agnes@yutech.com.my',      // the accountant; anyone can type over it
    toName: '', signoff: '', ocr: true, holidays: TNG.DEFAULT_HOLIDAYS,
    gmailClientId: '561844027130-njr633b0hh2d5mciu0o8r0be6plrovt7.apps.googleusercontent.com',      // the team's Google client ID (public, not a secret), so nobody has to paste it in Settings
    msClientId: '',      // the team's Microsoft application (client) ID (public, not a secret): paste it here once the app is registered - see the README
    dashApi: 'https://script.google.com/macros/s/AKfycbxMR5cSfFwSgI4D0SWcdwzyle9ardosITFVmX5c3fn0a22eW9XnqrXURVs1VFPHWNcF/exec',          // the accountant's dashboard (the WFC Claims inbox on Google). Empty = email only. Built in, so nobody has to paste it
    sendDash: true,
  };  const cfg = Object.assign({}, DEFAULTS, store.get('wfc-claim-cfg', {}));
  cfg.fromEmail = ''; cfg.toEmail = DEFAULTS.toEmail;      // ignore anything an earlier version saved
  const gmailClientId = () => String(cfg.gmailClientId || DEFAULTS.gmailClientId || '').trim();
  const dashApi = () => String(cfg.dashApi || DEFAULTS.dashApi || '').trim();
  // the demo launcher opens this page with ?dash=http://localhost:8787/api. Only a localhost address is accepted, so a link from someone else can never point claims at another server
  (function () {
    const q = new URLSearchParams(location.search).get('dash');
    if (q && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/api$/.test(q)) { cfg.dashApi = q; store.set('wfc-claim-cfg', Object.assign({}, cfg, { fromEmail: '', toEmail: '' })); }
    if (q) history.replaceState(null, '', location.pathname + location.hash);
  })();
  // who the email is from and who gets it are chosen fresh on every visit: sender blank (pick from the list), receiver the accountant
  const saveCfg = () => store.set('wfc-claim-cfg', Object.assign({}, cfg, { fromEmail: '', toEmail: '' }));

  const S = {
    tng: null, overrides: new Map(), other: [], edits: { toll: {}, parking: {} },     // edits = values typed over the calculated toll / parking line
    showTrips: false, showErrors: false, packs: { claim: null, leave: null }, inputs: [],
    step: 1, building: false, stepEls: null,
    user: Auth.get(),       // who signed in on the login page ({ provider: 'google' | 'microsoft' | 'none', email, name }); null = not yet. Kept for this tab, or for this device when "Keep me signed in" was ticked (js/auth.js)
    open: new Map(), lineRefs: new Map(),      // open = lines whose details were opened or closed by hand; lineRefs = each drawn line's refresh function
    touched: { subject: false, body: false, month: false, lName: false, lSign: false, lTo: false, lSubject: false, lBody: false },
  };

  /* ---------- month helpers ---------- */
  function monthParts() {
    const m = $('#month').value;
    return /^\d{4}-\d{2}$/.test(m) ? { y: +m.slice(0, 4), m: +m.slice(5, 7), key: m } : null;
  }
  const monthLabel = (mp) => (mp ? `${MONTH_NAMES[mp.m - 1]} ${mp.y}` : '');
  const monthEndIso = (mp) => new Date(Date.UTC(mp.y, mp.m, 0)).toISOString().slice(0, 10);

  /* ---------- toll view ---------- */
  function tollView() {
    if (!S.tng) return null;
    const mp = monthParts();
    const holidays = TNG.parseHolidays(cfg.holidays);
    const rows = TNG.classify(S.tng.rows, {
      month: mp && mp.key,
      holidays,
      daysOff: TNG.parseDaysOff($('#daysOff').value, mp ? mp.y : new Date().getFullYear()),
    });
    rows.forEach((r) => {
      r.auto = r.include;
      if (S.overrides.has(r.no)) { r.include = S.overrides.get(r.no); r.overridden = true; }
    });
    return { rows, toll: TNG.sum(rows, 'TOLL'), parking: TNG.sum(rows, 'PARKING'),
      holidayYears: new Set(Array.from(holidays.keys()).map((d) => d.slice(0, 4))) };
  }

  /* ---------- claim lines ---------- */
  function compileLines() {
    const tv = tollView();
    const mp = monthParts();
    const lines = [];
    // order on the claim form and its PDF: fuel, toll, parking, transport, travel, then medical, AI tools, accommodation, everything else
    const RANK = { fuel: 0, toll: 1, parking: 2, transport: 3, travel: 4, medical: 5, ai: 6, stay: 7 };
    const rankOf = (cat) => { const k = kindOf(cat); return k in RANK ? RANK[k] : 8; };
    S.other.forEach((o) => lines.push({ key: o.id, rank: rankOf(o.category), kind: 'other', src: o, category: o.category, date: o.date, name: o.name, receiptNo: o.receiptNo, amount: o.amount, litres: o.litres || null, fuel: o.fuel || '', files: o.files.map((x) => x.file) }));
    // toll / parking are calculated from the ticked trips, but every field can be typed over (S.edits)
    if (tv && tv.toll > 0 && mp) lines.push(Object.assign({ key: 'toll', rank: 1, kind: 'toll', category: 'Toll', date: monthEndIso(mp), name: "Touch 'n Go", receiptNo: S.tng.header.serial, amount: tv.toll, calc: tv.toll, files: [S.tng.file] }, S.edits.toll));
    if (tv && tv.parking > 0 && mp) lines.push(Object.assign({ key: 'parking', rank: 2, kind: 'parking', category: 'Parking', date: monthEndIso(mp), name: "Touch 'n Go", receiptNo: S.tng.header.serial, amount: tv.parking, calc: tv.parking, files: [S.tng.file] }, S.edits.parking));
    return { lines, tv };
  }
  const sortedForBuild = (lines) => lines.slice().sort((a, b) => a.rank - b.rank || (a.date || '').localeCompare(b.date || ''));
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const lineTotal = (lines) => round2(lines.reduce((a, l) => a + num(l.amount), 0));

  /* ---------- rendering: claim lines ---------- */
  function field(label, cls, input) { return h('label', { class: 'f ' + cls }, h('span', { text: label }), input); }

  function bound(obj, key, type, extra) {
    const i = h('input', Object.assign({ type, value: obj[key] == null ? '' : obj[key], autocomplete: 'off' }, extra || {}));
    i._obj = obj; i._key = key;
    if (obj.auto && obj.auto[key]) i.classList.add('guess');     // filled by the app: amber until the person edits it
    i.addEventListener('input', () => {
      obj[key] = i.value;
      if (obj.auto) delete obj.auto[key];
      if (obj.review && obj.review.includes(key)) obj.review = obj.review.filter((k) => k !== key);
      if (obj.orig && key in obj.orig) { obj.fixed = obj.fixed || {}; obj.fixed[key] = i.value; }      // a correction to what the app filled in
      i.classList.remove('guess', 'bad');
      if (key === 'name' && /petrol|fuel/i.test(obj.category || '')) store.set('wfc-last-station', i.value);
      updateSummary();
    });
    if (key === 'name') i.addEventListener('change', () => { if (/petrol|fuel/i.test(obj.category || '')) rememberStation(i.value); });
    S.inputs.push(i);
    return i;
  }

  /* a file chip; with onRemove it gets a small x beside it */
  function chip(file, url, onRemove) {
    const isImg = /^image\//.test(file.type);
    const a = h('a', { class: 'chip', href: url, target: '_blank', rel: 'noopener', title: file.name },
      isImg ? h('img', { src: url, alt: '' }) : h('i', { text: 'PDF' }), h('span', { text: file.name }));
    if (!onRemove) return a;
    return h('span', { class: 'chipbox' }, a,
      h('button', { class: 'icon sm', type: 'button', title: 'Remove this file', 'aria-label': 'Remove file ' + file.name, text: '×', onclick: onRemove }));
  }

  function removeOther(o) { o.files.forEach((x) => URL.revokeObjectURL(x.url)); S.other = S.other.filter((x) => x !== o); renderLines(); refreshStatus(); }

  /* remove one file from a line; a line left with no file goes too (a line typed by hand stays) */
  function removeFile(o, x) {
    URL.revokeObjectURL(x.url);
    o.files = o.files.filter((f) => f !== x);
    if (!o.files.length && !o.manual) S.other = S.other.filter((y) => y !== o);
    renderLines(); refreshStatus();
  }

  /* the toll and parking lines both come from the one TNG statement, so removing either removes the statement and both lines */
  function removeTng() {
    if (!S.tng) return;
    URL.revokeObjectURL(S.tng.url);
    S.tng = null; S.overrides.clear(); S.edits = { toll: {}, parking: {} }; S.showTrips = false;
    renderLines(); refreshStatus();
  }

  /* start over: every line and file off this page (the originals on the PC are not touched) */
  function clearAll(silent) {
    if (silent !== true && !window.confirm('Remove every line and file from this page?\n\nYour original files on this PC are not touched.')) return;
    S.other.forEach((o) => o.files.forEach((x) => URL.revokeObjectURL(x.url)));
    if (S.tng) URL.revokeObjectURL(S.tng.url);
    S.other = []; S.tng = null; S.overrides.clear(); S.edits = { toll: {}, parking: {} }; S.showTrips = false; S.open.clear();
    renderLines(); refreshStatus();
  }

  /* ---------- an unfinished claim survives a refresh ---------- */
  // what is kept: the form boxes, the TNG statement, every line with its files, the ticks and typed-over amounts, and the step you were on
  function draftSnapshot() {
    if (S.restoring) return undefined;                       // still putting the old draft back: do not overwrite it
    if (!S.tng && !S.other.length) return null;              // nothing to keep
    return {
      v: 1, savedAt: Date.now(), step: S.step, touchedMonth: !!S.touched.month,
      form: { month: $('#month').value, claimant: $('#claimant').value, signature: $('#signature').value, daysOff: $('#daysOff').value },
      tng: S.tng ? { file: S.tng.file } : null, overrides: Array.from(S.overrides), edits: S.edits,
      other: S.other.map((o) => ({ id: o.id, kind: o.kind, manual: !!o.manual, category: o.category || '', name: o.name || '', date: o.date || '', receiptNo: o.receiptNo || '',
        amount: o.amount == null ? '' : String(o.amount), auto: Object.assign({}, o.auto), hint: o.hint || '', planB: o.planB || '', bal: o.bal || null, fx: o.fx || null, litres: o.litres || null, fuel: o.fuel || '',
        invoiceNo: o.invoiceNo || '', ocr: o.ocr || '', askedClaude: !!o.askedClaude, scan: o.scan || null, review: o.review || [], orig: o.orig || null, fixed: o.fixed || null, pastOk: o.pastOk || '', walletId: o.walletId || '',
        files: o.files.map((x) => x.file) })),
    };
  }
  const keepDraft = () => { if (!S.restoring) Draft.schedule(draftSnapshot); };
  async function restoreDraft() {
    const d = await Draft.load();
    if (!d || (!d.tng && !(d.other && d.other.length))) { S.restoring = false; return; }
    S.restoring = true;
    try {
      if (d.tng && d.tng.file) await onTng([d.tng.file]);
      const f = d.form || {};
      if (f.month) $('#month').value = f.month;
      if (f.claimant) { $('#claimant').value = f.claimant; cfg.claimant = f.claimant; }
      if (f.signature != null) $('#signature').value = f.signature;
      if (f.daysOff != null) $('#daysOff').value = f.daysOff;
      S.touched.month = !!d.touchedMonth;
      if (d.tng) { S.overrides = new Map(d.overrides || []); S.edits = d.edits || { toll: {}, parking: {} }; }
      S.other = (d.other || []).map((o) => Object.assign({}, o, { files: (o.files || []).map((file) => ({ file, url: URL.createObjectURL(file) })) }));
      S.restoring = false;
      renderLines(); refreshStatus(); go(Math.min(d.step || 1, 3), true);
      // photos that were still being read when the page closed are read again
      S.other.filter((o) => o.ocr === 'queued' || o.ocr === 'reading').forEach((o) => { o.ocr = 'queued'; if (cfg.ocr || PlanB.available()) readPhoto(o); });
      const bar = $('#resumeBar');
      bar.querySelector('span').textContent = `Your unfinished claim from ${new Date(d.savedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${new Date(d.savedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} is back.`;
      bar.hidden = false;
    } catch (e) { console.warn('Could not put the draft back', e); }
    S.restoring = false;
  }
  // Start over: the page as it was on the first visit (the claimant name stays, it is remembered anyway)
  function startOver() {
    if (!window.confirm('Start again from the beginning?\n\nThis clears the expense claim and the leave application on this page, and the copy kept on this device. Your original files are not touched.')) return;
    Draft.cancel(); clearAll(true);
    const now = new Date(), last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    $('#month').value = `${last.getFullYear()}-${pad(last.getMonth() + 1)}`; S.touched.month = false; $('#daysOff').value = '';
    S.packs.claim = null; renderPack('claim');
    $('#fileNotes').textContent = ''; $('#rejects').textContent = ''; $('#resumeBar').hidden = true;
    resetLeave();
    Draft.clear(); go(1); renderLines(); refreshStatus();
  }

  /* the leave application as on the first visit: no dates, reason or MC, type Annual, signed today, the name carried over from the claim */
  function resetLeave() {
    S.mc.forEach((m) => URL.revokeObjectURL(m.url)); S.mc = []; renderMc();
    ['#lFrom', '#lTo', '#lReason'].forEach((id) => { const e = $(id); e.value = ''; e.classList.remove('guess'); });
    $('#lType').value = 'annual';
    Object.assign(S.touched, { lName: false, lSign: false, lTo: false, lSubject: false, lBody: false });
    $('#lName').value = $('#claimant').value; $('#lSign').value = $('#signature').value;
    $('#lSignDate').value = localIso(new Date());
    $('#mcNotes').textContent = ''; $('#lNotes').textContent = '';
    S.packs.leave = null; renderPack('leave');
    refreshLeaveEmail(); markNeededLeave();
  }

  function mergeInto(item, target) {
    target.files.push(...item.files);
    if (!target.amount && item.amount) target.amount = item.amount;
    S.other = S.other.filter((x) => x !== item);
    renderLines(); refreshStatus();
  }

  /* ---------- icons: a small drawing for each kind of claim ---------- */
  const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const ICON = {
    fuel: svg('<path d="M3 22h12"/><path d="M4 9h10"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.8a2 2 0 0 0-.6-1.4L18 5"/>'),
    toll: svg('<rect x="2.5" y="8" width="5" height="13" rx="1"/><rect x="7.5" y="11" width="14" height="4" rx="1"/><path d="M12 11v4M16 11v4"/><path d="M2 21h20"/>'),
    parking: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9.5 17V7.5h3.2a2.8 2.8 0 0 1 0 5.6H9.5"/>'),
    medical: svg('<path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/>'),
    ai: svg('<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M19 16v5M16.5 18.5h5"/>'),
    stay: svg('<path d="M3 20V5"/><path d="M3 16h18v4"/><path d="M21 16v-3a3 3 0 0 0-3-3h-7v6"/><circle cx="7" cy="12" r="2"/>'),
    meals: svg('<path d="M6 3v6a3 3 0 0 0 6 0V3"/><path d="M9 3v18"/><path d="M17 21V3c-2.5 1-4 4-4 8h4"/>'),
    stationery: svg('<path d="M4 20l1-5L16 4a2.1 2.1 0 0 1 3 3L8 18z"/><path d="M14 6l3 3"/>'),
    travel: svg('<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>'),
    transport: svg('<path d="M5 17h14v-5l-1.8-4.6A2 2 0 0 0 15.3 6H8.7a2 2 0 0 0-1.9 1.4L5 12z"/><path d="M5 12h14"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/>'),
    shopping: svg('<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>'),
    supplier: svg('<path d="M3 7h11v10H3z"/><path d="M14 10h4l3 3v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>'),
    other: svg('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'),
  };
  const KIND_LABEL = { fuel: 'Fuel', toll: 'Toll', parking: 'Parking', medical: 'Medical', ai: 'AI tools', stay: 'Accommodation', meals: 'Meals', stationery: 'Stationery',
    travel: 'Travel', transport: 'Transport', shopping: 'Online shopping', supplier: 'Supplier invoice', other: 'Other' };
  const kindOf = (cat) => {
    const c = String(cat || '');
    return /transport|grab|e-?hailing|taxi/i.test(c) ? 'transport' : /travel|flight|air\s?ticket|airfare|\btrains?\b|bus\s?ticket|ferry/i.test(c) ? 'travel'
      : /online|shopping|shopee|lazada/i.test(c) ? 'shopping' : /supplier|purchase/i.test(c) ? 'supplier'
      : /petrol|fuel/i.test(c) ? 'fuel' : /toll/i.test(c) ? 'toll' : /parking/i.test(c) ? 'parking'
      : /medical|klinik|clinic|pharmac|farmasi/i.test(c) ? 'medical' : /\bai\b|software|subscription|saas/i.test(c) ? 'ai'
        : /accommodation|hotel/i.test(c) ? 'stay' : /meal|food|lunch|dinner|makan/i.test(c) ? 'meals' : /stationer|office suppl/i.test(c) ? 'stationery' : 'other';
  };
  function iconEl(kind, cls) { const e = h('span', { class: `${cls} k-${kind}` }); e.innerHTML = ICON[kind]; return e; }   // ICON is fixed markup above, never user text

  /* ---------- what each line says in plain words ---------- */
  const FIELD_WORD = { category: 'type', date: 'date', name: 'name', receiptNo: 'receipt no.', amount: 'amount' };
  const plainList = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
  const isBlank = (o, k) => (k === 'amount' ? !(num(o[k]) > 0) : !String(o[k] || '').trim());
  const niceDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${+m[3]} ${MONTH_NAMES[+m[2] - 1].slice(0, 3)} ${m[1]}` : ''; };

  /* level: wait (still reading the photo) | bad (something required is empty) | warn (filled in by the app, please check) | ok */
  // the same purchase twice (an invoice and its payment slip, or one slip photographed again): the same amount and date, and the same
  // receipt no. or seller. Only a warning: the person attaches one to the other ("Same receipt as another line?") or removes it.
  const sellerKey = (s) => String(s || '').toLowerCase().replace(/\b(sdn|bhd|berhad|enterprise|ent|trading|the)\b/g, '').replace(/[^a-z0-9]/g, '');
  const noKey = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  function twinOf(o) {
    const a = num(o.amount); if (!(a > 0) || !o.date) return null;
    const so = sellerKey(o.name);
    return S.other.find((x) => x !== o && Math.abs(num(x.amount) - a) < 0.005 && x.date === o.date
      && ((noKey(o.receiptNo) && noKey(o.receiptNo) === noKey(x.receiptNo)) || (so.length >= 4 && sellerKey(x.name).length >= 4 && (so.includes(sellerKey(x.name)) || sellerKey(x.name).includes(so))))) || null;
  }
  /* ---------- receipts claimed before: in an earlier saved claim (any month, anyone) ----------
     The claims inbox is asked while the claim is made, a moment after the lines settle, only about lines not asked about yet. It answers the
     month, the status and whether it was this person's claim (never another person's name). Toll and parking lines are not compared (the
     Touch 'n Go card number is the same every month). "Looks right" on the line says it is a different receipt. */
  const PAST = { cache: new Map(), timer: 0, off: false, waitUntil: 0 };
  const PAST_STATUS = { new: 'not checked yet', checked: 'checked', paid: 'paid', question: 'has a question' };
  const pastKey = (o, mp, who) => [mp ? mp.key : '', sellerKey(who), noKey(o.receiptNo), sellerKey(o.name), o.date || '', num(o.amount).toFixed(2)].join('|');
  const pastOpen = (o) => !!(o.past && o.pastOk !== o.past.key);
  function pastText(p) {
    const where = plainList(p.claims.map((c) => `${c.monthLabel} (${c.mine ? 'your claim' : "another person's claim"}${PAST_STATUS[c.status] ? ', ' + PAST_STATUS[c.status] : ''})`));
    return p.check === 'receipt' ? `Claimed before: the same receipt no. is in ${where}` : `Possibly claimed before: the same shop, date and amount are in ${where}`;
  }
  const pastNote = (p) => (p.check === 'receipt' ? 'The same receipt number is on a line of an earlier claim.' : 'A line of an earlier claim has the same shop, date and amount.')
    + ' If it is the same receipt, remove this line. If the receipt number was misread, correct it. If it is a different receipt, press Looks right.';
  function schedulePastCheck() { clearTimeout(PAST.timer); PAST.timer = setTimeout(() => { checkPast().catch((e) => console.warn('Past-claims check failed', e)); }, 1500); }
  async function checkPast() {
    const api = dashApi(), mp = monthParts(), who = $('#claimant').value.trim();
    if (!api || PAST.off || !window.Accounts || !Accounts.seen) return;
    const ready = S.other.filter((o) => o.ocr !== 'queued' && o.ocr !== 'reading' && num(o.amount) > 0 && (noKey(o.receiptNo).length >= 3 || (o.name && o.date)));
    const ask = ready.filter((o) => !PAST.cache.has(pastKey(o, mp, who)));
    if (ask.length && Date.now() >= PAST.waitUntil) {
      try {
        const r = await Accounts.seen(api, { claimant: who, month: mp ? mp.key : '',
          lines: ask.map((o, i) => ({ ref: String(i), category: o.category || '', date: o.date || '', name: o.name || '', receiptNo: o.receiptNo || '', amount: num(o.amount) })) });
        const by = new Map((r.matches || []).map((m) => [m.ref, m]));
        ask.forEach((o, i) => PAST.cache.set(pastKey(o, mp, who), by.get(String(i)) || null));
      } catch (e) {
        if (/unknown action/i.test(e.message || '')) PAST.off = true;          // an inbox that has not been updated yet: nothing to ask
        else PAST.waitUntil = Date.now() + 60000;                              // out of reach: try again in a minute
      }
    }
    let changed = false;
    S.other.forEach((o) => {
      const k = pastKey(o, mp, who), m = ready.includes(o) ? PAST.cache.get(k) : null;
      const now = m ? k : '';
      if ((o.past ? o.past.key : '') !== now) { o.past = m ? Object.assign({ key: k }, m) : null; changed = true; }
    });
    if (changed) { if ($('#lines').contains(document.activeElement)) refreshHeads(); else renderLines(); }       // never pull the box out from under someone typing
  }
  function lineStatus(o, kind) {
    if (kind === 'other' && (o.ocr === 'queued' || o.ocr === 'reading')) return { level: 'wait', text: o.askedClaude ? 'Claude is reading it…' : 'Reading…' };
    const missing = ['category', 'date', 'name', 'amount'].filter((k) => isBlank(o, k));
    if (missing.length) return { level: 'bad', text: 'Please fill in: ' + plainList(missing.map((k) => FIELD_WORD[k])) };
    if (kind === 'other' && pastOpen(o)) return { level: 'warn', text: pastText(o.past) };
    if (kind === 'other' && twinOf(o)) return { level: 'warn', text: 'Possible duplicate: another line has the same amount, date and seller' };
    if (o.review && o.review.length) return { level: 'warn', text: 'Needs review: ' + plainList(o.review.map((k) => FIELD_WORD[k] || k)) };
    const guessed = ['category', 'date', 'name', 'receiptNo', 'amount'].filter((k) => o.auto && o.auto[k]);
    if (guessed.length) return { level: 'warn', text: 'Please check: ' + plainList(guessed.map((k) => FIELD_WORD[k])) };
    const mp = monthParts();
    if (kind === 'other' && mp && o.date.slice(0, 7) !== mp.key) return { level: 'warn', text: `The date is not in ${monthLabel(mp)}` };
    if (kind === 'other' && isBlank(o, 'receiptNo')) return { level: 'warn', text: 'Please check: receipt no.' };
    return { level: 'ok', text: 'Looks right' };
  }
  const statusOf = (l) => lineStatus(l.kind === 'other' ? l.src : l, l.kind);
  const refreshHeads = () => S.lineRefs.forEach((f) => f());

  /* the little menu on the icon: pick the type of claim from a short list */
  let menuWired = false;
  const closeMenus = () => document.querySelectorAll('.catmenu').forEach((m) => m.remove());
  function toggleCatMenu(wrap, o) {
    const was = wrap.querySelector('.catmenu');
    closeMenus();
    if (was) return;
    if (!menuWired) {
      menuWired = true;
      document.addEventListener('click', (e) => { if (!e.target.closest('.catmenu')) closeMenus(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
    }
    wrap.append(h('div', { class: 'catmenu', role: 'menu' }, CATEGORIES.map((c) =>
      h('button', { class: 'menuitem', type: 'button', role: 'menuitem', onclick: () => { closeMenus(); o.category = c; if (o.auto) delete o.auto.category; renderLines(); } }, iconEl(kindOf(c), 'mi'), c))));
  }

  /* One claim line as a card: icon, what and when, the amount, a status in plain words, and the boxes behind "Edit details".
     opt = { key, kind (fixed kinds only), pick, auto, status(), fields, tags, below, onRemove, removeTitle } */
  function lineCard(o, opt) {
    const key = opt.key;
    const badge = h(opt.pick ? 'button' : 'span', opt.pick ? { type: 'button', title: 'Click to change the type', 'aria-label': 'Change the type of this claim' } : {});
    const wrap = h('span', { class: 'badgewrap' }, badge);
    if (opt.pick) badge.addEventListener('click', (e) => { e.stopPropagation(); toggleCatMenu(wrap, o); });
    const lcat = h('b', { class: 'lcat' }), lsub = h('span', { class: 'lsub' }), lamt = h('b', { class: 'lamt' }), status = h('span', { class: 'status' });
    const toggle = h('button', { class: 'link toggle', type: 'button' });
    const details = h('div', { class: 'ldetails' }, opt.fields);
    const setOpen = (on) => { details.hidden = !on; toggle.textContent = on ? 'Hide details' : 'Edit details'; toggle.setAttribute('aria-expanded', String(on)); };
    toggle.addEventListener('click', () => { const on = details.hidden; S.open.set(key, on); setOpen(on); });
    details.addEventListener('input', () => S.open.set(key, true));        // once someone is typing here, keep it open

    const refresh = () => {
      const st = opt.status();
      const kind = opt.kind || kindOf(o.category);
      badge.className = 'badge k-' + kind;
      badge.innerHTML = ICON[kind];
      lcat.textContent = String(o.category || '').trim() || 'New line';
      const name = String(o.name || '').trim(), date = niceDate(o.date);
      lsub.textContent = '';
      lsub.append(name ? name : h('span', { class: 'miss', text: 'no name yet' }), ' · ', date ? date : h('span', { class: 'miss', text: 'no date yet' }));
      lamt.textContent = num(o.amount) > 0 ? 'RM ' + money(num(o.amount)) : 'RM –';
      lamt.classList.toggle('guess', !!(o.auto && o.auto.amount));
      status.className = 'status ' + st.level;
      status.textContent = st.text;
      if (S.showErrors && st.level === 'bad') { S.open.set(key, true); setOpen(true); }
      else if (opt.autoOpen && !S.open.has(key) && st.level === 'bad') setOpen(true);     // only a line typed by hand opens itself (it is empty and waiting); the rest stay folded
    };
    S.lineRefs.set(key, refresh);

    const card = h('div', { class: 'line' + (opt.auto ? ' auto' : ''), 'data-key': key },
      h('div', { class: 'lhead' }, wrap, h('div', { class: 'ltitle' }, lcat, lsub), lamt,
        h('button', { class: 'icon', type: 'button', title: opt.removeTitle, 'aria-label': opt.removeTitle, text: '×', onclick: opt.onRemove })),
      h('div', { class: 'lstat' }, status, opt.tags, toggle),
      details, opt.below);
    setOpen(false);
    refresh();
    if (S.open.has(key)) setOpen(S.open.get(key));
    return card;
  }

  function editableLine(l) {
    const o = l.src;
    const fields = [
      field('Type', 'cat', bound(o, 'category', 'text', { list: 'cats', placeholder: 'e.g. Petrol' })),
      field('Date', 'dt', bound(o, 'date', 'date')),
      field('Name', 'nm', bound(o, 'name', 'text', { placeholder: 'Station / merchant / hotel' })),
      field('Receipt no.', 'rn', bound(o, 'receiptNo', 'text')),
      field('Amount (RM)', 'am', bound(o, 'amount', 'number', { step: '0.01', min: '0', inputmode: 'decimal' })),
    ];
    if (S.other.length > 1) {
      const sel = h('select', { onchange: (e) => { const t = S.other.find((x) => x.id === e.target.value); if (t) mergeInto(o, t); } },
        h('option', { value: '', text: 'Keep as its own line' }),
        S.other.filter((x) => x !== o).map((x) => h('option', { value: x.id, text: `${x.category || 'Line'} · ${x.name || (x.files[0] && x.files[0].file.name) || 'typed line'}`.slice(0, 48) })));
      fields.push(h('label', { class: 'f mg' }, h('span', { text: 'Same receipt as another line? Attach this file to it' }), sel));
    }
    // what Claude said, or what looked odd, lives in the details so the line itself stays tidy (the "Please check" status on top is enough)
    const sc = o.scan;
    const notes = [pastOpen(o) ? pastNote(o.past) : '', o.planB, o.dateWarn].concat(sc ? sc.notes : []).filter(Boolean);
    if (notes.length) fields.push(h('div', { class: 'ainote' }, h('b', { text: 'About this reading' }), notes.map((t) => h('span', { text: t }))));
    // the rest of what the receipt says (not on the claim form, kept with the claim for the accountant)
    const more = sc ? [sc.docType && `Document: ${sc.docType}`, sc.currency && sc.currency !== 'MYR' && sc.total != null && `Total: ${sc.currency} ${money(sc.total)}`,
      sc.subtotal != null && `Subtotal: ${money(sc.subtotal)}`, sc.tax != null && `${sc.taxType || 'Tax'}: ${money(sc.tax)}`,
      sc.paymentMethod && `Paid by ${sc.paymentMethod}${sc.last4 ? ' ending ' + sc.last4 : ''}`, !sc.paymentMethod && sc.last4 && `Card ending ${sc.last4}`,
      sc.periodStart && `Period: ${niceDate(sc.periodStart)}${sc.periodEnd ? ' – ' + niceDate(sc.periodEnd) : ''}`, sc.dueDate && `Due: ${niceDate(sc.dueDate)}`,
      sc.why && sc.why.total && `Total chosen: ${sc.why.total}`, sc.why && sc.why.date && `Date chosen: ${sc.why.date}`,
      `Read by ${sc.source === 'claude' ? 'Claude' + (sc.model ? ' (' + sc.model.replace(/^claude-/, '') + ')' : '') : 'this device'}`].filter(Boolean) : [];
    if (more.length) fields.push(h('div', { class: 'ainote more' }, h('b', { text: 'From this receipt' }), more.map((t) => h('span', { text: t }))));
    const tags = [
      o.ocr ? h('span', { class: 'tag ocr', 'data-ocr': o.id, 'data-state': o.ocr, text: ocrText(o), hidden: !ocrText(o) }) : null,
      o.hint && !String(o.amount || '').trim() ? h('span', { class: 'tag hint', text: o.hint }) : null,
      o.fx && o.auto && o.auto.amount ? h('span', { class: 'tag hint', text: Fx.note(o.fx) }) : null,       // gone once the amount is typed over
      (o.review && o.review.length) || (o.auto && Object.keys(o.auto).length) || pastOpen(o) ? h('button', { class: 'link okbtn', type: 'button', text: 'Looks right', title: 'Accept what was filled in',
        onclick: () => { o.review = []; o.auto = {}; if (o.past) o.pastOk = o.past.key; keepDraft(); renderLines(); refreshStatus(); } }) : null,
    ];
    const below = o.files.length ? h('div', { class: 'files' }, o.files.map((x) => chip(x.file, x.url, () => removeFile(o, x)))) : null;
    return lineCard(o, { key: l.key, pick: true, autoOpen: !!o.manual, status: () => lineStatus(o, 'other'), fields, tags, below, onRemove: () => removeOther(o), removeTitle: 'Remove this line' });
  }

  function tollLine(l, tv) {
    const isToll = l.kind === 'toll';
    const rows = tv.rows.filter((r) => r.type === (isToll ? 'TOLL' : 'PARKING'));
    const counted = rows.filter((r) => r.include).length;
    // every field can be typed over; what is typed is kept in S.edits and wins over the calculated value
    const edits = S.edits[l.kind];
    const view = new Proxy(Object.assign({}, l), { set(t, k, v) { t[k] = v; edits[k] = v; return true; } });
    const fields = [
      field('Date', 'dt', bound(view, 'date', 'date')), field('Name', 'nm', bound(view, 'name', 'text')),
      field('Receipt no.', 'rn', bound(view, 'receiptNo', 'text')),
      field('Amount (RM)', 'am', bound(view, 'amount', 'number', { step: '0.01', min: '0', inputmode: 'decimal' })),
    ];
    const adjusted = Object.keys(edits).length > 0;
    const tags = [
      h('span', { class: 'tag', text: `Counting ${counted} of ${rows.length} ${isToll ? 'toll trips' : 'parking charges'}` }),
      adjusted ? h('span', { class: 'tag hint', text: `Changed by you · calculated RM ${money(l.calc)}` }) : null,
      adjusted ? h('button', { class: 'link', type: 'button', text: 'Use calculated', onclick: () => { S.edits[l.kind] = {}; renderLines(); } }) : null,
      isToll ? h('button', { class: 'link', type: 'button', text: S.showTrips ? 'Hide trips' : 'See which trips', onclick: () => { S.showTrips = !S.showTrips; renderLines(); } }) : null,
    ];
    const status = () => {
      const s = lineStatus(view, l.kind);
      if (s.level === 'ok') s.text = Object.keys(edits).length ? 'Changed by you' : 'Worked out from your statement';
      return s;
    };
    const below = [h('div', { class: 'files' }, chip(S.tng.file, S.tng.url, removeTng)), isToll ? tripsPanel(tv) : null];
    return lineCard(view, { key: l.key, kind: l.kind, auto: true, status, fields, tags, below, onRemove: removeTng, removeTitle: 'Remove the TNG statement (removes the toll and parking lines)' });
  }

  // the reason shown beside each trip, on screen and in the check-list PDF
  const tripWhy = (r) => (r.include
    ? (r.overridden ? 'Counted (ticked by you)' : r.reason)
    : (r.overridden ? 'Not counted (unticked by you)' : r.reason));

  /* Parking is personal by default. This small card lists every parking charge with a box: tick the ones to claim. */
  function parkingCard(tv) {
    const rows = tv.rows.filter((r) => r.type === 'PARKING').sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    if (!rows.length) return null;
    const ticked = rows.filter((r) => r.include);
    const rows$ = rows.map((r) => {
      const d = new Date(r.date + 'T00:00:00Z');
      const cb = h('input', { type: 'checkbox', checked: r.include, 'aria-label': 'Claim this parking',
        onchange: () => {
          if (cb.checked === r.auto) S.overrides.delete(r.no); else S.overrides.set(r.no, cb.checked);
          const sc = document.querySelector('.pk-list'); const top = sc ? sc.scrollTop : 0;
          renderLines();
          const sc2 = document.querySelector('.pk-list'); if (sc2) sc2.scrollTop = top;
        } });
      return h('label', { class: 'pk-row' + (r.include ? ' on' : '') }, cb,
        h('span', { class: 'pk-date', text: `${ClaimPdf.fmtDate(r.date).slice(0, 5)} ${ClaimPdf.DAY[d.getUTCDay()]}` }),
        h('span', { class: 'pk-name', text: r.plaza || 'Parking' }),
        h('span', { class: 'pk-amt', text: money(r.amount) }));
    });
    return h('div', { class: 'parking' },
      h('div', { class: 'pk-head' },
        h('b', { text: 'Parking' }), h('span', { class: 'pk-note', text: 'Not claimed unless you tick it (for example a client visit)' }),
        ticked.length ? h('span', { class: 'tag', text: `${ticked.length} ticked · RM ${money(TNG.sum(tv.rows, 'PARKING'))}` }) : null,
        h('button', { class: 'icon sm pk-x', type: 'button', title: 'Remove the TNG statement (removes the toll and parking lines)', 'aria-label': 'Remove TNG statement', text: '×', onclick: removeTng })),
      h('div', { class: 'pk-list' }, rows$));
  }

  function tripsPanel(tv) {
    const rows = tv.rows.filter((r) => r.type === 'TOLL').sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const tbody = h('tbody', {}, rows.map((r) => {
      const d = new Date(r.date + 'T00:00:00Z');
      const cb = h('input', { type: 'checkbox', checked: r.include, 'aria-label': 'Count this row',
        onchange: () => {
          if (cb.checked === r.auto) S.overrides.delete(r.no); else S.overrides.set(r.no, cb.checked);
          const sc = document.querySelector('.trips .scroll'); const top = sc ? sc.scrollTop : 0;
          renderLines();
          const sc2 = document.querySelector('.trips .scroll'); if (sc2) sc2.scrollTop = top;
        } });
      const why = tripWhy(r);
      return h('tr', { class: r.include ? '' : 'off' },
        h('td', {}, cb), h('td', { text: `${ClaimPdf.fmtDate(r.date)} ${ClaimPdf.DAY[d.getUTCDay()]}` }), h('td', { text: r.time.slice(0, 5) }),
        h('td', { text: r.type === 'PARKING' ? 'Parking' : 'Toll' }), h('td', { text: r.plaza || '-' }),
        h('td', { class: 'amt', text: money(r.amount) }), h('td', { text: why }));
    }));
    const panel = h('div', { class: 'trips' + (S.showTrips ? ' open' : '') },
      h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['', 'Date', 'Time', 'Type', 'Plaza', 'RM', 'Why'].map((t, i) => h('th', { class: i === 5 ? 'amt' : '', text: t })))), tbody)),
      h('p', { class: 'hint' }, 'Untick a trip you don\'t claim, or tick one the rules left out. ',
        S.overrides.size ? h('button', { class: 'link', type: 'button', text: 'Reset my ticks', onclick: () => { S.overrides.clear(); renderLines(); } }) : null));
    return panel;
  }

  // Subsidy petrol slips carry the litres left in the month: the one with more left was bought first, so its date cannot be later
  function checkOrder() {
    const slips = S.other.filter((o) => o.bal && o.date);
    S.other.forEach((o) => { delete o.dateWarn; });
    Petrol.orderCheck(slips.map((o) => ({ id: o.id, date: o.date, bal: o.bal }))).forEach((w) => { const o = S.other.find((x) => x.id === w.id); if (o) o.dateWarn = w.why; });
  }
  function renderLines() {
    checkOrder();
    const box = $('#lines');
    box.textContent = '';
    S.inputs = [];
    S.lineRefs.clear();
    closeMenus();
    const { lines, tv } = compileLines();
    lines.sort((a, b) => a.rank - b.rank);   // stable: keeps upload order inside each group
    if (!lines.length) {
      box.append(h('div', { class: 'empty', text: 'Add your files above and the claim lines will appear here.' }));
    } else {
      lines.forEach((l) => box.append(l.kind === 'toll' || l.kind === 'parking' ? tollLine(l, tv) : editableLine(l)));
    }
    const pk = tv && parkingCard(tv);
    if (pk) box.append(pk);
    $('#btnClearAll').hidden = !(S.tng || S.other.length);
    updateSummary();
    keepDraft();
  }

  /* ---------- summary, warnings, email defaults ---------- */
  function validate(lines, tv) {
    const bad = [], warn = [];
    const mp = monthParts();
    if (!$('#claimant').value.trim()) bad.push('Enter the claimant name.');
    if (!mp) bad.push('Choose the claim month.');
    if (!lines.length) bad.push('There is nothing to claim yet – add receipts or a TNG statement.');
    if (lines.length > ClaimXlsx.MAX_LINES) bad.push(`The claim form holds ${ClaimXlsx.MAX_LINES} lines; you have ${lines.length}.`);
    const incomplete = lines.filter((l) => !l.date || !String(l.name || '').trim() || !String(l.category || '').trim() || !(num(l.amount) > 0));
    if (incomplete.length) bad.push(`${incomplete.length} line${incomplete.length > 1 ? 's need' : ' needs'} a category, date, name and amount.`);
    if (mp) {
      const out = lines.filter((l) => l.date && l.kind === 'other' && l.date.slice(0, 7) !== mp.key);
      if (out.length) warn.push(`${out.length} receipt${out.length > 1 ? 's are' : ' is'} dated outside ${monthLabel(mp)} – check the date.`);
    }
    const noRn = lines.filter((l) => l.kind === 'other' && !String(l.receiptNo || '').trim());
    if (noRn.length) warn.push(`${noRn.length} line${noRn.length > 1 ? 's have' : ' has'} no receipt number.`);
    const noFile = lines.filter((l) => l.kind === 'other' && !l.files.length);
    if (noFile.length) warn.push(`${noFile.length} typed line${noFile.length > 1 ? 's have' : ' has'} no receipt attached – attach the receipt file to it (under "Edit details") or add it above.`);
    if (tv) {
      const hdr = S.tng.header;
      if (mp && hdr.from && hdr.to && !(hdr.from.slice(0, 7) === mp.key || hdr.to.slice(0, 7) === mp.key)) warn.push(`This statement covers ${hdr.from} to ${hdr.to}, not ${monthLabel(mp)}.`);
      if (mp && !tv.holidayYears.has(String(mp.y))) warn.push(`No public holidays are listed for ${mp.y}. Add them in Settings so holiday tolls are skipped.`);
      if (tv.toll === 0) warn.push('No toll trips qualified this month.');
    }
    return { bad, warn };
  }

  /* the column beside the lines: what each kind of claim adds up to, the total, and whether anything still needs a look */
  function renderSide(lines) {
    const rows = $('#sideRows'), check = $('#sideCheck');
    rows.textContent = '';
    const by = new Map();
    lines.forEach((l) => {
      const k = l.kind === 'other' ? kindOf(l.category) : l.kind;
      const g = by.get(k) || { n: 0, sum: 0 };
      g.n++; g.sum += num(l.amount); by.set(k, g);
    });
    if (!by.size) rows.append(h('div', { class: 'muted', text: 'Nothing added yet.' }));
    Object.keys(KIND_LABEL).filter((k) => by.has(k) && by.get(k).sum > 0).forEach((k) => {
      const g = by.get(k);
      rows.append(h('div', { class: 'srow' }, iconEl(k, 'sico'),
        h('span', { text: KIND_LABEL[k] + (g.n > 1 ? ` (${g.n})` : '') }), h('span', { class: 'samt', text: money(round2(g.sum)) })));
    });
    check.textContent = '';
    const sts = lines.map((l) => ({ l, st: statusOf(l) }));
    const need = sts.filter((x) => x.st.level === 'warn' || x.st.level === 'bad');
    if (sts.some((x) => x.st.level === 'wait')) check.append(h('span', { class: 'status wait', text: 'Reading photos…' }));
    else if (need.length) {
      check.append(h('span', { class: 'status warn', text: `${need.length} line${need.length > 1 ? 's need' : ' needs'} checking` }),
        h('button', { class: 'link', type: 'button', text: 'Show me', onclick: () => {
          const el = document.querySelector(`.line[data-key="${need[0].l.key}"]`);
          if (!el) return;
          const d = el.querySelector('.ldetails');
          if (d && d.hidden) el.querySelector('.toggle').click();
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } }));
    } else if (sts.length) check.append(h('span', { class: 'status ok', text: 'All lines look right' }));
  }

  /* ---------- steps: one form at a time, with a progress line on top ---------- */
  const STEPS = ['Details', 'Files', 'Check', 'Save and email'];
  const emailOk = (id) => /\S+@\S+/.test($(id).value);

  /* what each step still needs; a step is done when its list is empty */
  function stepProblems(lines) {
    const p = [[], [], [], []];
    if (!$('#claimant').value.trim()) p[0].push('the claimant name');
    if (!monthParts()) p[0].push('the claim month');
    if (!S.tng && !S.other.length) p[1].push('at least one file (or a line typed by hand)');
    const sts = lines.map(statusOf);
    const wait = sts.filter((s) => s.level === 'wait').length, bad = sts.filter((s) => s.level === 'bad').length;
    if (!lines.length) p[2].push('at least one claim line');
    if (wait) p[2].push('the photos to finish reading');
    if (bad) p[2].push(`${bad} line${bad > 1 ? 's' : ''} still to fill in`);
    if (lines.length > ClaimXlsx.MAX_LINES) p[2].push(`no more than ${ClaimXlsx.MAX_LINES} lines`);
    if (!emailOk('#toEmail')) p[3].push("the accountant's email");
    if (!$('#subject').value.trim()) p[3].push('the subject');
    return p;
  }

  function buildStepper() {
    const nav = $('#stepper');
    const items = STEPS.map((label, i) => {
      // each step starts with its number and a status, so the bar is never an empty row of circles (renderSteps then keeps them up to date)
      const dot = h('button', { type: 'button', class: 'sdot' + (i === 0 ? ' cur' : ''), text: String(i + 1), onclick: () => go(i + 1) });
      const name = h('span', { class: 'slabel' + (i === 0 ? ' cur' : ''), text: label });
      const cap = h('span', { class: 'scap' + (i === 0 ? ' cur' : ''), text: i === 0 ? 'In progress' : 'To do' });
      return { li: h('li', {}, dot, name, cap), dot, name, cap };
    });
    nav.append(h('ol', {}, items.map((x) => x.li)));
    S.stepEls = items;
    // Back / Next under each form
    document.querySelectorAll('#viewClaim > .pane').forEach((sec) => {
      const n = +sec.dataset.step;
      const back = n > 1 ? h('button', { class: 'ghost', type: 'button', text: '← Back', onclick: () => go(n - 1) }) : h('span');
      const next = n < 4 ? h('button', { class: 'ghost next', type: 'button', text: `Next: ${STEPS[n]} →`, onclick: () => go(n + 1) }) : null;
      sec.append(h('div', { class: 'stepnav' }, back, next));
    });
  }

  /* Who the email comes from is whoever signed in on the login page: their email goes into the two hidden boxes (#fromEmail,
     #lFromEmail) that the rest of the code reads. Someone who continued without signing in has no From, which is fine. */
  const applyUser = () => {
    const email = S.user && S.user.email ? S.user.email : '';
    $('#fromEmail').value = email; $('#lFromEmail').value = email; cfg.fromEmail = email;
  };

  /* ---------- the login page ---------- */
  const msClientId = () => String(cfg.msClientId || DEFAULTS.msClientId || '').trim();
  function unlock() {
    document.body.classList.remove('locked');
    const email = S.user && S.user.email ? S.user.email : '';
    const name = (S.user && S.user.name) || (email ? email.split('@')[0] : '');
    const initials = name ? (email && !(S.user && S.user.name) ? name[0] : name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('')).toUpperCase() : 'G';
    $('#who').hidden = false;
    $('#avatarText').textContent = $('#avatarText2').textContent = initials;
    $('#whoName').textContent = name || 'Guest';
    $('#whoEmail').textContent = email || 'Not signed in';
    $('#btnSignOut span').textContent = email ? 'Sign out' : 'Sign in';
    applyUser();
    if (canDrive()) Gmail.preload().catch(() => {});          // so the Google Drive window can open straight from a click
    refreshWalletBar();
    paintRemindBar();
    if (window.MailReceipts) paintMail();
  }
  function wireLogin() {
    const msg = (text, bad) => { const m = $('#loginMsg'); m.textContent = text || ''; m.classList.toggle('bad', !!bad); };
    const busy = (on) => ['#btnGoogle', '#btnMicrosoft', '#btnNoLogin'].forEach((id) => { $(id).disabled = on; });
    const done = (user) => {
      Auth.set(user, $('#keepSignedIn').checked); S.user = user; unlock(); renderSteps();
      ['claim', 'leave'].forEach((k) => { if (S.packs[k]) renderPack(k); });
      msg('');
    };
    const attempt = (start, opening) => {
      msg(opening); busy(true);                  // start() must run in this same click: it opens the sign-in popup
      let p;
      try { p = start(); } catch (e) { p = Promise.reject(e); }
      const hint = window.Pwa && Pwa.standalone() && Pwa.isIos() ? ' If Google\'s window did not open, tap "Continue without signing in": everything still works.' : '';
      p.then(done, (e) => msg(String((e && e.message) || e) + hint, true)).then(() => busy(false));
    };
    $('#btnGoogle').addEventListener('click', () => {
      if (!gmailClientId()) { msg('Google sign-in is not set up yet. Use "Continue without signing in" for now.', true); return; }
      attempt(() => Gmail.identify(gmailClientId()), 'Opening Google…');
    });
    $('#btnMicrosoft').addEventListener('click', () => {
      // no Microsoft app registered: Outlook people still get the email file with the zip attached, which opens in their own Outlook
      if (!msClientId()) { done({ provider: 'microsoft', email: '', name: '' }); return; }
      attempt(() => Outlook.signIn(msClientId()), 'Opening Microsoft…');
    });
    $('#btnNoLogin').addEventListener('click', () => { const u = { provider: 'none', email: '', name: '' }; Auth.set(u, $('#keepSignedIn').checked); S.user = u; unlock(); renderSteps(); });
    // "Keep me signed in on this device": ticked the first time, then as the person left it
    const keep = $('#keepSignedIn'); keep.checked = Auth.keepPref();
    keep.addEventListener('change', () => Auth.setKeepPref(keep.checked));
    // the account menu: the avatar opens it; Settings, Start over and Sign out live inside
    const acMenu = $('#acMenu'), acBtn = $('#btnAccount');
    const setMenu = (on) => { acMenu.hidden = !on; acBtn.setAttribute('aria-expanded', String(on)); if (on) { const first = acMenu.querySelector('button'); if (first) first.focus(); } };
    acBtn.addEventListener('click', (e) => { e.stopPropagation(); setMenu(acMenu.hidden); });
    acMenu.addEventListener('click', () => setMenu(false));                 // choosing an item closes the menu (the item's own action still runs)
    document.addEventListener('click', (e) => { if (!acMenu.hidden && !acMenu.contains(e.target)) setMenu(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !acMenu.hidden) { setMenu(false); acBtn.focus(); } });
    $('#btnSignOut').addEventListener('click', () => {
      // the page keeps the unfinished claim on this computer and puts it back after the reload (pagehide saves it)
      if (S.user && S.user.email && !window.confirm('Sign out?\n\nYour unfinished claim stays on this device.')) return;
      Draft.flush(draftSnapshot); Auth.signOut(); location.reload();
    });
    // the sign-in script and the popup have to be ready before the click
    if (gmailClientId()) Gmail.preload().catch(() => {});
    if (msClientId()) Outlook.preload(msClientId()).catch((e) => msg(String((e && e.message) || e), true));
  }

  /* a light-yellow outline on every box that still waits for the person, so it is clear where to type */
  function markNeeded() {
    ['#claimant', '#subject'].forEach((id) => $(id).classList.toggle('need', !$(id).value.trim()));
    $('#toEmail').classList.toggle('need', !emailOk('#toEmail'));       // From is optional: it never waits for the person
    $('#month').classList.toggle('need', !monthParts());
    $('#dropAll').classList.toggle('need', !S.tng && !S.other.length);
  }
  function markNeededLeave() {
    ['#lName', '#lFrom', '#lTo', '#lReason', '#lSubject'].forEach((id) => $(id).classList.toggle('need', !$(id).value.trim()));
    $('#lToEmail').classList.toggle('need', !emailOk('#lToEmail'));
  }

  function renderSteps(lines) {
    if (!S.stepEls) return;
    markNeeded();
    let p;
    try { p = stepProblems(lines || compileLines().lines); }
    catch (e) { console.warn('could not check the steps', e); p = STEPS.map(() => ['a check that could not run']); }       // the bar still shows, and nothing is marked done
    const done = p.map((x) => !x.length);
    // the bar shows a step as finished only when it and every step before it are: "Save and email" has its boxes filled in from the start,
    // and a green tick there while the files are still missing would be misleading
    const shown = done.map((_, i) => done.slice(0, i + 1).every(Boolean));
    S.stepEls.forEach((x, i) => {
      const n = i + 1, cur = S.step === n, fin = shown[i];
      // finished (not the one you are on) = green tick; the step you are on = blue number; the rest = grey number. A caption under each says it in words.
      x.dot.className = 'sdot' + (fin && !cur ? ' done' : '') + (cur ? ' cur' : '');
      x.dot.textContent = fin && !cur ? '✓' : String(n);
      x.cap.textContent = fin ? 'Done' : cur ? 'In progress' : 'To do';
      x.cap.className = 'scap' + (fin ? ' done' : cur ? ' cur' : '');
      x.dot.title = fin ? 'Done' : p[i].length ? 'Still needs: ' + p[i].join(', ') : 'Finish the earlier steps first';
      x.dot.setAttribute('aria-label', `Step ${n}: ${STEPS[i]}, ${fin ? 'done' : cur ? 'in progress' : 'to do'}`);
      if (cur) x.dot.setAttribute('aria-current', 'step'); else x.dot.removeAttribute('aria-current');
      x.name.className = 'slabel' + (cur ? ' cur' : '') + (fin ? ' done' : '');
      x.li.className = [i && shown[i - 1] ? 'after-done' : '', fin ? 'is-done' : ''].filter(Boolean).join(' ');        // the line between two steps turns green once the step before it is done
    });
    document.querySelectorAll('#viewClaim .stepnav .next').forEach((b) => {
      const n = +b.closest('.pane').dataset.step;
      b.className = (done[n - 1] ? 'primary' : 'ghost') + ' next';      // the next button lights up when this step is complete
    });
    // Build only works when all four are done
    const ready = done.every(Boolean);
    $('#btnBuild').disabled = S.building || !ready;
    const why = $('#buildWhy');
    why.textContent = '';
    if (!ready) {
      const bits = [];
      p.forEach((list, i) => { if (list.length) bits.push(h('button', { class: 'link', type: 'button', text: `step ${i + 1}: ${list.join(', ')}`, onclick: () => go(i + 1) })); });
      why.append(h('div', { class: 'note warn todo' }, h('span', { text: 'To save your claim, finish:' }), bits));      // one line each, so a long list never runs into the next
    }
  }

  function go(n, quiet) {
    S.step = n;
    document.querySelectorAll('#viewClaim > .pane').forEach((s) => { s.hidden = +s.dataset.step !== n; });
    renderSteps();
    if (!quiet) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateSummary() {
    schedulePastCheck();
    const { lines, tv } = compileLines();
    refreshHeads();
    renderSide(lines);
    $('#total').textContent = 'RM ' + money(lineTotal(lines));
    const v = validate(lines, tv);
    const notes = $('#notes');
    notes.textContent = '';
    if (S.showErrors) v.bad.forEach((t) => notes.append(h('div', { class: 'note bad', text: t })));
    v.warn.forEach((t) => notes.append(h('div', { class: 'note warn', text: t })));
    S.inputs.forEach((i) => {
      const o = i._obj, k = i._key;
      const req = k === 'date' || k === 'name' || k === 'category' || k === 'amount';
      const empty = k === 'amount' ? !(num(o[k]) > 0) : !String(o[k] || '').trim();
      i.classList.toggle('bad', S.showErrors && req && empty);
      i.classList.toggle('need', req && empty);
    });
    refreshEmail(lines);
    renderSteps(lines);                  // after the email subject is set, which step 4 checks
    if (S.packs.claim && !S.packs.claim.stale) { S.packs.claim.stale = true; renderPack('claim'); }
  }

  function bodyText(lines) {
    const mp = monthParts();
    const who = $('#claimant').value.trim();
    const sign = cfg.signoff || $('#signature').value.trim() || who;
    return [
      `Hi ${cfg.toName || 'there'},`, '',
      `Please find attached the ${monthLabel(mp) || 'monthly'} expense claim${who ? ' for ' + who : ''}.`,
      `Total claim: RM ${money(lineTotal(lines))}`, '',
      "The zip has the claim form (Excel and PDF), the Touch 'n Go statement with a tick list of which toll trips count, and all receipts.", '',
      'Thank you.', '', 'Regards,', sign,
    ].join('\n');
  }

  function refreshEmail(lines) {
    const mp = monthParts();
    if (!S.touched.subject) $('#subject').value = mp ? `Claim - ${monthLabel(mp)}` : 'Claim';
    if (!S.touched.body) $('#body').value = bodyText(lines);
  }

  function refreshStatus() {
    const parts = [];
    if (S.tng) parts.push('TNG statement');
    const n = S.other.reduce((a, o) => a + o.files.length, 0);
    if (n) parts.push(`${n} receipt file${n > 1 ? 's' : ''}`);
    $('#stAll').textContent = parts.length ? '✓ ' + parts.join(' · ') + ' added' : '';
    if (!parts.length) $('#fileNotes').textContent = '';          // "Added: 4 invoice / receipt PDFs" means nothing once they are all removed
  }

  const fileNote = (kind, text) => { $('#fileNotes').append(h('div', { class: 'note ' + kind, text })); };

  /* ---------- adding files ---------- */
  const readable = (f) => f && f.size > 0;
  const isPdf = (f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name);
  const isImage = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name);

  // what is inside a PDF (TNG statement, invoice / receipt, hotel receipt) - read once per file
  const sniffed = new WeakMap();
  async function sniff(file) {
    if (!sniffed.has(file)) sniffed.set(file, isPdf(file) ? await Receipts.readPdf(await file.arrayBuffer()) : { isTng: false, stripe: null, hotel: null });
    return sniffed.get(file);
  }

  async function onTng(files) {
    const file = files[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const parsed = await TNG.extract(buf.slice(0));
      if (S.tng) URL.revokeObjectURL(S.tng.url);
      S.tng = { file, buf, url: URL.createObjectURL(file), header: parsed.header, rows: parsed.rows };
      S.overrides.clear(); S.edits = { toll: {}, parking: {} };
      const hd = parsed.header;
      if (!S.touched.month && hd.from && hd.to && hd.from.slice(0, 7) === hd.to.slice(0, 7)) $('#month').value = hd.from.slice(0, 7);
      if (!$('#claimant').value.trim() && hd.name) { $('#claimant').value = titleCase(hd.name); cfg.claimant = $('#claimant').value; saveCfg(); }
      fileNote('ok', `Read ${parsed.rows.filter((r) => r.type !== 'RETAIL').length} toll / parking rows from the statement (${hd.periodText || 'period unknown'}).`);
    } catch (e) {
      S.tng = null;
      fileNote('bad', e.message && e.message.includes('Touch') ? e.message : 'Could not read that PDF as a TNG statement: ' + (e.message || e));
    }
    refreshStatus(); renderLines();
  }

  function guessDate(file) {
    const mp = monthParts();
    const d = localIso(new Date(file.lastModified || Date.now()));
    return mp && d.slice(0, 7) === mp.key ? d : '';
  }

  /* ---------- reading receipt photos (OCR) ---------- */
  const OCR_LABEL = {
    queued: 'Waiting to check the photo…', reading: 'Checking the photo…',
    done: 'Read from the photo – check the amber fields', failed: "Couldn't check this photo – please type the details",
  };
  const ocrTag = (item) => document.querySelector(`[data-ocr="${item.id}"]`);
  // a failure says why, so it can be reported
  // the line's status already says "reading" and "please check", so the tag appears only when the photo could not be read
  const ocrText = (item) => (item.ocr !== 'failed' ? '' : item.ocrError ? `${OCR_LABEL.failed} (${item.ocrError})` : OCR_LABEL.failed);
  function setOcr(item, state) {
    item.ocr = state; keepDraft();
    const tag = ocrTag(item);
    if (tag) { tag.textContent = ocrText(item); tag.hidden = !ocrText(item); tag.dataset.state = state; }
    refreshHeads();
  }

  // dealers seen on past claims, so a receipt reading "KEJAYAAN TEGUH ENT" is named the way the team already writes it
  const SEED_STATIONS = ['Kejayaan Teguh Enterprise', 'Klinik Putra Care', 'Legasi Puncak', 'BE Petrol Station', 'R & Z Aktiviti Enterprise', 'PS Taman Tenaga',
    'MNR Synergy', 'Mickey Puchong Petrol Station', 'Setar Quay Sdn Bhd', 'Stesen Minyak Jasa Tuah'];
  const stations = () => store.get('wfc-stations', []).concat(SEED_STATIONS);
  function rememberStation(name) {
    const n = String(name || '').trim();
    if (!n) return;
    store.set('wfc-stations', [n].concat(store.get('wfc-stations', []).filter((s) => s.toLowerCase() !== n.toLowerCase())).slice(0, 20));
  }

  /* put what was read into the line, without overwriting anything the person already typed */
  function applyOcr(item, r) {
    item.auto = item.auto || {};
    const fill = (key, value, replaceGuess) => {
      if (!value) return;
      const blank = !String(item[key] || '').trim();
      if (!blank && !(replaceGuess && item.auto[key])) return;
      item[key] = value;
      item.auto[key] = true;
      const input = S.inputs.find((i) => i._obj === item && i._key === key);
      if (input) { input.value = value; input.classList.add('guess'); }
    };
    fill('date', r.date, true);          // beats the date guessed from the photo's file time
    fill('amount', r.amount);
    fill('name', r.station, true);       // beats the last station name pre-filled
    fill('receiptNo', r.receiptNo);
    if (r.litres) { item.litres = r.litres; item.fuel = r.fuelType || 'petrol'; }        // for the carbon of business travel on the accountant's dashboard
    // a photo starts as Petrol; a hotel bill or clinic receipt says what it is, so switch the type (shown as "please check")
    if (r.category && item.category === 'Petrol' && r.category !== 'Petrol') {
      item.category = r.category; item.auto.category = true;
      const input = S.inputs.find((i) => i._obj === item && i._key === 'category');
      if (input) { input.value = r.category; input.classList.add('guess'); }
    }
    updateSummary();
  }

  /* ---------- the general reader and the scanner: receipts that are not fuel slips (meals, rides, tickets, shops, software, suppliers ...) ----------
     The reader on this PC (js/extract.js) reads the text; when it is unsure of a main field, Claude reads the file itself (js/scan.js) and
     the two are put together field by field. Fields that are still not sure are marked "Needs review". Clinic, parking and hotel papers and
     fuel slips keep their own, tuned readers. */
  // a tuned reader's result with gaps (no receipt number, no name, no date): the general reader fills them when it is sure
  function fillGaps(r, x) {
    if (!r.receiptNo && x.number && x.confidence.number >= 0.6) {
      r.receiptNo = x.number;
      // the slip's own number beside its label (Petron "Invoice #", Caltex "Transaction number"): not the six-character code that dot-matrix print garbles
      if (r.invoiceDoubt && !/^[0-9a-f]{6}$/i.test(x.number)) r.invoiceDoubt = false;
    }
    if (!r.station && x.vendor && x.confidence.vendor >= 0.75) r.station = x.vendor;
    if (!r.date && x.date && x.confidence.date >= 0.8) r.date = x.date;
    if (!r.category && TUNED_KINDS.includes(x.category) && x.category !== 'Petrol') r.category = x.category;
    return r;
  }
  const TUNED_KINDS = ['Petrol', 'Medical', 'Parking', 'Accommodation'];
  // the general reader takes it: no fuel words, and neither reader sees one of the kinds with a tuned reader (the rule lives in js/extract.js)
  const forGeneral = (x, p, text) => Extract.forGeneral(x, p, text);
  const KEY_OF = { vendor: 'name', number: 'receiptNo', total: 'amount', date: 'date', category: 'category' };
  async function finishGeneral(item, file, x, text, mp, ocr) {
    let f = Object.assign({}, x), review = (x.needsReview || []).slice(), notes = [], source = 'pc', model = '';
    if (x.unsure && PlanB.available() && !item.askedClaude && window.Scan) {
      item.askedClaude = true; setOcr(item, 'reading');
      try {
        const out = await Scan.read(file, { text, month: mp && mp.key });
        if (!alive(item)) return;
        if (!out.reading.isReceipt) {
          refuse(item, file, `Claude looked at this and it does not seem to be a receipt${out.reading.notes ? ': ' + out.reading.notes.replace(/\.$/, '') : ''}. Attach the receipt itself, or add it anyway and type the details.`, true);
          return;
        }
        const m = Scan.merge(x, out.reading, { ocr });          // read from a picture: Claude wins where the two disagree (marked for review)
        f = m.fields; review = m.needsReview; notes = m.notes; source = 'claude'; model = out.model;
      } catch (e) { console.warn('Scan failed', e); notes.push(`Claude could not help (${PlanB.explain(e)}), so this was read on this device.`); }
    }
    if (!alive(item)) return;
    // the claim is in ringgit: the ringgit charge when printed, else the total, else converted at the day's rate
    let amount = null, fx = null, hint = '';
    const cur = (f.currency || 'MYR').toUpperCase();
    if (f.totalMyr != null) amount = f.totalMyr;
    else if (f.total != null && cur === 'MYR') amount = f.total;
    else if (f.total != null) {
      const c = await Fx.toMyr(cur, f.total, f.date);
      if (c) { amount = c.myr; fx = c; } else hint = `Receipt is in ${cur} ${f.total.toFixed(2)} – type the MYR amount from your card statement`;
      if (!alive(item)) return;
    }
    fillScan(item, f, { amount, fx, hint, review, notes, source, model });
    setOcr(item, 'done');
    renderLines();
  }
  // a PDF that prints its number two ways (a scan read on this PC): the number is marked for review, and with Claude on, Claude reads the PDF and picks the spelling
  async function settleNumber(item, file, text, spellings, mp) {
    const key = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    item.review = ['receiptNo'];
    item.planB = `The receipt number is printed two ways (${spellings.join(', ')}). Please check which is right.`;
    if (PlanB.available() && window.Scan && !item.askedClaude) {
      item.askedClaude = true; setOcr(item, 'reading'); renderLines();
      try {
        const out = await Scan.read(file, { text, month: mp && mp.key });
        if (!alive(item)) return;
        const hit = spellings.find((s) => key(s) === key(out.reading.number));
        if (hit) {
          if (!String(item.receiptNo || '').trim() || (item.auto && item.auto.receiptNo)) { item.receiptNo = hit; item.auto = Object.assign(item.auto || {}, { receiptNo: true }); }
          item.review = []; item.planB = `Checked with Claude: the receipt number is ${hit}.`;
        }
      } catch (e) { console.warn('Scan failed', e); }
      if (!alive(item)) return;
      setOcr(item, 'done');
    }
    keepDraft(); renderLines(); refreshStatus();
  }
  // a reading -> the line: only blank boxes or boxes the app filled are changed; what was filled is kept, to learn from corrections
  function fillScan(item, f, info) {
    item.auto = item.auto || {};
    const set = (key, value) => {
      if (value == null || value === '') return;
      if (String(item[key] || '').trim() && !item.auto[key]) return;
      item[key] = value; item.auto[key] = true;
    };
    set('category', f.category); set('name', f.vendor); set('date', f.date); set('receiptNo', f.number);
    if (info.amount != null) set('amount', info.amount.toFixed(2));
    if (info.fx) item.fx = info.fx;
    if (info.hint) item.hint = info.hint;
    if (f.litres) { item.litres = f.litres; item.fuel = f.fuelType || 'petrol'; }
    item.orig = { category: item.category, name: item.name, date: item.date, receiptNo: item.receiptNo, amount: item.amount };
    item.review = (info.review || []).map((k) => KEY_OF[k] || k).filter((k) => item.auto[k] || isBlank(item, k));
    item.scan = {
      source: info.source || 'pc', model: info.model || '', docType: f.docType || '', currency: (f.currency || '').toUpperCase(), total: f.total != null ? f.total : null,
      subtotal: f.subtotal != null ? f.subtotal : null, tax: f.tax != null ? f.tax : null, taxType: f.taxType || '', paymentMethod: f.paymentMethod || '', last4: (String(f.last4 || '').match(/\d{4}$/) || [''])[0],
      dueDate: f.dueDate || '', periodStart: f.periodStart || '', periodEnd: f.periodEnd || '', numberKind: f.numberKind || '',
      lineItems: (f.lineItems || []).slice(0, 15), why: f.why || {}, notes: (info.notes || []).filter(Boolean),
    };
  }
  // the corrections people made to what the app filled in: sent with the claim, so the weak spots show up (never the files themselves)
  function scanLog() {
    const out = [];
    S.other.forEach((o) => {
      if (!o.orig || !o.fixed) return;
      Object.keys(o.fixed).forEach((k) => {
        const from = String(o.orig[k] == null ? '' : o.orig[k]), to = String(o.fixed[k] == null ? '' : o.fixed[k]);
        if (from.trim() !== to.trim()) out.push({ field: k, from: from.slice(0, 80), to: to.slice(0, 80), source: (o.scan && o.scan.source) || 'pc', docType: (o.scan && o.scan.docType) || '', category: String(o.category || '').slice(0, 40) });
      });
    });
    return out.slice(0, 60);
  }

  /* ---------- files that were refused: always say why ---------- */
  function reject(file, reason, canForce, isMc) {
    const note = h('div', { class: 'note bad reject' },
      h('div', {}, h('b', { text: file.name }), ' was not added'),
      h('div', { text: reason }),
      h('div', { class: 'reject-actions' },
        isMc ? h('button', { class: 'link', type: 'button', text: 'Use it on the Leave application', onclick: () => { note.remove(); showView('leave'); attachMc([file]); } }) : null,
        canForce ? h('button', { class: 'link', type: 'button', text: 'Add anyway and type the details', onclick: async () => { note.remove(); await onOther([file], { force: true }); } }) : null,
        h('button', { class: 'link', type: 'button', text: 'Dismiss', onclick: () => note.remove() })));
    $('#rejects').append(note);
  }

  function dropItem(item) {
    item.files.forEach((x) => URL.revokeObjectURL(x.url));
    S.other = S.other.filter((x) => x !== item);
    renderLines(); refreshStatus();
  }

  /* photos: read the text, refuse the ones that aren't a readable receipt, fill in the rest */
  async function readPhoto(item) {
    const file = item.files[0].file;
    try {
      const mp = item.mp || monthParts();          // a snapped receipt (My receipts) is read for the month it was snapped in
      const opts = { month: mp && mp.key, stations: stations() };
      // Claude first (a key is saved and this PC is set that way): one look at the photo. When it finds an amount and a date, is sure, and nothing looks
      // wrong, that is the reading and the slower reader on this PC is skipped; otherwise the reader on this PC checks it too
      let pre = null;
      if (PlanB.available() && PlanB.first() && !clearFile(file) && !item.askedClaude) {
        setOcr(item, 'reading');
        pre = await claudeFirst(item, file, mp);
        if (!alive(item)) return;
        if (pre.notReceipt) { refuse(item, file, pre.reason, true); return; }
        if (pre.c && PlanB.clean(pre.c, {})) { await finishFromClaude(item, pre.c); return; }
      }
      const parts = [];
      // quick when Claude is there to take over: a photo this PC cannot read well is handed on in seconds, not after a minute of extra looks
      const text = await OCR.read(file, Object.assign({ collect: parts, quick: PlanB.available(), onStart: () => setOcr(item, 'reading') }, Petrol.ocrChecks(opts)));       // when to stop looking: js/petrol.js
      if (!alive(item)) return;              // removed while waiting
      let r = Petrol.best(parts.length ? parts : [text], opts);          // every reading votes, so one misread digit is outvoted
      const verdict = Validate.judge(text, 'photo');
      // the stricter check can miss an amount the voting reader did find (a lost decimal point): then the photo stays
      const unreadable = verdict.status !== 'ok' && !(r.amount && verdict.reason === Validate.MSG.noAmount);
      // plan B: only when the normal reader could not read the photo, or what it read does not make sense, and only with a saved key
      const canRetry = unreadable && (verdict.reason === Validate.MSG.photoUnreadable || verdict.reason === Validate.MSG.noAmount);
      // not a fuel slip, clinic, parking or hotel paper (a meal, a ride, a ticket, a shop ...): the general reader, and Claude when it is unsure
      const gx = !pre && !unreadable && window.Extract ? Extract.read(text, { month: mp && mp.key }) : null;
      if (gx && forGeneral(gx, r, text)) { await finishGeneral(item, file, gx, text, mp, true); return; }
      if (gx) fillGaps(r, gx);              // a tuned reading: what it left empty, the general reader fills when it is sure
      const why = !unreadable || canRetry ? PlanB.doubts(r, { category: r.category || guessCategory(text) || item.category }) : [];
      const b = pre && pre.c ? claudeChecked(pre.c, r, why)
        : (canRetry || PlanB.worthAsking(why, r)) && PlanB.available() && !item.askedClaude ? await askClaude(item, file, r, why, mp) : null;       // Claude only when it is needed
      const claudeErr = pre && pre.error ? pre.error : '';
      if (!alive(item)) return;
      if (b && b.notReceipt) { refuse(item, file, b.reason, true); return; }
      if (b && b.r && !(canRetry && !b.r.amount && !b.r.foreign)) {
        r = b.r; item.planB = b.note;
        const known = r.station && Petrol.station(r.station, stations()); if (known) r.station = known;      // Claude's shop name, as it was saved before
        item.review = (r.review || []).slice();          // where the two readers disagreed: Claude's reading is used, marked for a look
      }
      else if (unreadable) { refuse(item, file, verdict.reason + (b ? (b.error ? ` Claude could not help: ${b.error}` : ' Claude could not read it either.') : ''), verdict.force, verdict.mc); return; }
      else if (why.length) {
        item.planB = 'Please check: ' + why.join('; ') + '.' + (b && b.error ? ` Claude could not help: ${b.error}` : '');
        if (why.includes('no invoice number found')) item.review = ['receiptNo'];
      }
      if (claudeErr && !item.planB) item.planB = `Claude could not help (${claudeErr}), so this was read on this device. Please check the photo.`;
      if (!r.amount && r.foreign) {                     // a receipt in another currency is claimed in ringgit
        const c = await Fx.toMyr(r.foreign.code, r.foreign.amount, r.date);
        if (c) { r.amount = c.myr.toFixed(2); item.fx = c; }
        else item.hint = `Receipt is in ${r.foreign.code} ${r.foreign.amount.toFixed(2)} – type the MYR amount from your card statement`;
        if (!alive(item)) return;
      }
      const kind = guessCategory(text);
      if (!r.category && (kind === 'Accommodation' || kind === 'Medical' || kind === 'Parking')) r.category = kind;
      item.bal = r.bal || null;                         // litres left before and after, for the order check
      applyOcr(item, r);
      if (item.review && item.review.length) item.review = item.review.filter((k) => (item.auto && item.auto[k]) || isBlank(item, k));      // only boxes the app filled, or left empty
      if (item.category === 'Accommodation' && !String(item.amount || '').trim()) item.hint = 'Hand-written bill: type the SUB TOTAL (not the deposit) and the check-in date';
      setOcr(item, 'done');
      if (item.fx || item.hint || item.planB || r.category || item.bal) renderLines();       // a new type also moves the line to its place in the order
    } catch (e) {
      console.warn('OCR failed', e);
      if (!alive(item)) return;
      if (e && e.code === 'decode') { refuse(item, file, Validate.MSG.decode, true); return; }
      item.ocrError = String((e && e.message) || e).slice(0, 220);
      // the normal reader broke (not just a poor photo): plan B reads it instead, when a key is saved
      const b = PlanB.available() && !item.askedClaude ? await askClaude(item, file, {}, ['the normal reader failed'], monthParts()) : null;
      if (!alive(item)) return;
      if (b && b.r && (b.r.amount || b.r.foreign)) {
        applyOcr(item, b.r); item.planB = b.note; delete item.ocrError;
        if (!b.r.amount) item.hint = `Receipt is in ${b.r.foreign.code} ${b.r.foreign.amount.toFixed(2)} – type the MYR amount from your card statement`;
        setOcr(item, 'done'); renderLines();
      } else setOcr(item, 'failed');
    }
  }

  // a screenshot or a clean picture made on a screen reads exactly with the reader on this PC: Claude first is for camera photos, which can be blurry
  const clearFile = (f) => f.type === 'image/png' || /screen[\s_-]?shot|snip/i.test(f.name || '');

  /* Claude first: one look at the photo. Never throws -> { c } | { notReceipt, reason } | { error } */
  async function claudeFirst(item, file, mp) {
    item.askedClaude = true;
    try {
      const c = (await PlanB.read(file, { month: mp && mp.key })).reading;
      if (!c.isReceipt) return { notReceipt: true, reason: `Claude looked at this photo and it does not seem to be a receipt${c.notes ? ': ' + c.notes.replace(/\.$/, '') : ''}. Attach the receipt itself, or add it anyway and type the details.` };
      return { c };
    } catch (e) { console.warn('Claude first failed', e); return { error: PlanB.explain(e) }; }
  }
  // Claude's reading used as it is (no reader on this PC needed): the shop is matched to the saved shops first
  async function finishFromClaude(item, c) {
    const r = PlanB.asReading(c);
    const known = Petrol.station(c.merchant || '', stations());
    if (known) r.station = known;
    if (!r.amount && r.foreign) {
      const f = await Fx.toMyr(r.foreign.code, r.foreign.amount, r.date);
      if (f) { r.amount = f.myr.toFixed(2); item.fx = f; }
      else item.hint = `Receipt is in ${r.foreign.code} ${r.foreign.amount.toFixed(2)} – type the MYR amount from your card statement`;
      if (!alive(item)) return;
    }
    applyOcr(item, r);
    if (c.confidence === 'medium' || c.notes) item.planB = c.notes ? `Read by Claude: ${c.notes.replace(/\.$/, '')}. Please check the photo.` : null;
    setOcr(item, 'done');
    renderLines();
  }
  // Claude's reading put next to the one from this PC: they agree, they differ (the slip's own sums win when they add up), or one fills a gap
  function claudeChecked(c, r, why) {
    if (r.sure === true && r.amount && c.amount && Math.abs(parseFloat(r.amount) - parseFloat(c.amount)) > 0.005) {
      return { r, note: `Claude read RM${c.amount}, but the sums on the slip add up to RM${r.amount}. Please check the photo.` };
    }
    const m = PlanB.merge(r, c, why);
    return { r: m.r, note: m.note || c.confidence === 'low' ? `Checked with Claude. ${m.note ? m.note + ' ' : ''}${c.confidence === 'low' ? 'Claude was not sure either. ' : ''}Please check the photo.` : null };
  }

  /* plan B: ask Claude about one photo. Never throws -> { r, note } | { notReceipt, reason } | { error } */
  async function askClaude(item, file, ocr, why, mp) {
    item.askedClaude = true;
    try {
      const out = await PlanB.read(file, { month: mp && mp.key });
      const c = out.reading;
      if (!c.isReceipt) return { notReceipt: true, reason: `Claude looked at this photo and it does not seem to be a receipt${c.notes ? ': ' + c.notes.replace(/\.$/, '') : ''}. Attach the receipt itself, or add it anyway and type the details.` };
      const m = PlanB.merge(ocr, c, why);
      return { r: m.r, note: `Checked again with Claude. ${m.note ? m.note + ' ' : ''}${c.confidence === 'low' ? 'Claude was not sure either. ' : ''}Please check the photo.` };
    } catch (e) { console.warn('Plan B failed', e); return { error: PlanB.explain(e) }; }
  }

  // any clinic, hospital, dental or health centre is Medical, by its words and by the big chains, so a name the tool has never seen still works
  const guessCategory = (text) => (/\b(klinik|clinic|poliklinik|polyclinic|hospital|hospitals|pusat\s+perubatan|perubatan|kesihatan|healthcare|medical\s+cent(?:re|er)|dental|pergigian|pharmacy|farmasi|consultation|medication|medical|doctor|kpj|gleneagles|columbia\s+asia|ijn)\b/i.test(text) ? 'Medical'
    : /\b(hotel|motel|room|booking|check-?\s?in|check-?\s?out|accommodation|resort|homestay|guest\s?house|penginapan)\b/i.test(text) ? 'Accommodation'
    : /\b(petrol|diesel|ron\s?9\d|pump|litre|liter)\b/i.test(text) ? 'Petrol'
    : /\b(flexi\s*parking|parking|car\s?park|mbsj|mbpj|mbsa|mpaj|dbkl)\b/i.test(text) ? 'Parking'
      : /\b(subscription|software|cloud|api|saas)\b/i.test(text) ? 'AI tools' : '');

  /* Everything that is not the TNG statement is checked, then becomes a claim line.
     Returns how many of each kind were added. opts.force = add by hand without checking. */
  async function onOther(files, opts) {
    opts = opts || {};
    const added = { photos: 0, invoices: 0, hotel: 0, unknown: 0, rejected: 0 };
    const mp = monthParts();
    for (const file of Array.from(files).filter(readable)) {
      if (S.other.some((o) => o.files.some((x) => x.file.name === file.name && x.file.size === file.size))) continue;
      if (!isPdf(file) && !isImage(file)) { reject(file, Validate.MSG.type, false); added.rejected++; continue; }
      const mk = () => ({ file, url: URL.createObjectURL(file) });
      const blank = (extra) => S.other.push(Object.assign({ id: uid(), kind: 'other', files: [mk()], category: '', name: '', date: '', receiptNo: '', amount: '', auto: {} }, extra));

      if (opts.force) {                                   // the person chose to add it anyway
        const date = guessDate(file);
        blank({ category: isImage(file) ? 'Petrol' : '', date, auto: date ? { date: true } : {} });
        added.unknown++;
        continue;
      }

      if (isPdf(file)) {
        const s = await sniff(file);
        const info = s.stripe;
        if (info) {                                       // Stripe-style invoice or receipt (Eleven Labs, Runway ...)
          const target = S.other.find((o) => o.invoiceNo === info.invoiceNo);
          if (target) {                                   // the other half of an invoice + receipt pair: same claim line
            target.files.push(mk());
            if (info.isReceipt && info.date) target.date = info.date;
            if (info.amount != null) {                    // the receipt's ringgit charge replaces any converted estimate
              target.amount = info.amount.toFixed(2); delete target.hint; delete target.fx;
              if (target.auto) delete target.auto.amount;
            }
            if (!target.name && info.merchant) target.name = info.merchant;
          } else {
            let amount = info.amount, fx = null, hint = '';
            if (amount == null) {                         // invoice only, in USD etc.: convert to ringgit until the receipt is added
              const f = Petrol.foreignTotal(s.text);
              const c = f && await Fx.toMyr(f.code, f.amount, info.date);
              if (c) { amount = c.myr; fx = c; }
              else hint = f ? `Invoice is in ${f.code} ${f.amount.toFixed(2)} – attach the receipt PDF, or type the MYR amount from your card statement`
                : 'Invoice only – attach the receipt PDF too so the MYR amount can be filled in';
            }
            blank({ invoiceNo: info.invoiceNo, category: 'AI tools', name: info.merchant, date: info.date, receiptNo: info.invoiceNo.replace(/-/g, ''),
              amount: amount != null ? amount.toFixed(2) : '', hint, fx, auto: fx ? { amount: true } : {} });
          }
          added.invoices++;
        } else if (s.hotel) {                             // Agoda receipt
          const hx = window.Extract ? Extract.read(s.lines && s.lines.length ? s.lines : s.text, { month: mp && mp.key }) : null;          // its booking number
          blank({ category: 'Accommodation', name: s.hotel.merchant, date: s.hotel.date, amount: s.hotel.amount != null ? s.hotel.amount.toFixed(2) : '', receiptNo: hx && hx.confidence.number >= 0.6 ? hx.number : '' });
          added.hotel++;
        } else {                                          // any other PDF: must really be a receipt or invoice
          let text = s.text, source = 'pdf';
          if (!s.hasText && cfg.ocr) {                    // a scan: read the page image
            try { text = await OCR.readCanvas(await Receipts.renderFirstPage(await file.arrayBuffer())); source = 'scan'; } catch (e) { text = ''; }
          }
          const verdict = Validate.judge(text, source);
          if (verdict.status !== 'ok') { reject(file, verdict.reason, verdict.force, verdict.mc); added.rejected++; continue; }
          const p = Petrol.parse(text, { month: mp && mp.key, stations: stations() });
          const x = window.Extract ? Extract.read(s.lines && s.lines.length ? s.lines : text, { month: mp && mp.key }) : null;
          if (x && forGeneral(x, p, text)) {
            const same = x.number && S.other.find((o) => !o.invoiceNo && String(o.receiptNo || '').replace(/\W/g, '').toLowerCase() === x.number.replace(/\W/g, '').toLowerCase());
            if (same) { same.files.push(mk()); added.invoices++; continue; }          // the same document number: another copy of it
            blank({ category: '', ocr: 'reading' });
            const item = S.other[S.other.length - 1];
            finishGeneral(item, file, x, text, mp, source === 'scan').catch((e) => { console.warn('Reading failed', e); if (S.other.includes(item)) { setOcr(item, 'done'); renderLines(); } });       // Claude may take a few seconds: the line shows at once and fills in
            added.invoices++;
            continue;
          }
          const target = p.receiptNo && S.other.find((o) => o.receiptNo === p.receiptNo && !o.invoiceNo);
          if (target) { target.files.push(mk()); }       // same document number: group with the other copy
          else {
            let fx = null, hint = '';
            if (!p.amount && p.foreign) {                // in USD etc.: claimed in ringgit
              const c = await Fx.toMyr(p.foreign.code, p.foreign.amount, p.date);
              if (c) { p.amount = c.myr.toFixed(2); fx = c; }
              else hint = `Receipt is in ${p.foreign.code} ${p.foreign.amount.toFixed(2)} – type the MYR amount from your card statement`;
            }
            const auto = {};
            ['date', 'amount', 'receiptNo'].forEach((k) => { if (p[k]) auto[k] = true; });
            if (p.station) auto.name = true;
            blank({ category: p.category || guessCategory(text), name: p.station, date: p.date, amount: p.amount, receiptNo: p.receiptNo, auto, fx, hint });
            const twins = p.receiptNo && window.Extract ? Extract.twinsOf(p.receiptNo, text) : [];
            if (twins.length) settleNumber(S.other[S.other.length - 1], file, text, [p.receiptNo].concat(twins), mp).catch((e) => console.warn('Number check failed', e));
          }
          added.invoices++;
        }
      } else {                                            // a photo: most often a petrol receipt
        const date = guessDate(file);
        const item = { id: uid(), kind: 'other', files: [mk()], category: 'Petrol', name: store.get('wfc-last-station', ''), date, auto: date ? { date: true } : {}, receiptNo: '', amount: '' };
        S.other.push(item);
        added.photos++;
        if (cfg.ocr) { item.ocr = 'queued'; readPhoto(item); }
      }
    }
    refreshStatus(); renderLines();
    return added;
  }

  /* One box for everything: sort the files, then say what was found. */
  async function routeFiles(list) {
    const files = Array.from(list).filter(readable);
    if (!files.length) return;
    $('#fileNotes').textContent = '';
    const tngs = [], rest = [];
    for (const f of files) (isPdf(f) && (await sniff(f)).isTng ? tngs : rest).push(f);
    const found = [];
    if (tngs.length) {
      await onTng([tngs[0]]);
      found.push('TNG statement');
      if (tngs.length > 1) fileNote('warn', `More than one TNG statement was added; only "${tngs[0].name}" is used.`);
    }
    if (rest.length) {
      const c = await onOther(rest);
      const plural = (n, s) => `${n} ${s}${n > 1 ? 's' : ''}`;
      if (c.photos) found.push(plural(c.photos, 'photo') + (cfg.ocr ? ' (reading…)' : ''));
      if (c.invoices) found.push(plural(c.invoices, 'invoice / receipt'));
      if (c.hotel) found.push(plural(c.hotel, 'hotel receipt'));
      if (c.unknown) found.push(plural(c.unknown, 'other file'));
    }
    if (found.length) fileNote('info', 'Added: ' + found.join(', '));      // refused files get their own red card, with the reason
  }

  function wireDrop() {
    const zone = $('#dropAll'), input = $('#fileAll');
    input.addEventListener('change', () => { const f = Array.from(input.files); input.value = ''; routeFiles(f); });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', (e) => routeFiles(Array.from(e.dataTransfer.files)));
    // Ctrl+V anywhere on the page: files copied in Explorer, or an image copied from a chat / screenshot
    document.addEventListener('paste', (e) => {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      if (!files.length) return;
      e.preventDefault();
      if ($('#viewLeave').hidden) routeFiles(files); else attachMc(files);     // the leave tab takes MCs
    });
    // the MC box on the leave tab
    const mcZone = $('#dropMc'), mcInput = $('#fileMc');
    mcInput.addEventListener('change', () => { const f = Array.from(mcInput.files); mcInput.value = ''; attachMc(f); });
    ['dragenter', 'dragover'].forEach((ev) => mcZone.addEventListener(ev, (e) => { e.preventDefault(); mcZone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => mcZone.addEventListener(ev, (e) => { e.preventDefault(); mcZone.classList.remove('over'); }));
    mcZone.addEventListener('drop', (e) => attachMc(Array.from(e.dataTransfer.files)));
  }

  /* ---------- build the claim pack ---------- */
  async function shrinkImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return null;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 1200000) return null;
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
      return blob && blob.size < file.size ? blob : null;
    } catch (e) { return null; }
  }

  function download(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  /* Writes the result where the person chose (or downloads the zip). Returns a label for where it went. */
  async function deliver({ dir, parts, files, zipName, zipBlob, zipToRoot, notes }) {
    if (!dir) {
      download(zipBlob, zipName);
      if (Folder.supported) notes.append(h('div', { class: 'note info', text: 'No save folder is chosen, so the zip went to your Downloads folder. Use "Choose folder" to pick one.' }));
      return '';
    }
    try {
      await Folder.saveFiles(dir, parts, files);
      if (zipToRoot) await Folder.writeFile(dir, zipName, zipBlob);
      return [dir.name].concat(parts).join(' / ');
    } catch (e) {
      console.error(e);
      notes.append(h('div', { class: 'note warn', text: `Could not write to "${dir.name}" (${e.message || e}). The zip was downloaded instead.` }));
      download(zipBlob, zipName);
      return '';
    }
  }

  /* ---------- the accountant's dashboard ---------- */
  /* shows the state of the send in the saved-claim box: sending... / done / could not (with Try again). Nothing here can stop the email. */
  function paintDash(box, p) {
    if (!box) return;
    box.textContent = '';
    const d = p.dash;
    if (!d) return;
    if (d.state === 'busy') box.append(h('div', { class: 'note info', text: d.text }));
    else if (d.state === 'ok') {
      box.append(h('div', { class: 'note ok', text: d.text }));
      if (d.skipped && d.skipped.length) box.append(h('div', { class: 'note warn', text: `${d.skipped.length} file${d.skipped.length > 1 ? 's were' : ' was'} too big for the dashboard (still in the zip): ${d.skipped.join(', ')}` }));
    } else if (d.state === 'skip') box.append(h('div', { class: 'note info', text: d.text }));
    else box.append(h('div', { class: 'note warn' }, d.text + ' ', h('button', { class: 'link', type: 'button', text: 'Try again', onclick: d.retry })));
  }

  /* kind: 'claim' (payload = the claim) or 'leave' (payload = the leave application); entries: [{ path, data, kind, line }] */
  function pushToDashboard(pack, payload, entries, kind) {
    const api = dashApi(), leave = kind === 'leave', what = leave ? 'leave form' : 'claim';
    pack.dash = null;
    if (!api || !$('#sendDash').checked) return Promise.resolve();
    const run = async () => {
      const set = (d) => { pack.dash = Object.assign({ retry: run }, d); paintDash(pack.dashEl, pack); };
      set({ state: 'busy', text: "Sending to the accountant's dashboard…" });
      try {
        if (leave) {          // an inbox that has not been updated yet only knows claims: say so instead of failing
          const info = await Accounts.ping(api).catch(() => null);
          if (info && !info.leave) { set({ state: 'skip', text: "The accountant's dashboard can't take leave forms yet. Your leave form is saved and the email still works." }); return; }
        }
        const r = await Accounts.send({
          api, claim: leave ? undefined : payload, leave: leave ? payload : undefined, files: entries.map((e) => ({ name: e.path, data: e.data, kind: e.kind, line: e.line })),
          onProgress: (p) => set({ state: 'busy', text: `Sending to the accountant's dashboard… ${Math.min(p.done, p.total - 1)} of ${p.total - 1} files` }),
        });
        set({ state: 'ok', text: "Also on the accountant's dashboard." + (r.version > 1 ? ` (This replaces the earlier version of this ${what}.)` : ''), skipped: r.skipped });
      } catch (e) {
        console.error(e);
        set({ state: 'bad', text: `Could not put it on the accountant's dashboard (${(e && e.message) || e}). Your ${what} is saved and the email still works.` });
      }
    };
    return run();
  }

  async function buildPack() {
    S.showErrors = true;
    const { lines: raw, tv } = compileLines();
    const v = validate(raw, tv);
    updateSummary();
    const notes = $('#buildNotes');
    notes.textContent = '';
    if (v.bad.length) { notes.append(h('div', { class: 'note bad', text: 'Fix the red items above first.' })); (document.querySelector('.line .status.bad') || $('#notes')).scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }

    const btn = $('#btnBuild');
    S.building = true; btn.disabled = true; btn.textContent = 'Saving…';
    const dir = await Folder.ready();     // first thing: the folder picker needs the click that started this
    try {
      await Lazy.need('zip', 'jspdf', 'claim');          // normally already there: they load quietly in the background
      const mp = monthParts();
      const claimant = $('#claimant').value.trim();
      const signature = $('#signature').value.trim() || claimant;
      const lines = sortedForBuild(raw);
      // every attached file must still be readable. A file that was moved, renamed or deleted after it was added (or is only online in OneDrive)
      // makes the browser fail late with "A requested file or directory could not be found", so check now and say which file it is
      for (const l of lines) {
        for (const f of l.files || []) {
          try { await f.slice(0, 16).arrayBuffer(); }
          catch (e) { throw new Error(`"${f.name}" can't be read any more. It was probably moved, renamed or deleted after you added it, or it is only stored online (OneDrive). Remove it from the claim and add it again, or use Start over and add your files again.`); }
        }
      }
      const claimLines = lines.map((l) => Object.assign({ category: String(l.category).trim(), date: l.date, name: String(l.name).trim(), receiptNo: String(l.receiptNo || '').trim(), amount: num(l.amount) },
        /petrol|fuel/i.test(l.category) && l.litres ? { litres: Math.round(num(l.litres) * 1000) / 1000, fuel: l.fuel === 'diesel' ? 'diesel' : 'petrol' } : {},       // litres: for the dashboard's carbon figures
        l.src && l.src.scan ? { scan: (({ docType, currency, total, subtotal, tax, taxType, paymentMethod, last4, dueDate, periodStart, periodEnd, source }) => ({ docType, currency, total, subtotal, tax, taxType, paymentMethod, last4, dueDate, periodStart, periodEnd, source }))(l.src.scan) } : {}));
      const signDate = localIso(new Date());
      const base = { year: mp.y, month: mp.m, claimant, signature, signDate, lines: claimLines };

      const xlsx = await ClaimXlsx.build(base);
      const pdf = await ClaimPdf.claim(Object.assign({}, base, { total: xlsx.total }));

      const folder = safe(`Claim - ${monthLabel(mp)} - ${claimant}`);
      const tag = MONTH_TAG[mp.m - 1];
      const zip = new JSZip();
      const root = zip.folder(folder);
      const entries = [];
      // kind / line say what a file is, for the accountant's dashboard (line = the number of the claim line a receipt belongs to)
      const add = (path, data, kind, line) => { root.file(path, data); entries.push({ path, data, size: data.size != null ? data.size : data.byteLength, kind: kind || 'other', line: line || 0 }); };

      add(`WFC - ${tag} Claim form.xlsx`, xlsx.data, 'form-xlsx');
      add(`WFC - ${tag} Claim form.pdf`, pdf, 'form-pdf');

      if (S.tng) {
        add(safe(S.tng.file.name), S.tng.buf, 'tng');
        add('TNG toll check list.pdf', ClaimPdf.tollBreakdown({
          claimant, monthLabel: monthLabel(mp), serial: S.tng.header.serial, period: S.tng.header.periodText,
          rows: tv.rows.map((r) => Object.assign({}, r, { why: tripWhy(r) })),
          total: num((raw.find((l) => l.kind === 'toll') || {}).amount), calculatedToll: tv.toll,          // what is claimed (may be typed over) vs what the ticks add up to
          parkingTotal: num((raw.find((l) => l.kind === 'parking') || {}).amount), calculatedParking: tv.parking,
        }), 'tollcheck');
      }

      const shrink = $('#shrink').checked;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.kind === 'toll' || l.kind === 'parking') continue;
        const n = pad(i + 1);
        for (let k = 0; k < l.files.length; k++) {
          const f = l.files[k];
          const suffix = l.files.length > 1 ? String.fromCharCode(97 + k) : '';
          const stem = safe(`Receipt ${n}${suffix} - ${l.category} - ${ClaimPdf.fmtDate(l.date).replace(/\//g, '-')}`);
          const small = shrink ? await shrinkImage(f) : null;
          if (small) add(`${stem}.jpg`, small, 'receipt', i + 1);
          else add(`${stem}.${ext(f.name)}`, f, 'receipt', i + 1);
        }
      }

      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const zipName = folder + '.zip';
      // the month folder holds the files; the zip (for email) sits next to it
      const savedTo = await deliver({ dir, parts: [monthLabel(mp)], files: entries.map((e) => ({ name: e.path, data: e.data })), zipName, zipBlob: blob, zipToRoot: true, notes });
      S.packs.claim = {
        kind: 'claim', blob, name: zipName, entries, savedTo, stale: false,
        title: `${zipName}  ·  ${sizeText(blob.size)}  ·  ${lines.length} line${lines.length > 1 ? 's' : ''}  ·  RM ${money(xlsx.total)}`,
        attachments: [{ name: zipName, blob }],
      };
      renderPack('claim');
      walletClaimed(mp.key);                           // receipts picked from My receipts are now claimed in this month
      if (window.Remind) { Remind.markClaimed(mp.key); if (remindReady) Remind.touch(remindPost, { name: claimant, email: owner() }); paintRemindBar(); }      // no more nudges for this month
      $('#pack').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // the email is still how the zip travels; this also puts the claim on the accountant's dashboard
      pushToDashboard(S.packs.claim, {
        claimant, month: mp.key, lines: claimLines.map((l) => Object.assign({}, l, { amount: round2(l.amount) })), scanLog: scanLog(),
        from: $('#fromEmail').value.trim(), to: $('#toEmail').value.trim(), subject: $('#subject').value,
      }, entries, 'claim');
    } catch (e) {
      console.error(e);
      notes.append(h('div', { class: 'note bad', text: 'Could not save the claim: ' + (e.message || e) }));
    } finally {
      S.building = false; btn.textContent = 'Save my claim'; renderSteps();
    }
  }

  /* ---------- leave application ---------- */
  const SHORT_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const TYPE_LABEL = { annual: 'Annual leave', sick: 'Sick leave', unpaid: 'Unpaid leave', personal: 'Personal leave', other: 'Other leave' };
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  function leaveData() {
    const name = $('#lName').value.trim();
    return {
      name, type: $('#lType').value, reason: $('#lReason').value.trim(), from: $('#lFrom').value, to: $('#lTo').value,
      signature: $('#lSign').value.trim() || name, signDate: $('#lSignDate').value,
    };
  }

  function rangeText(from, to) {
    const f = new Date(from + 'T00:00:00Z'), t = new Date(to + 'T00:00:00Z');
    const d = (x) => x.getUTCDate(), m = (x) => SHORT_MON[x.getUTCMonth()], y = (x) => x.getUTCFullYear();
    if (from === to) return `${d(f)} ${m(f)} ${y(f)}`;
    if (y(f) === y(t) && f.getUTCMonth() === t.getUTCMonth()) return `${d(f)} - ${d(t)} ${m(f)} ${y(f)}`;
    if (y(f) === y(t)) return `${d(f)} ${m(f)} - ${d(t)} ${m(t)} ${y(f)}`;
    return `${d(f)} ${m(f)} ${y(f)} - ${d(t)} ${m(t)} ${y(t)}`;
  }

  function leaveErrors(d) {
    const e = [];
    if (!d.name) e.push('Enter the employee name.');
    if (!d.reason) e.push('Enter the reason for leave.');
    if (!d.from || !d.to) e.push('Choose the leave dates.');
    else if (d.to < d.from) e.push('The "to" date is before the "from" date.');
    if (!d.signDate) e.push('Enter the date signed.');
    return e;
  }

  function refreshLeaveEmail() {
    const d = leaveData();
    const range = d.from && d.to && d.to >= d.from ? rangeText(d.from, d.to) : '';
    if (!S.touched.lSubject) $('#lSubject').value = range ? `Leave application - ${range}` : 'Leave application';
    if (!S.touched.lBody) {
      $('#lBody').value = [
        `Hi ${cfg.toName || 'there'},`, '',
        `Please find attached my leave application (${TYPE_LABEL[d.type]})${range ? ' for ' + range : ''}.`,
        d.reason ? `Reason: ${d.reason}` : null, '',
        'Thank you.', '', 'Regards,', cfg.signoff || d.signature || d.name,
      ].filter((x) => x !== null).join('\n');
    }
  }

  function addDaysOff(from, to) {
    const f = ClaimPdf.dmy(from), t = ClaimPdf.dmy(to);
    const txt = from === to ? f : `${f}-${t}`;
    const el = $('#daysOff');
    const cur = el.value.trim();
    if (cur.split(/[,;]/).map((s) => s.trim()).includes(txt)) return;
    el.value = cur ? `${cur}, ${txt}` : txt;
    renderLines();
  }

  async function buildLeave() {
    const d = leaveData();
    const notes = $('#lNotes');
    notes.textContent = '';
    const errs = leaveErrors(d);
    if (errs.length) { errs.forEach((t) => notes.append(h('div', { class: 'note bad', text: t }))); return; }

    const btn = $('#lBuild');
    btn.disabled = true; btn.textContent = 'Saving…';
    const dir = await Folder.ready();
    try {
      await Lazy.need('zip', 'jspdf', 'leave');
      const xlsx = await ClaimXlsx.buildLeave(d);
      const pdf = await ClaimPdf.leave(d);
      const sd = new Date(d.signDate + 'T00:00:00Z'), fd = new Date(d.from + 'T00:00:00Z');
      const base = safe(`WFC - ${MONTH_TAG[sd.getUTCMonth()]} Leave form (${fd.getUTCDate()}${SHORT_MON[fd.getUTCMonth()]})`);
      const files = [
        { name: base + '.xlsx', data: new Blob([xlsx], { type: XLSX_TYPE }), kind: 'form-xlsx' },
        { name: base + '.pdf', data: new Blob([pdf], { type: 'application/pdf' }), kind: 'form-pdf' },
      ];
      S.mc.forEach((m, i) => files.push({ name: safe(`MC ${i + 1} - ${rangeText(d.from, d.to)}`) + '.' + ext(m.file.name), data: m.file, kind: 'mc' }));
      const zip = new JSZip();
      files.forEach((f) => zip.file(f.name, f.data));
      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const savedTo = await deliver({ dir, parts: ['Leave form'], files, zipName: base + '.zip', zipBlob, zipToRoot: false, notes });
      S.packs.leave = {
        kind: 'leave', blob: zipBlob, name: base + '.zip', savedTo, stale: false,
        title: `${base}  ·  ${TYPE_LABEL[d.type]}  ·  ${rangeText(d.from, d.to)}`,
        entries: files.map((f) => ({ path: f.name, size: f.data.size })),
        attachments: files.map((f) => ({ name: f.name, blob: f.data })),
      };
      renderPack('leave');
      addDaysOff(d.from, d.to);       // leave days are never claimed for toll, so they always go into the claim's days off
      // the leave form also goes to the accountant's dashboard (Leave tab), the same way a claim does; the email is unchanged
      pushToDashboard(S.packs.leave, {
        claimant: d.name, type: d.type, start: d.from, end: d.to, days: Accounts.leaveDays(d.from, d.to, TNG.parseHolidays(cfg.holidays)), reason: d.reason, signedOn: d.signDate,
        from: $('#lFromEmail').value.trim(), to: $('#lToEmail').value.trim(), subject: $('#lSubject').value,
      }, files.map((f) => ({ path: f.name, data: f.data, kind: f.kind })), 'leave');
    } catch (e) {
      console.error(e);
      notes.append(h('div', { class: 'note bad', text: 'Could not save the leave form: ' + (e.message || e) }));
    } finally {
      btn.disabled = false; btn.textContent = 'Save my leave form';
    }
  }

  const staleLeave = () => { const p = S.packs.leave; if (p && !p.stale) { p.stale = true; renderPack('leave'); } };

  /* ---------- medical certificate (MC) on the leave application ---------- */
  S.mc = [];

  function renderMc() {
    const box = $('#mcFiles');
    box.textContent = '';
    S.mc.forEach((m) => {
      const label = [m.info.mcNo, m.info.from && (m.info.from === m.info.to ? ClaimPdf.dmy(m.info.from) : `${ClaimPdf.dmy(m.info.from)} to ${ClaimPdf.dmy(m.info.to)}`)].filter(Boolean).join(' · ');
      box.append(h('span', { class: 'mcitem' }, chip(m.file, m.url), label ? h('span', { class: 'tag', text: label }) : null,
        h('button', { class: 'icon', type: 'button', title: 'Remove', 'aria-label': 'Remove MC', text: '×', onclick: () => { URL.revokeObjectURL(m.url); S.mc = S.mc.filter((x) => x !== m); renderMc(); staleLeave(); } })));
    });
  }

  /* dates, type and reason come from the MC; amber until the person edits them */
  function fillFromMc() {
    if (!S.mc.length) return;
    const froms = S.mc.map((m) => m.info.from).filter(Boolean).sort();
    const tos = S.mc.map((m) => m.info.to).filter(Boolean).sort();
    const auto = (id, v) => { const el = $(id); el.value = v; el.classList.add('guess'); };
    if (froms.length) { auto('#lFrom', froms[0]); S.touched.lTo = true; }
    if (tos.length) auto('#lTo', tos[tos.length - 1]);
    $('#lType').value = 'sick';
    const dx = S.mc.map((m) => m.info.diagnosis).find(Boolean), no = S.mc.map((m) => m.info.mcNo).find(Boolean);
    if (!$('#lReason').value.trim() || $('#lReason').classList.contains('guess')) auto('#lReason', `Sick${dx ? ' - ' + dx : ''}${no ? ' (' + no + ')' : ''}`);
    refreshLeaveEmail(); staleLeave();
  }

  async function attachMc(list) {
    const notes = $('#mcNotes');
    notes.textContent = '';
    const refuse = (file, why) => notes.append(h('div', { class: 'note bad' }, h('b', { text: file.name }), ' was not added. ', why));
    for (const file of Array.from(list).filter(readable)) {
      if (S.mc.some((m) => m.file.name === file.name && m.file.size === file.size)) continue;
      if (!isPdf(file) && !isImage(file)) { refuse(file, Validate.MSG.type); continue; }
      let text = '';
      try {
        if (isPdf(file)) {
          const s = await sniff(file);
          text = s.hasText ? s.text : await OCR.readCanvas(await Receipts.renderFirstPage(await file.arrayBuffer()));
        } else {
          notes.append(h('div', { class: 'note info', text: `Reading ${file.name}…` }));
          // a photo of an MC is often sideways: say what a good reading holds (the title), so the reader turns the photo until it finds it
          text = await OCR.read(file, { good: Petrol.isMcText, turnIfMissing: true, rescue: false });
          notes.lastChild.remove();
        }
      } catch (e) { refuse(file, e && e.code === 'decode' ? Validate.MSG.decode : "Couldn't read this file. Please attach a clearer copy."); continue; }
      const info = Petrol.mc(text);
      if (!info) { refuse(file, text.replace(/[^A-Za-z0-9]/g, '').length < 25 ? Validate.MSG.photoUnreadable : Validate.MSG.notMc); continue; }
      S.mc.push({ file, url: URL.createObjectURL(file), info });
    }
    renderMc(); fillFromMc();
  }

  function syncLeaveDefaults() {
    if (!S.touched.lName) $('#lName').value = $('#claimant').value;
    if (!S.touched.lSign) $('#lSign').value = $('#signature').value;
    applyUser(); $('#lToEmail').value = cfg.toEmail;
    refreshLeaveEmail();
  }

  function showView(v) {
    $('#viewClaim').hidden = v !== 'claim';
    $('#stepper').hidden = v !== 'claim';           // the 1-2-3-4 bar belongs to the claim only
    $('#viewLeave').hidden = v !== 'leave';
    $('#tabClaim').classList.toggle('on', v === 'claim');
    $('#tabLeave').classList.toggle('on', v === 'leave');
    $('#tabClaim').setAttribute('aria-selected', String(v === 'claim'));
    $('#tabLeave').setAttribute('aria-selected', String(v === 'leave'));
    if (v === 'leave') { syncLeaveDefaults(); markNeededLeave(); }
    else { applyUser(); $('#toEmail').value = cfg.toEmail; renderSteps(); }
  }

  /* ---------- email panel ---------- */
  const mailFields = () => ({ from: $('#fromEmail').value.trim(), to: $('#toEmail').value.trim(), subject: $('#subject').value, body: $('#body').value });
  const leaveMailFields = () => ({ from: $('#lFromEmail').value.trim(), to: $('#lToEmail').value.trim(), subject: $('#lSubject').value, body: $('#lBody').value });

  function renderPack(kind) {
    const p = S.packs[kind];
    const box = $(kind === 'claim' ? '#pack' : '#lPack');
    const fields = kind === 'claim' ? mailFields : leaveMailFields;
    // one blue button at a time: once the claim is saved, the blue one is the button that makes the email draft; saving again turns blue only after a change
    const saveBtn = $(kind === 'claim' ? '#btnBuild' : '#lBuild');
    const saved = !!p && !p.stale;
    saveBtn.classList.toggle('primary', !saved); saveBtn.classList.toggle('ghost', saved);
    if (!p) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = '';
    const dashBox = h('div', { class: 'dashstat' });          // for a claim and for a leave form: did it also reach the accountant's dashboard?
    p.dashEl = dashBox; paintDash(dashBox, p);
    box.append(h('div', {},
      h('h3', { text: p.title }),
      p.savedTo ? h('div', { class: 'note ok', text: 'Saved to ' + p.savedTo + (kind === 'claim' ? ' (the zip is next to it)' : '') }) : h('div', { class: 'note info', text: 'Downloaded to your Downloads folder.' }),
      dashBox,
      p.stale ? h('div', { class: 'note warn', text: `You changed something after saving – save again before sending.` }) : null,
      p.blob.size / 1048576 > 24 ? h('div', { class: 'note warn', text: 'This is over 24 MB, which Gmail may refuse. Tick "Shrink photos" and save again, or send it by link.' }) : null,
      h('details', { class: 'zipfiles' }, h('summary', { text: `What is inside the zip (${p.entries.length} files)` }), h('ul', {}, p.entries.map((e) => h('li', { text: `${e.path} (${sizeText(e.size)})` }))))));
    const files = p.attachments.map((a) => new File([a.blob], a.name, { type: a.blob.type || 'application/octet-stream' }));
    const canShare = !!(navigator.canShare && navigator.canShare({ files }));
    const what = p.attachments.length > 1 ? 'files' : 'zip';
    const outlook = !!S.user && S.user.provider === 'microsoft';      // signed in with Microsoft: Outlook buttons; otherwise the Gmail ones
    const clientId = gmailClientId();
    const msId = msClientId();
    const gstat = h('div', { class: 'gstat' });
    const say = (cls, ...kids) => { gstat.textContent = ''; if (cls) gstat.append(h('div', { class: 'note ' + cls }, ...kids)); };
    /* the draft is made in the person's own mailbox; open it straight away (a browser may refuse a new tab this long after the click, then the big button does it) */
    const draftReady = (d, mailName) => {
      const tab = window.open(d.url, '_blank');
      if (tab) {
        try { tab.opener = null; } catch (e) { /* cross-origin already */ }
        say('ok', `Your ${mailName} draft is open in a new tab with the ${what} attached. Check it and press Send. `, h('a', { href: d.url, target: '_blank', rel: 'noopener', text: 'Open it again' }));
      } else {
        say('ok', `Your ${mailName} draft is ready with the ${what} attached. `, h('a', { class: 'openlink', href: d.url, target: '_blank', rel: 'noopener', text: 'Open the draft and press Send' }));
      }
    };
    const makeDraft = async (btn) => {
      const m = fields();
      btn.disabled = true;
      say('info', 'Signing in to Google…');
      try {
        draftReady(await Gmail.createDraft({ clientId, hint: m.from, makeBlob: () => { say('info', `Putting the ${what} into a Gmail draft…`); return Mail.emlBlob({ to: m.to, subject: m.subject, body: m.body, attachments: p.attachments }); } }), 'Gmail');
      } catch (e) {
        say('bad', String((e && e.message) || e));
      }
      btn.disabled = false;
    };
    const makeOutlookDraft = async (btn) => {
      const m = fields();
      btn.disabled = true;
      say('info', 'Signing in to Microsoft…');
      try {
        draftReady(await Outlook.createDraft({ clientId: msId, email: m.from, to: m.to, subject: m.subject, body: m.body, attachments: p.attachments, onStatus: (t) => say('info', t) }), 'Outlook');
      } catch (e) {
        say('bad', String((e && e.message) || e));
      }
      btn.disabled = false;
    };
    if (outlook) { if (msId) Outlook.preload(msId).catch(() => {}); }
    else if (clientId) Gmail.preload().catch(() => {});             // so the Google sign-in popup can open straight from the click
    const openName = outlook ? 'Outlook' : 'Gmail';
    const hasDraft = outlook ? !!msId : !!clientId;      // can this page put the zip into a draft for this person?
    const openBlank = () => window.open(outlook ? Outlook.composeLink(Object.assign({ personal: !!(S.user && S.user.personal) }, fields())) : Mail.gmailLink(fields()), '_blank', 'noopener');
    // the ONE blue button: the person's own mail, matched to the account they signed in with
    // Outlook with no Microsoft app registered (or a mailbox that is not on Microsoft's servers): the email file is the way.
    // Double-clicking it opens a new message in the person's own Outlook with the zip already attached.
    const fileOnly = outlook && !msId;
    const downloadEml = async () => {
      const m = fields();
      download(await Mail.emlBlob({ from: m.from, to: m.to, subject: m.subject, body: m.body, attachments: p.attachments }), safe(m.subject) + '.eml');
      // the first few times, a one-time tip so the double-click can be skipped from then on
      const shown = store.get('wfc-eml-tip', 0);
      store.set('wfc-eml-tip', shown + 1);
      say('ok', `The email file is downloaded. Double-click it to open it in Outlook with the ${what} attached, check it and press Send.`,
        shown < 3 ? h('span', { class: 'tip', text: 'Tip: to skip the double-click next time, open your browser\'s download list, press the three dots next to this file and choose "Always open files of this type".' }) : null);
    };
    const mainBtn = hasDraft
      ? h('button', { class: 'primary big', type: 'button', text: `Create ${openName} draft`, onclick: (e) => (outlook ? makeOutlookDraft : makeDraft)(e.currentTarget) })
      : fileOnly
        ? h('button', { class: 'primary big', type: 'button', text: 'Download email for Outlook', onclick: downloadEml })
        : h('button', { class: 'primary big', type: 'button', text: `Open ${openName} draft`, onclick: openBlank });
    // everything else is small and tucked away, so nobody has to choose between six buttons
    const mini = (text, onclick, title) => h('button', { class: 'ghost mini', type: 'button', text, title, onclick });
    const more = [
      hasDraft || fileOnly ? mini(`Open ${openName} without the file`, openBlank) : null,
      fileOnly ? null : mini('Download email file (.eml)', downloadEml, `Opens in Outlook or Apple Mail with the ${what} already attached`),
      mini(`Download ${what} again`, () => download(p.blob, p.name)),
      canShare ? mini('Share…', () => navigator.share({ files, title: fields().subject, text: fields().body }).catch(() => {})) : null,
      outlook || clientId ? null : h('button', { class: 'link', type: 'button', text: `Set up a Gmail draft with the ${what} attached…`, onclick: openSettings }),
    ].filter(Boolean);
    const hint = fileOnly
      ? `Double-click the email file and it opens in Outlook with the ${what} attached.`
      : hasDraft
      ? `Opens ${openName} with the ${what} attached. Nothing is sent until you press Send.`
      : `${openName} opens with the email filled in. Attach the ${what} from the saved folder.`;
    box.append(h('div', { class: 'sendbox' },
      mainBtn,
      h('p', { class: 'hint sendhint', text: hint }),
      gstat,
      h('details', { class: 'moreways' }, h('summary', { text: 'Other ways to send' }), h('div', { class: 'moreactions' }, more))));
  }

  /* ---------- save folder ---------- */
  async function refreshLoc() {
    const handle = Folder.supported ? await Folder.getSaved() : null;
    document.querySelectorAll('.loc').forEach((box) => {
      box.textContent = '';
      if (!Folder.supported) { box.append(h('span', { class: 'muted', text: 'Saved to your Downloads.' })); return; }
      box.append(h('span', { text: 'Save to:' }), h('b', { text: handle ? handle.name : 'not chosen yet' }),
        h('button', { class: 'link', type: 'button', text: handle ? 'Change folder' : 'Choose folder', onclick: changeFolder }));
    });
    const sName = $('#sLocName');
    if (sName) sName.textContent = !Folder.supported ? "This browser can't save into a folder (use Chrome or Edge)." : handle ? handle.name : 'Not chosen yet';
    const forget = $('#sLocForget');
    if (forget) forget.hidden = !handle;
    const change = $('#sLocChange');
    if (change) { change.hidden = !Folder.supported; change.textContent = handle ? 'Change folder' : 'Choose folder'; }
  }

  async function changeFolder() {
    try { await Folder.pick(); } catch (e) { /* cancelled */ }
    refreshLoc();
  }

  /* ---------- settings dialog ---------- */
  function openSettings() {
    $('#sToName').value = cfg.toName; $('#sSignoff').value = cfg.signoff;
    $('#sHol').value = cfg.holidays;
    $('#sGmail').value = cfg.gmailClientId || '';
    $('#sGmail').placeholder = DEFAULTS.gmailClientId || '1234567890-abc123.apps.googleusercontent.com';
    $('#sMs').value = cfg.msClientId || '';
    $('#sMs').placeholder = DEFAULTS.msClientId || '00000000-0000-0000-0000-000000000000';
    $('#sDash').value = cfg.dashApi || '';
    $('#sDash').placeholder = DEFAULTS.dashApi || 'https://script.google.com/macros/s/…/exec';
    refreshLoc();
    $('#dlg').showModal();
  }

  /* On this PC's own copy (localhost), when the local claims inbox is running, link to it instead of the built-in online one, so a demo
     on this PC never mixes with real claims. Nothing happens on the live site or when the local inbox is not running. */
  function autoLinkDash() {
    const explicit = (store.get('wfc-claim-cfg', {}) || {}).dashApi;         // what this PC was told on purpose (Settings or the demo link), not the built-in address
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || explicit) return;
    const api = 'http://localhost:8787/api';
    fetch(api + '?action=ping', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
      if (j && j.ok && j.service === 'wfc-claims' && j.where === 'local') { cfg.dashApi = api; saveCfg(); refreshDash(); }
    }).catch(() => { /* no local inbox: stay email-only */ });
  }

  /* Claude through the company: when the claims inbox holds an Anthropic key, this browser can use it with nothing to paste. Asked once per visit;
     if the inbox is out of reach or has no key, nothing changes. A key pasted in the Claude panel still wins. */
  function linkTeamClaude() {
    const api = dashApi();
    if (!api || !window.Accounts) return;
    if (!window.PlanB) { Accounts.ping(api).then(remindServerReady).catch(() => {}); return; }
    Accounts.ping(api).then((j) => { remindServerReady(j); if (j && j.claude) { PlanB.useTeam(api); if (window.AiPanel) AiPanel.refresh(); } }).catch(() => { /* stay as before */ });
  }

  /* the tick box under Save my claim only exists when there is a dashboard to send to */
  function refreshDash() {
    $('#dashOpt').hidden = !dashApi();
    $('#sendDash').checked = cfg.sendDash !== false;
  }

  /* ---------- init ---------- */
  /* ---------- My receipts: snap a receipt with the phone right away, keep it, claim it later (storage and Google Drive: js/wallet.js) ----------
     A snapped receipt is kept at once (before it is read), checked for blur while the paper is still in hand, read like any receipt photo, and
     kept with what was read. At claim time the receipts are picked from My receipts (no reading again); once the claim is saved they are
     marked claimed in that month and can't be picked again. */
  const W = { list: [], sel: new Set() };
  const owner = () => (S.user && S.user.email) || '';
  const canDrive = () => !!(S.user && S.user.provider === 'google' && S.user.email && gmailClientId() && window.Wallet);
  const monthNow = () => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1, key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }; };
  const monthWord = (key) => (/^\d{4}-\d{2}$/.test(key || '') ? `${MONTH_NAMES[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}` : 'No date');
  const alive = (item) => S.other.includes(item) || !!(item.snap && !item.snap.closed);
  // a photo that is not a usable receipt: on the claim, a red note; in the snap window, said there
  function refuse(item, file, reason, canForce, isMc) {
    if (item.snap) { item.snap.refused = reason; return; }
    dropItem(item); reject(file, reason, canForce, isMc);
  }

  // the Drive line under the snap and in My receipts: where the receipts are kept, and the one button that keeps a copy in Drive
  function driveLine(after) {
    if (!window.Wallet) return null;
    if (!canDrive()) return h('p', { class: 'driveline', text: S.user && S.user.provider === 'google' ? 'Kept on this device.' : 'Kept on this device. Sign in with Google to keep a copy in your own Google Drive.' });
    if (Wallet.connected()) return h('p', { class: 'driveline ok', text: 'Kept on this device and in your Google Drive (folder "WFC Receipts").' });
    if (window.Pwa && !Pwa.online()) return h('p', { class: 'driveline', text: 'Saved on this phone. You can copy it to your Google Drive when you are back online.' });
    return h('p', { class: 'driveline' }, 'Kept on this device. ',
      h('button', { class: 'link', type: 'button', text: 'Keep a copy in my Google Drive', onclick: () => driveConnect(after) }));
  }
  function driveConnect(after) {
    Wallet.connect(gmailClientId(), owner())          // first, still inside the click (the Google window)
      .then(() => Wallet.sync(owner())).then((res) => { W.list = res.list; if (res.errors.length) fileNote('warn', 'Google Drive: ' + res.errors[0]); if (after) after(); refreshWalletBar(); })
      .catch((e) => { alert(e.message || 'Google Drive could not be reached.'); });
  }
  function driveSyncQuiet() { if (window.Wallet && Wallet.connected()) Wallet.sync(owner()).then((res) => { W.list = res.list; refreshWalletBar(); }).catch(() => {}); }

  function openSnap() { const i = $('#snapInput'); i.value = ''; i.click(); }
  function readingRows(r, compact) {
    const rows = [['Type', r.category], ['Shop', r.name], ['Date', niceDate(r.date)], ['Amount', r.amount ? 'RM ' + money(num(r.amount)) : ''], ['Receipt no.', r.receiptNo]].filter((x) => x[1]);
    if (!rows.length) return h('p', { class: 'muted', text: 'Nothing could be read from it. You can type the details when you claim it.' });
    return h('dl', { class: compact ? 'rrows compact' : 'rrows' }, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]).flat());
  }
  async function onSnapped(file) {
    if (!file || !window.Wallet) return;
    const dlg = $('#snapDlg'), body = $('#snapBody'), url = URL.createObjectURL(file);
    const show = (...kids) => { body.textContent = ''; body.append(...kids.filter(Boolean)); };
    const pic = h('img', { class: 'snappic', src: url, alt: 'The receipt you snapped' });
    const close = () => { dlg.close(); };
    if (!dlg.open) dlg.showModal();
    show(pic, h('p', { class: 'snapst wait', text: 'Checking the photo…' }));
    const q = await Wallet.quality(file);
    if (!q.ok) {
      const why = q.problem === 'dark' ? 'too dark' : q.problem === 'small' ? 'too small' : 'blurry';
      const choice = await new Promise((resolve) => show(pic, h('p', { class: 'snapst bad', text: `This photo looks ${why}. Take it again while you still have the receipt?` }),
        h('div', { class: 'snapacts' }, h('button', { class: 'primary', type: 'button', text: 'Take it again', onclick: () => resolve('again') }),
          h('button', { class: 'ghost', type: 'button', text: 'Keep this one', onclick: () => resolve('keep') }))));
      if (choice === 'again') { URL.revokeObjectURL(url); close(); openSnap(); return; }
    }
    let rec;
    try { rec = await Wallet.add(file, owner(), {}); }         // kept before it is read: nothing is lost if the page is closed now
    catch (e) { show(pic, h('p', { class: 'snapst bad', text: "This photo couldn't be kept on this device (" + (e.message || e) + '). Add it to the claim directly instead.' })); return; }
    show(pic, h('p', { class: 'snapst wait', text: 'Saved. Reading the receipt…' }));
    const mp = monthNow(), item = { id: uid(), kind: 'other', files: [{ file, url }], category: 'Petrol', name: '', date: '', auto: { category: true }, receiptNo: '', amount: '', snap: {}, mp };
    try { await readPhoto(item); } catch (e) { console.warn('Reading the snap failed', e); }
    item.snap.closed = true;
    const refused = item.snap.refused;
    rec = (await Wallet.setReading(rec.id, refused ? {} : Wallet.readingOf(item))) || rec;
    driveSyncQuiet();
    refreshWalletBar();
    const r = rec.reading || {};
    show(pic,
      h('p', { class: 'snapst ' + (refused ? 'bad' : 'ok'), text: refused ? `Saved, but it could not be read as a receipt: ${refused.replace(/ Attach the receipt itself.*$/, '')}` : window.Pwa && !Pwa.online() ? 'Saved on your phone. No signal needed: it waits in My receipts.' : 'Saved to My receipts.' }),
      refused ? null : readingRows(r),
      !refused && r.review && r.review.length ? h('p', { class: 'snapst warn', text: 'Please check ' + plainList(r.review.map((k) => FIELD_WORD[k] || k)) + ' when you claim it.' }) : null,
      driveLine(() => onSnappedDone(rec)),
      h('div', { class: 'snapacts' },
        h('button', { class: 'primary', type: 'button', text: 'Snap another', onclick: () => { close(); openSnap(); } }),
        refused ? h('button', { class: 'ghost', type: 'button', text: 'Take it again', onclick: async () => { await Wallet.remove(rec.id); refreshWalletBar(); close(); openSnap(); } }) : null,
        h('button', { class: 'ghost', type: 'button', text: 'Done', onclick: close })));
  }
  function onSnappedDone() { refreshWalletBar(); }

  async function openWallet() {
    if (!window.Wallet) return;
    const dlg = $('#walletDlg');
    W.sel = new Set();
    if (!dlg.open) dlg.showModal();
    paintWallet(true);
    try { W.list = (await Wallet.sync(owner())).list; } catch (e) { W.list = []; fileNote('warn', "My receipts couldn't be opened: " + (e.message || e)); }
    paintWallet(false);
  }
  function paintWallet(loading) {
    const body = $('#walletBody'), mp = monthParts();
    body.textContent = '';
    const open = W.list.filter((r) => r.status !== 'claimed');
    body.append(h('p', { class: 'muted', text: 'Tick the receipts for this claim.' }), driveLine(() => paintWallet(false)));
    if (loading) { body.append(h('p', { class: 'snapst wait', text: 'Opening your receipts…' })); return; }
    if (!W.list.length) body.append(h('div', { class: 'empty', text: 'No receipts yet. Use "Snap a receipt" right after you pay, and they will wait here until you claim them.' }));
    Wallet.byMonth(W.list).forEach((g) => {
      const waiting = g.items.filter((r) => r.status !== 'claimed').length;
      const inClaim = mp && g.month === mp.key;
      body.append(h('div', { class: 'wmonth' }, h('h3', { text: monthWord(g.month) }), h('span', { class: 'muted', text: waiting ? `${waiting} not claimed` : 'all claimed' }),
        waiting && inClaim ? h('button', { class: 'link', type: 'button', text: 'Tick all', onclick: () => { g.items.filter((r) => r.status !== 'claimed' && !S.other.some((o) => o.walletId === r.id)).forEach((r) => W.sel.add(r.id)); paintWallet(false); } }) : null));
      body.append(h('div', { class: 'wgrid' }, g.items.map((r) => walletCard(r))));
    });
    const n = W.sel.size;
    $('#walletAdd').disabled = !n;
    $('#walletAdd').textContent = n ? `Add ${n} to this claim` : 'Add to this claim';
    $('#walletCountTop').textContent = open.length ? `${open.length} not claimed` : '';
  }
  function walletCard(r) {
    const rd = r.reading || {}, used = S.other.some((o) => o.walletId === r.id), claimed = r.status === 'claimed';
    const pick = !claimed && !used;
    const box = pick ? h('input', { type: 'checkbox', checked: W.sel.has(r.id), 'aria-label': 'Pick this receipt', onchange: (e) => { if (e.target.checked) W.sel.add(r.id); else W.sel.delete(r.id); paintWallet(false); } }) : null;
    const chip = claimed ? h('span', { class: 'chip done', text: 'Claimed · ' + monthWord(r.claimedIn) }) : used ? h('span', { class: 'chip', text: 'In this claim' })
      : rd.review && rd.review.length ? h('span', { class: 'chip warn', text: 'Check ' + plainList(rd.review.map((k) => FIELD_WORD[k] || k)) }) : null;
    return h('label', { class: 'wcard' + (claimed || used ? ' off' : '') + (W.sel.has(r.id) ? ' on' : '') },
      h('div', { class: 'wthumb' }, r.thumb ? h('img', { src: r.thumb, alt: '' }) : h('span', { class: 'wph', text: '🧾' }), box),
      h('div', { class: 'wtext' },
        h('b', { text: rd.amount ? 'RM ' + money(num(rd.amount)) : 'Amount not read' }),
        h('span', { text: rd.name || rd.category || 'Receipt' }),
        h('span', { class: 'muted', text: rd.date ? niceDate(rd.date) : 'Snapped ' + niceDate(String(r.createdAt || '').slice(0, 10)) }),
        chip,
        claimed ? h('button', { class: 'link subtle', type: 'button', text: 'Not claimed after all', onclick: async (e) => { e.preventDefault(); await Wallet.unclaim(r.id); W.list = (await Wallet.sync(owner())).list; paintWallet(false); refreshWalletBar(); } })
          : h('button', { class: 'link subtle', type: 'button', text: 'Remove', onclick: async (e) => { e.preventDefault(); if (!confirmRemove(r)) return; await Wallet.remove(r.id); W.sel.delete(r.id); W.list = (await Wallet.sync(owner())).list; paintWallet(false); refreshWalletBar(); } })));
  }
  const confirmRemove = (r) => window.confirm(`Remove this receipt${r.reading && r.reading.amount ? ' (RM ' + money(num(r.reading.amount)) + ')' : ''} from My receipts?${r.driveId ? ' It goes to the bin of your Google Drive.' : ''}`);
  async function addFromWallet(recs) {
    let added = 0;
    for (const rec of recs) {
      if (S.other.some((o) => o.walletId === rec.id)) continue;
      let blob = null;
      try { blob = await Wallet.photo(rec); } catch (e) { blob = null; }
      if (!blob) { fileNote('warn', `A receipt from ${monthWord(rec.month)} is in your Google Drive but couldn't be fetched just now. Try again in a moment.`); continue; }
      const file = new File([blob], rec.name || 'Receipt.jpg', { type: blob.type || 'image/jpeg' });
      const r = rec.reading || {};
      const item = { id: uid(), kind: 'other', files: [{ file, url: URL.createObjectURL(file) }], category: r.category || '', name: r.name || '', date: r.date || '', receiptNo: r.receiptNo || '',
        amount: r.amount || '', auto: Object.assign({}, r.auto || {}), review: (r.review || []).slice(), planB: r.planB || '', hint: r.hint || '', fx: r.fx || null, scan: r.scan || null,
        litres: r.litres || null, fuel: r.fuel || '', askedClaude: !!r.askedClaude, ocr: 'done', walletId: rec.id };
      item.orig = { category: item.category, name: item.name, date: item.date, receiptNo: item.receiptNo, amount: item.amount };      // corrections to what was read are logged
      S.other.push(item); added++;
    }
    if (added) { refreshStatus(); renderLines(); fileNote('info', `Added ${added} receipt${added > 1 ? 's' : ''} from My receipts.`); }
    return added;
  }
  async function walletAdd() {
    const recs = W.list.filter((r) => W.sel.has(r.id));
    $('#walletAdd').disabled = true; $('#walletAdd').textContent = 'Adding…';
    await addFromWallet(recs);
    W.sel = new Set();
    $('#walletDlg').close();
    refreshWalletBar();
  }
  /* the bar on the claim page: how many receipts wait, and the ones from this claim's month in one click */
  async function refreshWalletBar() {
    if (!window.Wallet || !window.indexedDB) return;
    let list = [];
    try { list = (await Wallet.localAll(owner())).filter((r) => !r.removed); } catch (e) { return; }
    if (W.list.length) { const ids = new Set(list.map((r) => r.id)); W.list.forEach((r) => { if (!ids.has(r.id)) list.push(r); }); }      // receipts only in Drive, once listed
    const open = list.filter((r) => r.status !== 'claimed');
    ['#walletCount', '#walletCount2'].forEach((id) => { $(id).textContent = open.length ? String(open.length) : ''; $(id).hidden = !open.length; });
    const mp = monthParts();
    const waiting = mp ? open.filter((r) => (r.month || Wallet.monthFor(r)) === mp.key && !S.other.some((o) => o.walletId === r.id)) : [];
    const hint = $('#walletHint');
    hint.textContent = ''; hint.hidden = !waiting.length;
    if (waiting.length) hint.append(h('span', { text: `${waiting.length} snapped receipt${waiting.length > 1 ? 's' : ''} from ${monthLabel(mp)} ${waiting.length > 1 ? 'are' : 'is'} waiting.` }),
      h('button', { class: 'link', type: 'button', text: 'Add to this claim', onclick: async () => { await addFromWallet(waiting); refreshWalletBar(); } }));
  }
  /* after the claim is saved: its receipts from My receipts are claimed in that month */
  function walletClaimed(month) {
    if (!window.Wallet) return;
    const ids = S.other.filter((o) => o.walletId).map((o) => o.walletId);
    if (!ids.length) return;
    Wallet.markClaimed(ids, month).then(() => { driveSyncQuiet(); refreshWalletBar(); }).catch((e) => console.warn('Marking claimed failed', e));
  }
  /* where it lives: a small camera in the header (any step), My receipts in the account menu, and one slim row in step 2 (Add your files) */
  function wireWallet() {
    if (!window.Wallet || !window.indexedDB) return;          // an old browser: none of it shows
    ['#btnSnap', '#snapBar', '#btnWallet'].forEach((id) => { $(id).hidden = false; });
    $('#btnSnap').addEventListener('click', openSnap); $('#btnSnap2').addEventListener('click', openSnap);
    $('#snapInput').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) onSnapped(f); });
    $('#btnWallet').addEventListener('click', openWallet); $('#btnWallet2').addEventListener('click', openWallet);
    $('#walletAdd').addEventListener('click', walletAdd);
    $('#walletClose').addEventListener('click', () => $('#walletDlg').close());
  }

  /* ---------- Flow on the phone: works with no signal, sits on the home screen (js/pwa.js, sw.js) ----------
     Snapping needs no signal: the photo is checked, kept and read on the phone. When the signal is back, receipts that are only on the phone
     can be copied to the person's own Google Drive (one tap: Google asks for a click, so it cannot happen by itself). */
  const svgIcon = (inner) => { const s = document.createElement('span'); s.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg>'; return s; };   // fixed icon markup only
  const ICON_SHARE = '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 5 21h14a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 19 11h-1"/>';
  const ICON_PLUS = '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/>';
  const ICON_DOTS = '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>';
  const HIDE_KEY = 'wfc-install-hide', HIDE_DAYS = 14;
  async function backOnline() {
    if (!window.Wallet || !canDrive()) return;
    let list = [];
    try { list = await Wallet.localAll(owner()); } catch (e) { return; }
    const waiting = list.filter((r) => !r.removed && !r.driveId && r.file).length;
    if (!waiting) return;
    const plural = `${waiting} receipt${waiting > 1 ? 's' : ''}`;
    if (Wallet.connected()) {
      Wallet.sync(owner()).then((res) => { W.list = res.list; refreshWalletBar(); Pwa.bar(res.sent ? `Copied ${res.sent} receipt${res.sent > 1 ? 's' : ''} to your Google Drive.` : '', { kind: 'on', seconds: 6 }); }).catch(() => {});
      return;
    }
    Pwa.bar(`You are back online. ${plural} snapped without signal can be copied to your Google Drive.`, { kind: 'on', action: { label: 'Copy now', run: () => driveConnect(() => Pwa.bar(`Copied to your Google Drive.`, { kind: 'on', seconds: 5 })) } });
  }
  async function showInstall() {
    const body = $('#installBody'), dlg = $('#installDlg');
    body.textContent = '';
    const ios = Pwa.isIos(), steps = [];
    if (Pwa.inAppBrowser()) body.append(h('p', { class: 'howtip warn', text: 'You are inside another app (WhatsApp, Gmail, Facebook...). Open this page in ' + (ios ? 'Safari' : 'Chrome') + ' first: tap the menu (… or ⋮) and choose "Open in browser".' }));
    if (ios) {
      steps.push(h('li', {}, h('span', {}, 'Tap the ', h('b', { text: 'Share' }), ' button ', svgIcon(ICON_SHARE), ' at the bottom of Safari (top right on an iPad).')));
      steps.push(h('li', {}, h('span', {}, 'Scroll down and tap ', h('b', { text: 'Add to Home Screen' }), ' ', svgIcon(ICON_PLUS), '.')));
      steps.push(h('li', {}, h('span', {}, 'Tap ', h('b', { text: 'Add' }), '. From now on open ', h('b', { text: 'Flow' }), ' from its new icon.')));
    } else if (Pwa.canPrompt()) {
      steps.push(h('li', {}, h('span', {}, 'Tap ', h('b', { text: 'Install Flow' }), ' below, then ', h('b', { text: 'Install' }), '.')));
      steps.push(h('li', {}, h('span', {}, 'Open ', h('b', { text: 'Flow' }), ' from its new icon on your home screen.')));
    } else {
      steps.push(h('li', {}, h('span', {}, 'Tap the menu ', svgIcon(ICON_DOTS), ' at the top right of Chrome.')));
      steps.push(h('li', {}, h('span', {}, 'Tap ', h('b', { text: 'Install app' }), ' (or ', h('b', { text: 'Add to Home screen' }), '), then ', h('b', { text: 'Install' }), '.')));
      steps.push(h('li', {}, h('span', {}, 'Open ', h('b', { text: 'Flow' }), ' from its new icon.')));
    }
    body.append(h('p', { class: 'muted', text: 'It opens like an app, works with no signal, keeps your snapped receipts safe and can remind you when claims are due.' }), h('ol', { class: 'howto' }, steps));
    if (!ios && Pwa.canPrompt()) body.append(h('div', { class: 'snapacts' }, h('button', { class: 'primary', type: 'button', text: 'Install Flow', onclick: async () => { const ok = await Pwa.prompt(); if (ok) dlg.close(); } })));
    if (ios) body.append(h('p', { class: 'howtip warn', text: 'Added Flow before? That old icon opens Safari. Press and hold it, tap Remove App, then follow the steps again.' }));
    let n = 0;
    try { n = window.Wallet ? (await Wallet.localAll(owner())).filter((r) => !r.removed && !r.driveId && r.file).length : 0; } catch (e) { n = 0; }
    if (n) {
      const many = n > 1, what = `${n} snapped receipt${many ? 's' : ''}`;
      body.append(h('p', { class: 'howtip', text: canDrive()
        ? `You have ${what} that ${many ? 'are' : 'is'} only in this browser. Copy ${many ? 'them' : 'it'} to your Google Drive first (My receipts > Keep a copy in my Google Drive). ${many ? 'They come' : 'It comes'} back in the new app once you connect Drive there.`
        : `You have ${what} in this browser. ${many ? 'They' : 'It'} will not be in the new app, so add ${many ? 'them' : 'it'} to your claim first.` }));
    }
    if (!dlg.open) dlg.showModal();
  }
  function wirePhone() {
    if (!window.Pwa) return;
    const hidden = () => { const t = Number(store.get(HIDE_KEY, 0)); return t && Date.now() - t < HIDE_DAYS * 864e5; };
    const paintInstall = () => {
      const can = Pwa.installable();
      $('#btnInstall').hidden = !can;
      $('#installBar').hidden = !(can && !hidden() && Pwa.online());          // no signal: one slim bar is enough
    };
    $('#btnInstall').addEventListener('click', showInstall);
    $('#btnInstallShow').addEventListener('click', showInstall);
    $('#btnInstallHide').addEventListener('click', () => { store.set(HIDE_KEY, Date.now()); paintInstall(); });
    Pwa.on('installable', paintInstall); Pwa.on('installed', paintInstall); Pwa.on('offline', paintInstall); Pwa.on('online', paintInstall);
    paintInstall();
    Pwa.on('online', (e) => { if (e && e.back) backOnline(); });
    // "Works without signal" once the page and the reading engine are saved on this phone
    const note = h('p', { class: 'offnote', id: 'offNote', hidden: true, text: 'Works without signal ✓' });
    $('#acMenu').append(note);
    const mark = () => Pwa.haveEngine().then((ok) => { note.hidden = !ok; });
    Pwa.on('ready', mark); mark();
  }

  /* ---------- e-receipts from Gmail (js/mailrcpt.js) ----------
     "Find e-receipts in Gmail" (step 2, for people signed in with Google): the page looks only at emails of the claim month that look like receipts,
     lists them, and the ticked ones go into the claim exactly like dropped files (an email with no attachment is printed to a one-page PDF). */
  const canMail = () => !!(window.MailReceipts && S.user && S.user.provider === 'google' && S.user.email && gmailClientId());
  const paintMail = () => { $('#btnMail2').hidden = !canMail(); };
  async function emailToPdf(m, text) {                         // proof for an email that has no attachment: one clean page (or more) of its text
    await Lazy.need('jspdf');
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4', compress: true }), W = 595, M = 48;
    let y = 56;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text('Email receipt', M, y); y += 24;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    [['From', `${m.from.name} <${m.from.email}>`], ['Date', new Date(m.date).toLocaleString('en-GB')], ['Subject', m.subject]].forEach(([k, v]) => {
      const lines = doc.splitTextToSize(`${k}: ${MailReceipts.printable(v) || v}`, W - 2 * M); doc.text(lines, M, y); y += lines.length * 13;
    });
    y += 6; doc.setDrawColor(200); doc.line(M, y, W - M, y); y += 18;
    doc.setFontSize(10.5);
    for (const line of doc.splitTextToSize(text, W - 2 * M)) { if (y > 790) { doc.addPage(); y = 56; } doc.text(line, M, y); y += 14; }
    y += 10; if (y > 790) { doc.addPage(); y = 56; }
    doc.setFontSize(8.5); doc.setTextColor(120); doc.text('Printed by Flow from the email above, received ' + new Date(m.date).toLocaleDateString('en-GB') + '.', M, y);
    return new File([doc.output('blob')], MailReceipts.printedName(m), { type: 'application/pdf' });
  }
  async function openMail() {
    if (!canMail()) return;
    const mp = monthParts();
    const dlg = $('#mailDlg'), body = $('#mailBody'), foot = $('#mailFoot');
    if (!mp) { fileNote('warn', 'Pick the claim month in step 1 first, so Flow knows which month to look at.'); return; }
    foot.hidden = true; foot.textContent = '';
    const show = (...kids) => { body.textContent = ''; body.append(...kids.filter(Boolean)); };
    const note = (text, kind) => h('p', { class: 'snapst ' + (kind || 'wait'), text });
    const intro = () => show(
      h('p', { text: `Flow will look in your Gmail for emails from ${monthLabel(mp)} that look like receipts or invoices: AI tools, Grab, flights, hotels and so on.` }),
      h('ul', { class: 'mailtrust' },
        h('li', { text: 'It only opens emails that look like receipts. Nothing else is read.' }),
        h('li', { text: 'You choose which ones to add. Nothing is kept or sent anywhere.' }),
        h('li', { text: 'Google asks you once to allow "view your email". View only: Flow cannot send, change or delete anything.' })),
      h('div', { class: 'snapacts' }, h('button', { class: 'primary', type: 'button', text: 'Look in my Gmail', onclick: go })));
    function go() {
      MailReceipts.connect(gmailClientId(), owner())            // first, still inside the click (the Google window)
        .then(() => { show(note('Looking in your Gmail…')); return MailReceipts.search(mp.key, (p) => show(note(`Looking in your Gmail… ${p.done} of ${p.total}`))); })
        .then(list, (e) => show(note(e.message || String(e), 'bad'), h('div', { class: 'snapacts' }, h('button', { class: 'ghost', type: 'button', text: 'Try again', onclick: intro }))));
    }
    function list(res) {
      const items = res.list, on = new Set(items.filter((m) => m.rank.tick).map((m) => m.id));
      if (!items.length) { show(note(`No receipts found in your Gmail for ${monthLabel(mp)}${res.found ? ' (' + res.found + ' emails looked at, none like a receipt)' : ''}. Check you are signed in with the Gmail the receipts went to.`, 'warn')); return; }
      const paint = () => {
        show(h('p', { class: 'muted', text: `${items.length} email${items.length > 1 ? 's' : ''} from ${monthLabel(mp)} look like receipts. Tick the ones for this claim.` }),
          h('ul', { class: 'mailist' }, items.map((m) => h('li', {}, h('label', { class: on.has(m.id) ? 'on' : '' },
            h('input', { type: 'checkbox', checked: on.has(m.id), onchange: (e) => { if (e.target.checked) on.add(m.id); else on.delete(m.id); paint(); } }),
            h('div', { class: 'mtext' }, h('b', { text: m.from.name }), h('span', { text: m.subject || '(no subject)' }),
              h('small', {}, niceDate(localIso(new Date(m.date))), h('span', { class: 'mailtag' + (m.rank.kind === 'email' ? ' email' : ''), text: m.rank.kind === 'pdf' ? 'PDF attached' : m.rank.kind === 'photo' ? 'Photo attached' : 'Email only: printed as a PDF' }))))))));
        foot.hidden = false; foot.textContent = '';
        const add = h('button', { class: 'primary', type: 'button', text: on.size ? `Add ${on.size} to my claim` : 'Add to my claim', disabled: !on.size, onclick: () => addChosen(items.filter((m) => on.has(m.id))) });
        foot.append(h('button', { class: 'ghost', type: 'button', text: 'Close', onclick: () => dlg.close() }), add);
      };
      paint();
    }
    async function addChosen(chosen) {
      foot.hidden = true;
      const files = [], failed = [];
      for (let i = 0; i < chosen.length; i++) {
        show(note(`Getting your receipts… ${i + 1} of ${chosen.length}`));
        try { files.push(...(await MailReceipts.filesOf(chosen[i], emailToPdf))); } catch (e) { failed.push(`${chosen[i].from.name}: ${e.message || e}`); }
      }
      dlg.close();
      if (files.length) await routeFiles(files);
      failed.forEach((t) => fileNote('warn', 'Not added. ' + t));
    }
    intro();
    if (!dlg.open) dlg.showModal();
  }
  function wireMail() {
    if (!window.MailReceipts) return;
    $('#btnMail2').addEventListener('click', openMail);
    paintMail();
  }

  /* ---------- claim reminders (js/remind.js; the sender is the claims inbox, see its README) ----------
     A slim bar on the 1st-15th until last month's claim is saved, for everyone. And, once the inbox knows about reminders, a push notification
     on the 1st, 8th, 13th and 15th, which the person turns on once in "Claim reminders" in the account menu. */
  let remindReady = false;                         // the inbox answers to reminders (its ping says so)
  const remindPost = (body) => Accounts.remind(dashApi(), body);
  const remindWho = () => ({ name: ($('#claimant').value || (S.user && S.user.name) || '').trim(), email: owner() });
  async function paintRemindBar() {
    const bar = $('#remindBar');
    const t = window.Remind && Remind.needsNudge();
    if (!t || document.body.classList.contains('locked')) { bar.hidden = true; return; }
    $('#remindText').textContent = t.daysLeft <= 0 ? `Last day for ${t.label} claims.` : `${t.label} claims are open until ${t.due} (${t.daysLeft} day${t.daysLeft > 1 ? 's' : ''} left).`;
    bar.hidden = false;
    const st = remindReady ? await Remind.state() : '';
    $('#btnRemindOn').hidden = !(st === 'off' || st === 'needs-install');
  }
  async function showRemind() {
    const dlg = $('#remindDlg'), body = $('#remindBody');
    const st = await Remind.state();
    body.textContent = '';
    const msg = h('p', { class: 'snapst', hidden: true });
    const say = (text, kind) => { msg.hidden = !text; msg.className = 'snapst ' + (kind || 'wait'); msg.textContent = text || ''; };
    body.append(h('p', { class: 'muted', text: 'A friendly reminder, with your phone\'s notification sound, to make last month\'s claim. We keep it to four a month and stop as soon as your claim is in.' }),
      h('ul', { class: 'remindwhen' },
        h('li', {}, h('b', { text: '1st' }), h('span', { text: 'Claims are open.' })), h('li', {}, h('b', { text: '8th' }), h('span', { text: 'A friendly nudge.' })),
        h('li', {}, h('b', { text: '13th' }), h('span', { text: 'Two days left.' })), h('li', {}, h('b', { text: '15th' }), h('span', { text: 'Last day.' }))));
    if (st === 'on') {
      body.append(h('div', { class: 'remindon' }, svgIcon('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 21a2 2 0 0 0 4 0"/>'), h('span', { text: 'Reminders are on for this phone.' })),
        h('div', { class: 'snapacts' },
          h('button', { class: 'ghost', type: 'button', text: 'Send me a test now', onclick: async () => { try { await Remind.test(); say('Sent. You should hear and see it in a moment.', 'ok'); } catch (e) { say('The test could not be shown: ' + (e.message || e), 'bad'); } } }),
          h('button', { class: 'ghost', type: 'button', text: 'Turn off', onclick: async () => { await Remind.disable(remindPost); paintRemindBar(); showRemind(); } })), msg);
    } else if (st === 'needs-install') {
      body.append(h('p', { class: 'snapst warn', text: 'On an iPhone, reminders come from the home-screen app. Put Flow on your home screen first, open it from there, then turn reminders on.' }),
        h('div', { class: 'snapacts' }, h('button', { class: 'primary', type: 'button', text: 'Show me how', onclick: () => { dlg.close(); showInstall(); } })));
    } else if (st === 'blocked') {
      body.append(h('p', { class: 'snapst warn', text: 'Notifications are blocked for Flow. iPhone: Settings > Notifications > Flow > Allow. Android: press and hold the Flow icon > App info > Notifications. Then come back here.' }));
    } else if (st === 'unsupported') {
      body.append(h('p', { class: 'snapst warn', text: 'This browser cannot show reminders. Use Flow from your phone\'s home screen, or the page below will still remind you whenever you open it.' }));
    } else {
      const name = h('input', { type: 'text', id: 'remindName', value: remindWho().name, placeholder: 'Full name, as on your IC', autocomplete: 'name' });
      const go = h('button', { class: 'primary', type: 'button', text: 'Turn on reminders' });
      go.addEventListener('click', async () => {
        go.disabled = true; say('Turning on…');
        try {
          await Remind.enable(remindPost, { name: name.value, email: owner() });
          try { await Remind.test(); } catch (e) { /* the test is only a bonus */ }
          paintRemindBar(); showRemind();
        } catch (e) { say(e.message || String(e), 'bad'); go.disabled = false; }
      });
      body.append(h('label', { class: 'f remindfield' }, 'Your name, as on your claims', name), h('div', { class: 'snapacts' }, go), msg);
    }
    if (!dlg.open) dlg.showModal();
  }
  function wireRemind() {
    if (!window.Remind) return;
    $('#btnRemind').addEventListener('click', showRemind);
    $('#btnRemindOn').addEventListener('click', showRemind);
    $('#btnRemindLater').addEventListener('click', () => { Remind.snoozeToday(); paintRemindBar(); });
    paintRemindBar();
  }
  const remindServerReady = (j) => { remindReady = !!(j && j.remind); if (window.Remind) { $('#btnRemind').hidden = !remindReady; paintRemindBar(); } };

  function init() {
    S.restoring = true;       // until the saved draft has been looked for, nothing may overwrite it
    ClaimPdf.croppedLogo().then((l) => { $('#brandLogo').src = l.url; $('#loginLogo').src = l.url; }).catch(() => { $('#brandLogo').remove(); $('#loginLogo').remove(); });
    const dl = h('datalist', { id: 'cats' }, CATEGORIES.map((c) => h('option', { value: c })));
    document.body.append(dl);

    $('#claimant').value = cfg.claimant; $('#signature').value = cfg.signature;
    $('#toEmail').value = cfg.toEmail;
    wireLogin();
    if (S.user) unlock();       // signed in earlier in this tab (or continued without signing in): straight to the claim
    const now = new Date();
    // claims are made the month after: October's is claimed by 15 Nov, so the page opens on last month
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    $('#month').value = `${lastMonth.getFullYear()}-${pad(lastMonth.getMonth() + 1)}`;
    $('#lSignDate').value = localIso(now);

    $('#claimant').addEventListener('input', () => { cfg.claimant = $('#claimant').value; saveCfg(); updateSummary(); });
    $('#signature').addEventListener('input', () => { cfg.signature = $('#signature').value; saveCfg(); updateSummary(); });
    $('#month').addEventListener('input', () => { S.touched.month = true; renderLines(); refreshWalletBar(); });
    wireWallet();
    wirePhone();
    wireRemind();
    wireMail();
    $('#daysOff').addEventListener('input', renderLines);
    $('#toEmail').addEventListener('input', () => { cfg.toEmail = $('#toEmail').value; saveCfg(); renderSteps(); });
    $('#subject').addEventListener('input', () => { S.touched.subject = true; renderSteps(); });
    $('#body').addEventListener('input', () => { S.touched.body = true; });

    // leave application
    $('#lName').addEventListener('input', () => { S.touched.lName = true; refreshLeaveEmail(); staleLeave(); });
    $('#lSign').addEventListener('input', () => { S.touched.lSign = true; cfg.signature = $('#lSign').value; saveCfg(); $('#signature').value = cfg.signature; refreshLeaveEmail(); staleLeave(); });
    ['#lType', '#lReason', '#lSignDate'].forEach((id) => $(id).addEventListener('input', () => { refreshLeaveEmail(); staleLeave(); }));
    $('#lFrom').addEventListener('input', () => {
      if (!S.touched.lTo || $('#lTo').value < $('#lFrom').value) $('#lTo').value = $('#lFrom').value;
      refreshLeaveEmail(); staleLeave();
    });
    $('#lTo').addEventListener('input', () => { S.touched.lTo = true; refreshLeaveEmail(); staleLeave(); });
    $('#lToEmail').addEventListener('input', () => { cfg.toEmail = $('#lToEmail').value; saveCfg(); });
    $('#lSubject').addEventListener('input', () => { S.touched.lSubject = true; });
    $('#lBody').addEventListener('input', () => { S.touched.lBody = true; });
    ['#lFrom', '#lTo', '#lReason'].forEach((id) => $(id).addEventListener('input', (e) => e.target.classList.remove('guess')));
    $('#lBuild').addEventListener('click', buildLeave);
    $('#tabClaim').addEventListener('click', () => showView('claim'));
    $('#tabLeave').addEventListener('click', () => showView('leave'));
    $('#viewLeave').addEventListener('input', markNeededLeave);
    $('#viewLeave').addEventListener('change', markNeededLeave);

    wireDrop();
    $('#ocrOn').checked = !!cfg.ocr;
    $('#ocrOn').addEventListener('change', () => { cfg.ocr = $('#ocrOn').checked; saveCfg(); });
    refreshDash(); autoLinkDash(); linkTeamClaude();
    $('#sendDash').addEventListener('change', () => { cfg.sendDash = $('#sendDash').checked; saveCfg(); });

    $('#btnAddLine').addEventListener('click', () => {      // a line typed by hand: no file needed
      const item = { id: uid(), kind: 'other', manual: true, files: [], category: '', name: '', date: '', receiptNo: '', amount: '', auto: {} };
      S.other.push(item); renderLines();
      const first = S.inputs.find((i) => i._obj === item && i._key === 'category');
      if (first) { first.focus(); first.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    });
    $('#btnClearAll').addEventListener('click', clearAll);
    $('#btnBuild').addEventListener('click', buildPack);
    $('#btnSettings').addEventListener('click', openSettings);
    $('#sLocChange').addEventListener('click', changeFolder);
    $('#sLocForget').addEventListener('click', async () => { await Folder.forget(); refreshLoc(); });
    $('#sReset').addEventListener('click', () => { $('#sHol').value = TNG.DEFAULT_HOLIDAYS; });
    $('#dlgForm').addEventListener('submit', () => {
      cfg.toName = $('#sToName').value.trim(); cfg.signoff = $('#sSignoff').value.trim();
      cfg.holidays = $('#sHol').value;
      cfg.gmailClientId = $('#sGmail').value.trim();
      cfg.msClientId = $('#sMs').value.trim();
      cfg.dashApi = $('#sDash').value.trim();
      saveCfg(); refreshDash(); linkTeamClaude(); S.touched.body = false; S.touched.lBody = false; renderLines(); refreshLeaveEmail();
      ['claim', 'leave'].forEach((k) => { if (S.packs[k]) renderPack(k); });       // so the Gmail draft button appears or goes
    });

    buildStepper();
    go(1, true);
    renderLines();
    refreshStatus();
    refreshLoc();
    refreshLeaveEmail();
    // keep the unfinished claim as it changes, and put it back after a refresh
    ['input', 'change'].forEach((ev) => document.addEventListener(ev, keepDraft));
    document.addEventListener('visibilitychange', () => { if (document.hidden && !S.restoring) Draft.flush(draftSnapshot); });
    window.addEventListener('pagehide', () => { if (!S.restoring) Draft.flush(draftSnapshot); });
    $('#btnStartOver').addEventListener('click', startOver); $('#btnResumeStart').addEventListener('click', startOver);
    restoreDraft();
  }

  window.__claimApp = { S, routeFiles, onTng, onOther, buildPack, buildLeave, compileLines, tollView };   // handy for testing
  init();
})();
