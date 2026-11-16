/* Who is using the page: the login page's memory. Kept in the browser tab only (sessionStorage), so closing the tab signs out,
   and a refresh does not ask again. This is for convenience (the right "From" and the right draft button), not security: the claim
   is built on the person's own PC either way. provider: 'google' | 'microsoft' | 'none' (continued without signing in). */
(function (root) {
  'use strict';
  const KEY = 'wfc-login';

  function get() {
    try {
      const u = JSON.parse(root.sessionStorage.getItem(KEY));
      if (u && u.provider === 'none') return { provider: 'none', email: '', name: '' };
      if (u && u.provider === 'microsoft' && !u.email) return { provider: 'microsoft', email: '', name: '', personal: false };      // Outlook without a Microsoft sign-in: the email file is used
      if (u && (u.provider === 'google' || u.provider === 'microsoft') && /@/.test(u.email || '')) return { provider: u.provider, email: u.email, name: u.name || '', personal: !!u.personal };
    } catch (e) { /* nothing kept */ }
    return null;
  }
  function set(u) { try { root.sessionStorage.setItem(KEY, JSON.stringify(u)); } catch (e) { /* private mode: the page still works until it is refreshed */ } }
  function clear() { try { root.sessionStorage.removeItem(KEY); } catch (e) { /* nothing kept */ } }

  function signOut() {
    clear();
    if (root.Gmail && root.Gmail.forget) root.Gmail.forget();
    if (root.Outlook && root.Outlook.forget) root.Outlook.forget();
  }

  const api = { get, set, clear, signOut };
  root.Auth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
