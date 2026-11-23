/* Flow's general receipt reader. It reads the text of any receipt or invoice (a PDF's text, or what OCR read from a photo) with no
   rules for one vendor or layout: it looks for what every receipt has - the seller, a document number, dates, money beside its label,
   the way it was paid - by their labels in English, Bahasa Malaysia and Chinese, and says how sure it is of each field (0 to 1).
   What it is not sure of is marked "needs review"; the claim tool then asks Claude (only when unsure), and the person has the last word.
   Fuel slips, Touch 'n Go statements and software invoices keep their own, more exact readers (petrol.js, tng.js, receipts.js);
   their results are cross-checked against this one.
   Read(text or lines, { month: 'YYYY-MM', today: Date }) -> { fields..., confidence: {}, why: {}, needsReview: [], unsure: bool } */
(function (root) {
  'use strict';
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    januari: 1, februari: 2, mac: 3, mei: 5, julai: 7, ogos: 8, oktober: 10, disember: 12 };
  const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  const pad = (n) => String(n).padStart(2, '0');
  const r2 = (n) => Math.round(n * 100) / 100;

  /* ---------- the text, cleaned: one entry per line ---------- */
  function linesOf(input) {
    const raw = Array.isArray(input) ? input.join('\n') : String(input || '');
    return raw
      .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))       // full-width digits, letters and colons (Chinese receipts)
      .replace(/　/g, ' ').replace(/[­‐-―−﹘﹣]/g, '-')
      .split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }

  /* ---------- money: every amount with its currency and the words in front of it ---------- */
  const CUR = [['MYR', /\b(?:RM|MYR)\b|ringgit/i], ['USD', /\bUSD\b|US\$|(?<![A-Z])\$/], ['SGD', /\bSGD\b|S\$/], ['EUR', /\bEUR\b|€/], ['GBP', /\bGBP\b|£/],
    ['CNY', /\b(?:CNY|RMB)\b|元|¥/], ['THB', /\bTHB\b|฿/], ['IDR', /\b(?:IDR|Rp)\b/], ['JPY', /\bJPY\b/], ['AUD', /\bAUD\b|A\$/], ['HKD', /\bHKD\b|HK\$/]];
  const AMOUNT = /(?<![\d.,])(-?)(\d{1,3}(?:[,\s]\d{3})+|\d+)[.,](\d{2})(?![\d])/g;
  function moneyOf(lines) {
    const out = [];
    lines.forEach((line, li) => {
      AMOUNT.lastIndex = 0;
      let m;
      while ((m = AMOUNT.exec(line))) {
        if (/^\d{1,2}[.,]\d{2}$/.test(m[0]) && /\d{1,2}[.:]\d{2}\s*(?:am|pm|AM|PM)\b/.test(line.slice(m.index, m.index + 9))) continue;   // a time, 10.30 am
        if (/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(line.slice(Math.max(0, m.index - 3), m.index + m[0].length + 5))) continue;           // part of a date
        const value = parseFloat(m[2].replace(/[,\s]/g, '') + '.' + m[3]) * (m[1] ? -1 : 1);
        const before = line.slice(Math.max(0, m.index - 40), m.index), after = line.slice(m.index + m[0].length, m.index + m[0].length + 8);
        // the label: the words in front on this line, or (labels and values in two columns) the line before
        let label = before.replace(/[\s:=.-]+$/, '');
        if (!/[A-Za-z一-鿿]{3,}/.test(label) && li > 0) label = lines[li - 1] + ' ' + label;
        let currency = '';
        for (const [code, re] of CUR) if (re.test(before.slice(-8)) || re.test(after)) { currency = code; break; }
        out.push({ value, currency, label: label.slice(-60), line: li, text: line });
      }
    });
    return out;
  }
  const L_TOTAL = /\b(grand\s*total|total\s*(?:amount|payable|paid|due|charged|price|incl\.?|including|\(?rm\)?|\(?myr\)?)?|amount\s*(?:paid|due|payable|charged)|net\s*(?:total|amount)|jumlah(?:\s*(?:besar|keseluruhan|bayaran|perlu\s*dibayar))?|charged|you\s*paid|total\s*bayaran|bayaran)\b|合计|总计|总额|实付|应付|付款金额|總計|合計/i;
  const L_NOT_TOTAL = /\b(sub\s*-?\s*total|subtotal|jumlah\s*kecil|before|savings?|discount|diskaun|change|baki|cash|tunai|tendered|rounding|pembundaran|deposit|points?|balance|previous|unit\s*price|qty|quantity|each)\b|小计|找零|找赎|现金|折扣/i;
  const L_SUB = /\b(sub\s*-?\s*total|subtotal|jumlah\s*kecil|total\s*(?:excl|before\s*tax))\b|小计|小計/i;
  const L_TAX = /\b(sst|service\s*tax|sales\s*tax|gst|vat|tax|cukai(?:\s*(?:jualan|perkhidmatan))?)\b|税|稅/i;
  const taxTypeOf = (l) => (/\bsst\b|cukai\s*jualan/i.test(l) ? 'SST' : /\bgst\b/i.test(l) ? 'GST' : /\bvat\b/i.test(l) ? 'VAT' : /service\s*tax|cukai\s*perkhidmatan/i.test(l) ? 'service tax' : 'tax');

  function amounts(lines, money) {
    const cur = (() => { const c = {}; money.forEach((m) => { if (m.currency) c[m.currency] = (c[m.currency] || 0) + 1; }); const top = Object.keys(c).sort((a, b) => c[b] - c[a])[0]; return top || ''; })();
    const pos = money.filter((m) => m.value > 0);
    const labelled = (re, not) => pos.filter((m) => re.test(m.label) && !(not && not.test(m.label)));
    const totals = labelled(L_TOTAL, L_NOT_TOTAL);
    const subs = labelled(L_SUB);
    const taxes = labelled(L_TAX, /\b(incl|inclusive|termasuk|no\.?|reg|id|rate|%)\b/i).filter((m) => !L_TOTAL.test(m.label) || /tax\s*amount|amount\s*of\s*tax/i.test(m.label));
    let total = null, why = '', conf = 0;
    if (totals.length) {
      // the strongest label wins; among equals, the last one on the page (a grand total sits below the lines)
      const rank = (m) => (/grand\s*total|jumlah\s*(?:besar|keseluruhan)|总计|合计|總計|合計/i.test(m.label) ? 3 : /amount\s*paid|total\s*paid|charged|you\s*paid|实付|jumlah\s*bayaran/i.test(m.label) ? 3 : /total/i.test(m.label) ? 2 : 1);
      total = totals.slice().sort((a, b) => rank(b) - rank(a) || b.line - a.line)[0];
      why = `labelled "${(total.label.match(L_TOTAL) || [''])[0].trim()}"`;
      conf = rank(total) >= 2 ? 0.85 : 0.7;
    } else if (labelled(/\bamount\s*[:=]?\s*(?:\(?(?:rm|myr|usd)\)?)?$/i, L_NOT_TOTAL).length === 1) {
      total = labelled(/\bamount\s*[:=]?\s*(?:\(?(?:rm|myr|usd)\)?)?$/i, L_NOT_TOTAL)[0];          // a payment slip: "Amount : MYR 60.70", the only amount so labelled
      why = 'labelled "Amount"'; conf = 0.75;
    } else if (pos.length) {
      total = pos.reduce((a, b) => (b.value > a.value ? b : a));
      why = 'the largest amount (no total label found)';
      conf = 0.4;
    }
    const subtotal = subs.length ? subs[subs.length - 1].value : null;
    const tax = taxes.length ? r2(taxes.reduce((t, m) => t + m.value, 0)) : null;
    // the parts add up: more sure
    if (total && subtotal != null && Math.abs(r2(subtotal + (tax || 0)) - total.value) < 0.06) { conf = Math.max(conf, 0.95); why += '; subtotal and tax add up to it'; }
    if (total && subtotal != null && tax == null && Math.abs(subtotal - total.value) < 0.01) conf = Math.max(conf, 0.9);
    return {
      total: total ? r2(total.value) : null, currency: (total && total.currency) || cur || '', subtotal, tax,
      taxType: taxes.length ? taxTypeOf(taxes[0].label) : '', confTotal: conf, whyTotal: why,
    };
  }

  /* ---------- dates: every date, with its label; day first unless that cannot be ---------- */
  function datesOf(lines, ctx) {
    const out = [];
    const add = (li, d, mth, y, ambiguous, raw, idx) => {
      if (y < 100) y += 2000;
      if (!(mth >= 1 && mth <= 12 && d >= 1 && d <= 31 && y >= 2015 && y <= 2099)) return;
      const line = lines[li], before = line.slice(Math.max(0, idx - 40), idx);
      // no label in front: the line above is its label only when it is a label ("Invoice Date:"), not a line with its own value ("Change Due : 0.00")
      const above = li > 0 && !/[A-Za-z一-鿿]{3,}/.test(before) && !/\d\s*$/.test(lines[li - 1]) ? ' ' + lines[li - 1] : '';
      out.push({ iso: `${y}-${pad(mth)}-${pad(d)}`, ambiguous, raw, line: li, label: before + above });
    };
    lines.forEach((line, li) => {
      let m;
      const num = /(?<!\d)(\d{1,4})([./-])(\d{1,2})\2(\d{2,4})(?!\d)/g;
      while ((m = num.exec(line))) {
        const a = +m[1], b = +m[3], c = +m[4];
        if (m[1].length === 4) add(li, c, b, a, false, m[0], m.index);                                     // 2026-11-22
        else if (a > 12 && b <= 12) add(li, a, b, c, false, m[0], m.index);                                 // 22/11/2026
        else if (b > 12 && a <= 12) add(li, b, a, c, false, m[0], m.index);                                 // 11/22/2026 (US)
        else add(li, a, b, c, a !== b, m[0], m.index);                                                      // 03/04/2026: day first, but it could be either
      }
      const long1 = new RegExp(`(?<![A-Za-z])(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+(${MONTH_RE})[a-z]*\\.?[\\s,-]+(\\d{2,4})\\b`, 'gi');
      while ((m = long1.exec(line))) add(li, +m[1], MONTHS[m[2].toLowerCase()], +m[3], false, m[0], m.index);
      const long2 = new RegExp(`\\b(${MONTH_RE})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');
      while ((m = long2.exec(line))) add(li, +m[2], MONTHS[m[1].toLowerCase()], +m[3], false, m[0], m.index);
      const cn = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
      while ((m = cn.exec(line))) add(li, +m[3], +m[2], +m[1], false, m[0], m.index);
    });
    return out;
  }
  const L_DUE = /\b(due|tarikh\s*akhir|pay\s*by|payment\s*due)\b|到期|截止/i;
  const L_PERIOD_START = /\b(check[\s-]?in|arrival|arrive|depart(?:ure)?|travel\s*date|flight\s*date|from|period|start|daftar\s*masuk|berlepas)\b|入住|出发/i;
  const L_PERIOD_END = /\b(check[\s-]?out|until|to|end|daftar\s*keluar)\b|退房/i;
  const L_ISSUE = /\b(date\s*(?:of\s*issue|paid|issued)?|issued|invoice\s*date|receipt\s*date|transaction\s*date|txn\s*date|order\s*date|booking\s*date|tarikh(?:\s*(?:invois|resit|transaksi))?|billing\s*date)\b|日期|开票日期/i;

  function pickDates(dates, ctx) {
    const today = (ctx.today || new Date()).getTime(), DAY = 864e5;
    const plausible = (iso) => { const t = Date.parse(iso + 'T12:00:00Z'); return t <= today + 2 * DAY && t >= today - 400 * DAY; };
    const res = { date: '', dueDate: '', periodStart: '', periodEnd: '', confDate: 0, whyDate: '', ambiguous: false };
    if (!dates.length) return res;
    const due = dates.find((d) => L_DUE.test(d.label));
    if (due) res.dueDate = due.iso;
    const start = dates.find((d) => L_PERIOD_START.test(d.label) && d !== due && !L_ISSUE.test(d.label));
    const end = dates.find((d) => L_PERIOD_END.test(d.label) && d !== due && d !== start && !L_ISSUE.test(d.label));
    if (start) res.periodStart = start.iso;
    if (end) res.periodEnd = end.iso;
    const rest = dates.filter((d) => d !== due && d !== start && d !== end);
    const labelled = rest.find((d) => L_ISSUE.test(d.label));
    const pick = labelled || rest.find((d) => plausible(d.iso)) || rest[0] || start || dates[0];
    res.date = pick.iso;
    res.whyDate = labelled ? 'beside its date label' : rest.length > 1 ? 'the first date on the receipt' : 'the only date on the receipt';
    res.confDate = labelled ? 0.9 : rest.length === 1 ? 0.8 : 0.6;
    if (!plausible(pick.iso)) { res.confDate = Math.min(res.confDate, 0.4); res.whyDate += '; it is far from today'; }
    if (pick.ambiguous) {
      // 03/04/2026: Malaysian receipts are day first. Keep that, but if only the other reading falls in the claim month, take it; if both could be right, ask.
      const [y, mm, dd] = pick.iso.split('-').map(Number), swapped = `${y}-${pad(dd)}-${pad(mm)}`;
      const inMonth = (iso) => ctx.month && iso.slice(0, 7) === ctx.month;
      if (!inMonth(pick.iso) && inMonth(swapped)) { res.date = swapped; res.whyDate = 'read month first: only that falls in the claim month'; res.confDate = 0.7; }
      else if (!(inMonth(pick.iso) && !inMonth(swapped))) { res.ambiguous = true; res.confDate = Math.min(res.confDate, 0.5); res.whyDate += `; ${pick.raw} could be day or month first`; }
    }
    return res;
  }

  /* ---------- the document number: invoice, receipt, bill, order or booking ---------- */
  const NUM_LABELS = [
    ['invoice', /\b(?:tax\s*)?invoice\s*(?:no\.?|number|num|#|id)|\binv\.?\s*(?:no\.?|#)|no\.?\s*invois|invois\s*(?:no\.?|#)|发票号码?|發票號碼?/i],
    ['receipt', /\b(?:official\s*)?receipt\s*(?:no\.?|number|#|id)|\brcpt\.?\s*(?:no\.?|#)|no\.?\s*resit|resit\s*(?:no\.?|#)|收据号|收據號|单号|單號/i],
    ['bill', /\b(?:bill|cheque|check|doc(?:ument)?)\s*(?:no\.?|number|#)|\bno\.?\s*bil/i],
    ['order', /\border\s*(?:no\.?|number|id|#)|订单号|訂單號/i],
    ['booking', /\b(?:booking|reservation|confirmation)\s*(?:no\.?|number|id|ref(?:erence)?|code|#)|\bpnr\b|\bbooking\s*ref/i],
    ['receipt', /\b(?:transaction|txn|trans)\s*(?:no\.?|number|num|id|#)|\breference\s*(?:no\.?|number|#)|\bref\.?\s*(?:no\.?|#)/i],
    ['receipt', null],          // a bare "No." (BARE_NO below), last
  ];
  // "No. CS-1-26100000", "Number : CS-050000" at the start of a line (never an address)
  const BARE_NO = /^(?:no|number|nombor|num)\.?\s*[:.#]?(?=\s*[A-Za-z]{0,4}[-/]?\d)/i;
  NUM_LABELS[NUM_LABELS.length - 1][1] = BARE_NO;
  const NOT_NUM = /^(?:sst|gst|tin|roc|reg|company|tel|phone|fax|date|time|page|no)$/i;
  function numberOf(lines) {
    for (const [kind, re] of NUM_LABELS) {
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li], m = re.exec(line);
        if (!m) continue;
        const bare = re === BARE_NO;
        if (bare && (ADDRESS.test(line.slice(m[0].length)) || /\b(?:tel|phone|fax|acc(?:ount)?|bank)\b/i.test(line))) continue;      // "No. 8-1, Jalan 4/1": an address
        // the value right after the label, or on the next line (labels and values in two columns)
        const rest = line.slice(m.index + m[0].length).replace(/^[\s:#.]+/, '');
        const cand = [rest.split(/\s{1,}/)[0], (rest.split(/\s+/).slice(0, 2).join('')), (lines[li + 1] || '').split(/\s+/)[0]];
        for (const c0 of cand) {
          const c = (c0 || '').replace(/[,;)]+$/, '');
          if (bare && (c.length < 5 || !/^[A-Za-z]{1,4}[-/]?\d|^\d{5,}/.test(c))) continue;          // a bare "No." only for a document-shaped value (CS-050000, 250000)
          if (/^\d{5,8}-[A-Z]$/.test(c) || /^(?:19|20)\d{10}$/.test(c)) continue;                     // a company registration number (1087547-V, 200801003042), never the receipt's
          if (c.length >= 3 && c.length <= 30 && /\d/.test(c) && /^[A-Za-z0-9][A-Za-z0-9\-/_.]*$/.test(c) && !NOT_NUM.test(c) && !/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(c) && !/^\d+\.\d{2}$/.test(c))
            return { number: c, kind, conf: bare ? 0.6 : kind === 'receipt' && /transaction|txn|reference|ref/i.test(m[0]) ? 0.6 : 0.85 };
        }
      }
    }
    return { number: '', kind: '', conf: 0 };
  }

  /* ---------- the seller ---------- */
  const BRANDS = [
    // fuel, transport, travel, shops and food chains in Malaysia, and software: the name to show
    ['Petronas', /petronas/i], ['Shell', /\bshell\b/i], ['Caltex', /caltex/i], ['Petron', /\bpetron\b/i], ['BHPetrol', /bhpetrol/i],
    ['Grab', /\bgrab\b/i], ['AirAsia', /airasia/i], ['Malaysia Airlines', /malaysia\s*airlines/i], ['Firefly', /firefly/i], ['Batik Air', /batik\s*air/i], ['KTM', /\bktm\b|keretapi\s*tanah\s*melayu/i],
    ['Agoda', /agoda/i], ['Booking.com', /booking\.com/i], ['Airbnb', /airbnb/i], ['Traveloka', /traveloka/i], ['Trip.com', /trip\.com/i],
    ['Shopee', /shopee/i], ['Lazada', /lazada/i], ['TikTok Shop', /tiktok\s*shop/i], ['Zalora', /zalora/i], ['Amazon', /amazon/i],
    ['Starbucks', /starbucks/i], ["McDonald's", /mcdonald/i], ['KFC', /\bkfc\b/i], ['Tealive', /tealive/i], ['ZUS Coffee', /\bzus\b/i], ['Old Town White Coffee', /oldtown|old\s*town/i],
    ['7-Eleven', /7-?eleven/i], ['FamilyMart', /familymart/i], ['Watsons', /watsons/i], ['Guardian', /\bguardian\b/i], ['MR DIY', /mr\.?\s*diy/i], ['AEON', /\baeon\b/i], ["Lotus's", /lotus'?s/i], ['Jaya Grocer', /jaya\s*grocer/i], ['Popular', /popular\s*book/i],
    ['Touch \'n Go', /touch\s*'?n\s*go/i], ['TNB', /tenaga\s*nasional|\btnb\b/i], ['Unifi', /\bunifi\b/i], ['Maxis', /\bmaxis\b/i], ['CelcomDigi', /celcomdigi|\bdigi\b|\bcelcom\b/i],
    ['OpenAI', /openai|chatgpt/i], ['Anthropic', /anthropic/i], ['Runway', /runway\s*ai|runwayml/i], ['ElevenLabs', /eleven\s*labs/i], ['Canva', /canva/i], ['Adobe', /adobe/i], ['Metricool', /metricool/i],
  ];
  const LEGAL = /\b([A-Z0-9][A-Za-z0-9&'.\-]*(?:\s+[A-Z0-9&][A-Za-z0-9&'.\-]*){0,5})\s*,?\s+(SDN\.?\s*BHD\.?|BHD\.?|PLT|ENTERPRISE|ENT\.?|TRADING|RESOURCES|HOLDINGS|INC\.?|LLC|LTD\.?|LIMITED|PBC|CORP\.?|GMBH|PTE\.?\s*LTD\.?|S\.?L\.?|CO\.?\s*LTD\.?)(?![A-Za-z])/i;
  const NOT_SELLER = /\b(bill(?:ed)?\s*to|invoiced?\s*to|issued\s*to|charged\s*to|customer|sold\s*to|ship\s*to|deliver(?:y)?\s*to|attention|attn|pelanggan|kepada)\b|客户|收货人/i;
  // a Malaysian company registration number beside a name: (003796478-V), (978196-K), 200001016930 (519537-X)
  const REG_NO = /\(?\b(?:(?:19|20)\d{10}\s*)?\(?\d{5,9}-[A-Z]\)?\)?|\b(?:19|20)\d{10}\b/;
  // a line about paying ("<<< TOUCH N GO >>>", "Paid by GrabPay"): a brand on it is how it was paid, not who sold it
  const PAY_LINE = /\b(paid|payment|pay|via|tender(?:ed)?|method|wallet|e-?wallet|bayar|bayaran|card)\b|<<|>>/i;
  const ADDRESS = /\b(jalan|jln|lorong|taman|no\.|lot|level|floor|blok|block|street|road|avenue|suite|seksyen|persiaran|bandar|kuala\s*lumpur|selangor|johor|penang|pulau|melaka|perak|sabah|sarawak|\d{5})\b/i;
  function vendorOf(lines, ctx) {
    const self = (ctx && ctx.company) ? new RegExp(ctx.company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : /\bwfc\s*systems?\b/i;
    // the customer block: after "Bill to" / "Invoiced to", the first company named is the customer, never the seller
    const customer = new Set();
    for (let li = 0, until = -1, taken = false; li < lines.length; li++) {
      if (NOT_SELLER.test(lines[li]) && li > until) { until = li + 3; taken = false; }
      if (li <= until && !taken && (LEGAL.test(lines[li]) || REG_NO.test(lines[li]) && /[A-Za-z]{3,}/.test(lines[li].replace(NOT_SELLER, '')))) { customer.add(li); taken = true; }
    }
    // 1. a company named with its legal form, not in the customer block
    for (let li = 0; li < lines.length; li++) {
      const m = LEGAL.exec(lines[li]);
      if (!m || customer.has(li) || self.test(m[0])) continue;
      return { vendor: m[0].replace(/\s+/g, ' ').trim(), conf: 0.85, why: 'company name with its legal form' };          // as printed, "Notion Labs, Inc."
    }
    // 1b. a name with its company registration number, on the line or the line just below it ("WARISAN LESTARI VENTURES" / "(002543766-H)")
    for (let li = 0; li < Math.min(lines.length, 12); li++) {
      if (customer.has(li) || !REG_NO.test(lines[li])) continue;
      const own = lines[li].replace(REG_NO, ' ').replace(/[()\[\]]/g, ' ').replace(/\b(?:co(?:mpany)?|reg(?:istration)?|roc|ssm)\.?\s*(?:no\.?)?\s*:?/gi, ' ').replace(/\s+/g, ' ').trim();
      const name = /[A-Za-z]{3,}/.test(own) ? own : (li > 0 && !customer.has(li - 1) ? lines[li - 1] : '');
      if (name && /[A-Za-z]{3,}/.test(name) && !ADDRESS.test(name) && name.length <= 60 && !self.test(name) && !NOT_SELLER.test(name)) return { vendor: name, conf: 0.8, why: 'the name beside its company registration number' };
    }
    // 2. a known brand
    const text = lines.filter((l) => !PAY_LINE.test(l)).join(' ');
    for (const [name, re] of BRANDS) if (re.test(text)) return { vendor: name, conf: 0.8, why: 'a known brand' };
    // 3. a "From" / "Merchant" label
    for (let li = 0; li < lines.length; li++) {
      const m = /^(?:from|merchant|seller|sold\s*by|store|nama\s*kedai|商家|卖家)\s*(?::\s*(.*)|$)/i.exec(lines[li]);      // "From:" / a "FROM" line on its own
      if (m) { const v = (m[1] || lines[li + 1] || '').trim(); if (/[A-Za-z一-鿿]{3,}/.test(v) && !self.test(v)) return { vendor: v.slice(0, 60), conf: 0.75, why: 'beside its From label' }; }
    }
    // 4. the heading: the first line near the top with letters that is not a document title, an address, a date or money
    for (const l of lines.slice(0, 6)) {
      if (!/[A-Za-z一-鿿]{3,}/.test(l) || l.length > 50) continue;
      if (/\b(receipt|invoice|resit|invois|tax|official|bill|statement|copy|duplicate|welcome|thank|page|date|tarikh|tel|phone|fax|email|www|http)\b|收据|发票/i.test(l)) continue;
      if (ADDRESS.test(l) || /\d[\d.,/-]{4,}/.test(l) || self.test(l)) continue;
      return { vendor: l, conf: 0.55, why: 'the heading at the top' };
    }
    return { vendor: '', conf: 0, why: '' };
  }

  /* ---------- how it was paid ---------- */
  function paymentOf(lines) {
    const text = lines.join(' ');
    const methods = [['Visa', /\bvisa\b/i], ['Mastercard', /master\s*card|\bmc\b(?=.*\d{4})/i], ['American Express', /amex|american\s*express/i], ['UnionPay', /unionpay|银联/i],
      ['MyDebit', /mydebit/i], ['Touch \'n Go eWallet', /touch\s*'?\s*n\s*'?\s*go|\btng\s*e?-?wallet|tngwallet/i], ['GrabPay', /grabpay/i], ['Boost', /\bboost\b/i], ['ShopeePay', /shopeepay/i],
      ['DuitNow', /duitnow/i], ['FPX / online banking', /\bfpx\b|online\s*banking/i], ['Debit card', /debit\s*card/i], ['Credit card', /credit\s*card|kad\s*kredit/i], ['Cash', /\b(cash|tunai)\b|现金/i]];
    let method = '';
    for (const [name, re] of methods) if (re.test(text)) { method = name; break; }
    // the last four digits only: a masked card number, "ending in 1234", or "Visa - 5106"
    const m = /(?:[*xX•]{2,}[\s-]*){1,3}(\d{4})(?!\d)/.exec(text) || /\bending\s*(?:in|with)?\s*(\d{4})\b/i.exec(text)
      || /\b(?:visa|mastercard|master\s*card|amex|card)\s*[-:]\s*(\d{4})(?!\d)/i.exec(text);
    return { paymentMethod: method, last4: m ? m[1] : '' };
  }

  /* ---------- what kind of paper, and what kind of expense ---------- */
  function docTypeOf(text) {
    if (/\be-?invoice\b|unique\s*identifier|\buin\b|validated\s*by\s*lhdn|myinvois/i.test(text)) return 'e-invoice';
    if (/statement\s+of\s+account|transactions?\s+statement|transaction\s+history|penyata/i.test(text)) return 'statement';
    if (/boarding\s*pass|e-?ticket|itinerary|\bpnr\b|flight\s*no|passenger/i.test(text)) return 'ticket';
    if (/booking\s*confirm|reservation\s*confirm|confirmation\s*(?:no|number|code)|your\s*booking/i.test(text)) return 'booking confirmation';
    if (/tax\s*invoice|invois\s*cukai/i.test(text)) return 'tax invoice';
    if (/\binvoice\b|\binvois\b|发票|發票/i.test(text) && !/\breceipt\b|\bresit\b|收据/i.test(text)) return 'invoice';
    return 'receipt';
  }
  const CATEGORY_WORDS = [
    ['Petrol', /\b(petronas|shell|caltex|petron|bhpetrol|ron\s?9[57]|diesel|primax|v-power|budi\s?95|litres?|liters?|pump\s*no)\b/i, 3],
    ['Toll', /\b(toll|plaza\s*tol|smart\s*tag|plus\s*malaysia)\b/i, 2],
    ['Parking', /\b(parking|letak\s*kereta|car\s*park|flexi\s*parking|mbsj|mbpj|dbkl|parkir)\b|停车/i, 2],
    ['Medical', /\b(klinik|clinic|poliklinik|hospital|pharmacy|farmasi|consultation|dental|pergigian|medical|doctor|ubat)\b|诊所|医院|药/i, 2],
    ['Accommodation', /\b(hotel|resort|inn|motel|homestay|guest\s*house|check[\s-]?in|check[\s-]?out|room\s*(?:no|rate|night)|nights?|airbnb|agoda|booking\.com|penginapan)\b|酒店|住宿/i, 2],
    ['Travel', /\b(airline|airlines|airasia|firefly|batik\s*air|flight|boarding|e-?ticket|itinerary|pnr|passenger|depart|ktm|ets|bus\s*ticket|easybook|redbus|ferry|tiket\s*penerbangan)\b|机票|航班/i, 3],
    ['Transport', /\b(grab(?:car|taxi)?|e-?hailing|taxi|teksi|ride|trip\s*fare|pick[\s-]?up|drop[\s-]?off|indrive|mycar|maxim)\b/i, 2],
    ['Online shopping', /\b(shopee|lazada|tiktok\s*shop|zalora|amazon|order\s*(?:id|no)|shipping\s*fee|seller|delivery\s*fee|online\s*order|hardware|perkakasan|supplies|mr\.?\s*diy|daiso|eco\s*shop|ikea)\b/i, 2],          // shopping and supplies
    ['AI tools', /\b(subscription|openai|chatgpt|anthropic|claude|runway|eleven\s*labs|metricool|canva|adobe|midjourney|software|saas|api|credits?|per\s*month|\/\s?month|plan|domain|hosting|web\s*hosting|ssl|exabytes|google\s*workspace|microsoft\s*365)\b/i, 2],          // software and online services
    ['Meals', /\b(restaurant|restoran|cafe|café|kopitiam|food|beverage|makanan|minuman|nasi|mee|teh|kopi|coffee|tea|starbucks|mcdonald|kfc|tealive|zus|dine[\s-]?in|take[\s-]?away|bungkus|mamak|bakery|lunch|dinner|breakfast)\b|餐|饭|茶|咖啡|面/i, 2],
    ['Stationery', /\b(stationery|alat\s*tulis|popular\s*book|pen|pens|paper|a4|printer\s*ink|toner|notebook|file|folder)\b|文具/i, 1],
    ['Supplier invoice', /\b(purchase\s*order|p\s*[./]?\s*o\.?\s*no|delivery\s*order|terms?\s*:?\s*\d+\s*days|payment\s*terms|quotation|supplier|bill\s*to|account\s*no)\b/i, 2],
  ];
  function categoryOf(text, docType) {
    const scores = CATEGORY_WORDS.map(([name, re, w]) => {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      const hits = (text.match(g) || []).length;
      return { name, score: hits * w };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    if (docType === 'ticket' && !scores.some((s) => s.name === 'Travel')) scores.unshift({ name: 'Travel', score: 3 });
    if (!scores.length) return { category: '', conf: 0 };
    const [a, b] = scores;
    const margin = b ? a.score / (a.score + b.score) : 1;
    return { category: a.name, conf: Math.min(0.9, 0.45 + 0.45 * margin + (a.score >= 4 ? 0.05 : 0)) };
  }

  /* ---------- the whole receipt ---------- */
  const NEEDS = { vendor: 0.6, date: 0.7, number: 0.5, total: 0.7, category: 0.55 };
  function read(input, ctx) {
    ctx = ctx || {};
    const lines = linesOf(input), text = lines.join('\n');
    const money = moneyOf(lines), am = amounts(lines, money), dt = pickDates(datesOf(lines, ctx), ctx);
    const num = numberOf(lines), vd = vendorOf(lines, ctx), pay = paymentOf(lines);
    const docType = docTypeOf(text), cat = categoryOf(text, docType);
    const cjk = (text.match(/[一-鿿]/g) || []).length;
    const out = {
      docType, category: cat.category, vendor: vd.vendor, date: dt.date, dueDate: dt.dueDate, periodStart: dt.periodStart, periodEnd: dt.periodEnd,
      number: num.number, numberKind: num.kind, currency: am.currency, subtotal: am.subtotal, tax: am.tax, taxType: am.taxType, total: am.total,
      paymentMethod: pay.paymentMethod, last4: pay.last4,
      confidence: { vendor: vd.conf, date: dt.confDate, number: num.conf, total: am.confTotal, category: cat.conf, currency: am.currency ? 0.9 : 0.3 },
      why: { total: am.whyTotal, date: dt.whyDate, vendor: vd.why },
      ambiguousDate: dt.ambiguous, cjk,
    };
    out.needsReview = Object.keys(NEEDS).filter((k) => !(out.confidence[k] >= NEEDS[k]));
    if (out.docType === 'statement') out.needsReview = out.needsReview.filter((k) => k !== 'number');
    // unsure: a main field is missing or weak, or the text looks like it was not read well (Chinese on an English-only read, little text)
    out.unsure = out.needsReview.some((k) => ['vendor', 'date', 'total', 'category'].includes(k)) || cjk > 3 || lines.length < 4;
    return out;
  }

  /* which reader takes a receipt: fuel slips, clinic, parking and hotel papers have tuned readers (petrol.js); everything else is read here.
     x = read(), p = the fuel-slip reader's result (may be null), text = the receipt's text */
  const FUEL_WORDS = /\b(?:ron\s?9[57]|diesel|primax|v-?power|budi\s?95|litres?|liters?|pump\s*(?:no|#)?)\b/i;
  const TUNED = ['Petrol', 'Medical', 'Parking', 'Accommodation'];
  const forGeneral = (x, p, text) => !FUEL_WORDS.test(text) && !(p && (p.litres || TUNED.includes(p.category))) && !TUNED.includes(x.category);

  /* The same document number printed twice in the text but read two ways (4815162342108800q and 48151623421088002, a scan read on this PC):
     the other spellings, one character apart. Any found means the number is not sure. */
  function twinsOf(value, text) {
    const v = String(value || '').replace(/[^A-Za-z0-9]/g, '');
    if (v.length < 6) return [];
    const one = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return false; return d === 1; };
    const seen = new Set();
    for (const t of String(text || '').split(/[^A-Za-z0-9]+/)) if (t.length === v.length && t.toLowerCase() !== v.toLowerCase() && one(t.toLowerCase(), v.toLowerCase())) seen.add(t);
    return Array.from(seen);
  }

  const api = { read, forGeneral, twinsOf, linesOf, moneyOf, amounts, datesOf, pickDates, numberOf, vendorOf, paymentOf, docTypeOf, categoryOf, BRANDS };
  root.Extract = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
