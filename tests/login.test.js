/* node tests/login.test.js - the login page's two sign-ins and the Outlook draft with the zip attached,
   against stand-ins for Google, Microsoft and the Microsoft Graph mail service (no real account is touched). */
'use strict';
const assert = require('assert');

globalThis.location = { href: 'https://zzllchen.github.io/wfc-claim-builder/' };
const store = new Map();
globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

/* ---------- a stand-in for Microsoft's sign-in library ---------- */
function fakeMsal(opts = {}) {
  const log = { config: null, scopes: [] };
  class PublicClientApplication {
    constructor(config) { log.config = config; }
    async initialize() { log.initialized = true; }
    getAllAccounts() { return [{ username: 'Chow@Yutech.com.my', name: 'Chow', tenantId: 'tenant-1' }]; }
    async loginPopup(req) {
      log.scopes.push(['login', req.scopes.join(' '), req.prompt]);
      if (opts.closePopup) { const e = new Error('closed'); e.errorCode = 'user_cancelled'; throw e; }
      return { account: { username: opts.personal ? 'Kim@Outlook.com' : 'Chow@Yutech.com.my', name: 'Chow K L', tenantId: opts.personal ? '9188040d-6c67-4c5b-b112-36a304b66dad' : 'tenant-1' } };
    }
    async acquireTokenSilent(req) {
      log.scopes.push(['silent', req.scopes.join(' ')]);
      if (opts.silentWorks) return { accessToken: 'tok-silent', expiresOn: new Date(Date.now() + 3600e3) };
      const e = new Error('consent'); e.errorCode = 'consent_required'; throw e;
    }
    async acquireTokenPopup(req) {
      log.scopes.push(['popup', req.scopes.join(' '), req.loginHint]);
      if (opts.consentDenied) { const e = new Error('AADSTS65001: The user or administrator has not consented'); throw e; }
      return { accessToken: 'tok-popup', expiresOn: new Date(Date.now() + 3600e3) };
    }
    clearCache() { log.cleared = true; }
  }
  return { api: { PublicClientApplication }, log };
}

/* ---------- a stand-in for Microsoft Graph (mail) ---------- */
function fakeGraph(opts = {}) {
  const calls = [], uploaded = [];
  let counter = 0;
  const fn = async (url, init = {}) => {
    const headers = init.headers || {};
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ url, method: init.method, headers, body });
    const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
    if (url === 'https://graph.microsoft.com/v1.0/me/messages' && init.method === 'POST') {
      if (opts.forbidden) return json({ error: { message: 'Access is denied.' } }, 403);
      return json({ id: 'MSG1', webLink: 'https://outlook.office365.com/owa/?ItemID=MSG1&exvsurl=1&viewmodel=ReadMessageItem' }, 201);
    }
    if (/\/attachments$/.test(url)) return json({ id: 'A' + ++counter }, 201);
    if (/createUploadSession$/.test(url)) return json({ uploadUrl: 'https://upload.example/session/1' });
    if (url === 'https://upload.example/session/1') { uploaded.push({ range: headers['Content-Range'], size: init.body.length, auth: headers.Authorization, bytes: init.body }); return { ok: true, status: uploaded.length ? 200 : 200, json: async () => ({}) }; }
    return json({ error: { message: 'unexpected ' + url } }, 500);
  };
  return { fn, calls, uploaded };
}

(async () => {
  const Outlook = require('../js/outlook.js');
  const Auth = require('../js/auth.js');
  const Gmail = require('../js/gmail.js');

  // ---- addresses and the no-file compose link ----
  assert.deepStrictEqual(Outlook._addresses('agnes@yutech.com.my; b@x.com, c@y.com'), ['agnes@yutech.com.my', 'b@x.com', 'c@y.com']);
  assert.deepStrictEqual(Outlook._addresses(''), []);
  const work = Outlook.composeLink({ to: 'agnes@yutech.com.my', subject: 'Claim - October 2026', body: 'Hi Agnes,\nPlease find it.' });
  assert.ok(work.startsWith('https://outlook.office.com/mail/deeplink/compose?'), work);
  const u = new URL(work);
  assert.strictEqual(u.searchParams.get('to'), 'agnes@yutech.com.my');
  assert.strictEqual(u.searchParams.get('subject'), 'Claim - October 2026');
  assert.strictEqual(u.searchParams.get('body'), 'Hi Agnes,\nPlease find it.');
  assert.ok(Outlook.composeLink({ to: 'a@b.com', subject: 's', body: 'b', personal: true }).startsWith('https://outlook.live.com/mail/0/deeplink/compose?'));

  // ---- sign-in: only "who are you" is asked; the redirect page sits next to the app ----
  let ms = fakeMsal(); globalThis.msal = ms.api;
  await Outlook.preload('client-123');
  assert.ok(ms.log.initialized);
  assert.strictEqual(ms.log.config.auth.clientId, 'client-123');
  assert.strictEqual(ms.log.config.auth.authority, 'https://login.microsoftonline.com/common');
  assert.strictEqual(ms.log.config.auth.redirectUri, 'https://zzllchen.github.io/wfc-claim-builder/auth-redirect.html');
  const who = await Outlook.signIn('client-123');
  assert.deepStrictEqual(who, { provider: 'microsoft', email: 'chow@yutech.com.my', name: 'Chow K L', personal: false });
  assert.deepStrictEqual(ms.log.scopes[0], ['login', 'openid profile email', 'select_account']);       // no mail permission at login
  await assert.rejects(() => Outlook.signIn('some-other-id'), /still loading/);

  // ---- a draft with a small file and a big one (the zip): permission asked once, then the pieces go up ----
  let g = fakeGraph(); globalThis.fetch = g.fn;
  const small = new Blob([new Uint8Array(1000).fill(7)], { type: 'text/plain' });
  const bigBytes = new Uint8Array(Outlook.CHUNK * 2 + 12345); for (let i = 0; i < bigBytes.length; i++) bigBytes[i] = i % 251;
  const big = new Blob([bigBytes], { type: 'application/zip' });
  const statuses = [];
  const d = await Outlook.createDraft({
    clientId: 'client-123', email: 'chow@yutech.com.my', to: 'agnes@yutech.com.my', subject: 'Claim - October 2026', body: 'Hello\nAgnes',
    attachments: [{ name: 'note.txt', blob: small }, { name: 'Claim - October 2026 - Chow.zip', blob: big }], onStatus: (t) => statuses.push(t),
  });
  assert.deepStrictEqual(ms.log.scopes.slice(1).map((s) => s[0] + ':' + s[1]), ['popup:Mail.ReadWrite'], 'first time: straight to the popup, no wait before it');
  assert.strictEqual(ms.log.scopes[1][2], 'chow@yutech.com.my');           // the popup is pointed at the signed-in account
  assert.strictEqual(d.id, 'MSG1');
  assert.ok(d.url.includes('MSG1'));
  const make = g.calls[0];
  assert.strictEqual(make.headers.Authorization, 'Bearer tok-popup');
  assert.deepStrictEqual(make.body.toRecipients, [{ emailAddress: { address: 'agnes@yutech.com.my' } }]);
  assert.strictEqual(make.body.subject, 'Claim - October 2026');
  assert.deepStrictEqual(make.body.body, { contentType: 'Text', content: 'Hello\nAgnes' });
  const direct = g.calls[1];
  assert.ok(direct.url.endsWith('/me/messages/MSG1/attachments'));
  assert.strictEqual(direct.body['@odata.type'], '#microsoft.graph.fileAttachment');
  assert.strictEqual(Buffer.from(direct.body.contentBytes, 'base64').length, 1000);
  const session = g.calls[2];
  assert.ok(session.url.endsWith('/me/messages/MSG1/attachments/createUploadSession'));
  assert.deepStrictEqual(session.body.AttachmentItem, { attachmentType: 'file', name: 'Claim - October 2026 - Chow.zip', size: bigBytes.length, contentType: 'application/zip' });
  assert.strictEqual(g.uploaded.length, 3);
  assert.strictEqual(g.uploaded[0].range, `bytes 0-${Outlook.CHUNK - 1}/${bigBytes.length}`);
  assert.strictEqual(g.uploaded[2].range, `bytes ${Outlook.CHUNK * 2}-${bigBytes.length - 1}/${bigBytes.length}`);
  assert.ok(g.uploaded.every((x) => x.auth === undefined), 'the upload address carries its own permission: no Authorization header');
  assert.ok(Buffer.concat(g.uploaded.map((x) => Buffer.from(x.bytes))).equals(Buffer.from(bigBytes)), 'every byte of the zip arrives, in order');
  assert.ok(statuses.some((t) => /Attaching Claim - October 2026 - Chow\.zip/.test(t)));

  // ---- the second draft in the same tab needs no new permission ----
  g = fakeGraph(); globalThis.fetch = g.fn;
  const before = ms.log.scopes.length;
  await Outlook.createDraft({ clientId: 'client-123', email: 'chow@yutech.com.my', to: 'a@b.com', subject: 's', body: 'b', attachments: [] });
  assert.strictEqual(ms.log.scopes.length, before, 'token is reused');

  // ---- already agreed to earlier in this tab, token gone (an hour later): quiet renewal, no popup ----
  Outlook.forget(); assert.ok(ms.log.cleared); assert.ok(!store.has('wfc-ms-mail'), 'signing out forgets that Microsoft agreed');
  store.set('wfc-ms-mail', '1');
  ms = fakeMsal({ silentWorks: true }); globalThis.msal = ms.api;
  // (a fresh library object is only used once preload runs again for a different id)
  await Outlook.preload('client-456');
  g = fakeGraph(); globalThis.fetch = g.fn;
  await Outlook.createDraft({ clientId: 'client-456', email: 'chow@yutech.com.my', to: 'a@b.com', subject: 's', body: 'b', attachments: [] });
  assert.deepStrictEqual(ms.log.scopes.map((s) => s[0]), ['silent']);
  assert.strictEqual(g.calls[0].headers.Authorization, 'Bearer tok-silent');

  // ---- failures are said in plain words ----
  Outlook.forget();
  g = fakeGraph({ forbidden: true }); globalThis.fetch = g.fn;
  await assert.rejects(() => Outlook.createDraft({ clientId: 'client-456', email: 'chow@yutech.com.my', to: 'a@b.com', subject: 's', body: 'b', attachments: [] }), /would not let this account make a draft.*Download \.eml draft/);
  Outlook.forget();
  ms = fakeMsal({ consentDenied: true }); globalThis.msal = ms.api; await Outlook.preload('client-789');
  await assert.rejects(() => Outlook.createDraft({ clientId: 'client-789', email: 'x@y.com', to: 'a@b.com', subject: 's', body: 'b', attachments: [] }), /company has to approve/);
  ms = fakeMsal({ closePopup: true }); globalThis.msal = ms.api; await Outlook.preload('client-000');
  await assert.rejects(() => Outlook.signIn('client-000'), /closed before it finished/);
  ms = fakeMsal({ personal: true }); globalThis.msal = ms.api; await Outlook.preload('client-111');
  assert.strictEqual((await Outlook.signIn('client-111')).personal, true);

  // ---- Google: login asks for name and email only ----
  const seen = {};
  globalThis.google = { accounts: { oauth2: { initTokenClient: (cfg) => { seen.cfg = cfg; return { requestAccessToken: () => setTimeout(() => cfg.callback(seen.reply), 0) }; } } } };
  seen.reply = { access_token: 'g-tok', expires_in: 3600 };
  globalThis.fetch = async (url, init) => { seen.userinfoUrl = url; seen.auth = init.headers.Authorization; return { ok: true, status: 200, json: async () => ({ email: 'Edward.WFCSystems@Gmail.com', name: 'Edward' }) }; };
  const gu = await Gmail.identify('google-client');
  assert.deepStrictEqual(gu, { provider: 'google', email: 'edward.wfcsystems@gmail.com', name: 'Edward' });
  assert.strictEqual(seen.cfg.scope, 'openid email profile');            // no Gmail permission at login
  assert.strictEqual(seen.cfg.prompt, 'select_account');
  assert.strictEqual(seen.userinfoUrl, 'https://www.googleapis.com/oauth2/v3/userinfo');
  assert.strictEqual(seen.auth, 'Bearer g-tok');
  seen.reply = { error: 'access_denied' };
  await assert.rejects(() => Gmail.identify('google-client'), /would not let this account in/);
  globalThis.google = undefined;
  await assert.rejects(() => Gmail.identify('google-client'), /still loading/);

  // ---- the memory of who signed in (this tab only) ----
  assert.strictEqual(Auth.get(), null);
  Auth.set(gu); assert.deepStrictEqual(Auth.get(), { provider: 'google', email: 'edward.wfcsystems@gmail.com', name: 'Edward', personal: false });
  Auth.set({ provider: 'none' }); assert.deepStrictEqual(Auth.get(), { provider: 'none', email: '', name: '' });
  store.set('wfc-login', '{"provider":"google"}'); assert.strictEqual(Auth.get(), null, 'a login without an email is not a login');
  store.set('wfc-login', 'not json'); assert.strictEqual(Auth.get(), null);
  Auth.set(who); Auth.signOut(); assert.strictEqual(Auth.get(), null);

  console.log('login.test.js: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
