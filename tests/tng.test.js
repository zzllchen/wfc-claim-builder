/* node tests/tng.test.js - the newer Touch 'n Go export, "TNG WALLET TRANSACTION HISTORY": one table, a row per payment.
   Invented names and numbers, same layout as the real export (this repo is public: never put a real statement in a fixture). */
'use strict';
const assert = require('assert');
const TNG = require('../js/tng.js');

const ok = (name, fn) => { fn(); console.log('ok  ' + name); };
const items = (strs) => strs.map((str) => ({ str, x: 0, y: 0 }));
const stamp = (d, t) => `${d} ${t}`;

// a row as the export reads it: posted date | status | type | four reference cells | [plaza code] | description | details | amount | balance
const row = ({ posted, status = 'Success', type = 'RFID Payment', code = '658', desc, at, amount, balance }) => [
  posted, status, type, '20261001101', '10000010000', 'TNGOW3MY1', '71837049942', ...(code ? [code] : []), desc, at, amount, balance,
];

const HEAD = ['TNG WALLET TRANSACTION HISTORY', '1 October 2026 - 31 October 2026', 'TEST PERSON', '1000000000000001', 'Registered Name', 'Wallet ID', 'Account Status',
  'Generated Date & Time', 'Transaction Period', '17 November 2026 4:04 PM', 'Active', 'Date', 'Status', 'Transaction Type', 'Reference', 'Description', 'Details', 'Amount (RM)', 'Wallet Balance'];
const FOOT = ['*This is a system generated email. Please do not reply to this email. For further enquiry, kindly contact our customer service through https://tngd.my/careline-webform or call us at',
  '+603 5022 3888. The operating hours are Monday to Sunday, 7.00am to 10.00pm (including public holidays). Thank you.'];

const PAGE1 = HEAD.concat(
  row({ posted: '1/10/2026', desc: 'LDP - PUCHONG SELATAN', at: stamp('01/10/2026', '09:17 AM'), amount: 'RM2.10', balance: 'RM40.62' }),               // Thursday
  row({ posted: '3/10/2026', code: '624', desc: 'GRANDSAGA - BATU 9', at: stamp('02/10/2026', '07:47 PM'), amount: 'RM1.30', balance: 'RM16.02' }),    // paid on Friday evening, posted Saturday
  row({ posted: '3/10/2026', code: '927', desc: 'MEX - SALAK SELATAN', at: stamp('03/10/2026', '10:47 AM'), amount: 'RM2.00', balance: 'RM14.02' }),   // Saturday
  row({ posted: '5/10/2026', code: '', desc: 'MEX - SERI KEMBANGAN', at: stamp('05/10/2026', '12:05 AM'), amount: 'RM2.20', balance: 'RM11.82' }),     // Monday, no plaza code, just after midnight
  row({ posted: '6/10/2026', code: '', desc: 'KESAS - SRI PETALING', at: stamp('06/10/2026', '12:05 PM'), amount: 'RM1.10', balance: 'RM10.72' }),     // noon
  FOOT);
const PAGE2 = row({ posted: '7/10/2026', type: 'Reload', code: '', desc: 'Reload via FPX', at: stamp('07/10/2026', '08:00 AM'), amount: 'RM50.00', balance: 'RM60.72' })
  .concat(
    row({ posted: '8/10/2026', type: 'Payment', code: '', desc: 'MBSJ PARKING SEKSYEN 13', at: stamp('08/10/2026', '10:00 AM'), amount: 'RM4.00', balance: 'RM56.72' }),
    row({ posted: '8/10/2026', status: 'Failed', desc: 'LDP - PUCHONG BARAT', at: stamp('08/10/2026', '05:00 PM'), amount: 'RM2.10', balance: 'RM56.72' }),
    row({ posted: '9/10/2026', code: '389', desc: 'LDP - PUCHONG SELATAN', at: stamp('09/10/2026', '06:35 PM'), amount: 'RM2.10', balance: 'RM54.62' }),
    row({ posted: '12/10/2026', type: 'Payment', code: '', desc: 'Starbucks Coffee', at: stamp('12/10/2026', '08:10 AM'), amount: 'RM18.50', balance: 'RM36.12' }),
    FOOT);

const parsed = TNG.parseItems([items(PAGE1), items(PAGE2)]);

ok('the header: name, wallet ID as the statement number, period', () => {
  assert.strictEqual(parsed.header.name, 'TEST PERSON');
  assert.strictEqual(parsed.header.ewalletId, '1000000000000001');
  assert.strictEqual(parsed.header.serial, '1000000000000001', 'the wallet ID goes on the claim line as the Receipt No.');
  assert.strictEqual(parsed.header.periodText, '1 October 2026 - 31 October 2026');
  assert.strictEqual(parsed.header.from, '2026-10-01'); assert.strictEqual(parsed.header.to, '2026-10-31');
});

ok('every payment is a row, a failed one is left out, the page footer is not part of a row', () => {
  assert.strictEqual(parsed.rows.length, 9, 'ten rows in the file, one failed');
  assert.ok(parsed.rows.every((r) => !/system generated/i.test(r.plaza + r.text)));
  assert.strictEqual(new Set(parsed.rows.map((r) => r.no)).size, parsed.rows.length, 'the reference cells repeat from row to row, so the number is the row, not a reference');
});

ok('the date and time are the real ones from "details", not the posting date', () => {
  const late = parsed.rows.find((r) => /GRANDSAGA/.test(r.plaza));
  assert.strictEqual(late.date, '2026-10-02'); assert.strictEqual(late.time, '19:47:00'); assert.strictEqual(late.exitDate, '2026-10-02');
  assert.strictEqual(parsed.rows.find((r) => /SERI KEMBANGAN/.test(r.plaza)).time, '00:05:00', '12:05 AM is just after midnight');
  assert.strictEqual(parsed.rows.find((r) => /SRI PETALING/.test(r.plaza)).time, '12:05:00', '12:05 PM is noon');
});

ok('amount and balance, with the plaza name (a bare plaza code is not the name)', () => {
  const r = parsed.rows[0];
  assert.strictEqual(r.plaza, 'LDP - PUCHONG SELATAN'); assert.strictEqual(r.amount, 2.1); assert.strictEqual(r.balance, 40.62); assert.strictEqual(r.type, 'TOLL');
  assert.strictEqual(parsed.rows.find((r2) => /SRI PETALING/.test(r2.plaza)).amount, 1.1);
});

ok('tolls, parking, and everything else (reload, shop payments) told apart', () => {
  const byType = parsed.rows.reduce((a, r) => { a[r.type] = (a[r.type] || 0) + 1; return a; }, {});
  assert.deepStrictEqual(byType, { TOLL: 6, RETAIL: 2, PARKING: 1 });
  assert.strictEqual(parsed.rows.find((r) => /PARKING/.test(r.plaza)).type, 'PARKING');
  assert.strictEqual(parsed.rows.find((r) => /Reload/i.test(r.plaza)).type, 'RETAIL');
});

ok('the toll rules work on it: work days count, Saturday does not, reloads and shop payments are dropped', () => {
  const rows = TNG.classify(parsed.rows, { month: '2026-10', holidays: TNG.parseHolidays(TNG.DEFAULT_HOLIDAYS), daysOff: new Set() });
  assert.ok(!rows.some((r) => r.type === 'RETAIL'));
  assert.strictEqual(rows.find((r) => /SALAK/.test(r.plaza)).include, false, 'Saturday 3 Oct');
  assert.strictEqual(rows.find((r) => /GRANDSAGA/.test(r.plaza)).include, true, 'Friday 2 Oct, posted on the Saturday');
  assert.strictEqual(TNG.sum(rows, 'TOLL'), 2.1 + 1.3 + 2.2 + 1.1 + 2.1);
  assert.strictEqual(TNG.sum(rows, 'PARKING'), 0, 'parking is claimed only when ticked');
});

ok('something that is not a Touch \'n Go statement is refused in plain words', () => {
  assert.throws(() => TNG.parseItems([items(['Some other document', 'Total RM 40.00'])]), /Touch 'n Go/);
});

console.log('tng tests passed');
