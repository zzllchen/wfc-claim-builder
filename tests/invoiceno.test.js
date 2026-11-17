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
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
