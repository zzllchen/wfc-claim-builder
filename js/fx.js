/* Receipts in another currency (USD, SGD ...) are claimed in ringgit. This looks up the day's rate (European Central Bank
   reference rates through frankfurter.dev) and converts. Only the currency code and the date are sent - never a file or an
   amount. If the lookup fails the caller leaves the amount blank for the person to type from their card statement. */
(function (root) {
  'use strict';
  const cache = new Map();

  const urls = (code, date) => [
    `https://api.frankfurter.dev/v1/${date || 'latest'}?base=${code}&symbols=MYR`,
    `https://api.frankfurter.app/${date || 'latest'}?from=${code}&to=MYR`,
  ];

  async function fetchRate(code, date) {
    for (const url of urls(code, date)) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 6000);
        const res = await fetch(url, { signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const j = await res.json();
        const rate = j && j.rates && j.rates.MYR;
        if (rate > 0) return { rate, date: j.date || date || '' };
      } catch (e) { /* offline or blocked: try the next address */ }
    }
    return null;
  }

  /* rate for 1 unit of `code` in MYR on `date` (YYYY-MM-DD; the nearest earlier working day is used) -> { rate, date } | null */
  function rate(code, date) {
    const key = code + '|' + (date || 'latest');
    if (!cache.has(key)) {
      cache.set(key, (async () => (await fetchRate(code, date)) || (date ? await fetchRate(code) : null))()
        .then((r) => { if (!r) cache.delete(key); return r; }));
    }
    return cache.get(key);
  }

  /* -> { myr, rate, date, code, amount } | null */
  async function toMyr(code, amount, date) {
    if (!code || !(amount > 0)) return null;
    const r = await rate(code, /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : '');
    return r ? { myr: Math.round(amount * r.rate * 100) / 100, rate: r.rate, date: r.date, code, amount } : null;
  }

  const note = (c) => `Converted from ${c.code} ${c.amount.toFixed(2)} at 1 ${c.code} = ${c.rate.toFixed(4)} MYR (${c.date}) – check it against your card statement`;

  root.Fx = { rate, toMyr, note };
})(window);
