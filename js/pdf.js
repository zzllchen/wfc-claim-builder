/* PDF output: the claim form (same layout as the Excel print) and the TNG toll breakdown. */
(function (root) {
  'use strict';
  const { jsPDF } = root.jspdf;
  const PEACH = [252, 228, 214], GREY = [231, 230, 230], GREEN = [226, 242, 231];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
  const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // built-in PDF fonts only cover Latin-1: keep the text safe
  const ascii = (s) => String(s == null ? '' : s)
    .replace(/→/g, '>').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load image'));
      img.src = src;
    });
  }

  async function croppedLogo() {
    const img = await loadImage(root.WFC_LOGO_PNG);
    const sx = img.width * 0.16148, sy = img.height * 0.30219;
    const sw = img.width * (1 - 0.16148 - 0.15802), sh = img.height * (1 - 0.30219 - 0.34717);
    const c = document.createElement('canvas');
    c.width = Math.round(sw); c.height = Math.round(sh);
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return { url: c.toDataURL('image/png'), ratio: sw / sh };
  }

  function signatureImage(text) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = 'italic bold 110px "Brush Script MT","Segoe Script","Snell Roundhand","Lucida Handwriting",cursive';
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 24;
    c.width = w; c.height = 150;
    ctx.font = font; ctx.fillStyle = '#000'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 12, 75);
    return { url: c.toDataURL('image/png'), ratio: c.width / c.height };
  }

  function fitText(doc, text, maxW, size, min) {
    let s = size;
    doc.setFontSize(s);
    while (s > min && doc.getTextWidth(text) > maxW) { s -= 0.5; doc.setFontSize(s); }
    if (doc.getTextWidth(text) <= maxW) return text;
    let t = text;                                    // still too wide at the smallest size: cut with "..."
    while (t.length > 4 && doc.getTextWidth(t + '...') > maxW) t = t.slice(0, -1);
    return t.replace(/\s+$/, '') + '...';
  }

  /* claim: { year, month, claimant, signature, signDate, lines, total } */
  async function claimPdf(claim) {
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    const X =[12.8, 20.5, 67.6, 95.6, 150.0, 176.7, 202.7];
    const TOP = 38.3, HEAD_H = 27.4, ROWS = 35, RH = 5.34;
    const ROWS_TOP = TOP + HEAD_H, ROWS_BOTTOM = ROWS_TOP + ROWS * RH, TOTAL_H = 7.5, BOTTOM = ROWS_BOTTOM + TOTAL_H;
    const text = (s, x, y, opt) => doc.text(ascii(s), x, y, Object.assign({ baseline: 'middle' }, opt));

    // title block
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.setFillColor(...GREY);
    doc.rect(67.6, 10.3, 82.6, 8.9, 'F'); doc.rect(67.6, 24.2, 82.6, 9.1, 'F');
    text('Monthly expense claim', 42.5, 14.75, { align: 'center' });
    text('Claimant', 42.5, 28.75, { align: 'center' });
    text(`${MON[claim.month - 1]}-${String(claim.year).slice(2)}`, 108.9, 14.75, { align: 'center' });
    text(claim.claimant, 108.9, 28.75, { align: 'center' });
    try {
      const logo = await croppedLogo();
      const h = 20.5;
      doc.addImage(logo.url, 'PNG', 202.7 - h * logo.ratio, 11, h * logo.ratio, h);
    } catch (e) { /* logo is cosmetic */ }

    // header + total fills
    doc.setFillColor(...PEACH);
    doc.rect(X[0], TOP, X[6] - X[0], HEAD_H, 'F');
    doc.rect(X[0], ROWS_BOTTOM, X[6] - X[0], TOTAL_H, 'F');

    // grid
    doc.setDrawColor(0); doc.setLineWidth(0.25);
    for (let i = 0; i <= ROWS; i++) { const y = ROWS_TOP + i * RH; doc.line(X[0], y, X[6], y); }
    X.forEach((x) => doc.line(x, TOP, x, ROWS_BOTTOM));
    doc.setLineWidth(0.5);
    doc.rect(X[0], TOP, X[6] - X[0], BOTTOM - TOP);
    doc.line(X[0], ROWS_TOP, X[6], ROWS_TOP);
    doc.line(X[0], ROWS_BOTTOM, X[6], ROWS_BOTTOM);

    // header text
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    const hy = TOP + HEAD_H / 2;
    const mid = (i) => (X[i] + X[i + 1]) / 2;
    text('No', mid(0), hy, { align: 'center' });
    const lines = doc.splitTextToSize('Detailed discription of expense incurred (e.g. Customer Name, Company Name, Purpose of Expense etc. etc)', X[2] - X[1] - 5);
    lines.forEach((l, i) => text(l, mid(1), hy + (i - (lines.length - 1) / 2) * 4.6, { align: 'center' }));
    ['Date', 'Name', 'Receipt No.', 'Amount'].forEach((h, i) => text(h, mid(i + 2), hy, { align: 'center' }));

    // lines
    claim.lines.slice(0, ROWS).forEach((ln, i) => {
      const y = ROWS_TOP + i * RH + RH / 2;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10); text(String(i + 1), mid(0), y, { align: 'center' });
      [[1, ln.category], [2, fmtDate(ln.date)], [3, ln.name], [4, ln.receiptNo]].forEach(([c, v]) => {
        const s = fitText(doc, ascii(v), X[c + 1] - X[c] - 2, 10, 6.5);
        doc.text(s, mid(c), y, { align: 'center', baseline: 'middle' });
      });
      doc.setFontSize(10);
      text(money(ln.amount), X[6] - 2.5, y, { align: 'right' });
    });

    // total
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    text('Total :', mid(4), ROWS_BOTTOM + TOTAL_H / 2, { align: 'center' });
    text(money(claim.total), X[6] - 2.5, ROWS_BOTTOM + TOTAL_H / 2, { align: 'right' });

    // signature
    const sy = 272.3;
    text('Signature Claimant :', 49.8, sy, { align: 'center' });
    text('Date :', 171.4, sy, { align: 'center' });
    text(fmtDate(claim.signDate), 189.7, sy, { align: 'center' });
    doc.setLineWidth(0.8);
    doc.line(67.6, sy + 4.5, 150.2, sy + 4.5);
    doc.line(176.7, sy + 4.5, 202.7, sy + 4.5);
    if (claim.signature) {
      const sig = signatureImage(claim.signature);
      const h = 9.5, w = Math.min(h * sig.ratio, 78);
      doc.addImage(sig.url, 'PNG', 108.9 - w / 2, sy + 4.2 - h, w, h);
    }

    return new Uint8Array(doc.output('arraybuffer'));
  }

  /* The same tick / untick list the person sees on screen, so the accountant can check which trips count.
     info: { claimant, monthLabel, serial, period, rows (toll + parking rows, each with include + why), total, parkingTotal } */
  function tollBreakdownPdf(info) {
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    const L = 14, R = 196;
    const cols = { box: L + 0.8, date: L + 8, time: 46, type: 60, plaza: 73, amt: 150, why: 154 };
    const rows = info.rows.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const whyOf = (r) => r.why || (r.include ? 'Counted' : r.reason);
    let y;

    const box = (x, yy, ticked) => {            // 3.4 mm check box, drawn so it prints the same everywhere
      doc.setDrawColor(ticked ? 31 : 150, ticked ? 74 : 160, ticked ? 216 : 180); doc.setLineWidth(0.3);
      if (ticked) { doc.setFillColor(31, 74, 216); doc.rect(x, yy - 2.6, 3.4, 3.4, 'FD'); }
      else doc.rect(x, yy - 2.6, 3.4, 3.4, 'S');
      if (ticked) { doc.setDrawColor(255); doc.setLineWidth(0.5); doc.lines([[0.8, 0.9], [1.5, -2]], x + 0.7, yy - 0.7, [1, 1], 'S', false); }
    };

    const head = () => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(0);
      doc.setFillColor(...PEACH); doc.rect(L, y - 3.6, R - L, 5.6, 'F');
      doc.text('Tick', cols.box, y); doc.text('Date', cols.date, y); doc.text('Time', cols.time, y); doc.text('Type', cols.type, y);
      doc.text('Toll plaza', cols.plaza, y); doc.text('RM', cols.amt, y, { align: 'right' }); doc.text('Why', cols.why, y);
      y += 5.4;
    };

    const counted = rows.filter((r) => r.include), notCounted = rows.filter((r) => !r.include);
    const sum = (list) => list.reduce((a, r) => a + r.amount, 0);

    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(0);
    doc.text(ascii(`TNG toll check list - ${info.monthLabel}`), L, 16);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    [
      `Claimant: ${info.claimant}`,
      `Touch 'n Go card ${info.serial || '-'}   |   Statement period: ${info.period || '-'}`,
      'Ticked = counted in the claim: toll on work days (Mon-Fri) anywhere in Malaysia, not a public holiday or a day off (leave).',
      'Unticked = not claimed: weekends, public holidays, days off (leave), and parking unless stated.',
    ].forEach((m, i) => doc.text(ascii(m), L, 23 + i * 4.6));

    // summary
    doc.setFillColor(244, 247, 255); doc.rect(L, 41.5, R - L, 9.5, 'F');
    box(L + 3, 47.8, true);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5);
    doc.text(`Counted: ${counted.length} line${counted.length === 1 ? '' : 's'}  -  RM ${money(sum(counted))}`, L + 9, 47.5);
    box(L + 95, 47.8, false);
    doc.text(`Not counted: ${notCounted.length} line${notCounted.length === 1 ? '' : 's'}  -  RM ${money(sum(notCounted))}`, L + 101, 47.5);
    y = 58;
    head();

    rows.forEach((r) => {
      if (y > 279) { doc.addPage(); y = 16; head(); }
      const d = new Date(r.date + 'T00:00:00Z');
      if (r.include) { doc.setFillColor(...GREEN); doc.rect(L, y - 3.4, R - L, 4.9, 'F'); doc.setFont('helvetica', 'bold'); doc.setTextColor(0); }
      else { doc.setFont('helvetica', 'normal'); doc.setTextColor(120); }
      box(cols.box, y + 0.1, r.include);
      doc.setFontSize(8);
      doc.text(`${fmtDate(r.date)} ${DAY[d.getUTCDay()]}`, cols.date, y);
      doc.text(r.time.slice(0, 5), cols.time, y);
      doc.text(r.type === 'PARKING' ? 'Parking' : 'Toll', cols.type, y);
      const plaza = fitText(doc, ascii(r.plaza || '-'), cols.amt - cols.plaza - 12, 8, 6.5); doc.text(plaza, cols.plaza, y); doc.setFontSize(8);
      doc.text(money(r.amount), cols.amt, y, { align: 'right' });
      const why = fitText(doc, ascii(whyOf(r)), R - cols.why, 8, 6.5); doc.text(why, cols.why, y);
      y += 4.9;
    });
    doc.setTextColor(0);

    // totals
    if (y > 262) { doc.addPage(); y = 16; }
    y += 3;
    doc.setDrawColor(0); doc.setLineWidth(0.3); doc.line(L, y - 3.5, R, y - 3.5);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text('Toll claimed', cols.plaza, y); doc.text(money(info.total), cols.amt, y, { align: 'right' });
    if (info.parkingTotal > 0) { y += 5.5; doc.text('Parking claimed', cols.plaza, y); doc.text(money(info.parkingTotal), cols.amt, y, { align: 'right' }); }

    // why the unticked rows were left out
    const groups = new Map();
    notCounted.forEach((r) => {
      const k = whyOf(r);
      const g = groups.get(k) || { n: 0, amt: 0 };
      g.n++; g.amt += r.amount; groups.set(k, g);
    });
    if (groups.size) {
      y += 11;
      if (y > 262) { doc.addPage(); y = 16; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('Not counted, by reason', L, y); y += 5.5;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      Array.from(groups).sort((a, b) => b[1].amt - a[1].amt).forEach(([k, g]) => {
        if (y > 284) { doc.addPage(); y = 16; }
        doc.text(ascii(k), L, y);
        doc.text(`${g.n} line${g.n === 1 ? '' : 's'}`, cols.plaza + 40, y, { align: 'right' });
        doc.text(money(g.amt), cols.amt, y, { align: 'right' });
        y += 4.6;
      });
    }

    return new Uint8Array(doc.output('arraybuffer'));
  }

  const dmy = (iso) => `${+iso.slice(8, 10)}/${+iso.slice(5, 7)}/${iso.slice(0, 4)}`;   // 6/11/2026, as on the leave form

  /* leave: { name, type, reason, from, to, signature, signDate } */
  async function leavePdf(leave) {
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    const text = (s, x, y, opt) => doc.text(ascii(s), x, y, Object.assign({ baseline: 'middle' }, opt));
    const rule = (x1, y, x2, w) => { doc.setLineWidth(w || 0.25); doc.setDrawColor(0); doc.line(x1, y, x2, y); };

    try {
      const logo = await croppedLogo();
      doc.addImage(logo.url, 'PNG', 18.7, 16.2, 39.3, 39.3 / logo.ratio);
    } catch (e) { /* cosmetic */ }

    doc.setFillColor(128, 128, 128); doc.rect(18.3, 37.7, 158.8, 6.6, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    text('LEAVE APPLICATION FORM', 21.7, 41);
    doc.setTextColor(0); doc.setFont('helvetica', 'normal'); doc.setFontSize(10);

    text('Employee Name:', 19, 53.9); text(leave.name.toUpperCase(), 48.2, 53.7); rule(46.8, 56.8, 110);
    text('Reason for request leave :', 19, 66.7); text(leave.reason, 68.6, 66.5); rule(67.8, 69.6, 110);

    const types = [['Sick :', 'sick'], ['Annual leave :', 'annual'], ['Unpaid leave :', 'unpaid'], ['Personal leave:', 'personal'], ['Other :', 'other']];
    const ys = [79.4, 85.8, 92.2, 98.6, 105.5];
    types.forEach(([label, key], i) => {
      text(label, 46.6, ys[i], { align: 'right' });
      rule(47.5, ys[i] + 3, 73);
      if (leave.type === key) {                       // tick mark drawn as a path (standard fonts have no tick glyph)
        doc.setLineWidth(0.55);
        doc.lines([[1, 1.1], [2.2, -3]], 48.6, ys[i] + 0.2, [1, 1], 'S', false);
      }
    });
    [['Balance b/f:', 79.4], ['Entitle for the yr:', 85.8], ['AL taken for the yr:', 92.2], ['Balance c/f:', 98.6]]
      .forEach(([label, y]) => text(label, 134.4, y, { align: 'right' }));
    rule(134.7, 95.2, 146.8); rule(134.7, 100.7, 146.8); rule(134.7, 101.8, 146.8);

    doc.setTextColor(70);
    text('Leave from :', 46.6, 118.7, { align: 'right' });
    doc.setTextColor(0);
    text(dmy(leave.from), 48.2, 118.3); rule(47.5, 121.4, 73);
    text('to', 75.3, 118.7, { align: 'center' });
    text(dmy(leave.to), 84.2, 118.3); rule(83.5, 121.4, 110);

    doc.setFontSize(9); text('Signed:', 19, 137.9); doc.setFontSize(10);
    rule(18.3, 140.6, 46.8, 0.3);
    if (leave.signature) {
      const sig = signatureImage(leave.signature);
      const h = 8.5, w = Math.min(h * sig.ratio, 28);
      doc.addImage(sig.url, 'PNG', 60.1 - w / 2, 140.4 - h, w, h);
    }
    rule(47.2, 140.8, 73, 0.9);
    text('Date: ' + fmtDate(leave.signDate), 115, 137.7, { align: 'center' });
    rule(83.5, 140.6, 146.8, 0.6);

    return new Uint8Array(doc.output('arraybuffer'));
  }

  root.ClaimPdf = { claim: claimPdf, leave: leavePdf, tollBreakdown: tollBreakdownPdf, croppedLogo, fmtDate, dmy, money, MON, DAY };
})(window);
