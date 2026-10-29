/* Email draft helpers. A web page can't attach files to Gmail by link, so we offer:
   - a Gmail compose link (To / Subject / Body filled, opens in the work account) + the zip to attach,
   - an .eml draft with the zip already attached (opens in Outlook / Apple Mail / Thunderbird),
   - the phone share sheet, which can hand the zip straight to the Gmail app. */
(function (root) {
  'use strict';

  function gmailLink({ from, to, subject, body }) {
    const q = new URLSearchParams({ view: 'cm', fs: '1', to, su: subject, body });
    if (from) q.set('authuser', from);
    return 'https://mail.google.com/mail/?' + q.toString().replace(/\+/g, '%20');
  }

  const b64 = (bytes) => {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  };

  const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');
  const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + btoa(unescape(encodeURIComponent(s))) + '?=');

  /* attachments: [{ name, blob }] */
  async function emlBlob({ from, fromName, to, subject, body, attachments }) {
    const boundary = '----=_WFC_' + Math.random().toString(36).slice(2);
    const bodyB64 = btoa(unescape(encodeURIComponent(body.replace(/\r?\n/g, '\r\n'))));
    const attParts = [];
    for (const a of attachments) {
      const bytes = new Uint8Array(await a.blob.arrayBuffer());
      const safeName = a.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
      attParts.push(
        `--${boundary}`,
        `Content-Type: ${a.blob.type || 'application/octet-stream'}; name="${safeName}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${safeName}"`,
        '',
        wrap76(b64(bytes)));
    }
    const parts = [
      `From: ${fromName ? encodeWord(fromName) + ' ' : ''}<${from}>`,
      `To: ${to}`,
      `Subject: ${encodeWord(subject)}`,
      'X-Unsent: 1',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(bodyB64),
      ...attParts,
      `--${boundary}--`,
      '',
    ];
    return new Blob([parts.join('\r\n')], { type: 'message/rfc822' });
  }

  root.Mail = { gmailLink, emlBlob };
})(window);
