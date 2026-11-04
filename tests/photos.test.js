/* node tests/photos.test.js  (real readings of five petrol slips photographed on a keyboard, October 2026: dot-matrix print, one curved, one faint, one with a stain.
   The fixtures hold what the reader actually produced: whole-page readings and single-line re-reads, with the payment-card lines removed.) */
const P = require('../js/petrol.js'), fx = require('./fixtures/photos.json');
let fails = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? ' ' + JSON.stringify(got) : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)); };
const opts = { month: '2026-10', stations: ['Kejayaan Teguh Enterprise', 'Klinik Putra Care', 'Legasi Puncak', 'BE Petrol Station'] };
// the readings the app has after the second look: the page readings, then each single-line variant stitched into a page (each counted twice)
const readings = (f) => { const t = f.pages.slice(); ['h60', 'h60b', 'h90b'].forEach((v) => { const page = f.lines.map((l) => (l.reads && l.reads[v]) || l.t).join('\n'); t.push(page, page); }); return t; };
const must = {   // what the reader must get right (what it cannot yet: a 9 printed like a 0, a header lost to a fold, are listed after)
  o54: ['date', 'amount', 'station'],
  o55: ['amount'],
  o56: ['amount', 'station'],
  o57: ['date', 'amount'],
  o58: ['amount', 'station', 'receiptNo'],
};
Object.keys(must).forEach((n) => {
  const f = fx[n]; if (!f) return;
  const b = P.best(readings(f), opts);
  must[n].forEach((k) => eq(`${n} ${k}`, b[k], f.truth[k]));
});
// things that must never happen: a wrong guess given as a shop name, the transaction number given as the invoice number
const o57 = P.best(readings(fx.o57), opts); eq('curved slip: no made-up shop name', o57.station, '');
// the worked-out total beats a misread one, and only when the slip's own sums back it up
eq('44.34 read, litres 22.267 at 4.320 -> 44.31', P.snapTotal('44.34', P.fuelTotal({ lit: [22.267, 22.267, 22.267], pump: [4.32, 4.32], sub: [2.33], prevs: [], remains: [] })).amount, '44.31');
eq('a total that already adds up is left alone', P.snapTotal('', null), null);
eq('one litres line only is not enough to override a total', P.snapTotal('44.34', P.fuelTotal({ lit: [22.267], pump: [4.32], sub: [], prevs: [], remains: [] })), null);
// the order check: more litres left = bought earlier
const slips = [
  { id: 'a', date: '2026-10-24', bal: { prev: 216.103, remain: 193.836, litres: 22.267 } },
  { id: 'b', date: '2026-10-20', bal: { prev: 193.836, remain: 164.504, litres: 29.332 } },
  { id: 'c', date: '2026-10-11', bal: { prev: 274.915, remain: 246.955, litres: 27.96 } },
];
eq('a slip dated before the slip it follows is flagged', P.orderCheck(slips).map((w) => w.id).sort(), ['a', 'b']);
eq('slips in order give no warning', P.orderCheck([{ id: 'a', date: '2026-10-24', bal: slips[0].bal }, { id: 'b', date: '2026-10-29', bal: slips[1].bal }]), []);
eq('a slip with no litres balance is never flagged', P.orderCheck([{ id: 'a', date: '2026-10-24', bal: null }, { id: 'b', date: '2026-10-01', bal: slips[1].bal }]), []);
// the Petronas e-invoice page (the QR code on the slip opens it): a phone screenshot of it reads exactly, whatever the slip looked like
const shot = ['5¢cc50b                                     RM 55.64', '11 Oct 2026 at 01:39:04 PM', 'PS Taman Equine', 'KEJAYAAN TEGUH ENTERPRISE (001401458-V)', '200303035613', 'Lot 53391, Pn 7404, Putra Permai, Taman Equine, Seri Ke', 'ITEM                                                       AMOUNT', 'Primax 95                                     RM 130.57', '27.960L x RM 4.67/L', 'TOTAL                                        RM      55.64', 'IPT                                             RM      55.64'].join('\n');
const ei = P.parse(shot, opts);
eq('e-invoice page: date, amount, shop, invoice number', [ei.date, ei.amount, ei.station, ei.receiptNo], ['2026-10-11', '55.64', 'Kejayaan Teguh Enterprise', '5cc50b']);
eq('e-invoice page of a shop never seen: the legal name, without its registration number', P.parse(shot.replace('KEJAYAAN TEGUH ENTERPRISE (001401458-V)', 'ACME PETRO SDN BHD (123456-X)'), opts).station, 'Acme Petro Sdn Bhd');
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
