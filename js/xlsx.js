/* Fills the WFC monthly claim form (xlsx) by patching the base workbook's XML,
   so the original layout, logo, fonts and print setup are kept exactly. */
(function (root) {
  'use strict';
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const FIRST_ROW = 6, LAST_ROW = 40, TOTAL_ROW = 41, SIGN_ROW = 43;
  const COLS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const ALL_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const LEAVE_ROW = { sick: 11, annual: 12, unpaid: 13, personal: 14, other: 15 };   // tick goes in column B
  const MAX_LINES = LAST_ROW - FIRST_ROW + 1;
  const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const STYLE = { B: 8, C: 40, D: 8, E: 8, F: 5 };   // text, dd/mm/yyyy, text, text, amount

  const serial = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  const serialFromIso = (iso) => serial(+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10));
  const parse = (xml) => new DOMParser().parseFromString(xml, 'application/xml');
  const serialize = (doc) => XML_DECL + new XMLSerializer().serializeToString(doc.documentElement);
  const colIndex = (ref) => ALL_COLS.indexOf(ref.replace(/\d+/g, ''));

  function rowEl(doc, r) {
    return Array.from(doc.getElementsByTagNameNS(NS, 'row')).find((el) => +el.getAttribute('r') === r);
  }

  function cellEl(doc, r, col) {
    const row = rowEl(doc, r);
    if (!row) throw new Error('Claim template is missing row ' + r);
    const ref = col + r;
    const cells = Array.from(row.getElementsByTagNameNS(NS, 'c'));
    let c = cells.find((x) => x.getAttribute('r') === ref);
    if (c) return c;
    c = doc.createElementNS(NS, 'c');
    c.setAttribute('r', ref);
    const next = cells.find((x) => colIndex(x.getAttribute('r')) > colIndex(ref));
    row.insertBefore(c, next || null);
    return c;
  }

  function wipe(c) {
    while (c.firstChild) c.removeChild(c.firstChild);
    c.removeAttribute('t');
  }

  function setText(c, text) {
    wipe(c);
    if (text === '' || text == null) return;
    c.setAttribute('t', 'inlineStr');
    const is = c.ownerDocument.createElementNS(NS, 'is');
    const t = c.ownerDocument.createElementNS(NS, 't');
    t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    t.textContent = String(text);
    is.appendChild(t);
    c.appendChild(is);
  }

  function setNumber(c, n) {
    wipe(c);
    if (n === '' || n == null) return;
    const v = c.ownerDocument.createElementNS(NS, 'v');
    v.textContent = String(n);
    c.appendChild(v);
  }

  /* Rebuild sharedStrings.xml with only the strings the two sheets still use. */
  function pruneSharedStrings(sstXml, sheetDocs) {
    const sst = parse(sstXml);
    const items = Array.from(sst.getElementsByTagNameNS(NS, 'si'));
    const remap = new Map();
    const kept = [];
    let refs = 0;
    sheetDocs.forEach((doc) => {
      Array.from(doc.getElementsByTagNameNS(NS, 'c')).forEach((c) => {
        if (c.getAttribute('t') !== 's') return;
        const v = c.getElementsByTagNameNS(NS, 'v')[0];
        const old = +v.textContent;
        if (!remap.has(old)) { remap.set(old, kept.length); kept.push(items[old]); }
        v.textContent = String(remap.get(old));
        refs++;
      });
    });
    const root = sst.documentElement;
    while (root.firstChild) root.removeChild(root.firstChild);
    kept.forEach((si) => root.appendChild(si));
    root.setAttribute('count', String(refs));
    root.setAttribute('uniqueCount', String(kept.length));
    return serialize(sst);
  }

  /* claim: { year, month, claimant, signature, signDate: 'YYYY-MM-DD',
              lines: [{ category, date: 'YYYY-MM-DD', name, receiptNo, amount }] } */
  async function build(claim) {
    if (claim.lines.length > MAX_LINES) throw new Error(`The claim form holds ${MAX_LINES} lines; you have ${claim.lines.length}.`);
    const zip = await JSZip.loadAsync(root.CLAIM_BASE_B64, { base64: true });

    const sheet1 = parse(await zip.file('xl/worksheets/sheet1.xml').async('string'));
    const sheet2 = parse(await zip.file('xl/worksheets/sheet2.xml').async('string'));

    // clear the item table, then write the lines
    for (let r = FIRST_ROW; r <= LAST_ROW; r++) COLS.forEach((col) => wipe(cellEl(sheet1, r, col)));
    let total = 0;
    claim.lines.forEach((ln, i) => {
      const r = FIRST_ROW + i;
      setNumber(cellEl(sheet1, r, 'A'), i + 1);
      setText(cellEl(sheet1, r, 'B'), ln.category);
      setNumber(cellEl(sheet1, r, 'C'), ln.date ? serialFromIso(ln.date) : '');
      setText(cellEl(sheet1, r, 'D'), ln.name);
      setText(cellEl(sheet1, r, 'E'), ln.receiptNo);
      setNumber(cellEl(sheet1, r, 'F'), Number(ln.amount).toFixed(2));
      Object.keys(STYLE).forEach((col) => cellEl(sheet1, r, col).setAttribute('s', String(STYLE[col])));
      total += Math.round(Number(ln.amount) * 100);
    });
    total /= 100;

    setNumber(cellEl(sheet1, 1, 'C'), serial(claim.year, claim.month, 1));
    setText(cellEl(sheet1, 3, 'C'), claim.claimant);
    setText(cellEl(sheet1, SIGN_ROW, 'C'), claim.signature);
    setNumber(cellEl(sheet1, SIGN_ROW, 'F'), serialFromIso(claim.signDate));
    const totalCell = cellEl(sheet1, TOTAL_ROW, 'F');
    const v = totalCell.getElementsByTagNameNS(NS, 'v')[0];
    if (v) v.textContent = total.toFixed(2);

    // prune first: it re-indexes the <v> of every shared-string cell in both sheets
    zip.file('xl/sharedStrings.xml', pruneSharedStrings(await zip.file('xl/sharedStrings.xml').async('string'), [sheet1, sheet2]));
    zip.file('xl/worksheets/sheet1.xml', serialize(sheet1));
    zip.file('xl/worksheets/sheet2.xml', serialize(sheet2));

    let wb = await zip.file('xl/workbook.xml').async('string');
    wb = wb.replace(/<calcPr([^>]*?)\/>/, (m, a) => (a.includes('fullCalcOnLoad') ? m : `<calcPr${a} fullCalcOnLoad="1"/>`));
    zip.file('xl/workbook.xml', wb);

    let core = await zip.file('docProps/core.xml').async('string');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    core = core.replace(/<cp:lastModifiedBy>.*?<\/cp:lastModifiedBy>/, `<cp:lastModifiedBy>${esc(claim.claimant)}</cp:lastModifiedBy>`)
      .replace(/<cp:lastPrinted>.*?<\/cp:lastPrinted>/, '')
      .replace(/(<dcterms:modified[^>]*>).*?(<\/dcterms:modified>)/, `$1${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}$2`);
    zip.file('docProps/core.xml', core);

    const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    return { data, total };
  }

  /* Leave application (sheet "Leave form" is the first sheet of the leave workbook).
     leave: { name, type: sick|annual|unpaid|personal|other, reason, from, to, signature, signDate } (dates YYYY-MM-DD) */
  async function buildLeave(leave) {
    const zip = await JSZip.loadAsync(root.LEAVE_BASE_B64, { base64: true });
    const sheet1 = parse(await zip.file('xl/worksheets/sheet1.xml').async('string'));   // Leave form
    const sheet2 = parse(await zip.file('xl/worksheets/sheet2.xml').async('string'));   // CLAIM (blank)

    setText(cellEl(sheet1, 7, 'B'), leave.name.toUpperCase());
    setText(cellEl(sheet1, 9, 'C'), leave.reason);
    Object.keys(LEAVE_ROW).forEach((k) => setText(cellEl(sheet1, LEAVE_ROW[k], 'B'), k === leave.type ? '✔' : ''));
    setNumber(cellEl(sheet1, 17, 'B'), serialFromIso(leave.from));
    setNumber(cellEl(sheet1, 17, 'E'), serialFromIso(leave.to));
    setText(cellEl(sheet1, 20, 'B'), leave.signature);
    setNumber(cellEl(sheet1, 20, 'F'), serialFromIso(leave.signDate));

    zip.file('xl/sharedStrings.xml', pruneSharedStrings(await zip.file('xl/sharedStrings.xml').async('string'), [sheet1, sheet2]));
    zip.file('xl/worksheets/sheet1.xml', serialize(sheet1));
    zip.file('xl/worksheets/sheet2.xml', serialize(sheet2));

    let core = await zip.file('docProps/core.xml').async('string');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    core = core.replace(/<cp:lastModifiedBy>.*?<\/cp:lastModifiedBy>/, `<cp:lastModifiedBy>${esc(leave.name)}</cp:lastModifiedBy>`)
      .replace(/<cp:lastPrinted>.*?<\/cp:lastPrinted>/, '')
      .replace(/(<dcterms:modified[^>]*>).*?(<\/dcterms:modified>)/, `$1${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}$2`);
    zip.file('docProps/core.xml', core);

    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  root.ClaimXlsx = { build, buildLeave, MAX_LINES };
})(window);
