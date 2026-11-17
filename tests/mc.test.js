/* node tests/mc.test.js - reading a medical certificate (MC). The text below is a real reading of a sideways phone photo, with the
   patient's name and IC number replaced (this repo is public: never put real personal details in a fixture). */
'use strict';
const assert = require('assert');
const Petrol = require('../js/petrol.js');
const Validate = require('../js/validate.js');

const TURNED_UPRIGHT = ` KLINIK PUTRA CARE

C-10-G/C-11-G PUTRA WALK,
JALAN PP25T
43300 SERI KEMB,               AMAN PINGGIR
HP: 017 653 2202                    ANGOR. TEL           RAS  SEK

MEDICAL CERTIFICATE                       MC11733

| H
ere certify that | have examined A B C

I.C No 000000000000        and find that
He / She will be
ei for the proper performance of his / her duti
rom 19/0ct/2026 To  19/0ct/2026 he

He /
She is to be re-examined on
DR. ALEEYSA SHARMIRE
He / She
IS able to resume duties from
adi                                                                                                                MEDICAL OFFICER
HEADACHE                                                                es fo  €
SP! (CARE

19-Oct-2026
* Not Valid in Co
urt
`;

// the same page read sideways: the engine only sees noise, and must NOT pass for an MC
const SIDEWAYS_NOISE = 'TN\nSn\n¥    So\nbel  &         f\n-~   ak   — ne            (7)\n= °   [Y) @®  oO T      o\ni   g  : Po,  Sz ©      i)      =\n';

const ok = (name, fn) => { fn(); console.log('ok  ' + name); };

ok('the upright reading is an MC with number, date, type and diagnosis (label lost, complaint alone on its line)', () => {
  assert.ok(Petrol.isMcText(TURNED_UPRIGHT));
  const m = Petrol.mc(TURNED_UPRIGHT);
  assert.deepStrictEqual(m, { mcNo: 'MC11733', from: '2026-10-19', to: '2026-10-19', diagnosis: 'Headache' });
});

ok('the "Diagnosis:" label is still used when it is read', () => {
  const m = Petrol.mc('MEDICAL CERTIFICATE MC20418\nFrom 03/11/2026 To 04/11/2026\nDiagnosis: ACUTE GASTRITIS\n');
  assert.strictEqual(m.diagnosis, 'Acute Gastritis'); assert.strictEqual(m.from, '2026-11-03'); assert.strictEqual(m.to, '2026-11-04');
});

ok('sideways noise is not an MC, so the reader keeps turning the photo', () => {
  assert.strictEqual(Petrol.isMcText(SIDEWAYS_NOISE), false);
  assert.strictEqual(Petrol.mc(SIDEWAYS_NOISE), null);
});

ok('a misread title still counts (one wrong letter), and so does wording only an MC has', () => {
  assert.ok(Petrol.isMcText('MEDICAL CERT1FICATE'));
  assert.ok(Petrol.isMcText('MEDICAI CERTIFICATE'));
  assert.ok(Petrol.isMcText('xx I hereby certify that I have examined JOHN\nHe / She will be unfit for the proper performance of his duties'));
  assert.ok(Petrol.isMcText('* Not Valid in Court'));
});

ok('a clinic RECEIPT is not mistaken for an MC', () => {
  assert.strictEqual(Petrol.isMcText('KLINIK PUTRA CARE\nOFFICIAL RECEIPT\nConsultation RM 75.00\nTOTAL RM 75.00'), false);
});

ok('on the expense claim an MC is refused, but not a receipt that mentions certificates', () => {
  const r = Validate.judge(TURNED_UPRIGHT + '\nSome more printed words to be long enough', 'photo');
  assert.strictEqual(r.status, 'reject'); assert.strictEqual(r.mc, true);
  const rec = Validate.judge('KLINIK PUTRA CARE OFFICIAL RECEIPT medical certificate fee RM 5.00 TOTAL RM 80.00 thank you', 'photo');
  assert.strictEqual(rec.status, 'ok');
});


// ---- only the days the MC covers count, not the day it was given ----
// two MCs given on 19 Oct (the date at the bottom left): one for 19 Oct, one for 20 Oct. Name and IC number removed (this repo is public).
const MC_FOR_THE_20TH = `KLINIK PUTRA CARE
MEDICAL CERTIFICATE                MC11733
I Here certify that I have examined       A B C
I.C No 000000000000      and find that
He / She will be unfit for the proper performance of his / her duties for    1    day(s)
      (From  20/Oct/2026   To   20/Oct/2026   )
He / She is to be re-examined on
He / She is able to resume duties from
Diagnosis:    HEADACHE
19-Oct-2026
* Not Valid in Court
`;
const MC_FOR_THE_19TH = MC_FOR_THE_20TH.replace(/20\/Oct\/2026/g, '19/Oct/2026');

ok('the day the MC was given (19-Oct) does not stretch an MC for the 20th', () => {
  const m = Petrol.mc(MC_FOR_THE_20TH);
  assert.strictEqual(m.from, '2026-10-20'); assert.strictEqual(m.to, '2026-10-20');
  assert.strictEqual(m.mcNo, 'MC11733'); assert.strictEqual(m.diagnosis, 'Headache');
});

ok('an MC for the 19th, given on the 19th, is one day', () => {
  const m = Petrol.mc(MC_FOR_THE_19TH);
  assert.strictEqual(m.from, '2026-10-19'); assert.strictEqual(m.to, '2026-10-19');
});

ok('a real range stays a range, and an issue date after the leave does not matter', () => {
  const m = Petrol.mc('MEDICAL CERTIFICATE MC20418\nunfit for the proper performance of his duties for 3 day(s)\n(From 03/11/2026 To 05/11/2026)\n06-Nov-2026\nDiagnosis: FEVER\n');
  assert.strictEqual(m.from, '2026-11-03'); assert.strictEqual(m.to, '2026-11-05');
});

ok('the To part on the next line, and a lost F in "From", are still read', () => {
  const wrapped = Petrol.mc('MEDICAL CERTIFICATE\nunfit for the proper performance of his duties for 2 day(s) (From 12/Nov/2026\nTo 13/Nov/2026 )\n11-Nov-2026\n');
  assert.strictEqual(wrapped.from, '2026-11-12'); assert.strictEqual(wrapped.to, '2026-11-13');
  const lostF = Petrol.mc('MEDICAL CERTIFICATE\nrom 19/0ct/2026 To  19/0ct/2026\n18-Oct-2026\n');
  assert.strictEqual(lostF.from, '2026-10-19'); assert.strictEqual(lostF.to, '2026-10-19');
});

ok('"resume duties from <date>" and "re-examined on <date>" are not the leave days', () => {
  const m = Petrol.mc('MEDICAL CERTIFICATE\nHe / She will be unfit for the proper performance of his / her duties for 2 day(s) (From 03/11/2026 To 04/11/2026)\nHe / She is to be re-examined on 10/11/2026\nHe / She is able to resume duties from 05/11/2026\n02-Nov-2026\n');
  assert.strictEqual(m.from, '2026-11-03'); assert.strictEqual(m.to, '2026-11-04');
});

ok('with the From / To labels lost, the dates of the "unfit for" sentence are used, not the issue date', () => {
  const m = Petrol.mc('MEDICAL CERTIFICATE\nHe / She will be unfit for the proper performance of his / her duties for 1 day(s)\n( 20/Oct/2026   20/Oct/2026 )\nHe / She is to be re-examined on\n19-Oct-2026\n');
  assert.strictEqual(m.from, '2026-10-20'); assert.strictEqual(m.to, '2026-10-20');
});

ok('nothing to anchor on: the earliest and latest date on the page, as before', () => {
  const m = Petrol.mc('MEDICAL CERTIFICATE\n19-Oct-2026\n21-Oct-2026\n');
  assert.strictEqual(m.from, '2026-10-19'); assert.strictEqual(m.to, '2026-10-21');
});

// the form: two one-day MCs (19 and 20) make a leave from the 19th to the 20th, two working days
ok('two one-day MCs together cover 19 to 20 Oct, and each shows only its own day', () => {
  const a = Petrol.mc(MC_FOR_THE_20TH), b = Petrol.mc(MC_FOR_THE_19TH);
  const froms = [a.from, b.from].sort(), tos = [a.to, b.to].sort();
  assert.strictEqual(froms[0], '2026-10-19'); assert.strictEqual(tos[tos.length - 1], '2026-10-20');
  assert.strictEqual(a.from === a.to && b.from === b.to, true, 'each certificate is a single day');
});

console.log('mc tests passed');
