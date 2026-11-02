/* One-click Gmail draft with the zip attached. The person signs in to Google once (a popup), then the page hands Gmail a
   ready-made draft (To, Subject, message and the zip) through the Gmail API. The draft lands in their own Drafts folder; nothing
   is sent, and the zip goes to their Gmail only when they press the button.
   Needs a Google "client ID" (a public value, not a secret) - see "Gmail draft with the zip attached" in the README. */
(function (root) {
  'use strict';
  const SCOPE = 'https://www.googleapis.com/auth/gmail.compose';       // make drafts and send; it cannot read the mailbox
  const GIS = 'https://accounts.google.com/gsi/client';
  const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
  let loading = null, token = null, tokenUntil = 0;

  /* Load Google's sign-in script ahead of the click: the sign-in popup has to open inside the click itself or the browser blocks it. */
  function preload() {
    if (root.google && root.google.accounts) return Promise.resolve();
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = GIS; s.async = true; s.onload = resolve;
        s.onerror = () => { loading = null; reject(new Error("Couldn't reach Google sign-in. Check the internet connection (or a blocker) and try again.")); };
        document.head.append(s);
      });
    }
    return loading;
  }

  /* Call this straight from the click handler, before any await. */
  function signIn(clientId, hint) {
    return new Promise((resolve, reject) => {
      if (token && Date.now() < tokenUntil) { resolve(token); return; }
      if (!(root.google && root.google.accounts && root.google.accounts.oauth2)) { reject(new Error('Google sign-in is still loading - try again in a moment.')); return; }
      const client = root.google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: SCOPE, hint: hint || undefined,
        callback: (r) => {
          if (r.error) { reject(new Error(r.error_description || r.error)); return; }
          token = r.access_token;
          tokenUntil = Date.now() + Math.max(60, (Number(r.expires_in) || 3600) - 60) * 1000;
          resolve(token);
        },
        error_callback: (e) => reject(new Error(e && e.type === 'popup_closed' ? 'The Google sign-in was closed before it finished.'
          : e && e.type === 'popup_failed_to_open' ? 'The browser blocked the Google sign-in popup. Allow popups for this page and try again.' : 'Google sign-in failed.')),
      });
      client.requestAccessToken();
    });
  }

  async function call(url, init, tok) {
    const res = await fetch(url, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + tok }, init && init.headers) }));
    if (!res.ok) {
      if (res.status === 401) token = null;                                  // expired: sign in again next time
      let msg = '';
      try { msg = (await res.json()).error.message; } catch (e) { /* no detail */ }
      throw new Error(msg || `Gmail said no (HTTP ${res.status}).`);
    }
    return res.json();
  }

  /* makeBlob() -> a message/rfc822 Blob (Mail.emlBlob). Returns { id, messageId, email, url } for the new draft. */
  async function createDraft({ clientId, hint, makeBlob }) {
    const tok = await signIn(clientId, hint);                                // first, still inside the click
    const eml = await makeBlob();
    const draft = await call('https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media',
      { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: eml }, tok);
    let email = '';
    try { email = (await call(API + '/profile', {}, tok)).emailAddress || ''; } catch (e) { /* the link then uses the first signed-in account */ }
    const messageId = draft.message && draft.message.id;
    // Gmail refuses /mail/u/<address>/ ("Temporary Error 404"); ?authuser=<address> picks the right signed-in account
    return { id: draft.id, messageId, email, url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(email || '0')}#drafts?compose=${messageId}` };
  }

  root.Gmail = { preload, createDraft };
})(window);
