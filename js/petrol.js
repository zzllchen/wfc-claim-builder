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

  /* A date the dot-matrix print and the reader have both mangled: "112CT2026" (11 OCT 2026), "11QCT20286", "240512026" (24 OCT 2026).
     The day is the two digits at the front; the month is the word that, once look-alike characters are treated as the same (0 O Q D,
     5 S, 1 I L T, 2 Z, 8 B, 6 G), is within one slip of a month name (the claim month wins a tie); the year is 20xx, or the claim year when
     the token is within one slip of it. Returns [{ at, d }]. */
  const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const LOOK = { 0: 'O', Q: 'O', D: 'O', '@': 'O', 5: 'S', $: 'S', 1: 'I', L: 'I', '|': 'I', '!': 'I', T: 'I', 2: 'Z', 8: 'B', 6: 'G' };
  const lookNorm = (t) => t.toUpperCase().replace(/[0QD@5$1L|!T286]/g, (c) => LOOK[c]);
  const MONTH_NORM = MONTH_NAMES.map(lookNorm);
  const DAYLET = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', '|': '1', R: '2', Z: '2', z: '2', E: '3', A: '4', S: '5', s: '5', G: '6', b: '6', T: '7', Y: '7', B: '8', g: '9', q: '9' };
  const DAYCH = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', '|': '1', S: '5', B: '8', Z: '2', G: '6' };
  function fuzzyDates(text, opts) {
    const out = [], claim = opts && opts.month ? opts.month.split('-') : null;
    const re = /(?<![0-9A-Za-z])([0-9OQDIlS|BZG]{1,2})[ 	]?([A-Za-z0-9@|!$)(]{2,4}?)[ 	]?(2[0O][0-9OQDIlS]{2,3})(?!\d)/g;
    let m;
    while ((m = re.exec(String(text)))) {
      const day = +m[1].replace(/[OQDIlS|BZG]/g, (c) => DAYCH[c]);
      if (!(day >= 1 && day <= 31)) continue;
      // the month word: every month within one slip of the token (or the two-letter form with its first letter lost: "CT")
      const tok = lookNorm(m[2].replace(/[)(]/g, 'I'));
      const near = [];
      MONTH_NORM.forEach((mn, i) => {
        if (tok.length < 2) return;
        const dist = Math.min(editDistance(tok, mn), tok.length === 2 ? editDistance(tok, mn.slice(1)) : 9);
        if (dist <= 1) near.push(i + 1);
      });
      let mon = 0;
      if (claim && near.includes(+claim[1])) mon = +claim[1];
      else if (near.length === 1) mon = near[0];
      else if (claim && !near.length && /^[A-Z0-9]{3}$/.test(tok)) mon = +claim[1];     // three marks where a month should be and the year matches the claim: the claim month
      if (!mon) continue;
      // the year: as printed, or the claim year when the token is one slip from it
      let yr = 0;
      const ytok = m[3].replace(/[OQD]/g, '0').replace(/[IlS]/g, (c) => (c === 'S' ? '5' : '1'));
      if (claim && editDistance(ytok, claim[0]) <= 1) yr = +claim[0];
      else if (ytok.length === 4) yr = +ytok;
      else if (claim && ytok.length === 5 && [0, 1, 2, 3, 4].some((k) => ytok.slice(0, k) + ytok.slice(k + 1) === claim[0])) yr = +claim[0];
      // how far the reading is to be trusted: 3 = month word and year both exact, 2 = year exact, month one slip away, 1 = both guessed
      const tier = lookNorm(m[2]) === MONTH_NORM[mon - 1] && m[2].replace(/[0@QD]/g, 'O').toUpperCase() === MONTH_NAMES[mon - 1] && +ytok === yr ? 3 : +ytok === yr ? 2 : 1;
      if (validDate(yr, mon, day)) out.push({ at: m.index, d: iso(yr, mon, day), tier });
    }
    // the day itself can be mangled into letters ("RA0CT2026" for 24OCT2026) while the month and the year are plain: then the claim month's name
    // and the exact claim year are anchors, and the one or two marks in front of them are the day
    if (claim) {
      const name = MONTH_NAMES[+claim[1] - 1], anchor = new RegExp('(?<![0-9A-Za-z])([0-9A-Za-z|]{1,2})[ \\t]?(' + name.replace(/O/g, '[O0Q]') + ')[ \\t]?(' + claim[0] + ')(?!\\d)', 'gi');
      while ((m = anchor.exec(String(text)))) {
        const day = +m[1].replace(/[A-Za-z|]/g, (c) => DAYLET[c] || '9');
        if (day >= 1 && day <= 31 && validDate(+claim[0], +claim[1], day) && !out.some((x) => x.at === m.index)) out.push({ at: m.index, d: iso(+claim[0], +claim[1], day), tier: 3 });
      }
    }
    return out;
  }

  /* every plausible date in the text, as YYYY-MM-DD, in reading order */
  function dates(text, opts) { return datesDetailed(text, opts).map((x) => x.d); }
  function datesDetailed(text, opts) {
    const out = [], raw = String(text);        // the fuzzy reader gets the text as it came, before the tidying below changes its marks
    let m;
    // OCR reads the letter O as a zero inside month names ("19/0ct/2026"), sometimes with a stray extra one ("0Oct")
    text = String(text).replace(/(\d{1,2}\s*[-\/.\s]?\s*)([A-Za-z0]{3,9})(?=\s*[-\/,.\s]?\s*\d{4})/g, (all, pre, mon) => pre + mon.replace(/0/g, 'o'));
    // dot-matrix print often loses the first letter of a month ("11CT2026" for 11OCT2026)
    const LOST = { CT: 'OCT', EC: 'DEC', OV: 'NOV', EB: 'FEB', UG: 'AUG', EP: 'SEP' };
    text = text.replace(/(\d{1,2})\s?(CT|EC|OV|EB|UG|EP)(?=\s?\d{4})/gi, (all, d, f) => d + LOST[f.toUpperCase()]);
    const dmy = /(?<!\d)(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4}|\d{2})(?!\d)/g;
    while ((m = dmy.exec(text))) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (validDate(y, +m[2], +m[1])) out.push({ at: m.index, d: iso(y, +m[2], +m[1]), tier: 3 });
    }
    const ymd = /(?<!\d)(\d{4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?!\d)/g;
    while ((m = ymd.exec(text))) if (validDate(+m[1], +m[2], +m[3])) out.push({ at: m.index, d: iso(+m[1], +m[2], +m[3]), tier: 3 });
    const named = /(?<!\d)(\d{1,2})\s*[-\/.\s]?\s*([A-Za-z]{3,9})\.?\s*[-\/,.\s]?\s*(\d{4})(?!\d)/g;   // 23APR2026, 19/Oct/2026, 5 Jun 2026
    while ((m = named.exec(text))) {
      const w = m[2].toLowerCase();
      const mon = MONTHS[w.slice(0, 4) === 'sept' ? 'sept' : w.slice(0, 3)] || MONTHS[w.slice(1, 4)];     // 2nd form: "ooct" -> oct
      if (mon && validDate(+m[3], mon, +m[1])) out.push({ at: m.index, d: iso(+m[3], mon, +m[1]), tier: 3 });
    }
    const exact = new Set(out.map((x) => x.d));
    fuzzyDates(raw, opts).forEach((x) => { if (!exact.has(x.d)) out.push(x); });       // after the exact ones: only dates the plain reading missed
    return out.sort((a, b) => a.at - b.at);
  }

  // 12.34 but not litres ("20.12L"), which sit on the same line as the price. OCR often puts a space round the point ("RM116 .68")
  const MONEY = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\s?[.,]\s?)(\d{2})(?!\d)(?!\s*(?:l|ltr|litres?|liters?)\b)/gi;
  // "RMS8 . 37", "RMG1. 40", "KM49 91", "-RM74 93": after RM, letters that are really digits (S 5, G 6, O 0, I 1, B 8, Z 2) and a point
  // the print lost are put right, so "RM74.93" can be read
  const LIKE = { O: '0', o: '0', S: '5', s: '5', I: '1', l: '1', '|': '1', B: '8', G: '6', Z: '2' };
  const digits = (t) => t.replace(/[OoSsIl|BGZ]/g, (c) => LIKE[c]);
  const normMoney = (text) => String(text).replace(/\b[RK]M\s?([0-9OoSsIl|BGZ]{1,5})(?:\s?[.,]\s?|\s)([0-9OoSsIl|BGZ]{2})(?![0-9A-Za-z])/g, (all, a, b) => 'RM' + digits(a) + '.' + digits(b));
  let sureFlag = null;     // set by amount(): false when a subsidy receipt's TOTAL does not equal item minus subsidy (a digit was misread)
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
  const DEDUCT_SKIP = /\b(price|harga|information|info|details?|scan|e-?invoice|\w*nvoice\w*|balance|bal)\b/i;      // headings and the footer "Scan for E-Invoice & Subsidy Details" are not a discount
  const SUBSIDY_WORD = /subsid|budi|discount|diskaun|rebate/i;
  const MINUS_AMT = /[-–—~]\s*(?:RM|MYR)?\s*\d/i;

  // a word on the line that is the given word give or take a slip: "TO1AL" for TOTAL (the print turns I into 1 and O into 0)
  function fuzzyWord(line, word, slips) {
    return String(line).split(/[^A-Za-z0-9]+/).some((t) => t.length >= word.length - 1 && t.length <= word.length + 1 && editDistance(t.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I'), word) <= slips);
  }

  /* the amount paid: a TOTAL / AMOUNT line, never cash given or change */
  function amount(text) {
    sureFlag = null;
    const lines = normMoney(text).split(/\r?\n/);
    const skip = /\b(change|baki|cash|tunai|tender|tendered|received|diterima|rounding|sst|gst|tax|price|harga|volume|liter|litre|qty|deposit)\b/i;   // a deposit is never part of the claim
    const NOT_AMOUNT = /\b(tarikh|date|tel|h\/p|k\/p|passport|booking|check|phone|fax)\b/i;      // a figure on these lines is a date or a phone number misread, never the total
    // the nearest line with text above / below line i (OCR leaves blank lines, and often reads the amounts column before the labels)
    const near = (i, step) => { for (let j = i + step; j >= 0 && j < lines.length && Math.abs(j - i) <= 3; j += step) if (lines[j].trim()) return lines[j]; return ''; };
    const amountOnly = (l) => moneyIn(l).length > 0 && !/[A-Za-z]/.test(l.replace(/RM|MYR/gi, ''));
    // the TOTAL label, even when the print has mangled it ("TO1AL", "T0TAL", "TOTA")
    const TOTAL_RE = { test: (ln) => /\b(grand\s*total|total|jumlah)\b/i.test(ln) || fuzzyWord(ln, 'TOTAL', 1) };
    const pick = (re) => {
      const found = [];
      lines.forEach((ln, i) => {
        if (!re.test(ln) || skip.test(ln)) return;
        let vals = moneyIn(ln);
        const next = near(i, 1), prev = near(i, -1);
        if (!vals.length && next && !skip.test(next)) vals = moneyIn(next);
        if (!vals.length && prev && !skip.test(prev) && amountOnly(prev)) vals = moneyIn(prev);    // "RM60 . 00" read just above its "TOTAL"
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
      const all = moneyIn(ln), vals = all.filter((v) => v > 0);
      if (vals.length) vals.forEach((v) => cuts.add(v));
      // "Budios subsidy -RMS€ 68": there, but garbled. The word alone is not enough (the footer says "Subsidy Details"): an RM sign or a minus must follow it
      else if (!all.length && (MINUS_AMT.test(ln) || /(?:subsid|budi|discount|diskaun|rebate)\w*[^A-Za-z]{0,6}[-–—~]?\s*(?:RM|MYR)/i.test(ln))) unreadable = true;
    });
    const discounted = cuts.size > 0 || unreadable;
    let gross = null, net = null;
    if (discounted) {
      lines.forEach((ln) => {
        if (DEDUCT_WORD.test(ln) || skip.test(ln) || TOTAL_RE.test(ln)) return;
        moneyIn(ln).forEach((v) => { if (gross == null || v > gross) gross = v; });
      });
      const off = Array.from(cuts).reduce((a, v) => a + v, 0);
      // the thin leading 1 of "RM130.57" is often lost ("RM 30.57"): an item line smaller than its own subsidy is that, and 100 more is the item
      if (gross != null && off > 0 && gross >= 10 && gross < 100 && gross < off + 1 && gross + 100 - off >= 1 && gross + 100 - off <= off * 1.6) gross = Math.round((gross + 100) * 100) / 100;
      if (gross != null && off > 0 && gross - off >= 1) net = Math.round((gross - off) * 100) / 100;
    }
    if (/deposit/i.test(text)) {                    // hotel bill: the room total row includes the deposit, the SUB TOTAL below it does not
      const sub = pick(/\bsub\s*-?\s*total\b/i);
      if (sub.length) return sub[sub.length - 1];
    }
    for (const re of [TOTAL_RE, /\b(amount|amt|nett?|payable|bayar|sale)\b/i]) {
      const f = pick(re);
      if (f.length) {
        let labelled;
        if (discounted) {
          const below = gross != null ? f.filter((v) => v < gross - 0.05) : f;       // the figures after the discount
          if (below.length) { labelled = below[below.length - 1]; if (net != null) sureFlag = Math.abs(labelled - net) <= 0.05; }
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
    const all = lines.filter((ln) => !skip.test(ln) && !NOT_AMOUNT.test(ln)).reduce((acc, ln) => acc.concat(moneyIn(ln)), []).filter((v) => v >= 5);
    const counts = new Map();
    all.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
    const repeated = Array.from(counts).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    if (repeated.length) return repeated[0][0];
    return counts.size === 1 ? all[0] : null;       // a lone amount on the page is almost always the total
  }

  /* ---- subsidy fuel receipts: the arithmetic is printed on the slip, so a misread number can be put right ----
     "29.332L@RM4.420/L" is the litres and the pump price; the Budi95 line below it carries the subsidy per litre (pump price less RM1.99).
     The slip's own sums: item = litres x pump price, subsidy = litres x (pump price - 1.99), total = item - subsidy, and the litres
     balance: previous - litres = remaining. With the litres and pump price read (even on a slip whose money lines are garbled) the total
     can be worked out, and a misread total one or two digits away from it is corrected. */
  const BUDI_PRICE = 1.99;
  const DGT = { O: '0', o: '0', Q: '0', D: '0', G: '6', g: '6', S: '5', s: '5', Z: '2', z: '2', B: '8', I: '1', l: '1', '|': '1', A: '4' };
  const dg = (t) => String(t).replace(/[OoQDGgSsZzBIl|A]/g, (c) => DGT[c]);
  const r2 = (x) => Math.round(x * 100) / 100;
  // one "29.332L@RM4.420/L" line -> litres and price   (litres: three decimals, then L; price: RM, a digit, two or three decimals)
  const LITRE_LINE = /(?<![\d.])(\d{1,3})\s?[.,]\s?([0-9OGSZBIl]{3})[0-9]?\s*[LlIi1!|]?\s*[@&A-Za-z]{0,3}\s*[RK]M\s?([0-9OGSZBIlA])\s?[.,]?\s?([0-9OGSZBIl]{2})/g;
  function fuelFacts(text) {
    const t = String(text), lit = [], pump = [], sub = [];
    let m;
    LITRE_LINE.lastIndex = 0;
    while ((m = LITRE_LINE.exec(t))) {
      const litres = parseFloat(dg(m[1]) + '.' + dg(m[2])), price = parseFloat(dg(m[3]) + '.' + dg(m[4]));
      if (!(litres >= 1 && litres <= 200) || !(price >= 1 && price <= 7)) continue;
      lit.push(litres);
      (price >= 3.2 ? pump : sub).push(price);
    }
    const bals = (re) => { const out = []; let x; const g = new RegExp(re.source, 'gi'); while ((x = g.exec(t))) { const v = parseFloat(dg(x[1]) + '.' + dg(x[2])); if (v > 0 && v < 1000) out.push(v); } return out; };
    const prevs = bals(/prev\w*\s*[a-z]{0,3}\s*[:.]?\s*([0-9OGSZBIl]{1,3})\s?[.,]\s?([0-9OGSZBIl]{3})/);
    const remains = bals(/rema\w*\s*[a-z]{0,4}\s*[:.]?\s*([0-9OGSZBIl]{1,3})\s?[.,]\s?([0-9OGSZBIl]{3})/);
    return { lit, pump, sub, prevs, remains, prev: prevs[0] == null ? null : prevs[0], remain: remains[0] == null ? null : remains[0] };
  }
  const mode = (arr) => { const c = new Map(); arr.forEach((v) => c.set(v, (c.get(v) || 0) + 1)); return Array.from(c).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]; };
  /* the facts of one or more readings -> litres, pump price, and the total they work out to ; price comes from the pump lines, checked against the subsidy lines */
  function fuelTotal(facts) {
    if (!facts || !facts.lit.length) return null;
    const L = mode(facts.lit);                                      // [value, how many lines agree]
    let litres = L[0], votes = L[1], bal = null;
    // previous - litres = remaining: a triple that agrees is three numbers each confirming the others
    const prevs = facts.prevs || (facts.prev != null ? [facts.prev] : []), remains = facts.remains || (facts.remain != null ? [facts.remain] : []);
    const uniqLit = Array.from(new Set(facts.lit));
    outer: for (const x of uniqLit.sort((a, b) => (facts.lit.filter((v) => v === b).length - facts.lit.filter((v) => v === a).length))) {
      for (const pv of prevs) for (const rm of remains) if (Math.abs(pv - rm - x) < 0.0015) { litres = x; votes += 3; bal = { prev: pv, remain: rm, litres: x }; break outer; }
    }
    if (!bal && prevs.length && remains.length && votes < 2) {      // no triple agrees and the litres line is weak: the balances' difference is the better witness
      const viaBal = Math.round((prevs[0] - remains[0]) * 1000) / 1000;
      if (viaBal > 0 && viaBal < 200) { litres = viaBal; votes = 1; }
    }
    // pump price: the one the pump lines agree on; a subsidy line (pump price less 1.99) is a second witness
    const cand = new Map();
    facts.pump.forEach((p) => cand.set(p, (cand.get(p) || 0) + 1));
    facts.sub.forEach((q) => { const p = Math.round((q + BUDI_PRICE) * 100) / 100; cand.set(p, (cand.get(p) || 0) + 1); });
    const best = Array.from(cand).filter(([p]) => p >= 3.2 && p <= 6.5).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    if (!best) return null;
    const price = best[0], item = r2(litres * price), subsidy = r2(litres * (price - BUDI_PRICE));
    return { litres, price, item, subsidy, total: r2(item - subsidy), sure: votes >= 2, priceSure: best[1] >= 2, bal };       // total = litres x 1.99 whatever the pump price, give or take a cent of rounding
  }
  const digitsOf = (n) => n.toFixed(2).replace('.', '');
  /* a read total and the worked-out one -> the amount to use, and why ; null when the worked-out one cannot be trusted enough to override */
  function snapTotal(read, ft) {
    if (!ft) return null;
    const have = parseFloat(read);
    if (!(have > 0)) return ft.sure ? { amount: ft.total.toFixed(2), sure: true, how: 'worked out' } : null;
    if (!ft.sure) return null;                                         // the litres were not read twice: not enough to say anything about the total
    // the worked-out total is exact when the pump price is known, and within a cent either way when it is not
    if (Math.abs(have - ft.total) <= (ft.priceSure ? 0.015 : 0.025)) return { amount: ft.priceSure ? ft.total.toFixed(2) : have.toFixed(2), sure: true, how: 'confirmed' };
    if (editDistance(digitsOf(have), digitsOf(ft.total)) <= 2) return { amount: ft.total.toFixed(2), sure: true, how: 'corrected' };
    return null;
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

  function editDistance(a, b) {
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  // "PETRA", "HET RONAS", "PE TRoNAg" are PETRONAS read badly: close enough to a fuel brand's letters, and only a brand
  const FUEL_NAMES = ['PETRONAS', 'PETRON', 'SHELL', 'CALTEX', 'SETEL', 'ENEOS'];
  function fuzzyBrand(line) {
    const L = String(line).toUpperCase().replace(/[^A-Z]/g, '');
    if (L.length < 4 || L.length > 12) return false;
    return FUEL_NAMES.some((b) => editDistance(L, b) <= Math.max(1, Math.floor(b.length * 0.4)));
  }

  /* station: a station seen before if its name appears in the text, else the first name-like line */
  function station(text, known) {
    const st = stationRaw(text, known);
    if (!st) return '';
    if (fuzzyBrand(st) && !FUEL_BRAND.test(st.replace(/[^A-Za-z ]/g, '').trim())) return '';       // "Pe Yrong" is PETRONAS misread, not a shop
    const letters = st.toUpperCase().replace(/[^A-Z]/g, '');
    if (/FORMAT|SUBSID|INVOIC|TOTAL|PRICE|BALANCE|APPROV|TERMINAL|THANK|PUMP|REMAIN|PREVIOUS/.test(letters)) return '';      // a label of the slip, not a name
    if (/[A-Za-z]\d|\d[A-Za-z]/.test(st) && !(known || []).some((k) => k.toLowerCase() === st.toLowerCase())) return '';  // letters and digits fused ("Rin1l13") is noise
    return st;
  }
  function stationRaw(text, known) {
    const up = text.toUpperCase();
    let best = '', bestHits = 0;
    (known || []).forEach((name) => {
      const ws = words(name);
      if (!ws.length) return;
      // OCR often drops the first or last letters ("JAYAAN TEGUH ENT" for KEJAYAAN TEGUH ENTERPRISE), so a long word also counts
      // when all but its first two or last two letters are there
      // (and one wrong letter is allowed: TEGUM for TEGUH)
      const here = words(text);
      const close = (w) => w.length >= 5 && here.some((x) => Math.abs(x.length - w.length) <= 1 && editDistance(x, w) <= 1);
      const hits = ws.filter((w) => up.includes(w) || (w.length >= 7 && (up.includes(w.slice(2)) || up.includes(w.slice(0, -2)))) || close(w)).length;
      if (hits / ws.length >= 0.6 && hits > bestHits) { best = name; bestHits = hits; }
    });
    if (best) return best;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 8);
    const nameLike = (l) => {
      const letters = (l.match(/[A-Za-z]/g) || []).length;
      return letters >= 5 && letters / l.length > 0.6 && !NOISE_LINE.test(l);
    };
    // a clinic prints its name in capitals ("KLINIK PUTRA CARE"); the bare word KLINIK on the first line would otherwise be taken as the
    // name, so look for the full name anywhere in the text first
    const clinic = /\b(?:KLINIK|POLIKLINIK|CLINIC|FARMASI)(?:[ \t]+[A-Z][A-Z&.'-]+){1,3}/.exec(text);       // words on the same line only
    if (clinic) return tidy(clinic[0]);
    const brandAt = lines.findIndex((l) => (BRANDS.some((b) => l.toUpperCase().includes(b)) || fuzzyBrand(l)) && /[A-Za-z]{4}/.test(l));
    if (brandAt >= 0) {
      // "PETRONAS" on its own line: the dealer's name on the next line is what the claim uses
      if (FUEL_BRAND.test(lines[brandAt].replace(/[^A-Za-z ]/g, '').trim()) || fuzzyBrand(lines[brandAt])) {
        const dealer = lines.slice(brandAt + 1).find(nameLike);
        if (dealer) return tidy(dealer);
        if (!FUEL_BRAND.test(lines[brandAt].replace(/[^A-Za-z ]/g, '').trim())) return '';       // PETRONAS read badly, and no shop name under it: no name
      }
      return tidy(lines[brandAt]);
    }
    const first = lines.find((l) => {
      const letters = (l.match(/[A-Za-z]/g) || []).length;
      return letters >= 5 && letters / l.length > 0.6 && !NOISE_LINE.test(l);
    });
    return first ? tidy(first) : '';
  }
  // a hotel's name ends at the word Hotel: "PEKAN AUTO CITY BUDGET HOTEL curser ROOM BILL" is the hotel and the bill's title after it
  const tidy = (l) => l.replace(/[^A-Za-z0-9&'.,() \-]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(.*\b(?:hotel|motel|resort|homestay|guest\s?house|lodge|inn))\b.*$/i, '$1')
    .toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

  // Petronas invoice numbers are six hex characters ("60770c", "df8349"): G read for 6, O for 0, S for 5 and so on are put right
  const HEXLIKE = { G: '6', g: '6', O: '0', o: '0', Q: '0', I: '1', l: '1', '|': '1', S: '5', s: '5', B: '8', Z: '2', z: '2' };
  function hexFix(tok) {
    if (/^[0-9a-f]{6}$/i.test(tok)) return tok.toLowerCase();
    if (tok.length !== 6) return tok;
    const fixed = tok.replace(/[GgOoQIl|SsBZz]/g, (c) => HEXLIKE[c]);
    return /^[0-9a-f]{6}$/i.test(fixed) ? fixed.toLowerCase() : tok;
  }

  // the six-character invoice number read many times: each position takes the character most readings agree on (one misread character is outvoted)
  function hexVote(list) {
    const hex = list.filter((v) => /^[0-9a-f]{6}$/.test(v) && /\d/.test(v));
    if (!hex.length) return '';
    if (hex.length < 3) return hex[0];
    let out = '';
    for (let i = 0; i < 6; i++) { const c = new Map(); hex.forEach((v) => c.set(v[i], (c.get(v[i]) || 0) + 1)); out += Array.from(c).sort((a, b) => b[1] - a[1])[0][0]; }
    return out;
  }

  /* receipt / transaction number: only when it is labelled, and has a digit in it */
  function receiptNo(text) {
    // a Petronas slip: "Invoice No 60770c" (six hex characters). The label and the value are often mangled ("Invoice NG GO770C"), so read what follows the word
    const lines = String(text).split(/\r?\n/);
    for (const ln of lines) {
      const toks = ln.split(/[ \t]+/);
      const at = toks.findIndex((t) => t.replace(/[^A-Za-z]/g, '').length >= 5 && editDistance(t.replace(/[^A-Za-z]/g, '').toUpperCase(), 'INVOICE') <= 2);
      if (at < 0) continue;
      for (const t of toks.slice(at + 1)) {                         // skip the "No" and any junk, take the first six-character value
        const h = hexFix(t.replace(/[^0-9A-Za-z|]/g, ''));
        if (/^[0-9a-f]{6}$/.test(h) && /\d/.test(h)) return h;
      }
    }
    if (/subsid|budi/i.test(text)) return '';                      // a subsidy slip's invoice number is the six hex characters or nothing: the site and transaction numbers are not it
    // the label decides how much we trust a number: "Invoice No" on a petrol slip beats a bank "Ref"
    const labels = ['[il1]nv(?:oice)?', 'receipt|rcpt|resit', 'trans(?:action)?|txn|trx', 'bill|slip|doc(?:ument)?', 'ref(?:erence)?'];
    for (const label of labels) {
      const re = new RegExp('\\b(?:' + label + ')\\s*(?:no|num(?:ber)?|id|#)?\\s*[:.#\\-]?\\s*([A-Za-z0-9][A-Za-z0-9\\-]{3,19})\\b', 'gi');
      let m;
      while ((m = re.exec(text))) {
        const tok = m[1];
        if (/\d/.test(tok) && !/^\d{1,2}[-/]\d{1,2}/.test(tok) && !/^(no|number|date|time)$/i.test(tok)) return label === labels[0] ? hexFix(tok) : tok;
      }
    }
    // clinic official receipts just say "No. RCC000014807": letters then a long number (not an MC number)
    const official = /(?:official\s+receipt|resit)[\s\S]{0,200}?\b((?!MC)[A-Z]{2,4}\d{6,})\b/i.exec(text);
    if (official) return official[1].toUpperCase();
    // printed pad numbers ("No 257947", "№ 257947") on hotel bills and hand-written receipts: five or more digits right after No
    const padNo = /(?:^|[\s:])(?:no|n[o°º]|№)\.?\s*[:.#]?\s*(\d{5,9})\b/im.exec(text);
    return padNo ? padNo[1] : '';
  }

  /* opts: { month: 'YYYY-MM', stations: [names seen before] } */
  function parse(text, opts) {
    opts = opts || {};
    const dd = datesDetailed(text, opts);
    let ds = dd.map((x) => x.d);
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
    // MBSJ / council "Flexi Parking" monthly receipt (an email, a PDF of it or a screenshot): the Payment line is this month's
    // fee. The table under it adds the next period too, so its Total (twice the fee) is never the claim.
    let category = '', stationName = null;
    if (/flexi\s*parking/i.test(text)) {
      category = 'Parking';
      stationName = /\bmbsj\b/i.test(text) ? 'MBSJ Flexi Parking' : 'Flexi Parking';
      const pay = /\bpayment\s*:?\s*(?:RM|MYR)?\s*(\d{1,3}(?:,\d{3})+|\d+)\s?\.\s?(\d{2})(?!\d)/i.exec(text);
      if (pay) amt = parseFloat(pay[1].replace(/,/g, '') + '.' + pay[2]);
    }
    let fuel = null, sureOut = foreign ? null : sureFlag;
    if (!foreign && /subsid|budi/i.test(text)) {            // a subsidy fuel slip: check the total against the litres and the pump price
      fuel = fuelFacts(text);
      const snap = sureOut === true ? null : snapTotal(amt == null ? '' : amt, fuelTotal(fuel));
      if (snap) { amt = parseFloat(snap.amount); sureOut = true; }
    }
    const out = {
      fuel,
      date: (inMonth[0] || ds[0] || ''),
      dateTier: (dd[ds.indexOf(inMonth[0] || ds[0])] || { tier: 0 }).tier,
      amount: amt == null ? '' : amt.toFixed(2),
      foreign,
      station: stationName || station(text, opts.stations),
      receiptNo: receiptNo(text),
      category,
      sure: sureOut,                                // false: the amount does not add up (item - subsidy != TOTAL), so a digit was probably misread
    };
    out.found = !!(out.date || out.amount || out.foreign || out.station || out.receiptNo);
    return out;
  }

  /* Several readings of one receipt (each page layout, each way up) are read one by one and the fields voted on: a digit the engine
     misread in one reading is outvoted by the others, and a reading whose amount adds up (item - subsidy = TOTAL) counts triple. */
  function best(texts, opts) {
    const rs = (texts || []).map((t) => parse(t, opts));
    if (!rs.length) return parse('', opts);
    const vote = (key, usable) => {
      const c = new Map();
      rs.forEach((r, i) => {
        const v = r[key];
        if (!v || (usable && !usable(r))) return;
        const e = c.get(v) || { n: 0, first: i };
        e.n += key === 'date' ? (r.dateTier || 1) : r.sure === true ? 3 : 1;
        c.set(v, e);
      });
      return Array.from(c.entries()).sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first).map((x) => x[0]);
    };
    const known = ((opts && opts.stations) || []).map((s) => s.toLowerCase());
    // the shop name: a saved shop beats everything; then the reading that also found the amount and date; then the most word-like
    const score = (name, r) => (known.includes(name.toLowerCase()) ? 100 : 0) + (r.amount ? 10 : 0) + (r.date ? 10 : 0)
      + 5 * ((name.match(/[A-Za-z]/g) || []).length / Math.max(1, name.length)) + Math.min(5, name.split(/\s+/).filter((w) => w.length >= 3).length);
    let stations = rs.filter((r) => r.station).map((r) => [r.station, score(r.station, r)]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    // a hard photo is read many times: a name only one of those readings came up with (and no saved shop matches) is a misreading, not a name
    if (rs.length >= 4 && stations.length) {
      const near = (a, b) => editDistance(a.toLowerCase(), b.toLowerCase()) <= Math.max(2, Math.floor(Math.min(a.length, b.length) * 0.25));
      const firstOf = (t) => texts.indexOf(t);
      const agreed = stations.filter((n) => known.includes(n.toLowerCase()) || rs.filter((r, i) => r.station && firstOf(texts[i]) === i && near(r.station, n)).length >= 2);
      stations = agreed;
    }
    const out = Object.assign({}, rs.find((r) => r.found) || rs[0], {
      amount: vote('amount', (r) => r.sure !== false)[0] || vote('amount')[0] || '',
      date: vote('date')[0] || '',
      station: stations[0] || '',
      receiptNo: hexVote(rs.map((r) => r.receiptNo)) || vote('receiptNo')[0] || '',
      category: (rs.find((r) => r.category) || {}).category || '',
      foreign: (rs.find((r) => r.foreign) || {}).foreign || null,
    });
    out.sure = rs.some((r) => r.amount === out.amount && r.sure === true) ? true : rs.some((r) => r.amount === out.amount && r.sure === false) ? false : null;
    // the litres and pump price are read on several lines of several readings: pool them, work the total out, and fix a doubtful total with it
    if (out.sure !== true && rs.some((r) => r.fuel)) {
      const pool = { lit: [], pump: [], sub: [], prevs: [], remains: [] };
      rs.forEach((r) => {
        if (!r.fuel) return;
        pool.lit.push.apply(pool.lit, r.fuel.lit); pool.pump.push.apply(pool.pump, r.fuel.pump); pool.sub.push.apply(pool.sub, r.fuel.sub);
        pool.prevs.push.apply(pool.prevs, r.fuel.prevs || []); pool.remains.push.apply(pool.remains, r.fuel.remains || []);
      });
      const ft = fuelTotal(pool), snap = snapTotal(out.amount, ft);
      if (snap) { out.amount = snap.amount; out.sure = true; out.fuelNote = snap.how; }
      out.fuelFacts = ft;
      out.bal = ft && ft.bal ? ft.bal : null;       // the litres balance before and after, when previous - litres = remaining agrees: the order slips were bought in
    }
    // a slip whose total already adds up still carries its balances: the order of slips is worth knowing
    else if (rs.some((r) => r.fuel)) {
      const pool = { lit: [], pump: [], sub: [], prevs: [], remains: [] };
      rs.forEach((r) => { if (!r.fuel) return; pool.lit.push.apply(pool.lit, r.fuel.lit); pool.pump.push.apply(pool.pump, r.fuel.pump); pool.sub.push.apply(pool.sub, r.fuel.sub); pool.prevs.push.apply(pool.prevs, r.fuel.prevs || []); pool.remains.push.apply(pool.remains, r.fuel.remains || []); });
      const ft = fuelTotal(pool);
      out.bal = ft && ft.bal ? ft.bal : null;
    }
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

  /* slips from one claim, each { id, date, bal: { prev, remain, litres } } -> [{ id, why }] for the dates that cannot be right:
     the monthly litres allowance only goes down, so the slip with more litres left was bought first and must not be dated later */
  const sameBal = (a, b) => Math.abs(a - b) < 0.0015 || (a.toFixed(3).length === b.toFixed(3).length && editDistance(a.toFixed(3), b.toFixed(3)) <= 1);
  function orderCheck(slips) {
    const ok = slips.filter((x) => x.bal && x.date);
    const out = new Map();
    ok.forEach((a) => ok.forEach((b) => {
      if (a === b || !sameBal(a.bal.remain, b.bal.prev)) return;      // b is the slip bought straight after a
      if (a.date > b.date) {
        out.set(b.id, `Check the date: this slip comes straight after the one dated ${a.date}, but is dated earlier.`);
        if (!out.has(a.id)) out.set(a.id, `Check the date: the slip bought after this one is dated ${b.date}, earlier than ${a.date}.`);
      }
    }));
    return Array.from(out, ([id, why]) => ({ id, why }));
  }

  return { parse, best, orderCheck, dates, datesDetailed, amount, station, receiptNo, inWords, mc, foreignTotal, foreignAmounts, stripForeign, myrCharged, fuelFacts, fuelTotal, snapTotal };
});
