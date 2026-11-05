/* node tests/accounts.test.js - the sender that puts a saved claim on the accountant's dashboard (against a stand-in inbox) */
'use strict';
const assert = require('assert');
const Accounts = require('../js/accounts.js');

function fakeInbox(opts = {}) {
  const calls = [];
  let flaky = opts.failFirstUpload ? 1 : 0;
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, action: body.action, body });
    assert.strictEqual(init.method, 'POST');
    assert.ok(/^text\/plain/.test(init.headers['Content-Type']), 'must stay a simple request (no pre-flight)');
    const reply = (obj, status = 200) => ({ status, json: async () => obj });
    if (body.action === 'submit') return opts.refuseSubmit ? reply({ ok: false, error: 'The claim has no lines.' }) : reply({ ok: true, id: '2026-10_a', token: 'tok' });
    if (body.action === 'upload') {
      if (flaky-- > 0) throw new TypeError('Failed to fetch');
      if (opts.refuseUpload) return reply({ ok: false, error: 'The file is too big.' });
      return reply({ ok: true });
    }
    if (body.action === 'finish') return reply({ ok: true, version: 3, files: calls.filter((c) => c.action === 'upload').length });
    return reply({ ok: false, error: 'Unknown action.' });
  };
  return { fn, calls };
}

const claim = { claimant: 'A', month: '2026-10', lines: [{ category: 'Petrol', amount: 10 }] };
const pdf = new Blob(['%PDF-1.4 hello'], { type: 'application/pdf' });
const buf = new TextEncoder().encode('statement bytes').buffer;

(async () => {
  // in order: submit, every file, finish; names, kinds and lines travel with the files; the bytes arrive intact
  let inbox = fakeInbox(); globalThis.fetch = inbox.fn;
  const seen = [];
  const r = await Accounts.send({
    api: 'http://x/api', claim, onProgress: (p) => seen.push(p.done + '/' + p.total),
    files: [{ name: 'Claim form.pdf', data: pdf, kind: 'form-pdf' }, { name: 'Receipt 01.jpg', data: buf, kind: 'receipt', line: 1 }, { name: 'raw.bin', data: new Uint8Array([1, 2, 3]) }],
    concurrency: 1,
  });
  assert.deepStrictEqual(inbox.calls.map((c) => c.action), ['submit', 'upload', 'upload', 'upload', 'finish']);
  const up = inbox.calls.filter((c) => c.action === 'upload').map((c) => c.body.file);
  assert.deepStrictEqual(up.map((f) => [f.id, f.name, f.kind, f.line]), [['f01', 'Claim form.pdf', 'form-pdf', 0], ['f02', 'Receipt 01.jpg', 'receipt', 1], ['f03', 'raw.bin', 'other', 0]]);
  assert.strictEqual(Buffer.from(up[0].data, 'base64').toString(), '%PDF-1.4 hello');
  assert.strictEqual(Buffer.from(up[1].data, 'base64').toString(), 'statement bytes');
  assert.deepStrictEqual([...Buffer.from(up[2].data, 'base64')], [1, 2, 3]);
  assert.strictEqual(up[0].mime, 'application/pdf');
  assert.ok(inbox.calls.every((c) => c.action === 'submit' || c.body.token === 'tok'), 'the token from the first call is used throughout');
  assert.deepStrictEqual(r, { id: '2026-10_a', version: 3, files: 3, skipped: [] });
  assert.strictEqual(seen[0], '0/4'); assert.strictEqual(seen[seen.length - 1], '4/4');
  console.log('  ok  submit, files, finish');

  // many files at once: all arrive, "finish" is last
  inbox = fakeInbox(); globalThis.fetch = inbox.fn;
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `r${i}.jpg`, data: new Uint8Array([i]), kind: 'receipt', line: i + 1 }));
  await Accounts.send({ api: 'http://x/api', claim, files: many });
  assert.strictEqual(inbox.calls.filter((c) => c.action === 'upload').length, 9);
  assert.strictEqual(inbox.calls[inbox.calls.length - 1].action, 'finish');
  assert.deepStrictEqual(inbox.calls.filter((c) => c.action === 'upload').map((c) => c.body.file.id).sort(), many.map((_, i) => 'f' + String(i + 1).padStart(2, '0')));
  console.log('  ok  many files, finish last');

  // a file too big for the inbox is left out and named; the rest still goes
  inbox = fakeInbox(); globalThis.fetch = inbox.fn;
  const big = { name: 'huge.jpg', data: { size: Accounts.MAX_FILE + 1, arrayBuffer: async () => { throw new Error('must not be read'); } } };
  const r2 = await Accounts.send({ api: 'http://x/api', claim, files: [big, { name: 'ok.pdf', data: pdf, kind: 'form-pdf' }] });
  assert.deepStrictEqual(r2.skipped, ['huge.jpg']);
  assert.strictEqual(inbox.calls.filter((c) => c.action === 'upload').length, 1);
  console.log('  ok  too-big file left out');

  // a dropped connection is tried once more
  inbox = fakeInbox({ failFirstUpload: true }); globalThis.fetch = inbox.fn;
  await Accounts.send({ api: 'http://x/api', claim, files: [{ name: 'a.pdf', data: pdf }], concurrency: 1 });
  assert.strictEqual(inbox.calls.filter((c) => c.action === 'upload').length, 2);
  console.log('  ok  one retry');

  // the inbox saying no is passed on in its own words, with no retry
  inbox = fakeInbox({ refuseSubmit: true }); globalThis.fetch = inbox.fn;
  await assert.rejects(Accounts.send({ api: 'http://x/api', claim, files: [] }), /no lines/);
  inbox = fakeInbox({ refuseUpload: true }); globalThis.fetch = inbox.fn;
  await assert.rejects(Accounts.send({ api: 'http://x/api', claim, files: [{ name: 'a.pdf', data: pdf }] }), /too big/);
  assert.strictEqual(inbox.calls.filter((c) => c.action === 'upload').length, 1);
  assert.ok(!inbox.calls.some((c) => c.action === 'finish'), 'a claim whose upload failed is never finished');
  console.log('  ok  refusals');

  // nobody there
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(Accounts.send({ api: 'http://x/api', claim, files: [] }), /couldn't connect/);
  console.log('accounts tests passed');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
