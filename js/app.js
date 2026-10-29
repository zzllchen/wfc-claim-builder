/* WFC Claim Builder - everything runs in the browser; files are never uploaded. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const pad = (n) => String(n).padStart(2, '0');
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // file-name style the team already uses: WFC - JUNE Claim form
  const MONTH_TAG = ['JAN', 'FEB', 'MAR', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const CATEGORIES = ['Petrol', 'AI tools', 'Accommodation', 'Medical', 'Parking', 'Toll', 'Meals', 'Stationery', 'Other'];
  const round2 = TNG.round2;
  const money = ClaimPdf.money;

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

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
  const uid = (() => { let n = 0; return () => 'i' + (++n); })();
  const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const safe = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
  const ext = (name) => ((name.match(/\.([A-Za-z0-9]+)$/) || [, 'jpg'])[1]).toLowerCase();
  const sizeText = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  /* ---------- settings + state ---------- */
  const DEFAULTS = {
    claimant: '', signature: '', fromEmail: '', toEmail: '',
    toName: '', signoff: '', ocr: true, holidays: TNG.DEFAULT_HOLIDAYS,
  };
  const cfg = Object.assign({}, DEFAULTS, store.get('wfc-claim-cfg', {}));
  const saveCfg = () => store.set('wfc-claim-cfg', cfg);

  const S = {
    tng: null, overrides: new Map(), other: [],
    showTrips: false, showErrors: false, packs: { claim: null, leave: null }, inputs: [],
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
    const rankOf = (cat) => (/petrol|fuel/i.test(cat) ? 0 : /accommodation|hotel/i.test(cat) ? 1 : 2);
    S.other.forEach((o) => lines.push({ rank: rankOf(o.category), kind: 'other', src: o, category: o.category, date: o.date, name: o.name, receiptNo: o.receiptNo, amount: o.amount, files: o.files.map((x) => x.file) }));
    if (tv && tv.toll > 0 && mp) lines.push({ rank: 3, kind: 'toll', category: 'Toll', date: monthEndIso(mp), name: "Touch 'n Go", receiptNo: S.tng.header.serial, amount: tv.toll, files: [S.tng.file] });
    if (tv && tv.parking > 0 && mp) lines.push({ rank: 4, kind: 'parking', category: 'Parking', date: monthEndIso(mp), name: "Touch 'n Go", receiptNo: S.tng.header.serial, amount: tv.parking, files: [S.tng.file] });
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
      i.classList.remove('guess', 'bad');
      if (key === 'name' && /petrol|fuel/i.test(obj.category || '')) store.set('wfc-last-station', i.value);
      updateSummary();
    });
    if (key === 'name') i.addEventListener('change', () => { if (/petrol|fuel/i.test(obj.category || '')) rememberStation(i.value); });
    S.inputs.push(i);
    return i;
  }

  function chip(file, url) {
    const isImg = /^image\//.test(file.type);
    return h('a', { class: 'chip', href: url, target: '_blank', rel: 'noopener', title: file.name },
      isImg ? h('img', { src: url, alt: '' }) : h('i', { text: 'PDF' }), h('span', { text: file.name }));
  }

  function removeOther(o) { o.files.forEach((x) => URL.revokeObjectURL(x.url)); S.other = S.other.filter((x) => x !== o); renderLines(); refreshStatus(); }

  function mergeInto(item, target) {
    target.files.push(...item.files);
    if (!target.amount && item.amount) target.amount = item.amount;
    S.other = S.other.filter((x) => x !== item);
    renderLines(); refreshStatus();
  }

  function editableLine(l) {
    const o = l.src;
    const row = h('div', { class: 'row' },
      field('Category', 'cat', bound(o, 'category', 'text', { list: 'cats' })),
      field('Date', 'dt', bound(o, 'date', 'date')),
      field('Name', 'nm', bound(o, 'name', 'text', { placeholder: 'Station / merchant / hotel' })),
      field('Receipt no.', 'rn', bound(o, 'receiptNo', 'text')),
      field('Amount (RM)', 'am', bound(o, 'amount', 'number', { step: '0.01', min: '0', inputmode: 'decimal' })),
      h('button', { class: 'icon', type: 'button', title: 'Remove', 'aria-label': 'Remove line', text: '×', onclick: () => removeOther(o) }));
    const files = h('div', { class: 'files' }, o.files.map((x) => chip(x.file, x.url)),
      o.ocr ? h('span', { class: 'tag ocr', 'data-ocr': o.id, 'data-state': o.ocr, text: OCR_LABEL[o.ocr] || '', hidden: !OCR_LABEL[o.ocr] }) : null,
      o.hint && !String(o.amount || '').trim() ? h('span', { class: 'tag hint', text: o.hint }) : null);
    if (S.other.length > 1) {
      const sel = h('select', { onchange: (e) => { const t = S.other.find((x) => x.id === e.target.value); if (t) mergeInto(o, t); } },
        h('option', { value: '', text: 'separate line' }),
        S.other.filter((x) => x !== o).map((x) => h('option', { value: x.id, text: `${x.category || 'Line'} · ${x.name || x.files[0].file.name}`.slice(0, 48) })));
      files.append(h('label', { class: 'merge' }, 'Attach to', sel));
    }
    return h('div', { class: 'line' }, row, files);
  }

  function tollLine(l, tv) {
    const isToll = l.kind === 'toll';
    const rows = tv.rows.filter((r) => r.type === (isToll ? 'TOLL' : 'PARKING'));
    const counted = rows.filter((r) => r.include).length;
    const ro = (v) => h('input', { type: 'text', value: v, disabled: true });
    const row = h('div', { class: 'row' },
      field('Category', 'cat', ro(l.category)), field('Date', 'dt', ro(ClaimPdf.fmtDate(l.date))), field('Name', 'nm', ro(l.name)),
      field('Receipt no.', 'rn', ro(l.receiptNo)), field('Amount (RM)', 'am', ro(money(l.amount))), h('span'));
    const files = h('div', { class: 'files' }, chip(S.tng.file, S.tng.url),
      h('span', { class: 'tag', text: `${counted} of ${rows.length} ${isToll ? 'toll trips' : 'parking rows'} counted` }),
      isToll ? h('button', { class: 'link', type: 'button', text: S.showTrips ? 'Hide trips' : 'Review trips', onclick: () => { S.showTrips = !S.showTrips; renderLines(); } }) : null);
    const wrap = h('div', { class: 'line auto' }, row, files);
    if (isToll) wrap.append(tripsPanel(tv));
    return wrap;
  }

  // the reason shown beside each trip, on screen and in the check-list PDF
  const tripWhy = (r) => (r.include
    ? (r.overridden ? 'Counted (ticked by you)' : r.reason)
    : (r.overridden ? 'Not counted (unticked by you)' : r.reason));

  function tripsPanel(tv) {
    const rows = tv.rows.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
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
      h('p', { class: 'hint' }, 'Ticked rows go into the claim. Tick or untick any row to override the rules (for example a client visit parking). ',
        S.overrides.size ? h('button', { class: 'link', type: 'button', text: 'Reset my ticks', onclick: () => { S.overrides.clear(); renderLines(); } }) : null));
    return panel;
  }

  function renderLines() {
    const box = $('#lines');
    box.textContent = '';
    S.inputs = [];
    const { lines, tv } = compileLines();
    lines.sort((a, b) => a.rank - b.rank);   // stable: keeps upload order inside each group
    if (!lines.length) {
      box.append(h('div', { class: 'empty', text: 'Add your files above and the claim lines will appear here.' }));
    } else {
      box.append(h('div', { class: 'row head' }, ['Category', 'Date', 'Name', 'Receipt no.', 'Amount (RM)', ''].map((t) => h('span', { text: t }))));
      lines.forEach((l) => box.append(l.kind === 'toll' || l.kind === 'parking' ? tollLine(l, tv) : editableLine(l)));
    }
    updateSummary();
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
    if (tv) {
      const hdr = S.tng.header;
      if (mp && hdr.from && hdr.to && !(hdr.from.slice(0, 7) === mp.key || hdr.to.slice(0, 7) === mp.key)) warn.push(`This statement covers ${hdr.from} to ${hdr.to}, not ${monthLabel(mp)}.`);
      if (mp && !tv.holidayYears.has(String(mp.y))) warn.push(`No public holidays are listed for ${mp.y}. Add them in Settings so holiday tolls are skipped.`);
      if (tv.toll === 0) warn.push('No toll trips qualified this month.');
    }
    return { bad, warn };
  }

  function updateSummary() {
    const { lines, tv } = compileLines();
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
    });
    refreshEmail(lines);
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
      S.overrides.clear();
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
  function setOcr(item, state) {
    item.ocr = state;
    const tag = ocrTag(item);
    if (tag) { tag.textContent = OCR_LABEL[state] || ''; tag.hidden = !OCR_LABEL[state]; tag.dataset.state = state; }
  }

  // dealers seen on past claims, so a receipt reading "KEJAYAAN TEGUH ENT" is named the way the team already writes it
  const SEED_STATIONS = ['Kejayaan Teguh Enterprise', 'Legasi Puncak', 'BE Petrol Station', 'R & Z Aktiviti Enterprise', 'PS Taman Tenaga',
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
    updateSummary();
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
      const mp = monthParts();
      const opts = { month: mp && mp.key, stations: stations() };
      const text = await OCR.read(file, {
        onStart: () => setOcr(item, 'reading'),
        good: (t) => { const p = Petrol.parse(t, opts); return !!(p.amount && p.date); },
      });
      if (!S.other.includes(item)) return;              // removed while waiting
      const verdict = Validate.judge(text, 'photo');
      if (verdict.status !== 'ok') { dropItem(item); reject(file, verdict.reason, verdict.force, verdict.mc); return; }
      applyOcr(item, Petrol.parse(text, opts));
      setOcr(item, 'done');
    } catch (e) {
      console.warn('OCR failed', e);
      if (!S.other.includes(item)) return;
      if (e && e.code === 'decode') { dropItem(item); reject(file, Validate.MSG.decode, true); }
      else setOcr(item, 'failed');
    }
  }

  const guessCategory = (text) => (/\b(klinik|clinic|consultation|medication|medical|pharmacy|farmasi|doctor)\b/i.test(text) ? 'Medical'
    : /\b(hotel|room|booking|check-?in|accommodation|resort)\b/i.test(text) ? 'Accommodation'
    : /\b(petrol|diesel|ron\s?9\d|pump|litre|liter)\b/i.test(text) ? 'Petrol'
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
            if (info.amount != null) { target.amount = info.amount.toFixed(2); delete target.hint; }
            if (!target.name && info.merchant) target.name = info.merchant;
          } else {
            blank({ invoiceNo: info.invoiceNo, category: 'AI tools', name: info.merchant, date: info.date, receiptNo: info.invoiceNo.replace(/-/g, ''),
              amount: info.amount != null ? info.amount.toFixed(2) : '',
              hint: info.amount != null ? '' : 'Invoice only – attach the receipt PDF too so the MYR amount can be filled in' });
          }
          added.invoices++;
        } else if (s.hotel) {                             // Agoda receipt
          blank({ category: 'Accommodation', name: s.hotel.merchant, date: s.hotel.date, amount: s.hotel.amount != null ? s.hotel.amount.toFixed(2) : '' });
          added.hotel++;
        } else {                                          // any other PDF: must really be a receipt or invoice
          let text = s.text, source = 'pdf';
          if (!s.hasText && cfg.ocr) {                    // a scan: read the page image
            try { text = await OCR.readCanvas(await Receipts.renderFirstPage(await file.arrayBuffer())); source = 'scan'; } catch (e) { text = ''; }
          }
          const verdict = Validate.judge(text, source);
          if (verdict.status !== 'ok') { reject(file, verdict.reason, verdict.force, verdict.mc); added.rejected++; continue; }
          const p = Petrol.parse(text, { month: mp && mp.key, stations: stations() });
          const target = p.receiptNo && S.other.find((o) => o.receiptNo === p.receiptNo && !o.invoiceNo);
          if (target) { target.files.push(mk()); }       // same document number: group with the other copy
          else {
            const auto = {};
            ['date', 'amount', 'receiptNo'].forEach((k) => { if (p[k]) auto[k] = true; });
            if (p.station) auto.name = true;
            blank({ category: guessCategory(text), name: p.station, date: p.date, amount: p.amount, receiptNo: p.receiptNo, auto });
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
      if (c.photos) found.push(cfg.ocr ? plural(c.photos, 'photo') + ' being checked (any that cannot be read will be refused below)' : plural(c.photos, 'photo') + ' (set as Petrol, not checked)');
      if (c.invoices) found.push(plural(c.invoices, 'invoice / receipt PDF'));
      if (c.hotel) found.push(plural(c.hotel, 'hotel receipt'));
      if (c.unknown) found.push(plural(c.unknown, 'other file') + ' to fill in');
    }
    if (found.length) fileNote('info', 'Added: ' + found.join(', ') + '.');      // refused files get their own red card, with the reason
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

  async function buildPack() {
    S.showErrors = true;
    const { lines: raw, tv } = compileLines();
    const v = validate(raw, tv);
    updateSummary();
    const notes = $('#buildNotes');
    notes.textContent = '';
    if (v.bad.length) { notes.append(h('div', { class: 'note bad', text: 'Fix the red items above first.' })); $('#notes').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }

    const btn = $('#btnBuild');
    btn.disabled = true; btn.textContent = 'Building…';
    const dir = await Folder.ready();     // first thing: the folder picker needs the click that started this
    try {
      const mp = monthParts();
      const claimant = $('#claimant').value.trim();
      const signature = $('#signature').value.trim() || claimant;
      const lines = sortedForBuild(raw);
      const claimLines = lines.map((l) => ({ category: String(l.category).trim(), date: l.date, name: String(l.name).trim(), receiptNo: String(l.receiptNo || '').trim(), amount: num(l.amount) }));
      const signDate = localIso(new Date());
      const base = { year: mp.y, month: mp.m, claimant, signature, signDate, lines: claimLines };

      const xlsx = await ClaimXlsx.build(base);
      const pdf = await ClaimPdf.claim(Object.assign({}, base, { total: xlsx.total }));

      const folder = safe(`Claim - ${monthLabel(mp)} - ${claimant}`);
      const tag = MONTH_TAG[mp.m - 1];
      const zip = new JSZip();
      const root = zip.folder(folder);
      const entries = [];
      const add = (path, data) => { root.file(path, data); entries.push({ path, data, size: data.size != null ? data.size : data.byteLength }); };

      add(`WFC - ${tag} Claim form.xlsx`, xlsx.data);
      add(`WFC - ${tag} Claim form.pdf`, pdf);

      if (S.tng) {
        add(safe(S.tng.file.name), S.tng.buf);
        add('TNG toll check list.pdf', ClaimPdf.tollBreakdown({
          claimant, monthLabel: monthLabel(mp), serial: S.tng.header.serial, period: S.tng.header.periodText,
          rows: tv.rows.map((r) => Object.assign({}, r, { why: tripWhy(r) })), total: tv.toll, parkingTotal: tv.parking,
        }));
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
          if (small) add(`${stem}.jpg`, small);
          else add(`${stem}.${ext(f.name)}`, f);
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
      $('#pack').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      console.error(e);
      notes.append(h('div', { class: 'note bad', text: 'Could not build the pack: ' + (e.message || e) }));
    } finally {
      btn.disabled = false; btn.textContent = 'Build claim pack';
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
    btn.disabled = true; btn.textContent = 'Building…';
    const dir = await Folder.ready();
    try {
      const xlsx = await ClaimXlsx.buildLeave(d);
      const pdf = await ClaimPdf.leave(d);
      const sd = new Date(d.signDate + 'T00:00:00Z'), fd = new Date(d.from + 'T00:00:00Z');
      const base = safe(`WFC - ${MONTH_TAG[sd.getUTCMonth()]} Leave form (${fd.getUTCDate()}${SHORT_MON[fd.getUTCMonth()]})`);
      const files = [
        { name: base + '.xlsx', data: new Blob([xlsx], { type: XLSX_TYPE }) },
        { name: base + '.pdf', data: new Blob([pdf], { type: 'application/pdf' }) },
      ];
      S.mc.forEach((m, i) => files.push({ name: safe(`MC ${i + 1} - ${rangeText(d.from, d.to)}`) + '.' + ext(m.file.name), data: m.file }));
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
      if ($('#lDaysOff').checked) addDaysOff(d.from, d.to);
    } catch (e) {
      console.error(e);
      notes.append(h('div', { class: 'note bad', text: 'Could not build the leave form: ' + (e.message || e) }));
    } finally {
      btn.disabled = false; btn.textContent = 'Build leave form';
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
          text = await OCR.read(file);
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
    $('#lFromEmail').value = cfg.fromEmail; $('#lToEmail').value = cfg.toEmail;
    refreshLeaveEmail();
  }

  function showView(v) {
    $('#viewClaim').hidden = v !== 'claim';
    $('#viewLeave').hidden = v !== 'leave';
    $('#tabClaim').classList.toggle('on', v === 'claim');
    $('#tabLeave').classList.toggle('on', v === 'leave');
    $('#tabClaim').setAttribute('aria-selected', String(v === 'claim'));
    $('#tabLeave').setAttribute('aria-selected', String(v === 'leave'));
    if (v === 'leave') syncLeaveDefaults();
    else { $('#fromEmail').value = cfg.fromEmail; $('#toEmail').value = cfg.toEmail; }
  }

  /* ---------- email panel ---------- */
  const mailFields = () => ({ from: $('#fromEmail').value.trim(), to: $('#toEmail').value.trim(), subject: $('#subject').value, body: $('#body').value });
  const leaveMailFields = () => ({ from: $('#lFromEmail').value.trim(), to: $('#lToEmail').value.trim(), subject: $('#lSubject').value, body: $('#lBody').value });

  function renderPack(kind) {
    const p = S.packs[kind];
    const box = $(kind === 'claim' ? '#pack' : '#lPack');
    const fields = kind === 'claim' ? mailFields : leaveMailFields;
    if (!p) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = '';
    box.append(h('div', {},
      h('h3', { text: p.title }),
      p.savedTo ? h('div', { class: 'note ok', text: 'Saved to ' + p.savedTo + (kind === 'claim' ? ' (the zip is next to it)' : '') }) : h('div', { class: 'note info', text: 'Downloaded to your Downloads folder.' }),
      p.stale ? h('div', { class: 'note warn', text: `You changed something after building – build again before sending.` }) : null,
      p.blob.size / 1048576 > 24 ? h('div', { class: 'note warn', text: 'This is over 24 MB, which Gmail may refuse. Tick "Shrink photos" and build again, or send it by link.' }) : null,
      h('ul', {}, p.entries.map((e) => h('li', { text: `${e.path} (${sizeText(e.size)})` })))));
    const files = p.attachments.map((a) => new File([a.blob], a.name, { type: a.blob.type || 'application/octet-stream' }));
    const canShare = !!(navigator.canShare && navigator.canShare({ files }));
    const what = p.attachments.length > 1 ? 'files' : 'zip';
    box.append(h('div', { class: 'actions' },
      h('button', { class: 'primary', type: 'button', text: 'Open Gmail draft', onclick: () => window.open(Mail.gmailLink(fields()), '_blank', 'noopener') }),
      h('button', { class: 'ghost', type: 'button', text: `Download .eml draft (${what} attached)`, onclick: async () => {
        const m = fields();
        download(await Mail.emlBlob({ from: m.from, to: m.to, subject: m.subject, body: m.body, attachments: p.attachments }), safe(m.subject) + '.eml');
      } }),
      h('button', { class: 'ghost', type: 'button', text: 'Download zip again', onclick: () => download(p.blob, p.name) }),
      canShare ? h('button', { class: 'ghost', type: 'button', text: 'Share…', onclick: () => navigator.share({ files, title: fields().subject, text: fields().body }).catch(() => {}) }) : null));
    box.append(h('p', { class: 'hint', text: `Gmail opens with the To, Subject and message filled in (sent from ${fields().from || 'your work account'}). A web link can't attach files, so attach the ${what} yourself (drag it in from the saved folder or use the paperclip). The .eml file opens in Outlook / Apple Mail with the ${what} already attached.` }));
  }

  /* ---------- save folder ---------- */
  async function refreshLoc() {
    const handle = Folder.supported ? await Folder.getSaved() : null;
    document.querySelectorAll('.loc').forEach((box) => {
      box.textContent = '';
      if (!Folder.supported) { box.append(h('span', { class: 'muted', text: "This browser can't save into a folder, so the zip downloads instead. Use Chrome or Edge to pick a save folder." })); return; }
      box.append(h('span', { text: 'Save to:' }), h('b', { text: handle ? handle.name : 'not chosen yet' }),
        h('button', { class: 'link', type: 'button', text: handle ? 'Change folder' : 'Choose folder', onclick: changeFolder }),
        handle ? null : h('span', { class: 'muted', text: "You'll also be asked the first time you build." }));
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
    refreshLoc();
    $('#dlg').showModal();
  }

  /* ---------- init ---------- */
  function init() {
    ClaimPdf.croppedLogo().then((l) => { $('#brandLogo').src = l.url; }).catch(() => { $('#brandLogo').remove(); });
    const dl = h('datalist', { id: 'cats' }, CATEGORIES.map((c) => h('option', { value: c })));
    document.body.append(dl);

    $('#claimant').value = cfg.claimant; $('#signature').value = cfg.signature;
    $('#fromEmail').value = cfg.fromEmail; $('#toEmail').value = cfg.toEmail;
    const now = new Date();
    $('#month').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    $('#lSignDate').value = localIso(now);

    $('#claimant').addEventListener('input', () => { cfg.claimant = $('#claimant').value; saveCfg(); updateSummary(); });
    $('#signature').addEventListener('input', () => { cfg.signature = $('#signature').value; saveCfg(); updateSummary(); });
    $('#month').addEventListener('input', () => { S.touched.month = true; renderLines(); });
    $('#daysOff').addEventListener('input', renderLines);
    $('#fromEmail').addEventListener('input', () => { cfg.fromEmail = $('#fromEmail').value; saveCfg(); });
    $('#toEmail').addEventListener('input', () => { cfg.toEmail = $('#toEmail').value; saveCfg(); });
    $('#subject').addEventListener('input', () => { S.touched.subject = true; });
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
    $('#lFromEmail').addEventListener('input', () => { cfg.fromEmail = $('#lFromEmail').value; saveCfg(); });
    $('#lToEmail').addEventListener('input', () => { cfg.toEmail = $('#lToEmail').value; saveCfg(); });
    $('#lSubject').addEventListener('input', () => { S.touched.lSubject = true; });
    $('#lBody').addEventListener('input', () => { S.touched.lBody = true; });
    ['#lFrom', '#lTo', '#lReason'].forEach((id) => $(id).addEventListener('input', (e) => e.target.classList.remove('guess')));
    $('#lBuild').addEventListener('click', buildLeave);
    $('#tabClaim').addEventListener('click', () => showView('claim'));
    $('#tabLeave').addEventListener('click', () => showView('leave'));

    wireDrop();
    $('#ocrOn').checked = !!cfg.ocr;
    $('#ocrOn').addEventListener('change', () => { cfg.ocr = $('#ocrOn').checked; saveCfg(); });

    $('#btnBuild').addEventListener('click', buildPack);
    $('#btnSettings').addEventListener('click', openSettings);
    $('#sLocChange').addEventListener('click', changeFolder);
    $('#sLocForget').addEventListener('click', async () => { await Folder.forget(); refreshLoc(); });
    $('#sReset').addEventListener('click', () => { $('#sHol').value = TNG.DEFAULT_HOLIDAYS; });
    $('#dlgForm').addEventListener('submit', () => {
      cfg.toName = $('#sToName').value.trim(); cfg.signoff = $('#sSignoff').value.trim();
      cfg.holidays = $('#sHol').value;
      saveCfg(); S.touched.body = false; S.touched.lBody = false; renderLines(); refreshLeaveEmail();
    });

    renderLines();
    refreshStatus();
    refreshLoc();
    refreshLeaveEmail();
  }

  window.__claimApp = { S, routeFiles, onTng, onOther, buildPack, buildLeave, compileLines, tollView };   // handy for testing
  init();
})();
