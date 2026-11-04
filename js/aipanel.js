/* WFC Claim Builder: the Claude panel. A "Claude" button in the top bar (with a status dot) opens one place to paste the key, test it, pick the model,
   see what Claude has cost this month, and choose when Claude reads. The key stays in this browser. Everything works without it. */
(function (root) {
  'use strict';
  const P = root.PlanB, $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = (t) => { const d = new Date(t); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
  const LABEL = { none: 'Not connected', saved: 'Key saved, not tested', ok: 'Connected', bad: 'Not working', off: 'Switched off' };
  const MODES = [
    ['first', 'Camera photos first', 'Recommended. Claude reads each camera photo first, even blurry ones. PDFs and screenshots are read on this computer.'],
    ['backup', 'Only when needed', 'This computer reads first. Claude helps only when it cannot read a photo or the result looks wrong.'],
    ['off', 'Off', 'Claude is never used and nothing is sent.'],
  ];
  let dlg = null, busy = false, msg = '', msgBad = false, help = false;

  function refreshChip() {
    const b = $('#btnAi'); if (!b) return;
    const s = P.state();
    b.innerHTML = `<i class="aidot ${s}"></i>Claude`;
    b.title = `Claude: ${LABEL[s].toLowerCase()}. Click to set it up.`;
  }
  // the line on the Files step must say truthfully where photos go
  function refreshPrivacy() {
    const el = $('#privacyNote'); if (!el) return;
    const key = P.apiKey(), m = P.mode();
    el.textContent = !key || m === 'off' ? 'Your photos stay on this computer.'
      : m === 'first' ? 'Camera photos are sent to Claude to be read (a key is saved on this computer). PDFs stay on this computer.'
        : 'Your photos stay on this computer, unless it cannot read one.';
  }
  const refresh = () => { refreshChip(); refreshPrivacy(); if (dlg && dlg.open) render(); };

  function render() {
    const key = P.apiKey(), s = P.state(), t = P.tested(), m = P.mode();
    const stat = busy ? '<span class="aistat wait">Testing…</span>' : `<span class="aistat ${s}">${LABEL[s]}</span>`;
    const sub = !key ? '' : busy ? '' : t && t.ok ? `<small>Tested ${esc(when(t.at))} · answered in ${(t.ms / 1000).toFixed(1)} s</small>`
      : t && !t.ok ? `<small class="bad">${esc(t.msg || '')}</small>` : '<small>Press Test connection to check the key.</small>';
    const keyRow = key
      ? `<div class="airow"><span class="aikey">Key saved (ends ${esc(key.slice(-4))})</span><button class="ghost" type="button" data-a="test" ${busy ? 'disabled' : ''}>Test connection</button><a class="aia" data-a="remove">Remove</a></div>
         <div class="airow"><select id="aiModel" aria-label="Claude model">${Object.keys(P.MODELS).map((k) => `<option value="${k}" ${k === P.model() ? 'selected' : ''}>${esc(P.MODELS[k].label)}</option>`).join('')}</select></div>`
      : `<div class="airow"><input type="password" id="aiKey" placeholder="Paste your Anthropic key (sk-ant-…)" autocomplete="off" spellcheck="false"><button class="primary" type="button" data-a="save" ${busy ? 'disabled' : ''}>Save and test</button></div>`;
    const steps = help ? `<ol class="aisteps"><li>Open <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">platform.claude.com/settings/keys</a> and sign in.</li><li>Press <b>Create key</b>, name it, and copy it. It starts with <b>sk-ant-</b> and is shown only once.</li><li>Paste it above and press <b>Save and test</b>.</li></ol>` : '';
    const spendRm = P.spend();
    dlg.querySelector('form').innerHTML = `
      <div class="aihd"><h2>Claude</h2><button class="aix" type="button" data-a="close" aria-label="Close">×</button></div>
      <p class="hint" style="margin:-6px 0 0">Optional. Claude reads receipt photos, even blurry ones. Your key stays on this computer, and nothing works differently without it.</p>
      <div class="aicard">
        <div class="aihead"><b>Claude key</b>${stat}</div>
        ${sub}
        ${keyRow}
        ${msg ? `<p class="aimsg ${msgBad ? 'bad' : 'ok'}">${esc(msg)}</p>` : ''}
        <a class="aia" data-a="help">How do I get a key?</a>${steps}
      </div>
      <div class="aispend">Claude cost this month <b>about RM ${spendRm.toFixed(2)}</b> <a class="aia" data-a="resetspend">Reset</a> <span class="aitip" title="Added up from what each reading cost, on this computer only. The Anthropic Console shows the real bill.">?</span></div>
      <div class="aimodes"><div class="lbl">WHEN SHOULD CLAUDE READ?</div>
        ${MODES.map(([v, name, desc]) => `<label class="aimode ${m === v ? 'on' : ''} ${key ? '' : 'dim'}"><input type="radio" name="aimode" value="${v}" ${m === v ? 'checked' : ''} ${key ? '' : 'disabled'}><span><b>${name}</b><small>${desc}</small></span></label>`).join('')}
      </div>
      <div class="foot"><button class="primary" value="close">Done</button></div>`;
  }

  async function runTest() {
    busy = true; msg = ''; render();
    try { await P.runTest(); msg = 'Connected. Claude is ready.'; msgBad = false; }
    catch (e) { msg = ''; }
    busy = false; refresh();
  }
  async function save() {
    const el = $('#aiKey'), v = el ? el.value.trim() : '';
    if (!/^sk-ant-/.test(v)) { msg = 'That is not a Claude key. It starts with sk-ant-'; msgBad = true; render(); const e2 = $('#aiKey'); if (e2) e2.focus(); return; }
    P.setKey(v); msg = ''; await runTest();
  }

  function init() {
    if (!P) return;
    const b = $('#btnAi'); if (!b) return;
    dlg = document.createElement('dialog'); dlg.id = 'aiDlg'; dlg.innerHTML = '<form method="dialog"></form>'; document.body.append(dlg);
    b.addEventListener('click', () => { msg = ''; help = false; render(); dlg.showModal(); });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) { dlg.close(); return; }
      const a = e.target.closest('[data-a]'); if (!a) return;
      const k = a.dataset.a;
      if (k === 'close') dlg.close();
      else if (k === 'save') save();
      else if (k === 'test') runTest();
      else if (k === 'remove') { P.setKey(''); msg = ''; refresh(); }
      else if (k === 'help') { help = !help; render(); }
      else if (k === 'resetspend') { P.resetSpend(); render(); }
    });
    dlg.addEventListener('change', (e) => {
      if (e.target.id === 'aiModel') { P.setModel(e.target.value); msg = ''; refresh(); }
      else if (e.target.name === 'aimode') { P.setMode(e.target.value); refresh(); }
    });
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'aiKey') { e.preventDefault(); save(); } });
    dlg.addEventListener('close', () => { busy = false; });
    refresh();
  }

  root.AiPanel = { refresh, init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
