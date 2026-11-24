/* node tests/sw.test.js - the service worker's reminder words (they follow today's date, Malaysia time) and its caching rules */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ok = (name, fn) => { fn(); console.log('ok  ' + name); };

const code = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const listeners = {};
const fakeSelf = { registration: { scope: 'https://example.test/flow/' }, addEventListener: (n, f) => { listeners[n] = f; }, location: { origin: 'https://example.test' } };
const fakeCache = { match: async () => undefined, put: async () => {}, keys: async () => [], delete: async () => true };
new Function('self', 'caches', 'fetch', code)(fakeSelf, { open: async () => fakeCache, keys: async () => [] }, () => Promise.reject(new Error('no network in this test')));
const say = (iso) => fakeSelf.reminderText(new Date(iso));

ok('1st-7th: it is time to claim last month, with the due date', () => {
  const t = say('2026-11-01T01:00:00Z');                      // 09:00 in Malaysia
  assert.strictEqual(t.title, 'Time to claim your October expenses');
  assert.ok(/Due 15 November\./.test(t.body), t.body);
  assert.strictEqual(say('2026-11-07T01:00:00Z').tag, 'start');
});
ok('8th-12th: a friendly nudge', () => {
  const t = say('2026-11-08T01:00:00Z');
  assert.strictEqual(t.title, 'Friendly reminder: October claim');
  assert.strictEqual(t.tag, 'nudge');
});
ok('13th and 14th: days left, singular on the 14th', () => {
  assert.strictEqual(say('2026-11-13T01:00:00Z').title, 'October claims close in 2 days');
  assert.strictEqual(say('2026-11-14T01:00:00Z').title, 'October claims close in 1 day');
});
ok('15th: the last day', () => {
  const t = say('2026-11-15T01:00:00Z');
  assert.strictEqual(t.title, 'Last day for October claims');
  assert.strictEqual(t.tag, 'last');
});
ok('January claims December of last year; due date in January', () => {
  const t = say('2027-01-01T01:00:00Z');
  assert.strictEqual(t.title, 'Time to claim your December expenses');
  assert.ok(/Due 15 January\./.test(t.body));
});
ok('the day is Malaysia\'s, not the phone\'s: late 30 Nov in London is already 1 Dec in Kuala Lumpur', () => {
  assert.strictEqual(say('2026-11-30T17:30:00Z').title, 'Time to claim your November expenses');
});
ok('the worker handles install, activate, fetch, push and a tap on the notification', () => {
  ['install', 'activate', 'fetch', 'push', 'notificationclick'].forEach((n) => assert.strictEqual(typeof listeners[n], 'function', n));
});
ok('it never answers for other sites, other methods or the tests folder', () => {
  let answered = 0;
  const ev = (method, url, mode) => ({ request: { method, url, mode: mode || 'cors', headers: new Map() }, respondWith: (p) => { answered++; Promise.resolve(p).catch(() => {}); }, waitUntil: () => {} });
  listeners.fetch(ev('POST', 'https://example.test/flow/app.js'));
  listeners.fetch(ev('GET', 'https://accounts.google.com/gsi/client'));
  listeners.fetch(ev('GET', 'https://example.test/flow/tests/scan-bench.html'));
  listeners.fetch(ev('GET', 'https://example.test/other/app.js'));
  assert.strictEqual(answered, 0);
  listeners.fetch(ev('GET', 'https://example.test/flow/js/app.js?v=1'));
  listeners.fetch(ev('GET', 'https://example.test/flow/', 'navigate'));
  assert.strictEqual(answered, 2);
});
console.log('sw tests passed');
