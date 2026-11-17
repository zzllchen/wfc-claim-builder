/* node tests/receipts.test.js - the invoice number of Stripe-style invoices and receipts (Anthropic, Eleven Labs, Runway ...).
   The claim line takes the INVOICE number without its hyphen (OUXVRV1G0002), never the receipt number (2624-7281-7973). Invented text, same layout. */
'use strict';
const assert = require('assert');
const R = require('../js/receipts.js');

const ok = (name, fn) => { fn(); console.log('ok  ' + name); };
const parse = (text) => R.parseStripe(text.split(/\s{2,}|\n/).filter(Boolean), text);

// the receipt as it reads when the label sits next to its value
const ADJACENT = `Receipt   Invoice number OUXVRV1G-0002   Receipt number 2624-7281-7973   Date paid November 2, 2026   VAT Registration Malaysia Reg. No: 26000029
Anthropic, PBC  548 Market Street  Bill to  Jimmy   $108.00 paid on November 2, 2026   Charged RM448.54 using 1 USD = 4.1532 MYR`;
// the same page when the PDF hands over the labels as one block and the values as the next
const COLUMNS = `Receipt   Invoice number   Receipt number   Date paid   VAT Registration   OUXVRV1G-0002   2624-7281-7973   November 2, 2026   Malaysia Reg. No: 26000029
Anthropic, PBC  548 Market Street  Bill to  Jimmy   $108.00 paid on November 2, 2026`;

ok('label and value side by side: the invoice number, not the receipt number', () => {
  const r = parse(ADJACENT);
  assert.strictEqual(r.invoiceNo, 'OUXVRV1G-0002'); assert.strictEqual(r.isReceipt, true);
  assert.strictEqual(r.date, '2026-11-02'); assert.strictEqual(r.amount, 448.54);
  assert.strictEqual(r.invoiceNo.replace(/-/g, ''), 'OUXVRV1G0002', 'what goes on the claim line');
});

ok('labels in one block and values in the next: still the invoice number', () => {
  const r = parse(COLUMNS);
  assert.strictEqual(r.invoiceNo, 'OUXVRV1G-0002'); assert.strictEqual(r.date, '2026-11-02', 'the date is found too, with its label far away');
  assert.strictEqual(r.merchant, 'Anthropic');
});

ok('a company with no @handle is named from its legal form (Anthropic, PBC)', () => {
  assert.strictEqual(parse(ADJACENT).merchant, 'Anthropic');
  assert.strictEqual(parse('Invoice number AB12CD34-0001 Date paid May 3, 2026 Runway AI, Inc. 1 Main Street').merchant, 'Runway AI');
});

ok('any kind of dash in the PDF font (soft hyphen, non-breaking hyphen, en dash, minus), or spaces round it', () => {
  ['\u00ad', '\u2010', '\u2011', '\u2013', '\u2014', '\u2212', ' - ', ' \u2011 '].forEach((d) => {
    assert.strictEqual(parse(ADJACENT.replace('OUXVRV1G-0002', 'OUXVRV1G' + d + '0002')).invoiceNo, 'OUXVRV1G-0002', JSON.stringify(d));
    assert.strictEqual(parse(COLUMNS.replace('OUXVRV1G-0002', 'OUXVRV1G' + d + '0002')).invoiceNo, 'OUXVRV1G-0002', 'columns ' + JSON.stringify(d));
  });
});

ok('Eleven Labs / Runway style numbers still work', () => {
  assert.strictEqual(parse('Invoice Invoice number PZS6NSFF-0001  Date of issue October 14, 2026  Eleven Labs Inc. @elevenlabs').invoiceNo, 'PZS6NSFF-0001');
  assert.strictEqual(parse('Invoice number YJE6F0DZ-0001 Date of issue October 14, 2026').invoiceNo, 'YJE6F0DZ-0001');
});

ok('a document with no invoice number is not read as one, and a receipt number alone is never taken for it', () => {
  assert.strictEqual(parse('Receipt number 2624-7281-7973 Date paid November 2, 2026'), null);
  assert.strictEqual(parse('Invoice number   Receipt number 2624-7281-7973   Date paid November 2, 2026 hello'), null);
  assert.strictEqual(parse('KLINIK PUTRA CARE OFFICIAL RECEIPT 2026-11-02 RM 75.00'), null);
});

ok('numbers elsewhere on the page are not mistaken for it (dates, addresses, the VAT number)', () => {
  const r = parse('Invoice number   Receipt number   2624-7281-7973   Date paid   2026-11-02   PMB 90375   43300 Seri Kembangan   Malaysia Reg. No: 26000029   OUXVRV1G-0002');
  assert.strictEqual(r.invoiceNo, 'OUXVRV1G-0002');
});

console.log('receipts tests passed');
