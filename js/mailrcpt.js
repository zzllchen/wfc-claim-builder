/* Find e-receipts in the person's own Gmail and add them to the claim like dropped files.
   - One tap on "Find in Gmail"; Google asks once to let Flow VIEW email (read-only) and the page looks ONLY at emails from the claim month that look like
     receipts or invoices (a receipt-word subject, a known shop / tool / airline sender, or a PDF named receipt / invoice). Nothing else is opened.
   - The list shows who, what and when; receipts with a PDF or photo attached are ticked for the person, the rest are left unticked.
   - Ticked ones are fetched: their PDF / photo attachments as they are (an Anthropic or Runway email brings its invoice AND receipt PDFs, which
     the claim pairs on one line), and an email with no attachment is printed to a one-page PDF ("Email receipt") so the accountant has proof.
   - Everything happens in the browser. The access token lives in memory only (about an hour). Nothing is stored, and nothing is sent anywhere
     except what the claim already does with a receipt (the optional Claude backup may read a file it cannot read itself).
   Pure parts (query, message reading, ranking, html to text) are tested in node: tests/mailrcpt.test.js. */
(function (root) {
  'use strict';
  const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const MAX_LIST = 60, MAX_SHOW = 40;

  // words that make an email look like a receipt (English, Malay, Chinese) and the senders we know send them
  const SUBJECT_WORDS = ['receipt', 'e-receipt', 'invoice', 'tax invoice', 'order confirmation', 'order confirmed', 'booking confirmation', 'booking', 'itinerary', 'e-ticket', 'payment', 'paid', 'trip', 'statement', 'resit', 'inbois', 'bayaran', '收据', '发票', '收據', '發票'];
  const STRONG = /receipt|invoice|e-ticket|itinerary|tax invoice|booking confirmation|order confirm|resit|inbois|收据|发票|收據|發票/i;
  const KNOWN = ['grab.com', 'grabtaxi', 'shopee', 'lazada', 'foodpanda', 'airasia', 'malaysiaairlines', 'firefly', 'batikair', 'agoda', 'booking.com', 'stripe.com', 'anthropic.com', 'openai.com', 'runwayml.com', 'elevenlabs.io', 'metricool', 'google.com', 'microsoft.com', 'adobe.com', 'canva.com', 'zoom.us', 'github.com', 'godaddy', 'namecheap', 'exabytes', 'hostinger', 'digitalocean', 'amazon', 'apple.com', 'paypal', 'tngdigital', 'touchngo'];
  const FILE_WORDS = /receipt|invoice|resit|inbois|tax|ticket|itinerary|voucher|folio|bill/i;
  const LOGO_WORDS = /logo|banner|icon|spacer|pixel|facebook|twitter|instagram|linkedin|youtube|tiktok|badge|footer|header/i;

  /* ---------- the Gmail search for one claim month: [first day, first day of the next month) in local time ---------- */
  function buildQuery(monthKey) {
    const m = /^(\d{4})-(\d{2})$/.exec(monthKey || '');
    if (!m) throw new Error('No claim month.');
    const y = +m[1], mo = +m[2];
    const from = Math.floor(new Date(y, mo - 1, 1).getTime() / 1000), to = Math.floor(new Date(y, mo, 1).getTime() / 1000);
    const subj = SUBJECT_WORDS.map((w) => (/[\s-]/.test(w) ? `"${w}"` : w)).join(' OR ');
    const from_ = KNOWN.join(' OR ');
    return `after:${from} before:${to} -in:spam -in:trash -in:chats (subject:(${subj}) OR from:(${from_}) OR filename:(receipt OR invoice OR resit OR inbois))`;
  }

  /* ---------- reading one message (Gmail API format=full) ---------- */
  const b64urlToBytes = (s) => {
    const p = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = (typeof atob === 'function' ? atob : (x) => Buffer.from(x, 'base64').toString('binary'))(p + '='.repeat((4 - (p.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const utf8 = (bytes) => new TextDecoder('utf-8').decode(bytes);
  function header(msg, name) {
    const hs = (msg.payload && msg.payload.headers) || [];
    const h = hs.find((x) => String(x.name).toLowerCase() === name.toLowerCase());
    return h ? String(h.value || '') : '';
  }
  // "Grab Malaysia <no-reply@grab.com>" -> { name: 'Grab Malaysia', email: 'no-reply@grab.com', domain: 'grab.com' }
  function sender(from) {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from || '');
    const email = (m ? m[2] : String(from || '').trim()).toLowerCase();
    const name = (m && m[1].trim()) || email.split('@')[0];
    return { name, email, domain: (email.split('@')[1] || '') };
  }
  function walk(part, out) {
    if (!part) return;
    const mime = String(part.mimeType || '').toLowerCase(), body = part.body || {}, fn = part.filename || '';
    const hdr = (n) => { const h = (part.headers || []).find((x) => String(x.name).toLowerCase() === n); return h ? String(h.value || '') : ''; };
    if (part.parts && part.parts.length) part.parts.forEach((p) => walk(p, out));
    else if (fn && body.attachmentId) out.attachments.push({ id: body.attachmentId, filename: fn, mime, size: body.size || 0, inline: /^inline/i.test(hdr('content-disposition')) || !!hdr('content-id') });
    else if (mime === 'text/html' && body.data) out.html += utf8(b64urlToBytes(body.data)) + '\n';
    else if (mime === 'text/plain' && body.data) out.text += utf8(b64urlToBytes(body.data)) + '\n';
  }
  function parseMessage(msg) {
    const out = { html: '', text: '', attachments: [] };
    walk(msg.payload, out);
    const s = sender(header(msg, 'From'));
    return {
      id: msg.id, threadId: msg.threadId, from: s, subject: header(msg, 'Subject').replace(/\s+/g, ' ').trim(), date: Number(msg.internalDate) || Date.parse(header(msg, 'Date')) || 0,
      snippet: String(msg.snippet || ''), attachments: out.attachments, html: out.html, text: out.text, unsubscribe: !!header(msg, 'List-Unsubscribe'),
    };
  }

  /* ---------- which attachments are the receipt? ---------- */
  const isPdf = (a) => a.mime === 'application/pdf' || /\.pdf$/i.test(a.filename);
  const isPhoto = (a) => /^image\/(jpeg|png|webp)$/.test(a.mime) || /\.(jpe?g|png|webp)$/i.test(a.filename);
  function pickFiles(m) {
    const pdfs = m.attachments.filter(isPdf);
    if (pdfs.length) {
      const named = pdfs.filter((a) => FILE_WORDS.test(a.filename));
      // an invoice and its receipt travel together (the claim joins them on one line); otherwise the receipt-looking ones, else the first
      return (named.length ? named : pdfs.slice(0, 1)).slice(0, 3);
    }
    return m.attachments.filter((a) => isPhoto(a) && !a.inline && a.size >= 15000 && !LOGO_WORDS.test(a.filename)).slice(0, 3);
  }

  /* ---------- how receipt-like is it? ---------- */
  function rank(m) {
    const subj = m.subject, dom = m.from.domain, files = pickFiles(m);
    let score = 0;
    const why = [];
    if (STRONG.test(subj)) { score += 3; why.push('receipt in the subject'); }
    else if (SUBJECT_WORDS.some((w) => subj.toLowerCase().indexOf(w.toLowerCase()) >= 0)) score += 1;
    if (KNOWN.some((k) => dom.indexOf(k) >= 0)) { score += 2; why.push('a shop or tool you may claim from'); }
    if (files.length) { score += 3; why.push('has a ' + (isPdf(files[0]) ? 'PDF' : 'photo')); }
    if (m.attachments.some((a) => isPdf(a) && FILE_WORDS.test(a.filename))) score += 1;
    if (m.unsubscribe && !STRONG.test(subj) && !files.length) score -= 2;                       // a newsletter that mentions "order" or "payment"
    if (/\b(order|payment)\b.*\b(shipped|on its way|delivered|reminder|failed|declined|due soon|expired)\b|\b(rate|review|survey|win|voucher|promo|sale|discount)\b/i.test(subj) && !STRONG.test(subj)) score -= 2;
    const kind = files.length ? (isPdf(files[0]) ? 'pdf' : 'photo') : 'email';
    return { score, kind, why, files, tick: score >= 4 && (kind !== 'email' || STRONG.test(subj)) };
  }
  // the list shown to the person: receipt-like first? no - by date (the order they were paid in), unlikely ones dropped
  function candidates(messages) {
    const list = messages.map((raw) => { const m = raw.attachments ? raw : parseMessage(raw); return Object.assign({}, m, { rank: rank(m) }); })
      .filter((m) => m.rank.score >= 2)
      .sort((a, b) => a.date - b.date);
    return list.slice(0, MAX_SHOW);
  }

  /* ---------- an email with no attachment, as text for a one-page PDF ---------- */
  const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', copy: '(c)', reg: '(R)', trade: '(TM)', middot: '·', bull: '·' };
  const INVISIBLE = new RegExp('[' + [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0xfeff, 0xad].map((c) => String.fromCharCode(c)).join('') + ']', 'g');
  function htmlToText(html) {
    let s = String(html || '');
    s = s.replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table|\/section)\b[^>]*>/gi, '\n').replace(/<\/t[dh]>/gi, '   ').replace(/<[^>]+>/g, ' ');
    s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
      return Object.prototype.hasOwnProperty.call(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : ' ';
    });
    return s.replace(INVISIBLE, '').replace(/[ \t\xa0]+/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n');
  }
  const bodyText = (m) => (m.html ? htmlToText(m.html) : String(m.text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean).join('\n'));
  // file name for the printed copy: "2026-10-12 Grab - Your Grab E-Receipt.pdf"
  const iso = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function printedName(m) {
    const vendor = m.from.name.replace(/\b(no-?reply|noreply|support|team|e-?receipts?|notifications?)\b/gi, '').replace(/\s+/g, ' ').trim() || m.from.domain;
    return `${iso(m.date)} ${vendor} - ${m.subject}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) + '.pdf';
  }
  // Latin text only (the PDF maker has no Chinese font): returns null when most of the email is in another script
  function printable(text) {
    const odd = (text.match(/[^\u0009\u000a -ÿ‐-•…€]/g) || []).length;
    if (odd > Math.max(12, text.length * 0.12)) return null;
    return text.replace(/[‐-―]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/•/g, '*').replace(/…/g, '...').replace(/€/g, 'EUR ').replace(/[^\u0009\u000a -ÿ]/g, '?');
  }

  /* ---------- Google (browser only) ---------- */
  const g = { token: '', until: 0, email: '' };
  const connected = () => !!g.token && Date.now() < g.until;
  /* Call straight from a click (the Google window must open inside it). */
  function connect(clientId, email) {
    return new Promise((resolve, reject) => {
      if (connected() && g.email === (email || '')) { resolve(true); return; }
      const gis = root.google && root.google.accounts && root.google.accounts.oauth2;
      if (!gis) { reject(new Error('Google sign-in is still loading - try again in a moment.')); return; }
      gis.initTokenClient({
        client_id: clientId, scope: SCOPE, hint: email || undefined, include_granted_scopes: true,
        callback: (r) => {
          if (r.error) { reject(new Error(r.error === 'access_denied' ? 'Gmail was not allowed, so nothing was looked at.' : r.error === 'invalid_scope' ? 'Google has not been set up to let Flow view email yet. Please ask the admin.' : r.error_description || r.error)); return; }
          if (r.scope && r.scope.indexOf('gmail.readonly') < 0) { reject(new Error('Gmail was not allowed, so nothing was looked at.')); return; }
          g.token = r.access_token; g.email = email || ''; g.until = Date.now() + Math.max(60, (Number(r.expires_in) || 3600) - 60) * 1000;
          resolve(true);
        },
        error_callback: (e) => reject(new Error(e && e.type === 'popup_closed' ? 'The Google window was closed before it finished.' : 'Google could not be reached.')),
      }).requestAccessToken();
    });
  }
  async function call(path) {
    const res = await fetch(GMAIL + path, { headers: { Authorization: 'Bearer ' + g.token } });
    if (res.status === 401) { g.token = ''; throw new Error('Gmail needs you to connect again.'); }
    if (!res.ok) {
      let m = '';
      try { m = (await res.json()).error.message; } catch (e) { /* none */ }
      throw new Error(res.status === 403 ? 'Gmail did not allow this (' + (m || 'permission') + '). The admin may need to switch it on for your account.' : m || `Gmail said no (HTTP ${res.status}).`);
    }
    return res.json();
  }
  /* the emails of a claim month that look like receipts -> candidates (see candidates()) */
  async function search(monthKey, onProgress) {
    const q = encodeURIComponent(buildQuery(monthKey));
    const found = (await call(`/messages?q=${q}&maxResults=${MAX_LIST}`)).messages || [];
    const full = [];
    for (let i = 0; i < found.length; i += 5) {
      const batch = await Promise.all(found.slice(i, i + 5).map((x) => call(`/messages/${x.id}?format=full`).catch(() => null)));
      batch.forEach((m) => { if (m) full.push(m); });
      if (onProgress) onProgress({ done: Math.min(found.length, i + 5), total: found.length });
    }
    return { found: found.length, list: candidates(full) };
  }
  // the files of one chosen email: its PDFs / photos, or a printed copy of the email
  async function filesOf(m, makePdf) {
    const picks = m.rank.files;
    const out = [];
    for (const a of picks) {
      const j = await call(`/messages/${m.id}/attachments/${a.id}`);
      const name = a.filename.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'receipt.pdf';
      out.push(new File([b64urlToBytes(j.data)], name, { type: a.mime || (isPdf(a) ? 'application/pdf' : 'image/jpeg') }));
    }
    if (out.length) return out;
    const text = printable(bodyText(m));
    if (!text || text.length < 20) throw new Error('This email has nothing Flow can print as a receipt.');
    return [await makePdf(m, text)];
  }

  const __setToken = (t) => { g.token = t; g.until = Date.now() + 3600e3; };        // for the tests only

  const api = { __setToken, buildQuery, parseMessage, rank, pickFiles, candidates, htmlToText, bodyText, printable, printedName, sender, b64urlToBytes, connect, connected, search, filesOf, SCOPE, SUBJECT_WORDS, KNOWN };
  root.MailReceipts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
