/* node tests/invoiceno.test.js - the invoice number of a Budi95 petrol slip ("Invoice No 1b0eb6": six characters, 0-9 and a-f), read from
   OCR text the way it comes out: label mangled, value split, value under the label, letters read for digits. Invented slip, same layout as a real one. */
'use strict';
const P = require('../js/petrol.js');
let fails = 0;
const eq = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? ' ' + JSON.stringify(got) : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)); };
const opts = { month: '2026-10' };

// a dealer slip as the engine reads it; ${inv} is the line the tests change
const slip = (inv) => ['CALTEX', 'TEST ENERGY SDN BHD', 'Lot 1, Jalan Ujian', '21OCT2026 09:35AM', 'RON95 BUDI95   RM81.26', 'TOTAL RM81.26', 'SUBSIDY RM12.40', 'Site Id 100200', 'Site Tran No 003438', 'POS STAN 024034']
  .concat(inv, ['Ref 001031003519', 'For LHDN E-invoice Request', 'Scan for E-Invoice & Subsidy Details']).join('\n');
const no = (inv) => P.parse(slip(inv), opts).receiptNo;

eq('plain', no('Invoice No   1b0eb6'), '1b0eb6');
eq('O read for 0', no('Invoice No   1bOeb6'), '1b0eb6');
eq('l read for 1', no('Invoice No   lb0eb6'), '1b0eb6');
eq('i read for 1', no('Invoice No   ib0eb6'), '1b0eb6');
eq('h read for b', no('Invoice No   1h0eb6'), '1b0eb6');
eq('label misread', no('lnvoice No   1b0eb6'), '1b0eb6');
eq('label and value stuck together', no('Invoice No:1b0eb6'), '1b0eb6');
eq('label without the word No', no('Invoice   1b0eb6'), '1b0eb6');
eq('value split by a stray space', no('Invoice No   1b0 eb6'), '1b0eb6');
eq('value split in the middle', no('Invoice No   1b 0eb6'), '1b0eb6');
eq('value on the line under the label', no('Invoice No\n1b0eb6'), '1b0eb6');
eq('only the value was read', no('1b0eb6'), '1b0eb6');
eq('the site, transaction and reference numbers are never the invoice number', no('Invoice No'), '');
eq('a heading "INVOICE" with the value further up is not confused with the site number', P.parse(slip('INVOICE').replace('Site Id 100200', 'Site Id 1002ab'), opts).receiptNo, '');
eq('the Petronas slip as before', P.parse(['PETRONAS', 'KEJAYAAN TEGUH ENT', '29OCT2026 10:05AM', 'TOTAL RM58.37', 'SUBSIDY RM9.00', 'Invoice No 60770c'].join('\n'), opts).receiptNo, '60770c');

// an invoice number that is read once and may be a character off ("1hoe hs" is 1b0eb6 on the real slip) must be checked, not trusted
const PB = require('../js/planb.js');
const eqj = (name, got, want) => eq(name, JSON.stringify(got), JSON.stringify(want));
const one = P.best([slip('Invoice No   1hoe hs')], opts);
eq('read once, a character off: the number is given but to check', one.receiptNo + ',' + one.invoiceDoubt, '1b0eb5,true');
eq('read once: the doubt is a plain sentence for the line and for Claude', PB.doubts(one, { category: 'Petrol', today: new Date('2026-10-25') }).filter((w) => /invoice/.test(w)).join(), 'the invoice number (1b0eb5) may be misread');
const twoA = slip('Invoice No   1b0eb6'), twoB = slip('Invoice No   1b0eb6').replace('TEST ENERGY SDN BHD', 'TEST ENERGY SDN BH');
eq('two different readings agree: no doubt', P.best([twoA, twoB], opts).invoiceDoubt, false);
eq('the same page counted twice is still one reading', P.best([twoA, twoA], opts).invoiceDoubt, true);
eq('no invoice number found on a subsidy slip is a doubt too', P.best([slip('Ref 1')], opts).invoiceDoubt, true);
eq('a slip with no subsidy has no such doubt', P.best(['SHELL\nTOTAL RM40.00\n21OCT2026 09:35AM'], opts).invoiceDoubt, undefined);
const asked = PB.merge(one, { isReceipt: true, kind: 'Petrol', merchant: 'Padi Emas Petroleum Sdn Bhd', date: '2026-10-21', amount: 81.26, receiptNo: '1b0eb6', confidence: 'high' }, ['the invoice number (1b0eb5) may be misread']);
eq('Claude\'s six-character number replaces the doubtful one, and says so', asked.r.receiptNo + ' | ' + asked.note, '1b0eb6 | Claude agrees with RM81.26. Receipt number was 1b0eb5, now 1b0eb6.');
const other = PB.merge(one, { isReceipt: true, kind: 'Petrol', receiptNo: '21240000' }, ['the invoice number (1b0eb5) may be misread']);
eqj('a doubted number and Claude reads the slip\'s own number (Petron "Invoice #"): Claude\'s is used, marked for review, the note says what this PC read',
  [other.r.receiptNo, other.r.review, other.note], ['21240000', ['receiptNo'], 'Receipt number was 1b0eb5, now 21240000.']);
const undoubted = PB.merge(Object.assign({}, one, { invoiceDoubt: false }), { isReceipt: true, kind: 'Petrol', receiptNo: '1b0eb6' }, []);
eqj('even a number nobody doubted: where Claude (who saw the photo) reads it differently, its reading is used and marked for review', [undoubted.r.receiptNo, undoubted.r.review], ['1b0eb6', ['receiptNo']]);
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
