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

console.log('mc tests passed');
