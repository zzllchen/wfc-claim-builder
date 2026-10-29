/* Is this file really a receipt or invoice? Judges the text read from a PDF, a scan or a photo and, when the answer is
   no, gives a plain reason the person can act on. Pure functions (browser: window.Validate, Node: module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Validate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const alnum = (s) => (s.match(/[A-Za-z0-9]/g) || []).length;
  const MONEY = /(?<![\d.,])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\s?\.\s?|,)\d{2}(?!\d)/;      // OCR may leave a space round the point
  const WORDS_AMOUNT = /\b(?:ringgit(?:\s+malaysia)?|rm)\s+(?:[a-z\-]+\s+){1,9}?only\b/i;        // "RM SEVENTY FIVE ONLY" on clinic receipts
  const RECEIPT_WORDS =/\b(receipt|invoice|invois|resit|bill|payment|paid|total|amount|jumlah|bayar|folio|booking|order|subtotal|charged)\b/i;

  const MSG = {
    claimForm: 'This is a WFC claim form, not a receipt. The app fills in the claim form for you – attach the receipts or invoices instead.',
    leaveForm: 'This is a WFC leave form, not a receipt. Leave forms are made on the Leave application tab – attach receipts or invoices here.',
    photoUnreadable: "Couldn't read any text on this photo – it is too blurry or dark, or it isn't a receipt. Please re-attach a clearer photo.",
    pdfUnreadable: "No readable text in this PDF (it may be a poor scan). Please re-attach the original PDF or a clearer copy.",
    noAmount: "No amount found – this looks like the wrong file, or the amount is too blurry or cut off to read. Attach the receipt or invoice, or a clearer copy of it.",
    notReceipt: "This PDF doesn't look like a receipt or invoice (no receipt / invoice wording). Attach the receipt or invoice instead.",
    mc: "This is a medical certificate (MC), not a receipt, so it can't go on the expense claim. Add it on the Leave application tab, or attach the clinic's official receipt here instead.",
    notMc: "This doesn't look like a medical certificate (no \"Medical Certificate\" wording found). Attach the MC itself, or a clearer photo of it.",
    type: 'Only photos (JPG, PNG) and PDF files can be added.',
    decode: "This photo couldn't be opened (its format may not be supported, for example HEIC). Re-take or re-save it as JPG or PNG and attach it again.",
  };

  /* source: 'pdf' (text layer), 'scan' (text read from a PDF page image) or 'photo'.
     -> { status: 'ok' | 'reject', reason, force } ; force = the person may still add the file by hand */
  function judge(text, source) {
    const t = String(text || '');
    const no = (reason, force) => ({ status: 'reject', reason, force: !!force });
    if (alnum(t) < 25) return no(source === 'photo' ? MSG.photoUnreadable : MSG.pdfUnreadable, true);
    if (/monthly expense claim/i.test(t)) return no(MSG.claimForm, false);
    if (/leave application form/i.test(t)) return no(MSG.leaveForm, false);
    if (/medical\s+certificate/i.test(t) && !/\b(official\s+receipt|receipt|invoice|resit)\b/i.test(t)) return Object.assign(no(MSG.mc, false), { mc: true });
    if (!MONEY.test(t) && !WORDS_AMOUNT.test(t)) return no(MSG.noAmount, source !== 'pdf');
    if (source === 'pdf' && !RECEIPT_WORDS.test(t)) return no(MSG.notReceipt, false);
    return { status: 'ok' };
  }

  return { judge, MSG };
});
