/* node tests/remind.test.js - claim reminders: which month is due, when the page nudges, and that the page and the service worker say the same words */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ok = (name, fn) => { fn(); console.log('ok  ' + name); };

const mem = {};
global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
const Remind = require('../js/remind.js');

ok('1-15 November is the time to claim October; the due date is the 15th', () => {
  const t = Remind.due(new Date(2026, 10, 3));
  assert.deepStrictEqual([t.month, t.label, t.due, t.open, t.daysLeft], ['2026-10', 'October', '15 November', true, 12]);
  assert.strictEqual(Remind.due(new Date(2026, 10, 15)).open, true);
  assert.strictEqual(Remind.due(new Date(2026, 10, 16)).open, false);
});
ok('January claims December of last year', () => {
  const t = Remind.due(new Date(2027, 0, 2));
  assert.deepStrictEqual([t.month, t.label, t.due], ['2026-12', 'December', '15 January']);
});
ok('the four reminder days', () => {
  assert.deepStrictEqual(Remind.DAYS, [1, 8, 13, 15]);
  [1, 8, 13, 15].forEach((d) => assert.ok(Remind.isRemindDay(d)));
  [2, 7, 9, 14, 16, 30].forEach((d) => assert.ok(!Remind.isRemindDay(d)));
});
ok('the page nudges on the 1st-15th until that month\'s claim is saved here, and not after "not now"', () => {
  const d = new Date(2026, 10, 9);
  assert.strictEqual(Remind.needsNudge(d).month, '2026-10');
  assert.strictEqual(Remind.needsNudge(new Date(2026, 10, 20)), null, 'after the 15th: no nudge');
  Remind.snoozeToday(d);
  assert.strictEqual(Remind.needsNudge(d), null, 'put off for today');
  assert.strictEqual(Remind.needsNudge(new Date(2026, 10, 10)).month, '2026-10', 'back tomorrow');
  Remind.markClaimed('2026-10');
  assert.strictEqual(Remind.needsNudge(new Date(2026, 10, 10)), null, 'claim saved: quiet');
  assert.ok(Remind.isClaimed('2026-10') && !Remind.isClaimed('2026-09'));
  assert.strictEqual(Remind.needsNudge(new Date(2026, 11, 2)).month, '2026-11', 'next month it starts again');
});
ok('only the last 24 saved months are kept; a bad month is ignored', () => {
  for (let i = 1; i <= 30; i++) Remind.markClaimed(`${2020 + Math.floor(i / 12)}-${String(1 + (i % 12)).padStart(2, '0')}`);
  Remind.markClaimed('nonsense');
  assert.ok(Object.keys(JSON.parse(mem['wfc-claims-saved'])).length <= 24);
  assert.ok(!('nonsense' in JSON.parse(mem['wfc-claims-saved'])));
});
ok('the key from the inbox turns into the bytes the phone wants (65-byte point)', () => {
  const raw = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]);
  const b64url = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  global.atob = global.atob || ((s) => Buffer.from(s, 'base64').toString('binary'));
  const bytes = Remind.b64ToBytes(b64url);
  assert.strictEqual(bytes.length, 65);
  assert.strictEqual(bytes[0], 4);
});

// the service worker is the one that really shows the words; the page's test button must say exactly the same
const code = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const fakeSelf = { registration: { scope: 'https://example.test/flow/' }, addEventListener() {}, location: { origin: 'https://example.test' } };
new Function('self', 'caches', 'fetch', code)(fakeSelf, {}, () => {});
ok('page and service worker write the same reminder on every day of 2026 and 2027, in any time zone', () => {
  let n = 0;
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 3 * 3600e3) {
    const d = new Date(t);
    assert.deepStrictEqual(Remind.textFor(d), fakeSelf.reminderText(d), d.toISOString());
    n++;
  }
  assert.ok(n > 5000);
});
console.log('remind tests passed');

/* turning reminders on and off, with a stand-in phone (no real push service here) */
(async () => {
  const calls = [];
  let subscribed = null, perm = 'default';
  const sub = (key) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', options: { applicationServerKey: key }, unsubscribe: async () => { subscribed = null; calls.push('unsubscribe'); return true; } });
  const reg = { pushManager: { getSubscription: async () => subscribed, subscribe: async (o) => { calls.push('subscribe'); subscribed = sub(o.applicationServerKey); return subscribed; } } };
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { ready: Promise.resolve(reg), getRegistration: async () => reg }, userAgent: 'test', platform: 'x', maxTouchPoints: 0 }, configurable: true });
  globalThis.PushManager = function () {};
  globalThis.Notification = { get permission() { return perm; }, requestPermission: async () => { calls.push('permission'); if (perm !== 'denied') perm = 'granted'; return perm; } };
  const keyBytes = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]);
  const key = keyBytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const posts = [];
  const post = async (b) => { posts.push(b); return b.op === 'key' ? { ok: true, key } : { ok: true }; };

  assert.strictEqual(await Remind.state(), 'off');
  await assert.rejects(() => Remind.enable(post, { name: '  ' }), /type your name/);
  assert.deepStrictEqual(calls, [], 'no permission asked without a name');
  await Remind.enable(post, { name: 'Lim Ah Seng', email: 'a@b.c' });
  assert.deepStrictEqual(calls, ['permission', 'subscribe']);
  assert.deepStrictEqual(posts.map((p) => p.op), ['key', 'join']);
  assert.deepStrictEqual([posts[1].endpoint, posts[1].name, posts[1].email], ['https://fcm.googleapis.com/fcm/send/abc', 'Lim Ah Seng', 'a@b.c']);
  assert.strictEqual(await Remind.state(), 'on');
  console.log('ok  turning reminders on asks permission, gets the key, subscribes and tells the inbox');

  posts.length = 0; calls.length = 0;
  await Remind.enable(post, { name: 'Lim Ah Seng' });                       // again: the phone's address is kept, not remade
  assert.deepStrictEqual(calls, ['permission'], 'same key: no new subscription');
  console.log('ok  turning them on twice keeps the same phone address');

  subscribed = sub(new Uint8Array([1, 2, 3])); calls.length = 0;             // the inbox changed its key: the old address cannot work any more
  await Remind.enable(post, { name: 'Lim Ah Seng' });
  assert.deepStrictEqual(calls, ['permission', 'unsubscribe', 'subscribe']);
  console.log('ok  a changed inbox key makes a fresh phone address');

  posts.length = 0;
  await Remind.touch(post, { name: 'New Name', email: '' });
  assert.deepStrictEqual(posts.map((p) => [p.op, p.name]), [['join', 'New Name']]);
  await Remind.disable(post);
  assert.deepStrictEqual(posts.map((p) => p.op), ['join', 'leave']);
  assert.strictEqual(await Remind.state(), 'off');
  console.log('ok  the name is kept right after a claim, and turning off tells the inbox');

  perm = 'denied';
  assert.strictEqual(await Remind.state(), 'blocked');
  await assert.rejects(() => Remind.enable(post, { name: 'X' }), /blocked|not turned on/);
  console.log('ok  blocked notifications are explained');
  console.log('remind push tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
