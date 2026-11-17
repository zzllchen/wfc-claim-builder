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

// ---- other clinics, other wordings (all invented text: no real names or numbers) ----
const mcRange = (text) => { const m = Petrol.mc(text); return m && m.from + ' to ' + m.to; };
const CASES = [
  ['a sentence with from ... to ... and an issue date at the top',
    'MEDICAL CERTIFICATE\nDate: 18/10/2026\nThis is to certify that Mr A B C is unfit for duty for 2 days from 19/10/2026 to 20/10/2026.\n', '2026-10-19 to 2026-10-20'],
  ['From: and To: on separate lines',
    'MEDICAL CERTIFICATE\nDate of issue: 18-10-2026\nFrom:   19-10-2026\nTo:     20-10-2026\n', '2026-10-19 to 2026-10-20'],
  ['dots between the numbers (19.10.2026)',
    'MEDICAL CERTIFICATE\nunfit for duty from 19.10.2026 to 21.10.2026\nIssued 18.10.2026\n', '2026-10-19 to 2026-10-21'],
  ['month names written out (19 October 2026)',
    'MEDICAL CERTIFICATE\n18 October 2026\nhe is unfit for work from 19 October 2026 to 20 October 2026\n', '2026-10-19 to 2026-10-20'],
  ['a two-digit year after the month name (19-Oct-26)',
    'MEDICAL CERTIFICATE\n18-Oct-26\nFrom 19-Oct-26 To 20-Oct-26\n', '2026-10-19 to 2026-10-20'],
  ['only the start and the number of days (w.e.f. ... for 3 days): the end is worked out',
    'MEDICAL CERTIFICATE\nDate: 18/10/2026\nMC for 3 days w.e.f. 19/10/2026\n', '2026-10-19 to 2026-10-21'],
  ['commencing, one day',
    'MEDICAL CERTIFICATE\n18/10/2026\nunfit for duty for 1 day(s) commencing 19/10/2026\n', '2026-10-19 to 2026-10-19'],
  ['"2 (two) days" and a start date only',
    'MEDICAL CERTIFICATE\nunfit for duty for 2 (two) days effective from 19/10/2026\nDate: 18/10/2026\n', '2026-10-19 to 2026-10-20'],
  ['Period: 19/10/2026 - 20/10/2026 with no From / To words',
    'MEDICAL CERTIFICATE\nDate: 18/10/2026\nPeriod : 19/10/2026 - 20/10/2026\n', '2026-10-19 to 2026-10-20'],
  ['"until" instead of "to", on the next line',
    'MEDICAL CERTIFICATE\nThe patient is unfit for duty from 19/10/2026\nuntil 20/10/2026\nDate 18/10/2026\n', '2026-10-19 to 2026-10-20'],
  ['Malay: Sijil Cuti Sakit, dari ... hingga ...',
    'SIJIL CUTI SAKIT\nTarikh: 18/10/2026\nPesakit diberi cuti sakit selama 2 hari dari 19/10/2026 hingga 20/10/2026\n', '2026-10-19 to 2026-10-20'],
  ['Malay month names (5 Mei, 6 Mei)',
    'SURAT CUTI SAKIT\ndari 5 Mei 2026 hingga 6 Mei 2026\n4 Mei 2026\n', '2026-05-05 to 2026-05-06'],
  ['a bilingual title',
    'SIJIL CUTI SAKIT / MEDICAL CERTIFICATE\nDari / From : 19/10/2026   Hingga / To : 19/10/2026\nTarikh / Date : 18/10/2026\n', '2026-10-19 to 2026-10-19'],
  ['"Frorn" for "From" (a letter pair misread)',
    'MEDICAL CERTIFICATE\nunfit for 2 day(s) Frorn 19/0ct/2026 T0 20/0ct/2026\n18-Oct-2026\n', '2026-10-19 to 2026-10-20'],
  ['a leave over a month end',
    'MEDICAL CERTIFICATE\nFrom 30/10/2026 To 02/11/2026\n29/10/2026\n', '2026-10-30 to 2026-11-02'],
  ['re-examination and resume dates after the leave are not part of it',
    'MEDICAL CERTIFICATE\nFrom 19/10/2026 To 20/10/2026\nTo be re-examined on 27/10/2026\nAble to resume duties from 21/10/2026\n18/10/2026\n', '2026-10-19 to 2026-10-20'],
];
CASES.forEach(([name, text, want]) => ok(name, () => assert.strictEqual(mcRange(text), want)));

ok('a Malay MC counts as an MC (so the expense claim refuses it and the leave tab takes it)', () => {
  assert.ok(Petrol.isMcText('SIJIL CUTI SAKIT'));
  assert.ok(Petrol.isMcText('Surat Cuti Sakit'));
  const r = Validate.judge('SIJIL CUTI SAKIT\nKlinik Sri Maju\nPesakit diberi cuti sakit selama 2 hari dari 19/10/2026 hingga 20/10/2026\nTarikh 18/10/2026 dan teks lain yang cukup panjang', 'photo');
  assert.strictEqual(r.status, 'reject'); assert.strictEqual(r.mc, true);
});

ok('a receipt with dates and "days" in it is not turned into an MC period', () => {
  assert.strictEqual(Petrol.mc('KLINIK SRI MAJU OFFICIAL RECEIPT 18/10/2026 consultation 2 days medication RM 40.00'), null);
});

// found with invented photos read by the real reader: blank lines between the lines, "MC No: 55120", "Number of days: 2"
ok('blank lines between the From and To lines, as the photo reader gives them', () => {
  const t = 'POLIKLINIK CONTOH\nMEDICAL CERTIFICATE\nMC No: 55120\n\nDate of issue: 18-10-2026\n\nPatient: AB C\n\nDiagnosis: ACUTE GASTRITIS\nFrom: 19-10-2026\n\nTo: 20-10-2026\n\nNumber of days: 2\n';
  const m = Petrol.mc(t);
  assert.strictEqual(m.from, '2026-10-19'); assert.strictEqual(m.to, '2026-10-20'); assert.strictEqual(m.mcNo, 'MC55120');
});
ok('a start date only, with "Number of days: 3" after it', () => {
  assert.strictEqual(mcRange('MEDICAL CERTIFICATE\nDate: 18/10/2026\nFrom: 19/10/2026\n\nNumber of days: 3\n'), '2026-10-19 to 2026-10-21');
});
ok('MC numbers: MC11733, MC 20418, MC No: 55120, MC-7788', () => {
  ['MC11733', 'MC 20418', 'MC No: 55120', 'MC-7788'].forEach((n) => assert.strictEqual(Petrol.mc('MEDICAL CERTIFICATE\n' + n + '\nFrom 19/10/2026 To 19/10/2026').mcNo, 'MC' + n.replace(/\D/g, '')));
});

console.log('mc tests passed');
