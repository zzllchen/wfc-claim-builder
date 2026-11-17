/* Loads the big parts only when they are needed, so the page is usable straight away.
   The PDF reader, the PDF writer, the zip maker and the two form templates are about 1 MB together: they are not needed to see the page or type a name.
   Once the page is up they are fetched quietly in the background (one after another, when the browser is idle), and anything that needs one waits for it:
     await Lazy.need('pdf')      // pdf = reading PDFs, jspdf = writing PDFs, zip = the zip file, claim / leave = the Excel templates */
(function (root) {
  'use strict';
  const me = document.currentScript && document.currentScript.src || '';
  const V = (me.match(/[?&]v=([\w.-]+)/) || [])[1] || '';              // the same ?v= number as this file, so a new version never serves an old library
  const FILES = {
    pdf: 'vendor/pdf.min.js',
    jspdf: 'vendor/jspdf.umd.min.js',
    zip: 'vendor/jszip.min.js',
    claim: 'assets/claim-base.js',
    leave: 'assets/leave-base.js',
  };
  const AFTER = { pdf: () => { if (root.pdfjsLib) root.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; } };
  const tasks = {};

  function load(name) {
    if (!FILES[name]) return Promise.reject(new Error('Unknown part: ' + name));
    if (tasks[name]) return tasks[name];
    tasks[name] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = FILES[name] + (V ? '?v=' + V : '');
      s.onload = () => { try { if (AFTER[name]) AFTER[name](); } catch (e) { /* the part itself is loaded */ } resolve(); };
      s.onerror = () => { delete tasks[name]; s.remove(); reject(new Error('Part of the page could not be loaded. Check your internet connection and try again.')); };
      document.head.appendChild(s);
    });
    return tasks[name];
  }
  const need = (...names) => Promise.all(names.map(load)).then(() => undefined);

  // in the background, once the page has finished loading and the browser has nothing else to do: smallest first
  function warm() {
    const order = ['zip', 'pdf', 'jspdf', 'claim', 'leave'];
    const next = () => { const n = order.shift(); if (!n) return; load(n).catch(() => {}).then(() => idle(next)); };
    next();
  }
  const idle = (fn) => (root.requestIdleCallback ? root.requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 800));
  if (document.readyState === 'complete') idle(warm); else root.addEventListener('load', () => idle(warm));

  root.Lazy = { need, load };
})(typeof window !== 'undefined' ? window : globalThis);
