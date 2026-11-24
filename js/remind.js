/* Claim reminders: a friendly push notification (with the phone's normal notification sound) on the 1st, 8th, 13th and 15th of the month,
   about 9 am Malaysia time, until the person has sent last month's claim. Claims are made the month after: on 1-15 November the claim is for October.
   How it works:
   - the person taps "Turn on reminders" once; the phone asks to allow notifications and gives this app a push address;
   - that address and the claimant's name go to the accountant's inbox (the Google script), which pushes on those four days and skips anyone whose claim
     for last month is already there. The push carries no words: the service worker (sw.js) writes them from the date;
   - a slim bar on the page says the same thing for anyone who opens Flow during the 1st-15th with the claim not yet sent (no setup needed);
   - an iPhone only gets notifications from a home-screen app (iOS 16.4 or newer): the dialog says so and shows how.
   A web app cannot choose its own sound: the phone plays its standard notification sound (if its sound is on). */
(function (root) {
  'use strict';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = [1, 8, 13, 15];                       // the same four days the sender uses
  const DUE_DAY = 15;
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } } };
  const SAVED = 'wfc-claims-saved', ENDPOINT = 'wfc-remind-endpoint', SNOOZE = 'wfc-remind-snooze';

  /* ---------- the month a claim is due for (pure) ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (y, m) => `${y}-${pad(m)}`;
  // today's claim: { month: '2026-10', label: 'October', due: '15 November', day, open }  open = it is the 1st-15th, the days claims are made
  function due(now) {
    const d = now || new Date(), y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    return { month: keyOf(py, pm), label: MONTHS[pm - 1], due: `${DUE_DAY} ${MONTHS[m - 1]}`, day, open: day <= DUE_DAY, daysLeft: DUE_DAY - day };
  }
  const isRemindDay = (day) => DAYS.indexOf(day) >= 0;

  /* ---------- which months already have a saved claim (on this device) ---------- */
  const saved = () => { try { return JSON.parse(ls.get(SAVED) || '{}') || {}; } catch (e) { return {}; } };
  function markClaimed(month) { if (!/^\d{4}-\d{2}$/.test(month || '')) return; const s = saved(); s[month] = new Date().toISOString(); const keys = Object.keys(s).sort().slice(-24); const out = {}; keys.forEach((k) => { out[k] = s[k]; }); ls.set(SAVED, JSON.stringify(out)); }
  const isClaimed = (month) => !!saved()[month];
  // should the page nudge now? the 1st-15th, last month's claim not saved here, and not put off for today
  function needsNudge(now) {
    const t = due(now);
    if (!t.open || isClaimed(t.month)) return null;
    if (ls.get(SNOOZE) === (now || new Date()).toDateString()) return null;
    return t;
  }
  const snoozeToday = (now) => ls.set(SNOOZE, (now || new Date()).toDateString());

  /* ---------- push (browser only) ---------- */
  const b64ToBytes = (s) => { const p = String(s).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); };
  const ios = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => !!(navigator.standalone || (root.matchMedia && matchMedia('(display-mode: standalone)').matches));
  const canPush = () => !!(root.isSecureContext !== false && 'serviceWorker' in navigator && 'PushManager' in root && 'Notification' in root);

  /* 'unsupported' | 'needs-install' | 'blocked' | 'off' | 'on' */
  async function state() {
    if (!canPush()) return ios() && !standalone() ? 'needs-install' : 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
      return sub && Notification.permission === 'granted' ? 'on' : 'off';
    } catch (e) { return 'off'; }
  }

  /* Call from a click (the phone only asks for permission after a tap). api = the inbox address, post = (body) => Promise (Accounts.remind). */
  async function enable(post, who) {
    if (!canPush()) throw new Error(ios() ? 'Add Flow to your home screen first, then turn reminders on there.' : 'This browser cannot show reminders.');
    const name = String(who && who.name || '').trim();
    if (!name) throw new Error('Please type your name, as it is on your claims.');
    const perm = await Notification.requestPermission();                      // first, still inside the tap
    if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for Flow. Allow them in your phone settings, then try again.' : 'Reminders were not turned on.');
    const reg = await navigator.serviceWorker.ready;
    const k = await post({ op: 'key' });
    let sub = await reg.pushManager.getSubscription();
    if (sub) { const have = new Uint8Array(sub.options && sub.options.applicationServerKey || []); const want = b64ToBytes(k.key); if (have.length !== want.length || have.some((v, i) => v !== want[i])) { await sub.unsubscribe(); sub = null; } }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.key) });
    await post({ op: 'join', endpoint: sub.endpoint, name, email: String(who.email || '') });
    ls.set(ENDPOINT, sub.endpoint);
    return true;
  }
  async function disable(post) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
      if (sub) { try { await post({ op: 'leave', endpoint: sub.endpoint }); } catch (e) { /* the sender drops it when the phone stops answering */ } await sub.unsubscribe(); }
    } catch (e) { /* nothing to turn off */ }
    ls.set(ENDPOINT, '');
  }
  // keep the inbox's copy of the name right (after a claim is saved); silent
  async function touch(post, who) {
    if ((await state()) !== 'on' || !who || !String(who.name || '').trim()) return;
    try { const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg.pushManager.getSubscription(); if (sub) await post({ op: 'join', endpoint: sub.endpoint, name: String(who.name).trim(), email: String(who.email || '') }); } catch (e) { /* next time */ }
  }
  /* the words of a reminder, by Malaysia's date: the same as sw.js (tests/remind.test.js keeps the two equal) */
  function textFor(now) {
    const my = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
    const day = my.getDate(), last = MONTHS[(my.getMonth() + 11) % 12], dueOn = `${DUE_DAY} ${MONTHS[my.getMonth()]}`;
    if (day <= 7) return { title: `Time to claim your ${last} expenses`, body: `Flow is ready. It takes about 5 minutes, and your snapped receipts are waiting. Due ${dueOn}.`, tag: 'start' };
    if (day <= 12) return { title: `Friendly reminder: ${last} claim`, body: `Not sent yet? Open Flow and finish it today. Due ${dueOn}.`, tag: 'nudge' };
    if (day <= 14) return { title: `${last} claims close in ${15 - day} day${15 - day === 1 ? '' : 's'}`, body: 'A few minutes now saves the rush. Open Flow and send it.', tag: 'soon' };
    return { title: `Last day for ${last} claims`, body: 'Today is the deadline. Open Flow and send your claim.', tag: 'last' };
  }
  // a test on this phone only (no inbox): hear the sound and see the words
  async function test() {
    const reg = await navigator.serviceWorker.ready;
    const t = textFor(new Date());
    await reg.showNotification(t.title, { body: t.body, tag: 'flow-claim-test', icon: new URL('icons/icon-192.png', document.baseURI).href, silent: false });
  }

  const api = { due, textFor, isRemindDay, needsNudge, snoozeToday, markClaimed, isClaimed, state, enable, disable, touch, test, canPush, b64ToBytes, DAYS, MONTHS };
  root.Remind = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
