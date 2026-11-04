const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const STAMP = {
  verified: 'Verified',
  misplaced: 'Wrong lines',
  not_found: 'Not in source',
  missing_artifact: 'No such file',
  applies: 'Patch matches source',
  mismatch: 'Patch does not match',
  no_removals: 'Additions only',
};

let config = { key: false };
let incidents = [];
let current = null;
let source = null; // the open EventSource, if any

async function getJson(url) {
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

async function init() {
  [config, incidents] = await Promise.all([getJson('/api/config'), getJson('/api/incidents')]);
  $('#model').textContent = `${config.model} · ${config.wire} API${config.key ? '' : ' · no API key'}`;
  $('#incidents').innerHTML = incidents.map((i) => `
    <li><button data-id="${esc(i.id)}">
      <span class="inc-meta"><span class="sev sev-${esc(i.severity)}">${esc(i.severity)}</span> · ${esc(i.service)}</span>
      <span>${esc(i.title)}</span>
    </button></li>`).join('');
  $('#incidents').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) select(b.dataset.id);
  });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  renderScoreboard(await getJson('/api/eval'));
  if (incidents.length) select(incidents[0].id);
}

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $('#trail').hidden = name !== 'trail';
  $('#source').hidden = name !== 'source';
}

function renderScoreboard(ev) {
  if (!ev) {
    $('#scoreboard').innerHTML = `<h2 class="rail-title">Evaluation</h2><p class="hint">Run <code>npm run eval</code> to score the agent on all incidents.</p>`;
    return;
  }
  const byId = Object.fromEntries(ev.rows.map((r) => [r.id, r]));
  $('#scoreboard').innerHTML = `
    <h2 class="rail-title">Evaluation</h2>
    <div class="headline">${ev.correct}/${ev.incidents}</div>
    <div class="hint">root causes correct against hidden answer keys</div>
    <table>
      ${incidents.map((i) => {
        const r = byId[i.id];
        const cell = !r ? '—' : r.error ? 'error' : `${r.correct ? '✓' : '✗'} ${r.evidence_verified}/${r.evidence_total}`;
        return `<tr><td>${esc(i.id.replace(/^inc-/, ''))}</td><td>${esc(cell)}</td></tr>`;
      }).join('')}
    </table>
    <p class="hint">${ev.evidence_verified}/${ev.evidence_total} citations verified · ${ev.patches_apply}/${ev.incidents} patches match source<br>${esc(ev.model)} · ${esc(new Date(ev.at).toLocaleString())}</p>`;
}

async function select(id) {
  source?.close();
  current = incidents.find((i) => i.id === id);
  document.querySelectorAll('#incidents button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.id === id)));
  const recorded = await getJson(`/api/runs/${id}`);
  $('#case').innerHTML = `
    <div class="alert-head">
      <span class="inc-meta"><span class="sev sev-${esc(current.severity)}">${esc(current.severity)}</span> · ${esc(current.service)} · started ${esc(new Date(current.started_at).toUTCString().slice(5, 22))} UTC</span>
      <h1>${esc(current.title)}</h1>
      <p class="alert-text">${esc(current.alert)}</p>
      <div class="actions">
        <button class="btn" id="run" ${config.key ? '' : 'disabled'}>Investigate</button>
        ${recorded ? `<button class="btn secondary" id="replay">Replay recorded run</button>` : ''}
        <span class="status" id="status">${config.key ? '' : 'Set MODEL_API_KEY and restart the server to investigate live.'}</span>
      </div>
    </div>
    <div id="result"></div>`;
  $('#run')?.addEventListener('click', () => runLive(id));
  $('#replay')?.addEventListener('click', () => replay(id, recorded));
  $('#trail').innerHTML = `<p class="hint">Each tool call the agent makes appears here as it happens.</p>`;
  $('#source').innerHTML = `<p class="hint">Select a citation to open the file at the cited lines.</p>`;
  showTab('trail');
}

function startTrail() {
  $('#trail').innerHTML = `<ol class="steps" id="steps"></ol>`;
  $('#result').innerHTML = '';
  showTab('trail');
}

function addStep(html) {
  $('#steps').insertAdjacentHTML('beforeend', html);
  const panel = $('#trail');
  panel.scrollTop = panel.scrollHeight;
}

function setBusy(busy, text = '') {
  $('#run') && ($('#run').disabled = busy || !config.key);
  $('#replay') && ($('#replay').disabled = busy);
  $('#status').textContent = text;
  $('#status').classList.toggle('working', busy);
}

function runLive(id) {
  startTrail();
  setBusy(true, 'Investigating');
  let finished = false;
  source = new EventSource(`/api/investigate/${id}`);
  source.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'report' || e.type === 'error') finished = true;
    handle(e, id);
  };
  source.addEventListener('done', () => {
    source.close();
    setBusy(false, '');
  });
  // EventSource reconnects by default, which would start a second investigation.
  source.onerror = () => {
    source.close();
    setBusy(false, '');
    if (!finished) handle({ type: 'error', message: 'Lost connection to the IncidentLens server.' }, id);
  };
}

async function replay(id, run) {
  startTrail();
  setBusy(true, 'Replaying');
  const start = run.events.find((e) => e.type === 'start');
  $('#result').innerHTML = `<div class="notice replay">Replay of a recorded ${esc(run.model)} run from ${esc(new Date(start?.at ?? Date.now()).toLocaleString())}. Choose Investigate for a live run.</div>`;
  for (const e of run.events) {
    if (current?.id !== id) return;
    handle(e, id, true);
    if (!reducedMotion && (e.type === 'step' || e.type === 'verification')) await new Promise((r) => setTimeout(r, 220));
  }
  setBusy(false, '');
}

function handle(e, id, isReplay = false) {
  if (current?.id !== id) return;
  switch (e.type) {
    case 'start':
      addStep(`<li><span class="n"></span><span>Opened case with ${e.artifacts} artifacts</span><span class="ms">${esc(e.model)}</span></li>`);
      break;
    case 'thought':
      addStep(`<li><span class="n"></span><span class="thought">${esc(e.text.slice(0, 400))}</span></li>`);
      break;
    case 'step':
      addStep(`<li><span class="n">${e.n}</span><span class="${e.error ? 'err' : ''}">${esc(e.label)}${e.error ? ` — ${esc(e.error)}` : ''}</span><span class="ms">${e.ms}ms</span></li>`);
      break;
    case 'verification': {
      const bad = e.checks.filter((c) => c.status !== 'verified').length;
      const patchBad = e.patch.status === 'mismatch' || e.patch.status === 'missing_artifact';
      const text = e.accepted
        ? `Verifier: all ${e.checks.length} citations found in source; patch matches`
        : `Verifier rejected ${bad} of ${e.checks.length} citation${e.checks.length === 1 ? '' : 's'}${patchBad ? ' and the patch' : ''}${e.round === 1 ? '; agent revising' : ''}`;
      addStep(`<li><span class="verdict ${e.accepted ? 'ok' : 'bad'}">${esc(text)}</span></li>`);
      break;
    }
    case 'report':
      renderReport(e, isReplay);
      break;
    case 'error':
      $('#result').insertAdjacentHTML('beforeend', `<div class="notice bad">${esc(e.message)}</div>`);
      addStep(`<li><span class="verdict bad">Investigation stopped: ${esc(e.message.slice(0, 200))}</span></li>`);
      break;
  }
}

function diffHtml(patch) {
  return esc(patch).split('\n').map((l) => {
    if (l.startsWith('+') && !l.startsWith('+++')) return `<span class="add">${l}</span>`;
    if (l.startsWith('-') && !l.startsWith('---')) return `<span class="del">${l}</span>`;
    return l;
  }).join('\n');
}

function renderReport(e, isReplay) {
  const r = e.report;
  const verified = e.checks.filter((c) => c.status === 'verified').length;
  const keep = isReplay ? $('#result').innerHTML : '';
  $('#result').innerHTML = keep + `
    <section class="card diagnosis" aria-label="Diagnosis">
      <h2 class="section-title">Diagnosis</h2>
      <p class="summary">${esc(r.summary)}</p>
      <p class="root">${esc(r.root_cause)}</p>
      <div class="facts">
        <span><span class="meter"><i style="width:${Math.round((r.confidence ?? 0) * 100)}%"></i></span><strong>${Math.round((r.confidence ?? 0) * 100)}%</strong> confidence</span>
        <span>Category <strong>${esc(r.category)}</strong></span>
        <span><strong>${verified}/${e.checks.length}</strong> citations verified${e.revised ? ' after one revision' : ''}</span>
        <span><strong>${e.stats.steps}</strong> tool calls · <strong>${e.stats.seconds}s</strong></span>
      </div>
    </section>

    <section class="card" aria-label="Evidence">
      <h2 class="section-title">Evidence</h2>
      <ol class="evidence">
        ${r.evidence.map((ev, i) => {
          const c = e.checks[i];
          return `<li><button data-ev="${i}">
            <span class="cite"><span class="stamp ${c.status}">${STAMP[c.status]}</span>${esc(ev.artifact)} L${ev.start_line}${ev.end_line !== ev.start_line ? `–${ev.end_line}` : ''}${c.status === 'misplaced' ? ` (found at L${c.found_line})` : ''}</span>
            <span class="quote"><mark>${esc(ev.quote)}</mark></span>
            <span>${esc(ev.supports)}</span>
          </button></li>`;
        }).join('')}
      </ol>
    </section>

    ${r.timeline?.length ? `
    <section class="card" aria-label="Timeline">
      <h2 class="section-title">Timeline</h2>
      <ol class="timeline">${r.timeline.map((t) => `<li><time>${esc(t.time)}</time><span>${esc(t.event)}</span></li>`).join('')}</ol>
    </section>` : ''}

    <section class="card" aria-label="Ruled out">
      <h2 class="section-title">Ruled out</h2>
      <ul class="ruled">${(r.ruled_out ?? []).map((h) => `<li><s>${esc(h.hypothesis)}</s><br><span class="hint">${esc(h.reason)}</span></li>`).join('')}</ul>
    </section>

    <section class="card" aria-label="Proposed fix">
      <h2 class="section-title">Proposed fix</h2>
      <div class="cite"><span class="stamp ${e.patch.status}">${STAMP[e.patch.status]}</span>${esc(r.fix.artifact)}</div>
      <p>${esc(r.fix.explanation)}</p>
      <pre class="code diff">${diffHtml(r.fix.patch)}</pre>
      <details style="margin-top:16px"><summary>Regression test: ${esc(r.regression_test.name)}</summary>
        <pre class="code">${esc(r.regression_test.code)}</pre>
      </details>
    </section>

    <section class="card" aria-label="Next steps">
      <h2 class="section-title">Next steps</h2>
      <ul>${(r.next_steps ?? []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <details><summary>Check against hidden answer key: ${e.score.correct ? 'root cause matches' : 'root cause does not match'}</summary>
        <ul>${e.score.groups.map((g) => `<li>${g.hit ? '✓' : '✗'} mentions ${g.any.map(esc).join(' / ')}</li>`).join('')}
          <li>${e.score.fix_target_correct ? '✓' : '✗'} fix targets the expected file</li></ul>
      </details>
    </section>`;

  $('#result').querySelectorAll('button[data-ev]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.ev);
      openSource(r.evidence[i], e.checks[i]);
    });
  });
}

async function openSource(ev, check) {
  showTab('source');
  const data = await getJson(`/api/incidents/${current.id}/artifact?path=${encodeURIComponent(ev.artifact)}`);
  if (!data) {
    $('#source').innerHTML = `<div class="source-head"><code>${esc(ev.artifact)}</code><span class="stamp missing_artifact">${STAMP.missing_artifact}</span></div>
      <p class="hint">The agent cited a file that is not part of this incident.</p>`;
    return;
  }
  const span = Math.max(0, ev.end_line - ev.start_line);
  // Highlight where the quote really is; if it is nowhere, show the range the agent claimed.
  const from = check.found_line ?? ev.start_line;
  const to = check.found_line ? check.found_line + span : ev.end_line;
  $('#source').innerHTML = `
    <div class="source-head"><code>${esc(ev.artifact)}</code><span class="stamp ${check.status}">${STAMP[check.status]}${check.found_line ? ` · L${check.found_line}` : ''}</span></div>
    ${check.status === 'not_found' ? `<p class="notice bad">The quoted text does not appear in this file. Highlighted lines are what the agent cited.</p>` : ''}
    <div class="lines">${data.lines.map((l, i) => {
      const n = i + 1;
      return `<div class="${n >= from && n <= to ? 'hit' : ''}" ${n === from ? 'id="first-hit"' : ''}><span class="ln">${n}</span><span>${esc(l) || ' '}</span></div>`;
    }).join('')}</div>`;
  // Scroll only the panel; scrollIntoView would also move the page.
  const hit = $('#first-hit');
  if (hit) $('#source').scrollTop = hit.offsetTop - $('#source').clientHeight / 2;
}

init();
