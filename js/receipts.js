/* Looks inside a dropped PDF and says what it is, so one drop box can sort everything:
   - a Touch 'n Go statement,
   - a Stripe-style invoice / receipt (Eleven Labs, Runway, ...) -> merchant, date, MYR amount, invoice number,
   - an Agoda hotel receipt -> hotel, check-in date, MYR total.
   Anything it can't read is left for the user to type. */
(function (root) {
  'use strict';
  const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
    september: 9, october: 10, november: 11, december: 12 };

  const pdfReady = () => (root.Lazy ? root.Lazy.need('pdf') : Promise.resolve());       // the PDF reader is loaded after the page is up (js/lazy.js)

  async function pdfStrings(buffer) {
    await pdfReady();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
    const out = [];
    for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      tc.items.forEach((it) => { const s = it.str.trim(); if (s) out.push(s); });
    }
    return out;
  }

  function isoFromLong(s) {
    const m = s && s.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
    if (!m || !MONTHS[m[1].toLowerCase()]) return '';
    return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
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

  /* -> { invoiceNo, merchant, date, amount|null, isReceipt } or null when it isn't this kind of document */
  function parseStripe(strs, text) {
    text = String(text).replace(DASHES, '-');
    const invoiceNo = findInvoiceNo(text);
    if (!invoiceNo) return null;
    const isReceipt = /\bReceipt number\b/i.test(text) && /Date paid/i.test(text);
    // the date next to its label, or (when the labels and values are read as two blocks) the first long date on the page: "November 2, 2026"
    const dateM = text.match(/Date paid\s+([A-Za-z]+ \d{1,2}, \d{4})/) || text.match(/Date of issue\s+([A-Za-z]+ \d{1,2}, \d{4})/) || text.match(/\b((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4})/);
    const charged = text.match(/Charged\s+RM\s*([\d,]+\.\d{2})/i);
    let merchant = '';
    const at = strs.findIndex((s, i) => i > 0 && /^@\w+/.test(s));
    if (at > 0) merchant = strs[at - 1];
    if (!merchant) { const m = text.match(/([A-Z][\w.,&' -]{2,40}?)\s+@\w+/); if (m) merchant = m[1].trim(); }
    // no @handle (Anthropic): the company name in front of its legal form, "Anthropic, PBC"
    if (!merchant) { const m = text.match(/\b([A-Z][A-Za-z0-9&'.-]{1,30}(?: [A-Z][A-Za-z0-9&'.-]{1,30}){0,2}),?\s+(?:PBC|Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|GmbH|Pte\.?|Sdn\.? Bhd\.?)(?![A-Za-z])/); if (m) merchant = m[1].trim(); }
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
    try { strs = await pdfStrings(buffer); } catch (e) { return { isTng: false, stripe: null, hotel: null, text: '', hasText: false, broken: true }; }
    // the PDF font maps hyphens to NUL, so "PZS6NSFF-0001" arrives as "PZS6NSFF", NUL, "0001"
    const text = strs.join(' ').replace(/\s*\u0000\s*/g, '-');
    return {
      isTng: strs.some((s) => s === 'Customer Transactions Statement' || /^TNG WALLET TRANSACTION HISTORY$/i.test(s)),       // the two layouts of the Touch 'n Go statement
      stripe: parseStripe(strs, text),
      hotel: parseHotel(text),
      text,
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

  const api = { readPdf, renderFirstPage, parseStripe, findInvoiceNo };
  root.Receipts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
