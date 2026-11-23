/* node tests/scan.test.js - putting this PC's reading and Claude's together (js/scan.js merge) */
'use strict';
const assert = require('assert');
const S = require('../js/scan.js');
const ok = (name, fn) => { fn(); console.log('ok  ' + name); };

const local = { date: '2026-10-03', vendor: 'SEALS SUPPLY sk SDN, BHD', total: 84, number: 'CS-050000', category: 'Supplier invoice',
  confidence: { date: 0.9, vendor: 0.85, total: 0.7, number: 0.85, category: 0.6 } };
const claude = { isReceipt: true, date: '2026-10-29', vendor: 'SEALS SUPPLY SDN. BHD.', total: 112, number: 'CS-050000', category: 'Supplier invoice',
  confidence: { date: 0.8, vendor: 0.9, total: 0.95, number: 0.9, category: 0.9 } };

ok('read from a picture: where the two disagree Claude wins (it saw the picture), and the field needs review', () => {
  const m = S.merge(local, claude, { ocr: true });
  assert.deepStrictEqual([m.fields.date, m.fields.total, m.fields.number], ['2026-10-29', 112, 'CS-050000']);
  assert.deepStrictEqual(m.needsReview, ['date', 'total']);
});

ok('read from a PDF\'s own text: the surer reading wins a disagreement, still marked for review', () => {
  const m = S.merge(local, claude);
  assert.deepStrictEqual([m.fields.date, m.fields.total], ['2026-10-03', 112]);
  assert.ok(m.needsReview.includes('date'));
});

ok('where they agree, the field is sure', () => {
  const m = S.merge(local, claude, { ocr: true });
  assert.ok(!m.needsReview.includes('number') && !m.needsReview.includes('vendor'));
});

console.log('scan tests passed');
