/* TNG eWallet statement parser + toll rules.
   Works in the browser (window.TNG) and in Node (module.exports) so the rules can be tested. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TNG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
  const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;
  const MONEY_RE = /^\d{1,3}(,\d{3})*\.\d{2}$|^\d+\.\d{2}$/;
  const SECTOR_RE = /^(TOLL|PARKING|RETAIL)$/;
  const SP_CODE_RE = /^[A-Z0-9]{1,3}_[A-Z0-9_]+$/;
  const TYPE_WORDS = new Set(['Fare', 'Usage -', 'Toll/Bus', 'Parking', 'OTA', 'Reload']);
  const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
    september: 9, october: 10, november: 11, december: 12 };

  const iso = (dmy) => dmy.slice(6, 10) + '-' + dmy.slice(3, 5) + '-' + dmy.slice(0, 2);

  /* ---------- parsing ---------- */

  function parseHeader(items) {
    const get = (label) => {
      const l = items.find((i) => i.str.trim() === label);
      if (!l) return '';
      const v = items.find((i) => i.str.trim().startsWith(':') && Math.abs(i.y - l.y) <= 3 && i.x > l.x);
      return v ? v.str.replace(/^\s*:\s*/, '').trim() : '';
    };
    const header = {
      name: get('Account Name'),
      ewalletId: get('eWallet ID'),
      serial: get('Serial No.'),
      generated: get('Generated Date & Time'),
      periodText: get('Transaction Period'),
    };
    return addRange(header);
  }

  /* "1 October 2026 - 31 October 2026" -> header.from / header.to as YYYY-MM-DD */
  function addRange(header) {
    const m = header.periodText.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*-\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
    if (m && MONTHS[m[2].toLowerCase()] && MONTHS[m[5].toLowerCase()]) {
      const p2 = (n) => String(n).padStart(2, '0');
      header.from = `${m[3]}-${p2(MONTHS[m[2].toLowerCase()])}-${p2(m[1])}`;
      header.to = `${m[6]}-${p2(MONTHS[m[5].toLowerCase()])}-${p2(m[4])}`;
    }
    return header;
  }

  /* ---------- the newer statement: "TNG WALLET TRANSACTION HISTORY" (the app's own export) ----------
     Two layouts exist, and both are read. This one is a single table, a row per payment:
     date posted | status | type | reference cells | [plaza code] | description | details (the real date and time) | amount | wallet balance.
     The date that counts is the one in "details" (a payment late in the evening is posted the next day). The wallet ID is the statement's number. */
  const WALLET_DMY = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
  const WALLET_STAMP = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i;
  const WALLET_RM = /^[+-]?\s?RM\s?([\d,]+\.\d{2})$/i;
  const isWalletStatement = (items) => items.some((i) => /^TNG WALLET TRANSACTION HISTORY$/i.test(i.str.trim()));

  // toll (RFID payment), parking, or anything else (reloads, transfers, shop payments: never claimed, so RETAIL)
  function walletSector(type, description) {
    if (/park/i.test(`${type} ${description}`)) return 'PARKING';
    if (/rfid|toll|highway|expressway/i.test(type)) return 'TOLL';
    return 'RETAIL';
  }

  function parseWallet(pages) {
    const strs = [];
    pages.forEach((page) => page.forEach((it) => { const s = it.str.trim(); if (s) strs.push(s); }));
    const header = { name: '', ewalletId: '', serial: '', generated: '', periodText: '' };
    const pi = strs.findIndex((s) => /^\d{1,2}\s+[A-Za-z]+\s+\d{4}\s*-\s*\d{1,2}\s+[A-Za-z]+\s+\d{4}$/.test(s));
    if (pi >= 0) {
      header.periodText = strs[pi];
      if (strs[pi + 1] && !/^\d+$/.test(strs[pi + 1])) header.name = strs[pi + 1];
      header.ewalletId = strs.slice(pi + 1, pi + 4).find((s) => /^\d{8,}$/.test(s)) || '';
    }
    header.generated = strs.find((s) => /^\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+\d{1,2}:\d{2}\s*[AP]M$/i.test(s)) || '';
    header.serial = header.ewalletId;               // goes on the claim line as the Receipt No.
    addRange(header);

    const groups = [];
    let cur = null;
    strs.forEach((s) => { if (WALLET_DMY.test(s)) { cur = []; groups.push(cur); } if (cur) cur.push(s); });
    const p2 = (n) => String(n).padStart(2, '0');
    const rows = [];
    groups.forEach((cells, k) => {
      const si = cells.findIndex((c) => WALLET_STAMP.test(c));
      if (si < 0) return;
      if (/fail|declin|reject|cancel|revers/i.test(cells[1] || '')) return;          // a payment that did not go through
      const money = cells.slice(si + 1).filter((c) => WALLET_RM.test(c)).slice(0, 2);   // the amount, then the balance (text after that is page furniture)
      if (!money.length) return;
      const st = WALLET_STAMP.exec(cells[si]);
      const hour = (+st[4] % 12) + (/PM/i.test(st[6]) ? 12 : 0);
      const description = /^\d+$/.test(cells[si - 1] || '') ? '' : (cells[si - 1] || '');   // a bare number is the plaza code, not its name
      const type = walletSector(cells[2] || '', description);
      const date = `${st[3]}-${st[2]}-${st[1]}`;
      rows.push({
        no: String(k + 1), date, time: `${p2(hour)}:${st[5]}:00`, exitDate: date, type,
        amount: parseFloat(WALLET_RM.exec(money[0])[1].replace(/,/g, '')),
        balance: money[1] ? parseFloat(WALLET_RM.exec(money[1])[1].replace(/,/g, '')) : 0,
        posted: '', plaza: description, text: `${description} ${cells[2] || ''}`.toUpperCase(),
      });
    });
    return { header, rows };
  }

  /* Join wrapped fragments back into words: "KEMBANGA" + "N" -> "KEMBANGAN". */
  function joinTokens(tokens) {
    let out = '';
    tokens.forEach((t) => {
      const tail = t.match(/^([A-Z]{1,2})(?=$|\s)(.*)$/);   // "N", or "A - BATU 9" after "GRANDSAG"
      if (!out) out = t;
      else if (tail && /[A-Z]{6,}$/.test(out)) out += tail[1] + tail[2];
      else out += ' ' + t;
    });
    return out;
  }

  function parseRow(raw) {
    // keep tokens up to and including the sector cell; anything after belongs to page furniture
    const parts = [];
    for (const p of raw.parts) {
      parts.push(p);
      if (SECTOR_RE.test(p.s)) break;
    }
    const last = parts[parts.length - 1];
    if (!last || !SECTOR_RE.test(last.s)) return null;
    const type = last.s;

    const dates = [];
    let posted = '';
    const moneyIdx = [];
    parts.forEach((p, i) => {
      if (DATE_RE.test(p.s)) dates.push({ d: iso(p.s), t: '' });
      else if (TIME_RE.test(p.s) && dates.length) dates[dates.length - 1].t = p.s;
      else if (MONEY_RE.test(p.s)) moneyIdx.push(i);
      else if (/^\d{2}\/\d{2}$/.test(p.s) && parts[i + 1] && /^\/\d{4}$/.test(parts[i + 1].s)) posted = p.s;
    });
    if (!dates.length || moneyIdx.length < 2) return null;

    const amount = parseFloat(parts[moneyIdx[moneyIdx.length - 2]].s.replace(/,/g, ''));
    const balance = parseFloat(parts[moneyIdx[moneyIdx.length - 1]].s.replace(/,/g, ''));

    // location cells sit between the type words and the amount
    let typeEnd = -1;
    parts.forEach((p, i) => { if (TYPE_WORDS.has(p.s)) typeEnd = i; });
    const locParts = parts.slice(typeEnd + 1, moneyIdx[moneyIdx.length - 2]).filter((p) => p.s !== '/2026' && !/^\/\d{4}$/.test(p.s));

    // split into entry / exit location by position of the two SP code cells
    const codes = locParts.filter((p) => SP_CODE_RE.test(p.s));
    let entry = [], exit = [];
    if (codes.length >= 2) {
      const e = codes[0].x, x = codes[1].x;
      locParts.forEach((p) => {
        if (p.x < e - 15) entry.push(p.s);
        else if (p.x >= e + 35 && p.x < x - 15) exit.push(p.s);
      });
    } else {
      entry = locParts.filter((p) => !SP_CODE_RE.test(p.s)).map((p) => p.s);
    }
    const entryName = joinTokens(entry), exitName = joinTokens(exit);
    const plaza = !exitName || exitName === entryName ? entryName : `${entryName} → ${exitName}`;

    return {
      no: raw.no,
      date: dates[0].d,            // toll: transaction date; parking: entry date
      time: dates[0].t,
      exitDate: (dates[1] || dates[0]).d,
      type,
      amount,
      balance,
      posted,
      plaza,
      // everything the plaza rules look at (operator cells included, e.g. "09_KESAS")
      text: (plaza + ' ' + locParts.map((p) => p.s).join(' ')).toUpperCase(),
    };
  }

  /* pages: array of arrays of { str, x, y } in content-stream order. */
  function parseItems(pages) {
    if (!pages.length) throw new Error('Empty PDF');
    const first = pages[0];
    if (isWalletStatement(first)) return parseWallet(pages);
    if (!first.some((i) => i.str.trim() === 'Customer Transactions Statement')) {
      throw new Error("This doesn't look like a Touch 'n Go eWallet statement.");
    }
    const header = parseHeader(first);
    const raws = [];
    let cur = null;
    pages.forEach((page) => {
      page.forEach((it) => {
        const s = it.str.trim();
        if (!s) return;
        if (/^\d{5,}$/.test(s) && it.x < 80) { cur = { no: s, parts: [] }; raws.push(cur); return; }
        if (cur) cur.parts.push({ s, x: it.x, y: it.y });
      });
    });
    const rows = raws.map(parseRow).filter(Boolean);
    return { header, rows };
  }

  async function extract(arrayBuffer) {
    if (typeof Lazy !== 'undefined') await Lazy.need('pdf');       // the PDF reader is loaded after the page is up (js/lazy.js)
    const pdfjs = (typeof pdfjsLib !== 'undefined') ? pdfjsLib : null;
    if (!pdfjs) throw new Error('PDF reader not loaded');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      pages.push(tc.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] })));
    }
    return parseItems(pages);
  }

  /* ---------- rules ---------- */

  const DEFAULT_HOLIDAYS = [
    "2026-01-01 New Year's Day",
    '2026-02-01 Thaipusam / Federal Territory Day',
    '2026-02-02 Thaipusam (replacement)',
    '2026-02-17 Chinese New Year',
    '2026-02-18 Chinese New Year (day 2)',
    '2026-03-07 Nuzul Al-Quran (Selangor)',
    '2026-03-21 Hari Raya Aidilfitri',
    '2026-03-22 Hari Raya Aidilfitri (day 2)',
    '2026-03-23 Hari Raya Aidilfitri (replacement)',
    '2026-05-01 Labour Day',
    '2026-05-27 Hari Raya Haji',
    '2026-05-31 Wesak Day',
    "2026-06-01 Agong's Birthday",
    '2026-06-02 Wesak Day (replacement)',
    '2026-06-17 Awal Muharram',
    '2026-08-25 Maulidur Rasul',
    '2026-08-31 Merdeka Day',
    '2026-09-16 Malaysia Day',
    '2026-11-08 Deepavali',
    '2026-11-09 Deepavali (replacement)',
    "2026-12-11 Sultan of Selangor's Birthday",
    '2026-12-25 Christmas Day',
  ].join('\n');

  function parseHolidays(text) {
    const map = new Map();
    String(text || '').split(/\r?\n/).forEach((line) => {
      const l = line.trim();
      if (!l) return;
      let m = l.match(/^(\d{4})-(\d{2})-(\d{2})\s*(.*)$/);
      if (!m) {
        const d = l.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(.*)$/);
        if (d) m = [null, d[3], d[2].padStart(2, '0'), d[1].padStart(2, '0'), d[4]];
      }
      if (m) map.set(`${m[1]}-${m[2]}-${m[3]}`, (m[4] || 'Public holiday').trim());
    });
    return map;
  }

  /* "27/08-28/08, 05/08" -> Set of ISO dates (year taken from the claim month). */
  function parseDaysOff(text, year) {
    const set = new Set();
    const toIso = (s) => {
      const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
      if (!m) return null;
      const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : year;
      return new Date(Date.UTC(y, +m[2] - 1, +m[1]));
    };
    String(text || '').split(/[,;\n]/).forEach((chunk) => {
      const c = chunk.trim();
      if (!c) return;
      const [a, b] = c.split(/\s*(?:-|to)\s*/);
      const d1 = toIso(a), d2 = b ? toIso(b) : d1;
      if (!d1 || !d2) return;
      for (let t = d1.getTime(); t <= d2.getTime(); t += 86400000) set.add(new Date(t).toISOString().slice(0, 10));
    });
    return set;
  }

  const dow = (isoDate) => new Date(isoDate + 'T00:00:00Z').getUTCDay();   // 0 Sun .. 6 Sat

  /* opts: { month: 'YYYY-MM', holidays: Map, daysOff: Set }
     Every toll on a work day counts, wherever in Malaysia it was: Mon-Fri, not a public holiday, not a day off (leave).
     Weekends, public holidays and leave days are holidays / trips home, so they never count. Parking is claimed only
     when stated (ticked by hand). Each row gets include (bool) and reason (string). Reloads are dropped. */
  function classify(rows, opts) {
    return rows.filter((r) => r.type !== 'RETAIL').map((r) => {
      const row = Object.assign({}, r, { include: false, reason: '' });
      if (opts.month && r.date.slice(0, 7) !== opts.month) { row.reason = 'Outside claim month'; return row; }
      if (r.type === 'PARKING') { row.reason = 'Parking \u2013 tick only if stated'; return row; }
      const wd = dow(r.date);
      if (wd === 0 || wd === 6) { row.reason = wd === 0 ? 'Sunday' : 'Saturday'; return row; }
      if (opts.holidays && opts.holidays.has(r.date)) { row.reason = 'Public holiday \u2013 ' + opts.holidays.get(r.date); return row; }
      if (opts.daysOff && opts.daysOff.has(r.date)) { row.reason = 'Day off / leave'; return row; }
      row.include = true; row.reason = 'Work-day toll';
      return row;
    });
  }
  const round2 = (n) => Math.round(n * 100 + 1e-9) / 100;
  const sum = (rows, type) => round2(rows.filter((r) => r.include && r.type === type).reduce((a, r) => a + r.amount, 0));

  return { parseItems, extract, classify, parseHolidays, parseDaysOff, sum, round2, dow, DEFAULT_HOLIDAYS };
});
