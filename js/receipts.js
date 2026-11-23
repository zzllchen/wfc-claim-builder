/* Looks inside a dropped PDF and says what it is, so one drop box can sort everything:
   - a Touch 'n Go statement,
   - a software invoice / receipt (Eleven Labs, Runway, Metricool, Anthropic ...) -> merchant, date, MYR amount, invoice number,
   - an Agoda hotel receipt -> hotel, check-in date, MYR total.
   Anything it can't read is left for the user to type. */
(function (root) {
  'use strict';
  const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
    september: 9, october: 10, november: 11, december: 12 };

  const pdfReady = () => (root.Lazy ? root.Lazy.need('pdf') : Promise.resolve());       // the PDF reader is loaded after the page is up (js/lazy.js)

  async function pdfStrings(buffer, lines) {
    await pdfReady();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
    const out = [];
    for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      tc.items.forEach((it) => { const s = it.str.trim(); if (s) out.push(s); });
      // the same text as lines: pieces at the same height, left to right (a label and its value end up on one line)
      if (lines) {
        const rows = [];
        tc.items.filter((it) => it.str.trim()).forEach((it) => { const y = it.transform[5], x = it.transform[4]; let row = rows.find((r) => Math.abs(r.y - y) < 3); if (!row) { row = { y, parts: [] }; rows.push(row); } row.parts.push({ x, s: it.str.trim() }); });
        rows.sort((a, b) => b.y - a.y).forEach((r) => lines.push(r.parts.sort((a, b) => a.x - b.x).map((q) => q.s).join(' ')));
      }
    }
    return out;
  }

  // "November 21, 2026" or "21 November 2026" -> '2026-11-21'
  function isoFromLong(s) {
    let m = s && s.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/), mon, day, year;
    if (m) { mon = m[1]; day = m[2]; year = m[3]; }
    else if ((m = s && s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/))) { day = m[1]; mon = m[2]; year = m[3]; }
    if (!m || !MONTHS[mon.toLowerCase()]) return '';
    return `${year}-${String(MONTHS[mon.toLowerCase()]).padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // every kind of dash a PDF font may use for the hyphen (soft hyphen, non-breaking hyphen, en / em dash, minus sign ...)
  const DASHES = /[­‐-―−﹘﹣－]/g;

  /* The invoice number of a Stripe-style invoice or receipt, e.g. OUXVRV1G-0002 (not the receipt number, 2624-7281-7973). -> 'OUXVRV1G-0002' or '' */
  function findInvoiceNo(text) {
    const t = String(text).replace(DASHES, '-');
    const near = /Invoice number\s+([A-Z0-9]{4,})\s?-\s?(\d{3,})/i.exec(t);
    if (near) return (near[1] + '-' + near[2]).toUpperCase();
    // the label and its value can be far apart (a PDF may give the labels as one block and the values as the next): look for the shape of the number,
    // 6-10 capitals and digits (at least one capital), a hyphen and four digits. A receipt number is only digits, so it never matches.
    if (/Invoice number/i.test(t)) {
      const re = /(?<![A-Z0-9-])([A-Z0-9]{6,10})\s?-\s?(\d{4})(?![\d-])/g;
      let m;
      while ((m = re.exec(t))) if (/[A-Z]/.test(m[1])) return m[1] + '-' + m[2];
    }
    return '';
  }

  /* An invoice number written next to its label in any common way: "Invoice number: 1875801" (Metricool), "INVOICE # YJE6F0DZ-0002" (Runway's newer
     layout), "Invoice No. INV-2041". It must hold a digit, so a label followed by another label ("Invoice number Receipt number") is never taken. */
  function labelledInvoiceNo(text) {
    const re = /\bInvoice\s*(?:number|no\.?|#)\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{2,30}[A-Z0-9])(?![A-Z0-9-])/gi;
    let m;
    while ((m = re.exec(String(text).replace(DASHES, '-')))) if (/\d/.test(m[1])) return m[1].toUpperCase();
    return '';
  }

  // software and AI tools seen on claims: the name to show when an invoice has no company line
  const VENDORS = [['Runway', /runway\s*ai|runwayml/i], ['Metricool', /metricool/i], ['ElevenLabs', /eleven\s*labs/i], ['OpenAI', /openai|chatgpt/i], ['Anthropic', /anthropic/i],
    ['Canva', /canva/i], ['Adobe', /adobe/i], ['Midjourney', /midjourney/i], ['CapCut', /capcut/i], ['Notion', /notion\s*labs|notion\.so/i], ['Figma', /figma/i],
    ['Zoom', /\bzoom\s*(?:video|communications)/i], ['Suno', /\bsuno\b/i], ['HeyGen', /heygen/i], ['Kling', /\bkling\b/i], ['Perplexity', /perplexity/i], ['Cursor', /anysphere|cursor\.com/i],
    ['GitHub', /github/i], ['Higgsfield', /higgsfield/i], ['Freepik', /freepik/i]];
  const knownVendor = (text) => { for (const [name, re] of VENDORS) if (re.test(text)) return name; return ''; };
  const LEGAL = "(?:PBC|Inc\\.?|LLC|Ltd\\.?|Limited|Corp\\.?|GmbH|Pte\\.?(?: Ltd\\.?)?|Sdn\\.? Bhd\\.?|S\\.?L\\.?|S\\.A\\.|B\\.V\\.|SAS|SRL)";
  const stripLegal = (s) => String(s || '').replace(new RegExp(`,?\\s+${LEGAL}\\s*$`), '').trim();

  /* -> { invoiceNo, merchant, date, amount|null, isReceipt } or null when it isn't this kind of document */
  function parseStripe(strs, text) {
    text = String(text).replace(DASHES, '-');
    let invoiceNo = findInvoiceNo(text);
    if (!invoiceNo) {
      // other invoice layouts: a labelled number on a software invoice. Fuel, clinic and hotel papers are left to their own readers.
      const other = labelledInvoiceNo(text);
      const software = knownVendor(text) || /\b(subscriptions?|per month|\/\s?month|monthly|credits?|seats?|software|saas|api usage)\b/i.test(text);
      if (other && software && !/\b(petrol|diesel|ron\s?9\d|litres?|liters?|pump|klinik|clinic|hospital|agoda|hotel)\b/i.test(text)) invoiceNo = other;
    }
    if (!invoiceNo) return null;
    const isReceipt = /\bReceipt number\b/i.test(text) && /Date paid/i.test(text);
    // the date next to its label, or (when the labels and values are read as two blocks) the first long date on the page: "November 2, 2026"
    const dateM = text.match(/Date paid\s+([A-Za-z]+ \d{1,2}, \d{4})/) || text.match(/(?:Date of issue|ISSUED|Invoice date|Issue date)\s*:?\s+([A-Za-z]+ \d{1,2}, \d{4}|\d{1,2} [A-Za-z]+ \d{4})/i)
      || text.match(/\b((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4})/)
      || text.match(/\b(\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4})/);
    // the ringgit amount: what the card was charged ("Charged RM93.39"), or a total billed in ringgit ("TOTAL MYR 148.65")
    const charged = text.match(/Charged\s+RM\s*([\d,]+\.\d{2})/i) || text.match(/(?<![A-Za-z])(?:TOTAL|Amount paid|Total paid)\s*:?\s*-?\s*(?:MYR|RM)\s*([\d,]+\.\d{2})/i);
    let merchant = '';
    const at = strs.findIndex((s, i) => i > 0 && /^@\w+/.test(s));
    if (at > 0) merchant = strs[at - 1];
    if (!merchant) { const m = text.match(/([A-Z][\w.,&' -]{2,40}?)\s+@\w+/); if (m) merchant = m[1].trim(); }
    // a FROM block (Runway's newer layout): the line after it, without its legal form
    if (!merchant) { const f = strs.findIndex((s) => /^from:?$/i.test(s)); if (f >= 0 && strs[f + 1] && /[A-Za-z]/.test(strs[f + 1])) merchant = stripLegal(strs[f + 1]); }
    // no @handle (Anthropic): the company name in front of its legal form, "Anthropic, PBC", "Metricool Software SL";
    // never the customer, so a name just after "Bill to" is skipped
    if (!merchant) {
      const re = new RegExp(`\\b([A-Z][A-Za-z0-9&'.-]{1,30}(?: [A-Z][A-Za-z0-9&'.-]{1,30}){0,2}),?\\s+${LEGAL}(?![A-Za-z])`, 'g');
      let m;
      while ((m = re.exec(text))) {
        const before = text.slice(Math.max(0, m.index - 160), m.index);
        const bill = before.search(/\b(?:bill(?:ed)?\s*to|customer|sold\s*to|ship\s*to)\b/i), from = before.search(/\bfrom\b/i);
        if (bill >= 0 && bill > from) continue;
        merchant = m[1].trim();
        break;
      }
    }
    if (/^(from|bill to|billed to|invoice)\b/i.test(merchant)) merchant = merchant.replace(/^(from|bill to|billed to|invoice)\s+/i, '');
    if (!merchant) merchant = knownVendor(text);
    return {
      invoiceNo,
      merchant,
      date: dateM ? isoFromLong(dateM[1]) : '',
      amount: charged ? parseFloat(charged[1].replace(/,/g, '')) : null,
      isReceipt,
    };
  }

  /* Agoda receipt -> { merchant, date (check-in), amount } or null */
  function parseHotel(text) {
    if (!/agoda/i.test(text)) return null;
    const amt = text.match(/Total Charge\s+MYR\s*([\d,]+\.\d{2})/i);
    const name = text.match(/Hotel Name\s+(.+?)\s+Period\b/i);
    const period = text.match(/Period\s+([A-Za-z]+ \d{1,2}, \d{4})/i);
    if (!amt && !name) return null;
    return {
      merchant: name ? name[1].trim() : '',
      date: period ? isoFromLong(period[1]) : '',
      amount: amt ? parseFloat(amt[1].replace(/,/g, '')) : null,
    };
  }

  /* -> { isTng, stripe, hotel, text, hasText } ; hasText is false for scans / image-only PDFs */
  async function readPdf(buffer) {
    let strs;
    const lines = [];
    try { strs = await pdfStrings(buffer, lines); } catch (e) { return { isTng: false, stripe: null, hotel: null, text: '', lines: [], hasText: false, broken: true }; }
    // the PDF font maps hyphens to NUL, so "PZS6NSFF-0001" arrives as "PZS6NSFF", NUL, "0001"
    const text = strs.join(' ').replace(/\s*\u0000\s*/g, '-');
    return {
      isTng: strs.some((s) => s === 'Customer Transactions Statement' || /^TNG WALLET TRANSACTION HISTORY$/i.test(s)),       // the two layouts of the Touch 'n Go statement
      stripe: parseStripe(strs, text),
      hotel: parseHotel(text),
      text,
      lines,
      hasText: text.replace(/[^A-Za-z0-9]/g, '').length >= 25,
    };
  }

  /* page 1 of a PDF drawn onto a canvas, for reading scans with OCR */
  async function renderFirstPage(buffer) {
    await pdfReady();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(3, 2200 / Math.max(base.width, base.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  const api = { readPdf, renderFirstPage, parseStripe, findInvoiceNo, labelledInvoiceNo, isoFromLong };
  root.Receipts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
