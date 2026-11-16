/* Microsoft sign-in and a one-click Outlook draft with the zip attached - the Outlook twin of gmail.js.
   The person signs in with Microsoft once (a popup). When they press "Create Outlook draft" the page asks Microsoft for permission
   to make a draft, then puts the To, Subject, message and the zip into a new draft in their own Outlook Drafts folder. Nothing is sent.
   Works for work / school accounts (Microsoft 365) and personal ones (outlook.com, hotmail, live).
   Needs a Microsoft "application (client) ID" (a public value, not a secret) - see "Outlook draft" in the README.
   Microsoft has no smaller permission than Mail.ReadWrite ("read and write your mail") for making a draft; the page only ever creates one. */
(function (root) {
  'use strict';
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const AUTHORITY = 'https://login.microsoftonline.com/common';       // work, school and personal accounts
  const LOGIN_SCOPES = ['openid', 'profile', 'email'];                   // the login page asks only who you are
  const MAIL_SCOPES = ['Mail.ReadWrite'];                                // asked when a draft is made
  const PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';        // Microsoft's fixed id for personal accounts
  const DIRECT_MAX = 2500000;                                            // a file up to this size goes in one request; bigger ones in pieces
  const CHUNK = 12 * 320 * 1024;                                         // Microsoft wants pieces in multiples of 320 KB, at most 4 MB

  let app = null, appFor = '', booting = null, token = null, tokenUntil = 0;

  const loadingError = () => new Error('Microsoft sign-in is still loading - try again in a moment.');

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = resolve;
      s.onerror = () => reject(new Error("Couldn't load Microsoft sign-in. Check the internet connection and try again."));
      document.head.append(s);
    });
  }

  /* Load the Microsoft sign-in library and get it ready ahead of the click: the popup has to open inside the click itself. */
  function preload(clientId, libSrc) {
    if (app && appFor === clientId) return Promise.resolve();
    if (booting && appFor === clientId) return booting;
    appFor = clientId;
    booting = (async () => {
      if (!(root.msal && root.msal.PublicClientApplication)) await loadScript(libSrc || 'vendor/msal-browser.min.js');
      const pca = new root.msal.PublicClientApplication({
        auth: { clientId, authority: AUTHORITY, redirectUri: new URL('auth-redirect.html', root.location.href).href, navigateToLoginRequestUrl: false },
        cache: { cacheLocation: 'sessionStorage' },
      });
      await pca.initialize();
      app = pca;
    })().catch((e) => { booting = null; appFor = ''; throw e; });
    return booting;
  }

  const niceError = (e) => {
    const code = (e && (e.errorCode || e.code)) || '';
    if (code === 'user_cancelled') return 'The Microsoft sign-in was closed before it finished.';
    if (code === 'popup_window_error' || code === 'empty_window_error') return 'The browser blocked the Microsoft sign-in popup. Allow popups for this page and try again.';
    if (/AADSTS65001|AADSTS90094|AADSTS650057|consent_required/i.test(String((e && e.message) || '') + code)) return 'Your company has to approve this app in Microsoft first. Ask whoever looks after your Microsoft 365, or use "Download .eml draft".';
    if (/AADSTS700016|AADSTS50011/.test(String((e && e.message) || ''))) return 'Microsoft sign-in is not set up correctly yet (the app address does not match). Please tell the person who set it up.';
    return String((e && (e.errorMessage || e.message)) || e || 'Microsoft sign-in failed.').replace(/\s*Trace ID[\s\S]*$/, '');
  };

  /* The login page: who is this? Asks only for name and email. Call it straight from the click handler, before any await.
     Resolves { provider: 'microsoft', email, name, personal }. */
  async function signIn(clientId) {
    if (!app || appFor !== clientId) throw loadingError();
    try {
      const r = await app.loginPopup({ scopes: LOGIN_SCOPES, prompt: 'select_account' });
      const a = r.account || {};
      const claims = r.idTokenClaims || a.idTokenClaims || {};
      const email = String(a.username || claims.preferred_username || claims.email || '').toLowerCase();
      if (!email) throw new Error('Microsoft signed you in but did not share your email address. Please try again.');
      return { provider: 'microsoft', email, name: a.name || claims.name || '', personal: (a.tenantId || claims.tid) === PERSONAL_TENANT };
    } catch (e) { throw new Error(niceError(e)); }
  }

  /* "has this person already allowed drafts in this tab?" - then no popup is needed. Until then the popup is opened at once, straight from
     the click (a browser blocks a popup that opens after a wait), so nothing is awaited before it. */
  const FLAG = 'wfc-ms-mail';
  const agreed = () => { try { return root.sessionStorage.getItem(FLAG) === '1'; } catch (e) { return false; } };
  const markAgreed = () => { try { root.sessionStorage.setItem(FLAG, '1'); } catch (e) { /* asked again next time */ } };

  /* an access token that may make drafts */
  async function mailToken(clientId, email) {
    if (token && Date.now() < tokenUntil) return token;
    if (!app || appFor !== clientId) await preload(clientId);          // normally ready already, so no wait here
    const want = String(email || '').toLowerCase();
    const accounts = app.getAllAccounts();
    const account = accounts.find((x) => String(x.username || '').toLowerCase() === want) || accounts[0];
    let r = null;
    if (agreed()) { try { r = await app.acquireTokenSilent({ scopes: MAIL_SCOPES, account }); } catch (e) { r = null; } }
    if (!r) {
      try { r = await app.acquireTokenPopup({ scopes: MAIL_SCOPES, account, loginHint: want || undefined }); }
      catch (e) { throw new Error(niceError(e)); }
    }
    markAgreed();
    token = r.accessToken;
    tokenUntil = (r.expiresOn ? +new Date(r.expiresOn) : Date.now() + 3300000) - 60000;
    return token;
  }

  async function graph(method, path, tok, json) {
    const res = await fetch(GRAPH + path, {
      method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json),
    });
    if (!res.ok) {
      if (res.status === 401) token = null;                               // expired: ask again next time
      let msg = '';
      try { msg = (await res.json()).error.message; } catch (e) { /* no detail */ }
      throw new Error(res.status === 403 ? 'Microsoft would not let this account make a draft' + (msg ? ' (' + msg + ')' : '') + '. Use "Download .eml draft" instead.'
        : msg || `Microsoft said no (HTTP ${res.status}).`);
    }
    return res.status === 204 ? null : res.json();
  }

  function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /* One file onto the draft: small ones in one request, big ones (the zip is often several MB) in pieces. */
  async function attach(messageId, att, tok) {
    const bytes = new Uint8Array(await att.blob.arrayBuffer());
    const type = att.blob.type || 'application/octet-stream';
    if (bytes.length <= DIRECT_MAX) {
      await graph('POST', `/me/messages/${messageId}/attachments`, tok, { '@odata.type': '#microsoft.graph.fileAttachment', name: att.name, contentType: type, contentBytes: base64(bytes) });
      return;
    }
    const session = await graph('POST', `/me/messages/${messageId}/attachments/createUploadSession`, tok,
      { AttachmentItem: { attachmentType: 'file', name: att.name, size: bytes.length, contentType: type } });
    for (let start = 0; start < bytes.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, bytes.length);
      const res = await fetch(session.uploadUrl, {                          // the address already carries the permission: no Authorization header here
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` }, body: bytes.slice(start, end),
      });
      if (!res.ok) throw new Error(`Microsoft stopped the upload of ${att.name} (HTTP ${res.status}).`);
    }
  }

  const addresses = (to) => String(to || '').split(/[,;\s]+/).filter((x) => x.includes('@'));

  /* attachments: [{ name, blob }]. Returns { id, url } for the new draft; url opens it in Outlook on the web. */
  async function createDraft({ clientId, email, to, subject, body, attachments, onStatus }) {
    const say = onStatus || (() => {});
    const tok = await mailToken(clientId, email);
    say('Making the draft in Outlook…');
    const msg = await graph('POST', '/me/messages', tok, {
      subject, body: { contentType: 'Text', content: body }, toRecipients: addresses(to).map((a) => ({ emailAddress: { address: a } })),
    });
    for (const a of attachments || []) { say(`Attaching ${a.name}…`); await attach(msg.id, a, tok); }
    return { id: msg.id, url: msg.webLink || 'https://outlook.office.com/mail/drafts' };
  }

  /* an Outlook "new message" page with To / Subject / message filled in (no file) */
  function composeLink({ to, subject, body, personal }) {
    const q = new URLSearchParams({ to: addresses(to).join(';'), subject, body });
    return (personal ? 'https://outlook.live.com/mail/0/deeplink/compose?' : 'https://outlook.office.com/mail/deeplink/compose?') + q.toString().replace(/\+/g, '%20');
  }

  function forget() {
    token = null; tokenUntil = 0;
    try { root.sessionStorage.removeItem(FLAG); } catch (e) { /* nothing kept */ }
    try { if (app && app.clearCache) app.clearCache(); } catch (e) { /* nothing kept */ }
  }

  const api = { preload, signIn, createDraft, composeLink, forget, _addresses: addresses, CHUNK, DIRECT_MAX };
  root.Outlook = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
