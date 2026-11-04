/* node tests/planb.test.js  (when plan B should be asked, and how Claude's answer is read and merged; no network) */
const P = require('../js/planb.js');
let fails = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? ' ' + JSON.stringify(got).slice(0, 100) : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)); };
const today = new Date('2026-11-04T04:00:00Z');
const d = (r, cat) => P.doubts(r, { category: cat || 'Petrol', today });

// a normal fuel receipt raises no doubt, so Claude is not asked
eq('normal fuel receipt: no doubts', d({ amount: '60.00', date: '2026-10-19', sure: true }), []);
eq('normal fuel receipt, unsure flag null', d({ amount: '84.35', date: '2026-10-28', sure: null }), []);
// the RM7 fuel receipt from the brief
eq('RM7 fuel receipt: doubtful', d({ amount: '7.00', date: '2026-10-19' }).length, 1);
eq('RM7 on a parking receipt is fine', d({ amount: '7.00', date: '2026-10-19' }, 'Parking'), []);
eq('RM900 fuel: doubtful', /too big/.test(d({ amount: '900.00', date: '2026-10-19' })[0]), true);
eq('no amount: doubtful', d({ amount: '', date: '2026-10-19' }), ['no amount found']);
eq('foreign amount is not "no amount"', d({ amount: '', foreign: { code: 'USD', amount: 11 }, date: '2026-10-19' }), []);
eq('amount that does not add up: doubtful', d({ amount: '60.00', date: '2026-10-19', sure: false }).length, 1);
eq('no date: doubtful', d({ amount: '60.00', date: '' }), ['no date found']);
eq('future date: doubtful', /looks wrong/.test(d({ amount: '60.00', date: '2026-12-25' })[0]), true);
eq('date 5 months ago: doubtful', /looks wrong/.test(d({ amount: '60.00', date: '2026-05-01' })[0]), true);
eq('date a month ago: fine', d({ amount: '60.00', date: '2026-10-01' }), []);
eq('missing shop name or receipt number alone is NOT a doubt', d({ amount: '60.00', date: '2026-10-19', station: '', receiptNo: '' }), []);
eq('several doubts at once', d({ amount: '5.00', date: '' }).length, 2);

// Claude's answer
let c = P.parseReply('Here you go: {"isReceipt": true, "kind": "Petrol", "merchant": "Kejayaan Teguh Enterprise", "date": "2026-10-19", "amount": 70.5, "currency": "MYR", "receiptNo": "257947", "confidence": "high", "notes": ""} done');
eq('reply parsed', [c.isReceipt, c.kind, c.merchant, c.date, c.amount, c.receiptNo, c.confidence], [true, 'Petrol', 'Kejayaan Teguh Enterprise', '2026-10-19', '70.50', '257947', 'high']);
c = P.parseReply('{"isReceipt": true, "kind": "Other", "date": "2026-02-31", "amount": "1,234.50", "currency": "RM"}');
eq('impossible date dropped, comma amount and RM accepted', [c.date, c.amount], ['', '1234.50']);
c = P.parseReply('{"isReceipt": true, "date": "2026-10-19", "amount": 11, "currency": "USD"}');
eq('USD amount is kept as foreign, never as ringgit', [c.amount, c.foreign], ['', { code: 'USD', amount: 11 }]);
c = P.parseReply('{"isReceipt": false, "notes": "a medical certificate"}');
eq('not a receipt', [c.isReceipt, c.amount, c.notes], [false, '', 'a medical certificate']);
eq('garbage reply is rejected', P.parseReply('sorry, I cannot'), null);
eq('negative or zero amount ignored', P.parseReply('{"amount": -5}').amount, '');

// merging with the normal reading
const ocr = { amount: '7.00', date: '2026-10-19', station: '', receiptNo: '', category: '', sure: null, found: true };
let m = P.merge(ocr, P.parseReply('{"isReceipt":true,"kind":"Petrol","merchant":"BE Petrol Station","date":"2026-10-19","amount":70,"receiptNo":"88123"}'), ['RM7.00 looks too small for petrol']);
eq('Claude corrects 7.00 to 70.00 and fills the shop and number', [m.r.amount, m.r.station, m.r.receiptNo], ['70.00', 'BE Petrol Station', '88123']);
eq('the note says what changed', m.note, 'Amount was RM7.00, now RM70.00.');
m = P.merge(ocr, P.parseReply('{"isReceipt":true,"date":"2026-10-19","amount":7}'), ['RM7.00 looks too small']);
eq('Claude agrees: amount kept, note says so', [m.r.amount, m.note], ['7.00', 'Claude agrees with RM7.00.']);
m = P.merge({ amount: '60.00', date: '', station: 'X', found: true }, P.parseReply('{"isReceipt":true,"date":"2026-10-20","amount":60}'), ['no date found']);
eq('missing date filled from Claude', m.r.date, '2026-10-20');
m = P.merge({ amount: '60.00', date: '2026-10-19', station: 'Real Name' }, P.parseReply('{"isReceipt":true,"date":"2026-10-21","merchant":"Other Name","amount":60}'), []);
eq('a date and name the normal reader already has are kept when nothing was doubted', [m.r.date, m.r.station], ['2026-10-19', 'Real Name']);
m = P.merge({ amount: '', date: '', station: '', receiptNo: '' }, P.parseReply('{"isReceipt":true,"kind":"Medical","merchant":"Klinik Putra Care","date":"2026-10-10","amount":75}'), ['no amount found']);
eq('unreadable photo read by Claude: category follows the kind', [m.r.amount, m.r.category, m.r.station], ['75.00', 'Medical', 'Klinik Putra Care']);

// the safety limits
eq('no key saved: plan B is not available', P.available(), false);
eq('errors are explained in plain words', [P.explain({ status: 401 }).slice(0, 22), P.explain({ status: 429, message: 'Your credit balance is too low' }).slice(0, 27)], ['Anthropic rejected the', 'The API account has no cred']);
eq('cost of a 1,500-token photo on Sonnet 5.5 is about 3 sen', +P.costRM('claude-sonnet-5-5', { input_tokens: 1500, output_tokens: 300 }).toFixed(3), 0.026);
// Claude first: when is Claude's reading good enough to use as it is?
const good = P.parseReply('{"isReceipt":true,"kind":"Petrol","merchant":"KEJAYAAN TEGUH ENT","date":"2026-10-29","amount":58.37,"currency":"MYR","receiptNo":"60770c","confidence":"high"}');
eq('Claude first is on by default', P.first(), true);
eq('a clear reading is used as it is', P.clean(good, {}), true);
eq('not sure: the reader on this PC checks it too', P.clean(Object.assign({}, good, { confidence: 'low' }), {}), false);
eq('no date: the reader on this PC checks it too', P.clean(Object.assign({}, good, { date: '' }), {}), false);
eq('no amount: the reader on this PC checks it too', P.clean(Object.assign({}, good, { amount: '' }), {}), false);
eq('a RM7 fuel reading looks wrong: checked too', P.clean(Object.assign({}, good, { amount: '7.00' }), {}), false);
eq('RM7 for parking is fine', P.clean(Object.assign({}, good, { kind: 'Parking', amount: '7.00' }), {}), true);
eq('not a receipt is never used', P.clean(Object.assign({}, good, { isReceipt: false }), {}), false);
const rd = P.asReading(good);
eq('as the line reading: date, amount, shop, number', [rd.date, rd.amount, rd.station, rd.receiptNo], ['2026-10-29', '58.37', 'KEJAYAAN TEGUH ENT', '60770c']);
eq('Claude says Other: the line becomes Other', P.asReading(Object.assign({}, good, { kind: 'Other' })).category, 'Other');
eq('Claude says Medical: the line becomes Medical', P.asReading(Object.assign({}, good, { kind: 'Medical' })).category, 'Medical');
// the panel's modes, spend and connection state (a small stand-in for the browser's storage)
const mem = {}; global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
eq('no key: not connected', P.state(), 'none');
P.setKey('sk-ant-test-1234');
eq('key saved, never tested', P.state(), 'saved');
mem['wfc-claude-tested'] = JSON.stringify({ ok: true, at: 1, ms: 900, model: P.model(), tail: '1234' });
eq('last test passed', P.state(), 'ok');
mem['wfc-claude-tested'] = JSON.stringify({ ok: false, at: 1, msg: 'no', model: P.model(), tail: '1234' });
eq('last test failed', P.state(), 'bad');
mem['wfc-claude-tested'] = JSON.stringify({ ok: true, at: 1, ms: 900, model: P.model(), tail: '9999' });
eq('a different key needs a new test', P.state(), 'saved');
P.setModel('claude-haiku-5-5'); eq('a different model needs a new test', P.state(), 'saved'); P.setModel('claude-sonnet-5-5');
eq('default mode is camera photos first', [P.mode(), P.first(), P.available()], ['first', true, true]);
P.setMode('backup'); eq('only when needed', [P.mode(), P.first(), P.available()], ['backup', false, true]);
P.setMode('off'); eq('off: Claude is never used and the dot says so', [P.mode(), P.first(), P.available(), P.state()], ['off', false, false, 'off']);
P.setMode('first');
mem['wfc-claude-first'] = '0'; delete mem['wfc-claude-mode']; eq('the older "first" tick, unticked, means only when needed', P.mode(), 'backup');
delete mem['wfc-claude-first'];
eq('no spend yet', P.spend(), 0); P.addSpend(0.03); P.addSpend(0.05); eq('spend adds up', +P.spend().toFixed(2), 0.08);
mem['wfc-ai-spend-old'] = 1; mem['wfc-claude-spend'] = JSON.stringify({ m: '2020-01', rm: 9 }); eq('last month does not count', P.spend(), 0);
P.resetSpend(); eq('reset', P.spend(), 0);
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
