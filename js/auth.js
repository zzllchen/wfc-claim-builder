/* Who is using the page: the login page's memory. For convenience (the right "From" and the right draft button), not security: the claim is built
   on the person's own PC either way, and only the name and email are kept, never a token or a password.
   Two places: this browser tab (sessionStorage: a refresh does not ask again, closing the tab signs out) and, when the person ticks "Keep me signed in",
   this device (localStorage, 30 days from the last visit, so the next visit goes straight in).
   provider: 'google' | 'microsoft' | 'none' (continued without signing in). */
(function (root) {
  'use strict';
  const KEY = 'wfc-login', KEEP = 'wfc-login-keep', PREF = 'wfc-login-keep-pref';
  const DAYS = 30;

  const store = (kind) => { try { return root[kind] || null; } catch (e) { return null; } };      // private browsing can refuse storage: the page still works
  const read = (kind, key) => { try { const s = store(kind); return s ? JSON.parse(s.getItem(key)) : null; } catch (e) { return null; } };
  const write = (kind, key, v) => { try { const s = store(kind); if (s) s.setItem(key, JSON.stringify(v)); } catch (e) { /* nothing kept */ } };
  const drop = (kind, key) => { try { const s = store(kind); if (s) s.removeItem(key); } catch (e) { /* nothing kept */ } };

  // a stored login is only a login when it has the right shape
  function clean(u) {
    if (u && u.provider === 'none') return { provider: 'none', email: '', name: '' };
    if (u && u.provider === 'microsoft' && !u.email) return { provider: 'microsoft', email: '', name: '', personal: false };      // Outlook without a Microsoft sign-in: the email file is used
    if (u && (u.provider === 'google' || u.provider === 'microsoft') && /@/.test(u.email || '')) return { provider: u.provider, email: u.email, name: u.name || '', personal: !!u.personal };
    return null;
  }

  function get() {
    const tab = clean(read('sessionStorage', KEY));
    if (tab) return tab;
    const kept = read('localStorage', KEEP);
    if (kept && typeof kept.at === 'number' && Date.now() - kept.at < DAYS * 864e5) {
      const u = clean(kept.user);
      if (u) { write('localStorage', KEEP, { user: u, at: Date.now() }); write('sessionStorage', KEY, u); return u; }       // each visit renews the 30 days
    }
    if (kept) drop('localStorage', KEEP);                                                    // expired or unreadable
    return null;
  }
  // keep = true also remembers it on this device; false forgets any earlier memory of it
  function set(u, keep) {
    write('sessionStorage', KEY, u);
    if (keep && clean(u)) write('localStorage', KEEP, { user: u, at: Date.now() }); else drop('localStorage', KEEP);
  }
  function clear() { drop('sessionStorage', KEY); drop('localStorage', KEEP); }

  // the tick box on the login page: on the first visit it is ticked, afterwards it stays as the person left it
  function keepPref() { const v = read('localStorage', PREF); return v === null || v === undefined ? true : !!v; }
  function setKeepPref(on) { write('localStorage', PREF, !!on); }

  function signOut() {
    clear();
    if (root.Gmail && root.Gmail.forget) root.Gmail.forget();
    if (root.Outlook && root.Outlook.forget) root.Outlook.forget();
  }

  const api = { get, set, clear, signOut, keepPref, setKeepPref };
  root.Auth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
