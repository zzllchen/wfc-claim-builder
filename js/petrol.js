/* Turns the text OCR read from a receipt photo into claim-line fields.
   Pure functions (browser: window.Petrol, Node: module.exports) so they can be tested without a camera.
   It only fills what it is reasonably sure about; anything else stays blank for the person to type. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Petrol = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const BRANDS = ['PETRONAS', 'PETRON', 'SHELL', 'CALTEX', 'BHP', 'SETEL', 'ENEOS', 'PETROL', 'MINYAK', 'ENTERPRISE', 'SDN BHD', 'STESEN',
    'KLINIK', 'CLINIC', 'HOSPITAL', 'FARMASI', 'PHARMACY'];
  const FUEL_BRAND = /^(petronas|petron|shell|caltex|bhp|setel|eneos)$/i;   // a bare brand is not the dealer's name
  const NOISE_LINE = /^(tel|fax|phone|gst|sst|reg|co\.?\s*no|company|tax|invoice|receipt|date|time|no\b|cashier|pump|www|http|thank|terima)/i;

  const pad = (n) => String(n).padStart(2, '0');
  const validDate = (y, m, d) => {
    if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  };
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  /* every plausible date in the text, as YYYY-MM-DD, in reading order */
  function dates(text) {
    const out = [];
    let m;
    // OCR reads the letter O as a zero inside month names ("19/0ct/2026"), sometimes with a stray extra one ("0Oct")
    text = String(text).replace(/(\d{1,2}\s*[-\/.\s]?\s*)([A-Za-z0]{3,9})(?=\s*[-\/,.\s]?\s*\d{4})/g, (all, pre, mon) => pre + mon.replace(/0/g, 'o'));
    const dmy = /(?<!\d)(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4}|\d{2})(?!\d)/g;
    while ((m = dmy.exec(text))) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (validDate(y, +m[2], +m[1])) out.push({ at: m.index, d: iso(y, +m[2], +m[1]) });
    }
    const ymd = /(?<!\d)(\d{4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?!\d)/g;
    while ((m = ymd.exec(text))) if (validDate(+m[1], +m[2], +m[3])) out.push({ at: m.index, d: iso(+m[1], +m[2], +m[3]) });
    const named = /(?<!\d)(\d{1,2})\s*[-\/.\s]?\s*([A-Za-z]{3,9})\.?\s*[-\/,.\s]?\s*(\d{4})(?!\d)/g;   // 23APR2026, 19/Oct/2026, 5 Jun 2026
    while ((m = named.exec(text))) {
      const w = m[2].toLowerCase();
      const mon = MONTHS[w.slice(0, 4) === 'sept' ? 'sept' : w.slice(0, 3)] || MONTHS[w.slice(1, 4)];     // 2nd form: "ooct" -> oct
      if (mon && validDate(+m[3], mon, +m[1])) out.push({ at: m.index, d: iso(+m[3], mon, +m[1]) });
    }
    return out.sort((a, b) => a.at - b.at).map((x) => x.d);
  }

  // 12.34 but not litres ("20.12L"), which sit on the same line as the price. OCR often puts a space round the point ("RM116 .68")
  const MONEY = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\s?\.\s?|,)(\d{2})(?!\d)(?!\s*(?:l|ltr|litres?|liters?)\b)/gi;
  const moneyIn = (s) => {
    const out = [];
    let m;
    MONEY.lastIndex = 0;
    while ((m = MONEY.exec(s))) out.push(parseFloat(m[1].replace(/,/g, '') + '.' + m[2]));
    return out;
  };

  const NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
    fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

  /* "RINGGIT SEVENTY FIVE ONLY" -> 75 ; "RM ONE HUNDRED AND TWENTY CENTS FIFTY ONLY" -> 120.50 ; otherwise null */
  function inWords(text) {
    const m = /\b(?:ringgit(?:\s+malaysia)?|rm)\s+((?:[a-z\-]+\s+){1,9}?)only\b/i.exec(String(text).replace(/\s+/g, ' '));
    if (!m) return null;
    const [ringgitPart, centsPart] = m[1].toLowerCase().split(/\bcents?\b|\bsen\b/);
    const toNum = (s) => {
      let total = 0, cur = 0, seen = false;
      for (const w of s.split(/[\s\-]+/).filter(Boolean)) {
        if (w === 'and' || w === 'rm' || w === 'ringgit' || w === 'malaysia') continue;
        if (w in NUM) { cur += NUM[w]; seen = true; }
        else if (w === 'hundred') { cur = (cur || 1) * 100; seen = true; }
        else if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; seen = true; }
        else return null;                           // not a number word: this isn't an amount in words
      }
      return seen ? total + cur : null;
    };
    const r = toNum(ringgitPart || '');
    if (r == null) return null;
    const c = centsPart ? toNum(centsPart) : 0;
    return r + (c || 0) / 100;
  }

  /* A subsidy / discount line ("Budi95 Subsidy -RM56.68") comes off the item line above it. The amount paid is the figure
     AFTER it, so the item line on its own (RM116.68) is never taken as the amount. */
  const DEDUCT_WORD = /\b(subsid\w*|budi\w*|discount|diskaun|rebate|voucher|promo\w*)/i;
  const DEDUCT_SKIP = /\b(price|harga|information|info)\b/i;
  const MINUS_AMT = /[-–—~]\s*(?:RM|MYR)?\s*\d/i;

  /* the amount paid: a TOTAL / AMOUNT line, never cash given or change */
  function amount(text) {
    const lines = text.split(/\r?\n/);
    const skip = /\b(change|baki|cash|tunai|tender|tendered|received|diterima|rounding|sst|gst|tax|price|harga|volume|liter|litre|qty)\b/i;
    const pick = (re) => {
      const found = [];
      lines.forEach((ln, i) => {
        if (!re.test(ln) || skip.test(ln)) return;
        let vals = moneyIn(ln);
        if (!vals.length && lines[i + 1] && !skip.test(lines[i + 1])) vals = moneyIn(lines[i + 1]);
        vals.forEach((v) => { if (v > 0) found.push(v); });
      });
      return found;
    };
    // cash given minus change is the total: a cross-check on the TOTAL line, and the answer when that line is unreadable
    const cashes = [], changes = [];
    lines.forEach((ln) => {
      if (/\b(change|baki)\b/i.test(ln)) changes.push.apply(changes, moneyIn(ln));
      else if (/\b(cash|tunai|tender|tendered|received|diterima)\b/i.test(ln)) cashes.push.apply(cashes, moneyIn(ln));
    });
    let paid = null;
    if (cashes.length && changes.length) {
      const t = Math.round((Math.max.apply(null, cashes) - Math.min.apply(null, changes)) * 100) / 100;
      if (t >= 1) paid = t;
    }
    // subsidy / discount lines: what came off (cuts), whether a cut was there but its figure unreadable, and the item line above
    const cuts = new Set();
    let unreadable = false;
    lines.forEach((ln) => {
      if (!DEDUCT_WORD.test(ln) || DEDUCT_SKIP.test(ln)) return;
      const vals = moneyIn(ln).filter((v) => v > 0);
      if (vals.length) vals.forEach((v) => cuts.add(v));
      else if (MINUS_AMT.test(ln)) unreadable = true;
    });
    const discounted = cuts.size > 0 || unreadable;
    let gross = null, net = null;
    if (discounted) {
      lines.forEach((ln) => {
        if (DEDUCT_WORD.test(ln) || skip.test(ln) || /\b(total|jumlah)\b/i.test(ln)) return;
        moneyIn(ln).forEach((v) => { if (gross == null || v > gross) gross = v; });
      });
      const off = Array.from(cuts).reduce((a, v) => a + v, 0);
      if (gross != null && off > 0 && gross - off >= 1) net = Math.round((gross - off) * 100) / 100;
    }
    for (const re of [/\b(grand\s*total|total|jumlah)\b/i, /\b(amount|amt|nett?|payable|bayar|sale)\b/i]) {
      const f = pick(re);
      if (f.length) {
        let labelled;
        if (discounted) {
          const below = gross != null ? f.filter((v) => v < gross - 0.05) : f;       // the figures after the discount
          if (below.length) labelled = below[below.length - 1];
          else if (net != null) labelled = net;
          else return paid;                                                         // only the pre-discount figure was readable
        } else labelled = Math.max.apply(null, f);
        return paid != null && Math.abs(paid - labelled) > 0.05 ? paid : labelled;   // "60.46" misread as "0.46"
      }
    }
    // no TOTAL line read: the item line less the discount, else blank - never the pre-discount figure
    if (discounted) return net != null ? net : paid;
    const spelled = inWords(text);                  // clinic receipts: "RM SEVENTY FIVE ONLY"
    if (spelled != null) return spelled;
    if (paid != null) return paid;
    // no label: only trust an amount on a plain line (never cash / change) that appears more than once
    const all = lines.filter((ln) => !skip.test(ln)).reduce((acc, ln) => acc.concat(moneyIn(ln)), []).filter((v) => v >= 5);
    const counts = new Map();
    all.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
    const repeated = Array.from(counts).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    if (repeated.length) return repeated[0][0];
    return counts.size === 1 ? all[0] : null;       // a lone amount on the page is almost always the total
  }

  /* ---- other currencies: a receipt in USD etc. is never recorded as ringgit; the app converts it to MYR ---- */
  const SYMCODE = { 'US$': 'USD', '$': 'USD', 'S$': 'SGD', 'A$': 'AUD', 'C$': 'CAD', 'HK$': 'HKD', 'NZ$': 'NZD',
    '€': 'EUR', '£': 'GBP', '¥': 'JPY', '฿': 'THB', '₹': 'INR', '₩': 'KRW', '₱': 'PHP' };
  const ISO = 'USD|SGD|EUR|GBP|AUD|CAD|HKD|NZD|JPY|CNY|RMB|THB|IDR|INR|KRW|PHP';
  const SYM = '(?<![A-Za-z])(?:US\\$|HK\\$|NZ\\$|S\\$|A\\$|C\\$|\\$)|[€£¥฿₹₩₱]';
  const FAMT = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)\\s?\\.\\s?\\d{2}(?!\\d)';
  // symbol or code before the figure ($11.00, USD 11.00 [USD]), or the code after it (11.00 USD)
  const fxRe = () => new RegExp('(?:(' + SYM + ')|\\b(' + ISO + ')\\b)\\s?(' + FAMT + ')(?:\\s?\\b(' + ISO + ')\\b)?|(' + FAMT + ')\\s?\\b(' + ISO + ')\\b', 'gi');
  const FX_LABEL = /\b(grand\s+total|total|amount\s+(?:due|paid|charged)|balance\s+due|charged|paid)\s*:?\s*$/i;
  const codeOf = (c) => { c = String(c || '').toUpperCase(); return c === 'RMB' ? 'CNY' : c; };
  const hasMyr = (t) => /\b(?:RM|MYR)\s?\d|\d\s?(?:RM|MYR)\b|\bringgit\b/i.test(t);

  /* every amount written with a foreign symbol or code: [{ code, value, at, end, labelled }] */
  function foreignAmounts(text) {
    const out = [], re = fxRe();
    let m;
    text = String(text);
    while ((m = re.exec(text))) {
      const code = m[4] || m[2] || m[6] || (m[1] ? SYMCODE[m[1].toUpperCase()] : '');
      const raw = m[3] || m[5];
      if (!code || !raw) continue;
      out.push({ code: codeOf(code), value: parseFloat(raw.replace(/[\s,]/g, '')), at: m.index, end: m.index + m[0].length,
        labelled: FX_LABEL.test(text.slice(Math.max(0, m.index - 30), m.index)) });
    }
    return out;
  }
  const stripForeign = (text) => {
    text = String(text);
    let out = '', at = 0;
    foreignAmounts(text).forEach((s) => { out += text.slice(at, s.at) + ' '; at = s.end; });
    return out + text.slice(at);
  };
  /* the total of a document written in another currency -> { code, amount } or null */
  function foreignTotal(text) {
    const all = foreignAmounts(text);
    if (!all.length) return null;
    const labelled = all.filter((a) => a.labelled);
    const pool = labelled.length ? labelled : all;                  // no TOTAL label: the biggest figure
    const top = pool.reduce((a, b) => (b.value > a.value ? b : a));
    return top.value > 0 ? { code: top.code, amount: top.value } : null;
  }
  /* "Charged RM46.70 using 1 USD = 4.2452 MYR": the card was charged in ringgit, so that is the amount */
  function myrCharged(text) {
    const m = /\b(?:charged|amount\s+(?:charged|paid|due)|total(?:\s+charged)?)\s*:?\s*(?:RM|MYR)\s?(\d{1,3}(?:,\d{3})+|\d+)\s?\.\s?(\d{2})(?!\d)/i.exec(String(text));
    return m ? parseFloat(m[1].replace(/,/g, '') + '.' + m[2]) : null;
  }

  const words = (s) => s.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 4);

  /* station: a station seen before if its name appears in the text, else the first name-like line */
  function station(text, known) {
    const up = text.toUpperCase();
    let best = '', bestHits = 0;
    (known || []).forEach((name) => {
      const ws = words(name);
      if (!ws.length) return;
      const hits = ws.filter((w) => up.includes(w)).length;
      if (hits / ws.length >= 0.6 && hits > bestHits) { best = name; bestHits = hits; }
    });
    if (best) return best;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 8);
    const nameLike = (l) => {
      const letters = (l.match(/[A-Za-z]/g) || []).length;
      return letters >= 5 && letters / l.length > 0.6 && !NOISE_LINE.test(l);
    };
    const brandAt = lines.findIndex((l) => BRANDS.some((b) => l.toUpperCase().includes(b)) && /[A-Za-z]{4}/.test(l));
    if (brandAt >= 0) {
      // "PETRONAS" on its own line: the dealer's name on the next line is what the claim uses
      if (FUEL_BRAND.test(lines[brandAt].replace(/[^A-Za-z ]/g, '').trim())) {
        const dealer = lines.slice(brandAt + 1).find(nameLike);
        if (dealer) return tidy(dealer);
      }
      return tidy(lines[brandAt]);
    }
    const first = lines.find((l) => {
      const letters = (l.match(/[A-Za-z]/g) || []).length;
      return letters >= 5 && letters / l.length > 0.6 && !NOISE_LINE.test(l);
    });
    return first ? tidy(first) : '';
  }
  const tidy = (l) => l.replace(/[^A-Za-z0-9&'.,() \-]/g, ' ').replace(/\s+/g, ' ').trim()
    .toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

  /* receipt / transaction number: only when it is labelled, and has a digit in it */
  function receiptNo(text) {
    // the label decides how much we trust a number: "Invoice No" on a petrol slip beats a bank "Ref"
    const labels = ['[il1]nv(?:oice)?', 'receipt|rcpt|resit', 'trans(?:action)?|txn|trx', 'bill|slip|doc(?:ument)?', 'ref(?:erence)?'];
    for (const label of labels) {
      const re = new RegExp('\\b(?:' + label + ')\\s*(?:no|num(?:ber)?|id|#)?\\s*[:.#\\-]?\\s*([A-Za-z0-9][A-Za-z0-9\\-]{3,19})\\b', 'gi');
      let m;
      while ((m = re.exec(text))) {
        const tok = m[1];
        if (/\d/.test(tok) && !/^\d{1,2}[-/]\d{1,2}/.test(tok) && !/^(no|number|date|time)$/i.test(tok)) return tok;
      }
    }
    // clinic official receipts just say "No. RCC000014807": letters then a long number (not an MC number)
    const official = /(?:official\s+receipt|resit)[\s\S]{0,200}?\b((?!MC)[A-Z]{2,4}\d{6,})\b/i.exec(text);
    return official ? official[1].toUpperCase() : '';
  }

  /* opts: { month: 'YYYY-MM', stations: [names seen before] } */
  function parse(text, opts) {
    opts = opts || {};
    let ds = dates(text);
    if (opts.month) {
      // OCR often misreads the year digit (2026 -> 2024): a date in the claim month with the wrong year is that month
      const [cy, cm] = opts.month.split('-');
      ds = ds.map((d) => (d.slice(5, 7) === cm && d.slice(0, 4) !== cy ? `${cy}-${cm}-${d.slice(8, 10)}` : d));
    }
    const inMonth = opts.month ? ds.filter((d) => d.slice(0, 7) === opts.month) : [];
    let amt, foreign = null;
    if (foreignAmounts(text).length) {              // written in another currency: ringgit only when the document says so
      amt = myrCharged(text);
      if (amt == null && hasMyr(text)) amt = amount(stripForeign(text));
      if (amt == null) foreign = foreignTotal(text);
    } else amt = amount(text);
    const out = {
      date: (inMonth[0] || ds[0] || ''),
      amount: amt == null ? '' : amt.toFixed(2),
      foreign,
      station: station(text, opts.stations),
      receiptNo: receiptNo(text),
    };
    out.found = !!(out.date || out.amount || out.foreign || out.station || out.receiptNo);
    return out;
  }

  /* Medical certificate (MC): -> { mcNo, from, to, diagnosis } or null when the text isn't one. A photo can hold several. */
  function mc(text) {
    const t = String(text || '');
    if (!/medical\s+certificate/i.test(t)) return null;
    const ds = dates(t).sort();
    const no = /\bMC\s?-?(\d{3,7})\b/i.exec(t);
    const dx = /diagnosis[\s:.\-]*([A-Za-z][A-Za-z ]{2,30})/i.exec(t);
    return {
      mcNo: no ? 'MC' + no[1] : '',
      from: ds[0] || '',
      to: ds[ds.length - 1] || '',
      diagnosis: dx ? dx[1].trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : '',
    };
  }

  return { parse, dates, amount, station, receiptNo, inWords, mc, foreignTotal, foreignAmounts, stripForeign, myrCharged };
});
