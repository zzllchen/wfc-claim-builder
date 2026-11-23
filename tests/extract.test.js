/* node tests/extract.test.js - the general receipt reader (js/extract.js) on invented receipts of every kind, in the layouts real ones use */
'use strict';
const assert = require('assert');
const X = require('../js/extract.js');
const ok = (name, fn) => { fn(); console.log('ok  ' + name); };
const ctx = { month: '2026-11', today: new Date('2026-11-23T10:00:00Z') };
const pick = (r, keys) => Object.fromEntries(keys.map((k) => [k, r[k]]));

ok('a restaurant bill: seller with its legal form, receipt number, SST, the total after tax, card and last 4', () => {
  const r = X.read(`RESTORAN SRI MELAKA SDN BHD
No. 12, Jalan SS15/4, 47500 Subang Jaya
SST No: W10-1808-32000123
Receipt No: R-004512
Date: 21/11/2026 13:42
Nasi Lemak Ayam 2 x 12.50 25.00
Teh Tarik 2 x 3.80 7.60
Subtotal 32.60
SST 6% 1.96
Total RM 34.56
VISA **** **** **** 4321
Thank you`, ctx);
  assert.deepStrictEqual(pick(r, ['vendor', 'number', 'date', 'subtotal', 'tax', 'taxType', 'total', 'currency', 'paymentMethod', 'last4', 'category']),
    { vendor: 'RESTORAN SRI MELAKA SDN BHD', number: 'R-004512', date: '2026-11-21', subtotal: 32.6, tax: 1.96, taxType: 'SST', total: 34.56, currency: 'MYR', paymentMethod: 'Visa', last4: '4321', category: 'Meals' });
  assert.ok(r.confidence.total >= 0.9, 'subtotal and tax add up'); assert.strictEqual(r.unsure, false);
});

ok('a Grab ride receipt (e-mail style): Transport, the trip fare total, booking ID, Grab', () => {
  const r = X.read(`Your Grab E-Receipt
Booking ID: A-7XK2PQ9ZW
Picked up on 20 Nov 2026
GrabCar
Pick-up location: Seri Kembangan
Drop-off location: KLCC
Fare RM 23.00
Platform fee RM 1.00
Total Paid RM 24.00
Paid by Visa ending 1234`, ctx);
  assert.deepStrictEqual(pick(r, ['vendor', 'category', 'total', 'date', 'number', 'paymentMethod', 'last4']),
    { vendor: 'Grab', category: 'Transport', total: 24, date: '2026-11-20', number: 'A-7XK2PQ9ZW', paymentMethod: 'Visa', last4: '1234' });
});

ok('a flight e-ticket: Travel, booking reference, travel date kept apart from the booking date', () => {
  const r = X.read(`AirAsia Berhad
Booking Confirmation / E-Ticket
Booking number: K9XQ2P
Booking date: 15 Nov 2026
Depart: 02 Dec 2026 07:10 KUL - PEN
Passenger: ALEX TAN
Flight AK6102
Total amount MYR 189.00`, ctx);
  assert.deepStrictEqual(pick(r, ['category', 'number', 'numberKind', 'date', 'periodStart', 'total', 'docType']),
    { category: 'Travel', number: 'K9XQ2P', numberKind: 'booking', date: '2026-11-15', periodStart: '2026-12-02', total: 189, docType: 'ticket' });
});

ok('a Shopee order: Online shopping, order ID, total payment', () => {
  const r = X.read(`Shopee
Order ID: 2611208XYZ123
Order Date 18-11-2026
Seller: TechHub Official Store
Product: USB-C Hub 7-in-1 1 x 89.90
Merchandise Subtotal RM89.90
Shipping Fee RM4.90
Shipping Discount -RM4.90
Order Total RM89.90
Payment method: ShopeePay`, ctx);
  assert.deepStrictEqual(pick(r, ['vendor', 'category', 'number', 'numberKind', 'date', 'total', 'paymentMethod']),
    { vendor: 'Shopee', category: 'Online shopping', number: '2611208XYZ123', numberKind: 'order', date: '2026-11-18', total: 89.9, paymentMethod: 'ShopeePay' });
});

ok('a hotel folio: Accommodation, check-in and check-out as the stay, the issue date apart', () => {
  const r = X.read(`PEKAN AUTO CITY BUDGET HOTEL
Folio No: 257947
Date: 22/11/2026
Check-in: 20/11/2026
Check-out: 22/11/2026
Room charges 2 nights 170.00
Tourism tax 20.00
Total RM 190.00
Paid: Cash`, ctx);
  assert.deepStrictEqual(pick(r, ['category', 'date', 'periodStart', 'periodEnd', 'total', 'paymentMethod']),
    { category: 'Accommodation', date: '2026-11-22', periodStart: '2026-11-20', periodEnd: '2026-11-22', total: 190, paymentMethod: 'Cash' });
});

ok('a supplier invoice to the company: Supplier invoice, due date, never the customer as the seller', () => {
  const r = X.read(`GOLDEN RACKING SUPPLY SDN BHD
TAX INVOICE
Invoice No: GRS-2026-0412
Invoice Date: 10/11/2026
Bill To:
WFC SYSTEMS SDN BHD
Terms: 30 Days
Due Date: 10/12/2026
PO No: PO-7781
Steel beam 2400mm 10 x 85.00 850.00
Sub Total 850.00
SST 8% 68.00
Total Amount 918.00`, ctx);
  assert.deepStrictEqual(pick(r, ['vendor', 'docType', 'category', 'number', 'numberKind', 'date', 'dueDate', 'subtotal', 'tax', 'total']),
    { vendor: 'GOLDEN RACKING SUPPLY SDN BHD', docType: 'tax invoice', category: 'Supplier invoice', number: 'GRS-2026-0412', numberKind: 'invoice', date: '2026-11-10', dueDate: '2026-12-10', subtotal: 850, tax: 68, total: 918 });
});

ok('Bahasa Malaysia: Resit, Tarikh, Jumlah, Tunai', () => {
  const r = X.read(`KEDAI MAKAN AH SENG
No. Resit: 88231
Tarikh: 19/11/2026
Mee goreng 8.00
Air sirap 2.50
Jumlah RM 10.50
Tunai RM 20.00
Baki RM 9.50`, ctx);
  assert.deepStrictEqual(pick(r, ['vendor', 'number', 'date', 'total', 'paymentMethod', 'category']),
    { vendor: 'KEDAI MAKAN AH SENG', number: '88231', date: '2026-11-19', total: 10.5, paymentMethod: 'Cash', category: 'Meals' });
});

ok('Chinese: 日期, 单号, 合计, full-width digits; flagged for a second look (OCR on Chinese)', () => {
  const r = X.read(`海南鸡饭店
单号：１０２３４
日期：2026年11月20日
鸡饭 2 份 18.00
咖啡 2 杯 5.60
合计 RM 23.60
现金`, ctx);
  assert.deepStrictEqual(pick(r, ['number', 'date', 'total', 'category', 'paymentMethod']), { number: '10234', date: '2026-11-20', total: 23.6, category: 'Meals', paymentMethod: 'Cash' });
  assert.strictEqual(r.unsure, true, 'Chinese text: Claude takes a second look');
});

ok('03/04/2026 is read day first; when only month first fits the claim month it is taken; when both could be right, it needs review', () => {
  const amb = X.read('ABC TRADING\nReceipt No: 1001\nDate: 11/10/2026\nTotal RM 50.00', { month: '2026-10', today: new Date('2026-11-23') });
  assert.strictEqual(amb.date, '2026-10-11', 'day first is in the claim month: kept');
  const swap = X.read('ABC TRADING\nReceipt No: 1001\nDate: 10/11/2026\nTotal RM 50.00', { month: '2026-10', today: new Date('2026-11-23') });
  assert.strictEqual(swap.date, '2026-10-11', 'only the month-first reading is in October');
  const both = X.read('ABC TRADING\nReceipt No: 1001\nDate: 03/04/2026\nTotal RM 50.00', { month: '2026-11', today: new Date('2026-11-23') });
  assert.strictEqual(both.date, '2026-04-03'); assert.ok(both.ambiguousDate && both.needsReview.includes('date'));
});

ok('the total is never the cash given, the change, a subtotal, a discount or a deposit', () => {
  const r = X.read('CAFE 21\nReceipt No: 5512\nDate: 20/11/2026\nSubtotal 40.00\nDiscount 5.00\nTotal 35.00\nCash 50.00\nChange 15.00', ctx);
  assert.strictEqual(r.total, 35);
  const h = X.read('HOTEL SEMBILAN\nInvoice No: H-22\nDate: 20/11/2026\nDeposit 100.00\nSub Total 180.00\nTotal 180.00', ctx);
  assert.strictEqual(h.total, 180);
});

ok('a USD software invoice: currency USD, labelled total; a foreign amount is left for converting', () => {
  const r = X.read('Notion Labs, Inc.\nInvoice number: NL-88123\nDate of issue: November 12, 2026\nPlus plan (per month)\nSubtotal $10.00\nTotal $10.00\nAmount due $10.00 USD', ctx);
  assert.deepStrictEqual(pick(r, ['vendor', 'category', 'number', 'date', 'total', 'currency']), { vendor: 'Notion Labs, Inc.', category: 'AI tools', number: 'NL-88123', date: '2026-11-12', total: 10, currency: 'USD' });
});

ok('little text, or no total label: unsure, so Claude takes a look', () => {
  const r = X.read('THANK YOU\n12.00\n15.50', ctx);
  assert.strictEqual(r.unsure, true); assert.ok(r.needsReview.includes('total') && r.needsReview.includes('date'));
});

ok('only the last 4 card digits are ever kept', () => {
  assert.strictEqual(X.paymentOf(['Card No: 4111 XXXX XXXX 9876']).last4, '9876');
  assert.strictEqual(X.paymentOf(['Visa - 5106 November 22, 2026']).last4, '5106');
  assert.strictEqual(X.paymentOf(['Mastercard']).last4, '');
});

ok('who reads it: fuel slips, clinic, parking and hotel papers keep their tuned readers; the rest is read in general', () => {
  assert.strictEqual(X.forGeneral({ category: 'Meals' }, null, 'RON95 20.5 litres'), false, 'fuel words');
  assert.strictEqual(X.forGeneral({ category: 'Medical' }, null, 'Klinik Sehat'), false, 'a clinic');
  assert.strictEqual(X.forGeneral({ category: 'Meals' }, { category: 'Parking' }, 'MBSJ'), false, 'the fuel-slip reader saw parking');
  assert.strictEqual(X.forGeneral({ category: 'Meals' }, null, 'Pumpkin soup 12.00'), true, 'pumpkin is not a pump');
  assert.strictEqual(X.forGeneral({ category: '' }, { amount: '5.00' }, 'Thank you'), true, 'unknown: read in general, Claude decides when unsure');
});

ok('a number printed twice but read two ways (a scan): the other spelling is found, so the number needs a second look', () => {
  const text = 'Gmail - Fwd: PARKING PASS Receipt 48151623421088002\nSubject: PARKING PASS Receipt 4815162342108800q\nReceipt No 4815162342108800q';
  assert.deepStrictEqual(X.twinsOf('48151623421088002', text), ['4815162342108800q']);
  assert.deepStrictEqual(X.twinsOf('4815162342108800q', 'Receipt 4815162342108800q and again 4815162342108800q'), []);
  assert.deepStrictEqual(X.twinsOf('60770c', 'Invoice No 60770c, site 123456'), [], 'a different number of the same length is not a twin');
});

console.log('extract tests passed');
