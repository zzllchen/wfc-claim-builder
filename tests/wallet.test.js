/* node tests/wallet.test.js - My receipts (js/wallet.js): the parts that need no browser */
'use strict';
const assert = require('assert');
const W = require('../js/wallet.js');
const ok = (name, fn) => { fn(); console.log('ok  ' + name); };

const rec = (over) => Object.assign({ id: 'r1', createdAt: '2026-11-21T09:30:00.000Z', reading: {}, status: 'new', claimedIn: '' }, over);

ok('a receipt belongs to the month printed on it, else the month it was snapped', () => {
  assert.strictEqual(W.monthFor(rec({ reading: { date: '2026-10-29' } })), '2026-10');
  assert.strictEqual(W.monthFor(rec({ reading: {} })), '2026-11');
});

ok('the file name in Drive is readable and sorts by date', () => {
  assert.strictEqual(W.fileName(rec({ reading: { date: '2026-11-03', category: 'Petrol', name: 'Shell / Sg Besi', amount: '50' } })), '2026-11-03 - Petrol - Shell Sg Besi - RM50.00.jpg');
  assert.strictEqual(W.fileName(rec({ reading: {} })), '2026-11-21.jpg');
});

ok('what is kept with the file in Drive comes back as the same receipt on another device', () => {
  const r = rec({ reading: { category: 'Meals', name: 'Restoran Sedap', date: '2026-11-05', amount: '23.40', receiptNo: '115600', review: [], auto: { name: true }, empty: '' } });
  const back = W.fromDrive({ id: 'g1', name: 'x.jpg', mimeType: 'image/jpeg', description: W.describe(r), appProperties: { wfcId: 'r1', status: 'claimed', claimedIn: '2026-11' }, createdTime: '2026-11-21T09:31:00Z' });
  assert.deepStrictEqual([back.id, back.driveId, back.status, back.claimedIn, back.month, back.synced], ['r1', 'g1', 'claimed', '2026-11', '2026-11', true]);
  assert.deepStrictEqual(back.reading, { category: 'Meals', name: 'Restoran Sedap', date: '2026-11-05', amount: '23.40', receiptNo: '115600', auto: { name: true } }, 'empty parts are left out');
  assert.ok(W.describe(rec({ reading: { planB: 'x'.repeat(9000) } })).length <= 3500, 'kept short');
});

ok('this device and Drive together: one entry per receipt, claimed elsewhere wins, removed ones gone, newest first', () => {
  const local = [rec({ id: 'a', createdAt: '2026-11-01' }), rec({ id: 'b', createdAt: '2026-11-03' }), rec({ id: 'c', createdAt: '2026-11-04', removed: true })];
  const remote = [W.fromDrive({ id: 'ga', description: JSON.stringify({ id: 'a' }), appProperties: { wfcId: 'a', status: 'claimed', claimedIn: '2026-11' } }),
    W.fromDrive({ id: 'gd', description: JSON.stringify({ id: 'd', createdAt: '2026-11-05' }), appProperties: { wfcId: 'd', status: 'new' } })];
  const m = W.merge(local, remote);
  assert.deepStrictEqual(m.map((r) => r.id), ['d', 'b', 'a']);
  assert.deepStrictEqual([m[2].status, m[2].driveId], ['claimed', 'ga'], 'claimed on the laptop shows as claimed on the phone');
});

ok('grouped by month, newest month first', () => {
  const g = W.byMonth([rec({ id: 'x', reading: { date: '2026-10-02' } }), rec({ id: 'y', reading: { date: '2026-11-02' } }), rec({ id: 'z', reading: { date: '2026-10-30' } })]);
  assert.deepStrictEqual(g.map((x) => [x.month, x.items.map((r) => r.id)]), [['2026-11', ['y']], ['2026-10', ['x', 'z']]]);
});

ok('the reading kept from a claim line: the boxes and what the scanner said, nothing else', () => {
  const r = W.readingOf({ id: 'i1', files: [{}], category: 'Petrol', name: 'Shell', date: '2026-11-03', receiptNo: '', amount: '50.00', review: ['receiptNo'], auto: { amount: true }, snap: {}, planB: 'Checked with Claude.' });
  assert.deepStrictEqual(r, { category: 'Petrol', name: 'Shell', date: '2026-11-03', amount: '50.00', review: ['receiptNo'], auto: { amount: true }, planB: 'Checked with Claude.' });
});

ok('a Drive upload is one request: the details, then the photo', async () => {
  const mp = W.multipart({ name: 'a.jpg' }, new Blob(['JPEG'], { type: 'image/jpeg' }), 'B');
  assert.strictEqual(mp.type, 'multipart/related; boundary=B');
  const text = await mp.body.text();
  assert.strictEqual(text, '--B\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.jpg"}\r\n--B\r\nContent-Type: image/jpeg\r\n\r\nJPEG\r\n--B--');
});

ok('only the files this tool makes in Drive (drive.file), in a folder of their own', () => {
  assert.strictEqual(W.SCOPE, 'https://www.googleapis.com/auth/drive.file');
  assert.strictEqual(W.FOLDER, 'WFC Receipts');
});

console.log('wallet tests passed');
