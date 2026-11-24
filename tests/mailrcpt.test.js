/* node tests/mailrcpt.test.js - finding e-receipts in Gmail: the search, reading a message, picking the receipt, ranking (invented emails, stand-in Gmail) */
'use strict';
const assert = require('assert');
const M = require('../js/mailrcpt.js');
const ok = (name, fn) => Promise.resolve().then(fn).then(() => console.log('ok  ' + name));

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hdrs = (o) => Object.keys(o).map((k) => ({ name: k, value: o[k] }));
const html = (id, from, subject, body, extra) => ({ id, threadId: id, internalDate: String(Date.UTC(2026, 9, 12, 3, 0, 0)), snippet: body.slice(0, 60),
  payload: { mimeType: 'multipart/alternative', headers: hdrs(Object.assign({ From: from, Subject: subject, Date: 'Mon, 12 Oct 2026 11:00:00 +0800' }, extra || {})),
    parts: [{ mimeType: 'text/plain', body: { data: b64(body.replace(/<[^>]+>/g, ' ')) } }, { mimeType: 'text/html', body: { data: b64(body) } }] } });
const withFiles = (m, files) => { m.payload.mimeType = 'multipart/mixed'; files.forEach((f, i) => m.payload.parts.push({ mimeType: f.mime, filename: f.name, headers: f.inline ? [{ name: 'Content-ID', value: '<x>' }] : [], body: { attachmentId: 'att' + i + f.name, size: f.size || 50000 } })); return m; };

const stripe = withFiles(html('m1', 'Anthropic, PBC <invoice+statements@mail.anthropic.com>', 'Your receipt from Anthropic, PBC #2561-3057-5961', '<p>Receipt from Anthropic</p>'),
  [{ name: 'Invoice-PZS6NSFF-0001.pdf', mime: 'application/pdf' }, { name: 'Receipt-2561-3057-5961.pdf', mime: 'application/pdf' }, { name: 'logo.png', mime: 'image/png', size: 4000, inline: true }]);
const grab = html('m2', 'Grab <no-reply@grab.com>', 'Your Grab E-Receipt', '<table><tr><td>Total</td><td>RM&nbsp;12.50</td></tr><tr><td>Fare</td><td>RM 11.00</td></tr></table><p>Thanks for riding &amp; see you!</p>');
const newsletter = html('m3', 'Deals <promo@shop.example>', 'Big sale: 50% off your next order', '<p>Save big</p>', { 'List-Unsubscribe': '<mailto:x@y.z>' });
const shipped = html('m4', 'Shopee <noreply@mail.shopee.com.my>', 'Your order has shipped', '<p>On its way</p>');
const flight = withFiles(html('m5', 'AirAsia <noreply@airasia.com>', 'Your itinerary', '<p>Booking</p>'), [{ name: 'Itinerary.pdf', mime: 'application/pdf' }]);
const photoMail = withFiles(html('m6', 'Ali <ali@gmail.example>', 'Hotel bill', '<p>See photo</p>'), [{ name: 'IMG_2201.jpg', mime: 'image/jpeg', size: 240000 }, { name: 'icon.png', mime: 'image/png', size: 3000 }]);
const quiet = html('m7', 'Friend <friend@mail.example>', 'Lunch on Friday?', '<p>Free?</p>');

(async () => {
  await ok('the Gmail search is for one month, with receipt words, known senders and receipt-named files', () => {
    const q = M.buildQuery('2026-10');
    const a = Math.floor(new Date(2026, 9, 1).getTime() / 1000), b = Math.floor(new Date(2026, 10, 1).getTime() / 1000);
    assert.ok(q.includes(`after:${a} before:${b}`), q);
    assert.ok(/subject:\(.*receipt.*invoice.*\)/.test(q) && /from:\(.*grab\.com.*anthropic\.com.*\)/.test(q) && /filename:\(receipt OR invoice/.test(q));
    assert.ok(q.includes('-in:spam') && q.includes('-in:trash'));
    assert.ok(q.includes('-in:sent') && q.includes('-in:drafts'), 'your own sent mail and drafts are never listed');
    assert.ok(q.includes('"tax invoice"'), 'phrases are quoted');
    assert.strictEqual(M.buildQuery('2026-12').includes(`before:${Math.floor(new Date(2027, 0, 1).getTime() / 1000)}`), true, 'December ends on 1 January');
    assert.throws(() => M.buildQuery(''), /claim month/);
  });

  await ok('a message is read into who, what, when, attachments and text', () => {
    const m = M.parseMessage(stripe);
    assert.deepStrictEqual([m.from.name, m.from.email, m.from.domain], ['Anthropic, PBC', 'invoice+statements@mail.anthropic.com', 'mail.anthropic.com']);
    assert.strictEqual(m.subject, 'Your receipt from Anthropic, PBC #2561-3057-5961');
    assert.deepStrictEqual(m.attachments.map((a) => [a.filename, a.inline]), [['Invoice-PZS6NSFF-0001.pdf', false], ['Receipt-2561-3057-5961.pdf', false], ['logo.png', true]]);
    assert.ok(m.html.includes('Receipt from Anthropic'));
  });

  await ok('an invoice and its receipt are both picked, a logo is not', () => {
    const files = M.pickFiles(M.parseMessage(stripe));
    assert.deepStrictEqual(files.map((a) => a.filename), ['Invoice-PZS6NSFF-0001.pdf', 'Receipt-2561-3057-5961.pdf']);
  });
  await ok('a photo attached to a mail is picked; a small icon is not', () => {
    assert.deepStrictEqual(M.pickFiles(M.parseMessage(photoMail)).map((a) => a.filename), ['IMG_2201.jpg']);
  });

  await ok('ranking: tool receipts and flights tick themselves; a Grab email with no file ticks because it says E-Receipt', () => {
    const r = (m) => M.rank(M.parseMessage(m));
    assert.deepStrictEqual([r(stripe).kind, r(stripe).tick], ['pdf', true]);
    assert.deepStrictEqual([r(flight).kind, r(flight).tick], ['pdf', true]);
    assert.deepStrictEqual([r(grab).kind, r(grab).tick], ['email', true]);
    assert.strictEqual(r(photoMail).kind, 'photo');
  });
  await ok('newsletters, shipping notices and chat are not offered', () => {
    const list = M.candidates([stripe, grab, newsletter, shipped, flight, photoMail, quiet]);
    assert.deepStrictEqual(list.map((m) => m.id).sort(), ['m1', 'm2', 'm5', 'm6'].sort());
  });
  await ok('the list is in date order and holds at most 40', () => {
    const many = [];
    for (let i = 0; i < 70; i++) { const m = JSON.parse(JSON.stringify(grab)); m.id = 'g' + i; m.internalDate = String(Date.UTC(2026, 9, 1 + (i % 28), 1, i)); many.push(m); }
    const list = M.candidates(many);
    assert.strictEqual(list.length, 40);
    assert.ok(list.every((m, i) => i === 0 || list[i - 1].date <= m.date));
  });

  await ok('email text: tables, entities and layout noise become plain lines', () => {
    const t = M.htmlToText('<html><head><style>.a{color:red}</style></head><body><table><tr><td>Total</td><td>RM&nbsp;12.50</td></tr></table><p>Tom &amp; Jerry&#39;s &#x52;M</p><br><div>Thanks</div><!-- hidden --></body></html>');
    assert.strictEqual(t, 'Total RM 12.50\nTom & Jerry\'s RM\nThanks');
    assert.ok(!/color|hidden/.test(t));
  });
  await ok('a printed copy of the email: Latin text passes, smart quotes are tidied, Chinese-heavy mail is refused', () => {
    assert.strictEqual(M.printable('Total – RM 12.50 “paid”'), 'Total - RM 12.50 "paid"');
    assert.strictEqual(M.printable('总计 人民币 合计 收据 '.repeat(20)), null);
    assert.ok(M.printable('Receipt total RM 8.30 收据'));
  });
  await ok('the printed copy is named by date, sender and subject', () => {
    const m = M.parseMessage(grab);
    assert.strictEqual(M.printedName(m), '2026-10-12 Grab - Your Grab E-Receipt.pdf');
    const long = M.parseMessage(html('x', 'A/B <a@b.c>', 'q'.repeat(200), 'x'));
    assert.ok(M.printedName(long).length <= 94 && !/[\\/:*?"<>|]/.test(M.printedName(long)));
  });
  await ok('the message body decodes UTF-8 (Malay and Chinese words survive)', () => {
    const m = M.parseMessage(html('u', 'Kedai <k@k.my>', 'Resit 收据', '<p>Jumlah RM 5.00 谢谢</p>'));
    assert.ok(M.bodyText(m).includes('Jumlah RM 5.00 谢谢'));
    assert.ok(m.subject.includes('收据'));
  });

  /* the whole search against a stand-in Gmail: only the listed messages are opened, 5 at a time, and chosen attachments are fetched on request */
  await ok('search opens only the messages Gmail listed, shows progress, and fetches attachments only for the chosen email', async () => {
    const all = { m1: stripe, m2: grab, m3: newsletter, m5: flight };
    const seen = [];
    global.fetch = async (url, init) => {
      seen.push(url.replace('https://gmail.googleapis.com/gmail/v1/users/me', ''));
      assert.strictEqual(init.headers.Authorization, 'Bearer tok');
      const u = new URL(url);
      if (u.pathname.endsWith('/messages')) return { ok: true, status: 200, json: async () => ({ messages: Object.keys(all).map((id) => ({ id })) }) };
      const att = /\/messages\/(\w+)\/attachments\/(.+)$/.exec(u.pathname);
      if (att) return { ok: true, status: 200, json: async () => ({ data: b64('%PDF-1.4 fake ' + att[2]) }) };
      const id = /\/messages\/(\w+)$/.exec(u.pathname)[1];
      return { ok: true, status: 200, json: async () => all[id] };
    };
    M.__setToken('tok');          // as the connect step would have left it
    const progress = [];
    const res = await M.search('2026-10', (p) => progress.push(p.done + '/' + p.total));
    assert.strictEqual(res.found, 4);
    assert.deepStrictEqual(res.list.map((m) => m.id), ['m1', 'm2', 'm5']);
    assert.deepStrictEqual(progress, ['4/4']);
    assert.ok(seen[0].startsWith('/messages?q=') && seen[0].includes('maxResults=60'));
    assert.ok(seen.filter((s) => /format=full/.test(s)).length === 4 && !seen.some((s) => /attachments/.test(s)), 'no attachment is downloaded by searching');
    const chosen = res.list.find((m) => m.id === 'm1');
    const files = await M.filesOf(chosen, async () => { throw new Error('no print needed'); });
    assert.deepStrictEqual(files.map((f) => [f.name, f.type]), [['Invoice-PZS6NSFF-0001.pdf', 'application/pdf'], ['Receipt-2561-3057-5961.pdf', 'application/pdf']]);
    assert.ok(seen.filter((s) => /attachments/.test(s)).length === 2);
    assert.strictEqual((await files[0].text()).slice(0, 8), '%PDF-1.4');
    const printed = await M.filesOf(res.list.find((m) => m.id === 'm2'), async (m, text) => { assert.ok(/Total RM 12.50/.test(text), text); return new File(['pdf'], M.printedName(m), { type: 'application/pdf' }); });
    assert.strictEqual(printed[0].name, '2026-10-12 Grab - Your Grab E-Receipt.pdf');
  });
  console.log('mailrcpt tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
