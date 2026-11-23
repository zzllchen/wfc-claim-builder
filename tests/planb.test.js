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
eq('RM7 on a parking receipt is fine', d({ amount: '7.00', date: '2026-10-19', station: 'MBSJ Flexi Parking' }, 'Parking'), []);
eq('RM900 fuel: doubtful', /too big/.test(d({ amount: '900.00', date: '2026-10-19' })[0]), true);
eq('no amount: doubtful', d({ amount: '', date: '2026-10-19' }), ['no amount found']);
eq('foreign amount is not "no amount"', d({ amount: '', foreign: { code: 'USD', amount: 11 }, date: '2026-10-19' }), []);
eq('amount that does not add up: doubtful', d({ amount: '60.00', date: '2026-10-19', sure: false }).length, 1);
eq('no date: doubtful', d({ amount: '60.00', date: '' }), ['no date found']);
eq('future date: doubtful', /looks wrong/.test(d({ amount: '60.00', date: '2026-12-25' })[0]), true);
eq('date 5 months ago: doubtful', /looks wrong/.test(d({ amount: '60.00', date: '2026-05-01' })[0]), true);
eq('date a month ago: fine', d({ amount: '60.00', date: '2026-10-01' }), []);
eq('missing shop name or receipt number alone is NOT a doubt on a fuel slip (the saved station is filled in)', d({ amount: '60.00', date: '2026-10-19', station: '', receiptNo: '' }), []);
eq('a clinic, hotel or shop with no name: worth a look (the name is a box the claim needs)', d({ amount: '75.00', date: '2026-10-19', station: '' }, 'Medical'), ['no name found']);
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
m = P.merge({ amount: '60.00', date: '2026-10-02', station: 'Involece' }, P.parseReply('{"isReceipt":true,"date":"2026-10-29","merchant":"KEJAYAAN TEGUH ENT","amount":60}'), []);
eq('the readers disagree on the date and the name: Claude (who saw the photo) wins, both marked for review', [m.r.date, m.r.station, m.r.review], ['2026-10-29', 'KEJAYAAN TEGUH ENT', ['date', 'name']]);
m = P.merge({ amount: '60.00', date: '2026-10-29', station: 'KEJAYAAN TEGUH ENTERPRISE' }, P.parseReply('{"isReceipt":true,"date":"2026-10-29","merchant":"KEJAYAAN TEGUH ENT","amount":60}'), []);
eq('the same shop, written another way: Claude\'s spelling (the claim tool matches it to the saved name), nothing to review', [m.r.station, m.r.review], ['KEJAYAAN TEGUH ENT', undefined]);
m = P.merge({ amount: '', date: '', station: '', receiptNo: '' }, P.parseReply('{"isReceipt":true,"kind":"Medical","merchant":"Klinik Putra Care","date":"2026-10-10","amount":75}'), ['no amount found']);
eq('unreadable photo read by Claude: category follows the kind', [m.r.amount, m.r.category, m.r.station], ['75.00', 'Medical', 'Klinik Putra Care']);
// Claude only when it is needed
eq('only the receipt number missing, the sums add up and the date was read: no Claude (the person types the number)',
  P.worthAsking(['no invoice number found'], { sure: true, date: '2026-10-04' }), false);
eq('the number missing and the amount not proven: Claude is asked', P.worthAsking(['no invoice number found'], { sure: null, date: '2026-10-04' }), true);
eq('a missing date is always worth asking', P.worthAsking(['no date found'], { sure: true }), true);
eq('nothing in doubt: no Claude', P.worthAsking([], { sure: true }), false);

// the safety limits
eq('no key saved: plan B is not available', P.available(), false);
eq('errors are explained in plain words', [P.explain({ status: 401 }).slice(0, 22), P.explain({ status: 429, message: 'Your credit balance is too low' }).slice(0, 27)], ['Anthropic rejected the', 'The API account has no cred']);
eq('cost of a 1,500-token photo on Sonnet 5.5 is about 3 sen', +P.costRM('claude-sonnet-5-5', { input_tokens: 1500, output_tokens: 300 }).toFixed(3), 0.026);
// Claude first: when is Claude's reading good enough to use as it is?
const good = P.parseReply('{"isReceipt":true,"kind":"Petrol","merchant":"KEJAYAAN TEGUH ENT","date":"2026-10-29","amount":58.37,"currency":"MYR","receiptNo":"60770c","confidence":"high"}');
eq('Claude only when unsure by default (as chosen, 23 Nov 2026)', P.first(), false);
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
eq('default mode is only when unsure', [P.mode(), P.first(), P.available()], ['backup', false, true]);
P.setMode('backup'); eq('only when needed', [P.mode(), P.first(), P.available()], ['backup', false, true]);
P.setMode('off'); eq('off: Claude is never used and the dot says so', [P.mode(), P.first(), P.available(), P.state()], ['off', false, false, 'off']);
P.setMode('first');
mem['wfc-claude-first'] = '0'; delete mem['wfc-claude-mode']; eq('the older "first" tick, unticked, means only when needed', P.mode(), 'backup');
delete mem['wfc-claude-first'];
eq('no spend yet', P.spend(), 0); P.addSpend(0.03); P.addSpend(0.05); eq('spend adds up', +P.spend().toFixed(2), 0.08);
mem['wfc-ai-spend-old'] = 1; mem['wfc-claude-spend'] = JSON.stringify({ m: '2020-01', rm: 9 }); eq('last month does not count', P.spend(), 0);
P.resetSpend(); eq('reset', P.spend(), 0);

// Claude through the company inbox: nothing to paste, the key never reaches the page
(async () => {
  const done = () => { console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0); };
  try {
    P.setKey(''); P.setMode('first');
    eq('team: before the inbox is known, Claude is not available', [P.available(), P.state(), P.teamOn()], [false, 'none', false]);
    P.useTeam('https://inbox.test/exec');
    eq('team: connected through the company', [P.available(), P.state(), P.teamOn()], [true, 'team', true]);
    P.setMode('backup'); eq('team: only when needed still works', [P.available(), P.first(), P.state()], [true, false, 'team']);
    P.setMode('off'); eq('team: off means off', [P.available(), P.state()], [false, 'off']); P.setMode('first');

    const calls = [];
    const reply = { content: [{ type: 'text', text: '{"isReceipt":true,"kind":"Petrol","merchant":"KEJAYAAN TEGUH ENT","date":"2026-10-29","amount":58.37,"currency":"MYR","receiptNo":"60770c","confidence":"high"}' }], stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 80 }, model: 'claude-sonnet-5-5' };
    global.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { json: async () => ({ ok: true, reply }) }; };
    const r = await P.read({ name: 'x.jpg' }, { _data: 'QUJD', month: '2026-10' });
    eq('team: the photo goes to the inbox address, as a plain POST', [calls[0].url, calls[0].init.method, calls[0].init.headers['Content-Type'], calls[0].body.action], ['https://inbox.test/exec', 'POST', 'text/plain;charset=utf-8', 'claude']);
    eq('team: no key travels from the page', [JSON.stringify(calls[0].init).includes('x-api-key'), JSON.stringify(calls[0].init).includes('sk-ant'), 'x-api-key' in calls[0].init.headers], [false, false, false]);
    eq('team: the request is one photo and one short note', [calls[0].body.request.messages.length, calls[0].body.request.messages[0].content.map((c) => c.type)], [1, ['image', 'text']]);
    eq('team: the reading comes back as before', [r.reading.date, r.reading.amount, r.reading.merchant, r.reading.receiptNo], ['2026-10-29', '58.37', 'KEJAYAAN TEGUH ENT', '60770c']);
    eq('team: the cost is counted on this PC', r.costRM > 0, true);
    // the same photo again (another claim, after a reload, another day): read from this PC, nothing sent, nothing paid
    const again = await P.read({ name: 'x.jpg' }, { _data: 'QUJD', month: '2026-10', today: '2026-12-01' });
    eq('the same photo again: no second call, the same reading, free', [calls.length, again.remembered, again.costRM, again.reading.receiptNo], [1, true, 0, '60770c']);
    await P.read({ name: 'y.jpg' }, { _data: 'REVG', month: '2026-10' });
    eq('a different photo is read by Claude', calls.length, 2);

    // the inbox refusing (daily limit, no credit, bad key) is shown in plain words and does not break the claim
    global.fetch = async () => ({ json: async () => ({ ok: false, error: "The company's Claude limit for today is used up.", code: 429 }) });
    let err = null; try { await P.read({ name: 'x.jpg' }, { _data: 'QUJD' }); } catch (e) { err = e; }
    eq('team: a refusal is an error with the inbox status', [err && err.status, err && err.team], [429, true]);
    eq('team: the daily limit is explained, and the PC reads the photo instead', /this computer reads the photo instead/.test(P.explain(err)), true);
    global.fetch = async () => ({ json: async () => { throw new Error('not json'); } });
    err = null; try { await P.read({ name: 'x.jpg' }, { _data: 'QUJD' }); } catch (e) { err = e; }
    eq('team: an unreadable answer is a plain error', /did not answer/.test(err && err.message), true);

    // a key of its own wins over the company one, and goes straight to Anthropic
    P.setKey('sk-ant-own-1234');
    const seen = []; global.fetch = async (url, init) => { seen.push(url); return { ok: true, status: 200, clone() { return this; }, json: async () => reply }; };
    await P.read({ name: 'x.jpg' }, { _data: 'QUJD' });
    eq('own key: used instead of the company one', seen, ['https://api.anthropic.com/v1/messages']);
    eq('own key: state is the key state again', P.state(), 'saved');
    done();
  } catch (e) { fails++; console.log('FAIL team tests threw', e); done(); }
})();
