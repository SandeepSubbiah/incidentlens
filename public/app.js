const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const STAMP = {
  verified: 'Verified',
  misplaced: 'Wrong lines',
  not_found: 'Not in source',
  missing_artifact: 'No such file',
  applies: 'Lines found in source',
  mismatch: 'Patch does not match',
  no_removals: 'Additions only',
};
const ROLE_LABEL = { commander: 'Commander', signals: 'Signals', platform: 'Platform', code: 'Code', skeptic: 'Skeptic', fixer: 'Fixer' };
const ROLES = Object.keys(ROLE_LABEL);
const HEAL_LABEL = {
  failover: 'Failover',
  'circuit-open': 'Circuit opened',
  'circuit-closed': 'Circuit closed',
  'param-negotiation': 'Adapted request',
  'history-compat': 'Adapted history',
  'rate-limited': 'Rate limited',
};

const state = { config: {}, session: {}, incidents: [], current: null, mode: 'solo', abort: null, tasks: new Map(), facts: [], quarantined: 0, rejected: 0 };

async function getJson(url, init) {
  const res = await fetch(url, init);
  return res.ok ? res.json() : null;
}

// Server-sent events over fetch, so HTTP errors (401, 429) are readable instead of silent.
async function readStream(url, onEvent, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status} ${res.statusText}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (chunk.startsWith('event: done')) return;
      const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (data) onEvent(JSON.parse(data));
    }
  }
}

const roleTag = (role) => (role && ROLE_LABEL[role] ? `<span class="role role-${role}">${ROLE_LABEL[role]}</span>` : `<span class="role">${esc(role ?? 'Agent')}</span>`);
const canRun = () => state.config.key && (!state.config.gated || (state.session?.sub && state.session.runs_left > 0));
const isAdmin = () => !state.config.gated || state.session?.role === 'admin';

async function init() {
  [state.config, state.session, state.incidents] = await Promise.all([getJson('/api/config'), getJson('/api/session'), getJson('/api/incidents')]);
  state.config ??= {};
  renderHeader();
  $('#incidents').innerHTML = state.incidents
    .map((i) => `<li><button data-id="${esc(i.id)}"><span class="inc-meta"><span class="sev sev-${esc(i.severity)}">${esc(i.severity)}</span> · ${esc(i.service)}</span><span>${esc(i.title)}</span></button></li>`)
    .join('');
  $('#incidents').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) select(b.dataset.id);
  });
  $('#nav-health').addEventListener('click', showHealth);
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#access-cancel').addEventListener('click', () => $('#access-dialog').close());
  $('#access-form').addEventListener('submit', signIn);
  renderScoreboard();
  if (state.incidents.length) select(state.incidents[0].id);
}

function renderHeader() {
  const m = state.config.models ?? {};
  $('#model').textContent = `deep ${m.deep ?? '?'} · fast ${m.fast ?? '?'} · ${state.config.wire ?? ''} API${state.config.key ? '' : ' · no API key'}`;
  const acc = $('#access');
  if (!state.config.gated) acc.innerHTML = `<span class="chip">Open access</span>`;
  else if (state.session?.sub) acc.innerHTML = `<span class="chip">${esc(state.session.sub)} · ${esc(state.session.role)} · ${state.session.runs_left} live runs left</span>`;
  else {
    acc.innerHTML = `<button class="btn secondary small" id="signin">Enter access code</button>`;
    $('#signin').addEventListener('click', () => $('#access-dialog').showModal());
  }
}

async function signIn(e) {
  e.preventDefault();
  const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: $('#access-code').value.trim() }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('#access-error').textContent = data.error ?? 'Sign-in failed.';
    return;
  }
  state.session = data;
  $('#access-dialog').close();
  renderHeader();
  if (state.current) select(state.current.id);
}

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $('#trail').hidden = name !== 'trail';
  $('#source').hidden = name !== 'source';
}

async function renderScoreboard() {
  const [solo, war] = await Promise.all([getJson('/api/eval'), getJson('/api/eval?mode=warroom')]);
  const block = (ev, label) => {
    if (!ev) return '';
    const byId = Object.fromEntries(ev.rows.map((r) => [r.id, r]));
    return `<div class="headline">${ev.correct}/${ev.incidents}</div>
      <div class="hint">${label}: root causes correct against hidden answer keys</div>
      <table>${state.incidents.map((i) => {
        const r = byId[i.id];
        const cell = !r ? '—' : r.error ? 'error' : `${r.correct ? '✓' : '✗'} ${r.evidence_verified}/${r.evidence_total}`;
        return `<tr><td>${esc(i.id.replace(/^inc-/, ''))}</td><td>${esc(cell)}</td></tr>`;
      }).join('')}</table>
      <p class="hint">${ev.evidence_verified}/${ev.evidence_total} citations verified · ${ev.patches_apply}/${ev.incidents} patches match source<br>${esc(ev.model)} · ${esc(new Date(ev.at).toLocaleString())}</p>`;
  };
  $('#scoreboard').innerHTML = `<h2 class="rail-title">Evaluation</h2>${block(solo, 'Solo') + block(war, 'War Room') || '<p class="hint">Run <code>npm run eval</code> to score the agent on every incident.</p>'}`;
}

function markNav(id) {
  document.querySelectorAll('#incidents button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.id === id)));
  $('#nav-health').setAttribute('aria-current', String(id === 'health'));
}

async function select(id) {
  state.abort?.abort();
  state.current = state.incidents.find((i) => i.id === id);
  markNav(id);
  const c = state.current;
  $('#case').innerHTML = `
    <div class="alert-head">
      <span class="inc-meta"><span class="sev sev-${esc(c.severity)}">${esc(c.severity)}</span> · ${esc(c.service)} · started ${esc(new Date(c.started_at).toUTCString().slice(5, 22))} UTC</span>
      <h1>${esc(c.title)}</h1>
      <p class="alert-text">${esc(c.alert)}</p>
      <div class="mode" role="radiogroup" aria-label="Investigation mode">
        <button role="radio" data-mode="solo">Solo agent</button>
        <button role="radio" data-mode="warroom">War Room · 6 agents</button>
      </div>
      <div class="actions">
        <button class="btn" id="run">Investigate</button>
        <button class="btn secondary" id="replay" hidden>Replay recorded run</button>
        <span class="status" id="status"></span>
      </div>
    </div>
    <div id="warroom"></div>
    <div id="result"></div>`;
  document.querySelectorAll('.mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#run').addEventListener('click', () => runLive(id));
  $('#trail').innerHTML = `<p class="hint">Each tool call, message and decision appears here as it happens.</p>`;
  $('#source').innerHTML = `<p class="hint">Select a citation to open the file at the cited lines.</p>`;
  showTab('trail');
  await setMode(state.mode);
}

async function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  const id = state.current.id;
  const recorded = await getJson(`/api/runs/${id}?mode=${mode}`);
  if (state.current?.id !== id || state.mode !== mode) return;
  const replay = $('#replay');
  replay.hidden = !recorded;
  replay.onclick = () => replayRun(id, recorded);
  $('#run').disabled = !canRun();
  $('#status').textContent = !state.config.key
    ? 'Set MODEL_API_KEY and restart the server to investigate live.'
    : state.config.gated && !state.session?.sub
      ? 'Enter an access code to investigate live.'
      : state.config.gated && state.session.runs_left <= 0
        ? 'This access code has no live investigations left.'
        : mode === 'warroom'
          ? 'Six agents, fast and deep models, shared verified board.'
          : '';
}

function setBusy(busy, text = '') {
  $('#run').disabled = busy || !canRun();
  if ($('#replay')) $('#replay').disabled = busy;
  document.querySelectorAll('.mode button').forEach((b) => (b.disabled = busy));
  $('#status').textContent = text;
  $('#status').classList.toggle('working', busy);
}

function reset() {
  state.tasks.clear();
  state.facts = [];
  state.quarantined = 0;
  state.rejected = 0;
  hyps.clear();
  $('#trail').innerHTML = `<ol class="steps" id="steps"></ol>`;
  $('#result').innerHTML = '';
  $('#warroom').innerHTML = state.mode === 'warroom' ? warroomSkeleton() : '';
  showTab('trail');
}

async function runLive(id) {
  reset();
  setBusy(true, state.mode === 'warroom' ? 'War Room in session' : 'Investigating');
  const ac = new AbortController();
  state.abort = ac;
  try {
    await readStream(`/api/investigate/${id}?mode=${state.mode}`, (e) => handle(e, id), ac.signal);
  } catch (err) {
    if (err.name !== 'AbortError') handle({ type: 'error', message: err.message }, id);
  } finally {
    if (state.current?.id === id) setBusy(false);
    state.session = (await getJson('/api/session')) ?? state.session;
    renderHeader();
  }
}

async function replayRun(id, run) {
  reset();
  setBusy(true, 'Replaying');
  const start = run.events.find((e) => e.type === 'start');
  $('#result').innerHTML = `<div class="notice replay">Replay of a recorded run (${esc(start?.model ?? run.model)}) from ${esc(new Date(start?.at ?? Date.now()).toLocaleString())}. Choose Investigate for a live run.</div>`;
  const pace = state.mode === 'warroom' ? 140 : 220;
  for (const e of run.events) {
    if (state.current?.id !== id) return;
    handle(e, id, true);
    if (!reducedMotion && ['step', 'verification', 'preempt', 'live_update', 'message'].includes(e.type)) await new Promise((r) => setTimeout(r, pace));
  }
  setBusy(false);
}

function addStep(html) {
  const list = $('#steps');
  if (!list) return;
  list.insertAdjacentHTML('beforeend', html);
  $('#trail').scrollTop = $('#trail').scrollHeight;
}
const line = (who, body, right = '') => addStep(`<li><span class="who">${who}</span><span>${body}</span><span class="ms">${right}</span></li>`);
const verdict = (cls, text) => addStep(`<li><span class="verdict ${cls}">${text}</span></li>`);

/* War Room panel */
function warroomSkeleton() {
  return `<section class="card" aria-label="War Room">
    <h2 class="section-title">War Room</h2>
    <div class="updates" id="wr-updates"></div>
    <div class="lanes" id="wr-lanes">${ROLES.map((r) => `<div class="lane" data-role="${r}">${roleTag(r)}<span class="tier" data-tier></span><span class="lane-status">idle</span><span class="lane-task"></span></div>`).join('')}</div>
    <div class="grid2" style="margin-top:16px">
      <div><h3 class="subtitle">Tasks by priority</h3><ol class="tasks" id="wr-tasks"></ol></div>
      <div>
        <h3 class="subtitle">Hypotheses</h3><ol class="hyps" id="wr-hyps"><li class="hint">None yet.</li></ol>
        <h3 class="subtitle">Verified facts · <span id="wr-factcount">0</span> <span class="hint" id="wr-rejected"></span></h3><ol class="facts-list" id="wr-facts"></ol>
      </div>
    </div>
  </section>`;
}

function setLane(role, status, task = '') {
  const lane = $(`.lane[data-role="${role}"]`);
  if (!lane) return;
  lane.classList.toggle('working', status === 'working');
  lane.querySelector('.lane-status').textContent = status;
  lane.querySelector('.lane-task').textContent = task;
}

function renderTasks() {
  const order = { running: 0, parked: 1, queued: 2, done: 3, failed: 4, cancelled: 5 };
  const list = [...state.tasks.values()].sort((a, b) => order[a.status] - order[b.status] || a.priority - b.priority || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  $('#wr-tasks').innerHTML = list
    .map((t) => `<li><span class="prio p${t.priority}">P${t.priority}</span><span class="mono">${esc(t.id)}</span>${roleTag(t.role)}<span>${esc(t.title)}</span><span class="stamp ${t.status}">${t.status === 'parked' ? 'paused' : esc(t.status)}</span></li>`)
    .join('');
}

const hyps = new Map();
function renderHyps() {
  $('#wr-hyps').innerHTML =
    [...hyps.values()]
      .map((h) => `<li><span><span class="mono">${esc(h.id)}</span> <span class="stamp ${h.status}">${esc(h.status)}</span>${h.review ? ` <span class="stamp ${h.review.verdict}">skeptic: ${esc(h.review.verdict)}</span>` : ''}</span><span>${esc(h.statement)}</span><span class="hint">support ${esc(h.support.join(', '))}${h.review ? ` · ${esc(h.review.reason)}` : ''}</span></li>`)
      .join('') || '<li class="hint">None yet.</li>';
}

function renderFacts() {
  $('#wr-factcount').textContent = String(state.facts.length);
  $('#wr-facts').innerHTML = state.facts
    .slice(-8)
    .map((f, i, arr) => `<li><button data-fact="${state.facts.length - arr.length + i}"><span class="cite"><span class="stamp verified">${esc(f.id)}</span>${roleTag(f.by)} ${esc(f.artifact)} L${f.start_line}</span><span>${esc(f.claim)}</span></button></li>`)
    .join('');
  $('#wr-facts').querySelectorAll('button[data-fact]').forEach((b) => {
    const f = state.facts[Number(b.dataset.fact)];
    b.addEventListener('click', () => openSource(f, { status: 'verified', found_line: f.start_line }));
  });
}

function handle(e, id, isReplay = false) {
  if (state.current?.id !== id) return;
  const ms = (x) => (x.ms !== undefined ? `${x.ms}ms` : '');
  switch (e.type) {
    case 'start':
      if (e.mode === 'warroom') {
        hyps.clear();
        for (const r of ROLES) {
          const tier = e.tiers?.[r];
          const el = $(`.lane[data-role="${r}"] [data-tier]`);
          if (el) el.textContent = tier ? `${tier} · ${e.models?.[tier] ?? ''}` : '';
        }
      }
      line(roleTag(e.mode === 'warroom' ? 'commander' : null), `Opened case with ${e.artifacts} artifacts · skills r${e.skills?.revision ?? 0}`, esc(e.mode === 'warroom' ? `${e.concurrency} in parallel` : e.model));
      break;
    case 'thought':
      line(roleTag(e.role), `<span class="thought">${esc(e.text.slice(0, 400))}</span>`);
      break;
    case 'step':
      line(roleTag(e.role), `<span class="${e.error ? 'err' : ''}">${esc(e.label)}</span>`, ms(e));
      break;
    case 'assign':
    case 'resume': {
      const t = state.tasks.get(e.task);
      setLane(e.role, 'working', t ? `${t.id} · ${t.title}` : e.task);
      if (e.type === 'resume') line(roleTag(e.role), `<span class="verdict warn">Resumed ${esc(e.task)} with the changes it missed</span>`);
      break;
    }
    case 'preempt':
      setLane(e.role, 'paused', `${e.task} paused by ${e.by} (P${e.by_priority})`);
      verdict('warn', `${esc(ROLE_LABEL[e.role])} paused ${esc(e.task)} (P${e.priority}) for ${esc(e.by)} (P${e.by_priority}, ${esc(ROLE_LABEL[e.by_role])})`);
      break;
    case 'task':
      state.tasks.set(e.task.id, e.task);
      if ($('#wr-tasks')) renderTasks();
      if (['done', 'failed', 'cancelled'].includes(e.task.status)) {
        const lane = $(`.lane[data-role="${e.task.role}"] .lane-task`);
        if (lane && lane.textContent.startsWith(e.task.id)) setLane(e.task.role, 'idle');
      }
      if (e.reprioritized) verdict('warn', `${esc(e.task.id)} priority P${e.reprioritized.from} → P${e.reprioritized.to}: ${esc(e.reprioritized.reason)}`);
      break;
    case 'fact':
      state.facts.push(e.fact);
      if ($('#wr-facts')) renderFacts();
      line(roleTag(e.fact.by), `Posted <b>${esc(e.fact.id)}</b>: ${esc(e.fact.claim)}`);
      break;
    case 'fact_rejected':
      line(roleTag(e.by), `<span class="err">Fact rejected: ${esc(e.reason)}</span>`);
      state.rejected++;
      if ($('#wr-rejected')) $('#wr-rejected').textContent = `· ${state.rejected} rejected at the gate`;
      break;
    case 'hypothesis':
      hyps.set(e.hypothesis.id, e.hypothesis);
      if ($('#wr-hyps')) renderHyps();
      break;
    case 'message': {
      const m = e.message;
      const to = m.to === 'all' ? 'everyone' : ROLE_LABEL[m.to] ?? m.to;
      line(roleTag(ROLE_LABEL[m.from] ? m.from : null).replace('Agent', esc(m.from)), `<span class="msg">→ ${esc(to)} (${esc(m.kind)}): ${esc(m.text.slice(0, 220))}</span>`);
      break;
    }
    case 'live_update':
      $('#wr-updates')?.insertAdjacentHTML('beforeend', `<div class="notice bad"><b>Live update from ${esc(e.from)} (P${e.priority}):</b> ${esc(e.text)}</div>`);
      verdict('bad', `Live update from ${esc(e.from)}: ${esc(e.text)}`);
      break;
    case 'escalate':
      verdict('warn', `${esc(ROLE_LABEL[e.role])} escalated from ${esc(e.from)} to ${esc(e.to)}: ${esc(e.reason)}`);
      break;
    case 'conclusion':
      verdict('ok', `Commander concluded on ${esc(e.conclusion.hypothesis)}: ${esc(e.conclusion.summary)}`);
      break;
    case 'fix_check':
      verdict(e.accepted ? 'ok' : 'bad', e.accepted ? `Fixer's patch checked against source: ${STAMP[e.patch.status]}` : `Fixer's patch rejected: ${STAMP[e.patch.status]}`);
      break;
    case 'mitigation':
      verdict('warn', `Mitigation from ${esc(ROLE_LABEL[e.by] ?? e.by)}: ${esc(e.steps.join('; '))}`);
      break;
    case 'budget':
      verdict('warn', `Budget reached (${e.turns} turns, $${e.cost_usd}); commander must conclude now`);
      break;
    case 'agent_error':
      line(roleTag(e.role), `<span class="err">${esc(e.message.slice(0, 200))}</span>`);
      break;
    case 'heal':
      verdict('warn', `Reflex · ${esc(HEAL_LABEL[e.kind] ?? e.kind)}: ${esc(e.detail)}`);
      break;
    case 'quarantine':
      state.quarantined++;
      verdict('bad', `Prompt injection quarantined in ${esc(e.artifact)} L${e.line}: treated as data, not instructions`);
      break;
    case 'verification': {
      const bad = e.checks.filter((c) => c.status !== 'verified').length;
      const patchBad = e.patch.status === 'mismatch' || e.patch.status === 'missing_artifact';
      verdict(e.accepted ? 'ok' : 'bad', e.accepted ? `Verifier: all ${e.checks.length} citations found in source; patch matches` : `Verifier rejected ${bad} of ${e.checks.length} citations${patchBad ? ' and the patch' : ''}${e.round === 1 ? '; agent revising' : ''}`);
      break;
    }
    case 'report':
      for (const r of ROLES) setLane(r, 'idle');
      renderReport(e, isReplay);
      break;
    case 'error':
      $('#result').insertAdjacentHTML('beforeend', `<div class="notice bad">${esc(e.message)}</div>`);
      verdict('bad', `Stopped: ${esc(e.message.slice(0, 200))}`);
      break;
  }
}

function diffHtml(patch) {
  return esc(patch)
    .split('\n')
    .map((l) => (l.startsWith('+') && !l.startsWith('+++') ? `<span class="add">${l}</span>` : l.startsWith('-') && !l.startsWith('---') ? `<span class="del">${l}</span>` : l))
    .join('\n');
}

function renderReport(e, isReplay) {
  const r = e.report;
  const verified = e.checks.filter((c) => c.status === 'verified').length;
  const keep = isReplay ? $('#result').innerHTML : '';
  const conf = Math.round((r.confidence ?? 0) * 100);
  const cost = e.stats.cost_usd !== undefined ? ` · <strong>$${e.stats.cost_usd.toFixed(3)}</strong>` : '';
  $('#result').innerHTML =
    keep +
    `
    <section class="card diagnosis" aria-label="Diagnosis">
      <h2 class="section-title">Diagnosis${e.board ? ' · War Room' : ''}${e.forced ? ' · concluded on budget' : ''}</h2>
      <p class="summary">${esc(r.summary)}</p>
      <p class="root">${esc(r.root_cause)}</p>
      <div class="facts">
        <span><span class="meter"><i style="width:${conf}%"></i></span><strong>${conf}%</strong> confidence</span>
        <span>Category <strong>${esc(r.category)}</strong></span>
        <span><strong>${verified}/${e.checks.length}</strong> citations verified${e.revised ? ' after one revision' : ''}</span>
        <span><strong>${e.stats.steps}</strong> tool calls · <strong>${e.stats.seconds}s</strong>${cost}</span>
        ${state.quarantined ? `<span><strong>${state.quarantined}</strong> injection attempt${state.quarantined > 1 ? 's' : ''} quarantined</span>` : ''}
      </div>
    </section>
    ${r.mitigation?.length ? `<section class="card" aria-label="Mitigation"><h2 class="section-title">Mitigate now</h2><ul>${r.mitigation.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></section>` : ''}
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
    ${r.timeline?.length ? `<section class="card" aria-label="Timeline"><h2 class="section-title">Timeline</h2><ol class="timeline">${r.timeline.map((t) => `<li><time>${esc(t.time)}</time><span>${esc(t.event)}</span></li>`).join('')}</ol></section>` : ''}
    <section class="card" aria-label="Ruled out">
      <h2 class="section-title">Ruled out</h2>
      <ul class="ruled">${(r.ruled_out ?? []).map((h) => `<li><s>${esc(h.hypothesis)}</s><br><span class="hint">${esc(h.reason)}</span></li>`).join('') || '<li class="hint">Nothing recorded.</li>'}</ul>
    </section>
    <section class="card" aria-label="Proposed fix">
      <h2 class="section-title">Proposed fix</h2>
      <div class="cite"><span class="stamp ${e.patch.status}">${STAMP[e.patch.status]}</span>${e.sandbox ? `<span class="stamp ${e.sandbox.status === 'applied' ? 'ok' : 'failed'}">${e.sandbox.status === 'applied' ? 'Applied to isolated copy' : 'Did not apply'}</span>` : ''}${esc(r.fix.artifact)}</div>${e.sandbox?.status === 'failed' ? `<p class="hint">${esc(e.sandbox.reason)}</p>` : ''}
      <p>${esc(r.fix.explanation)}</p>
      <pre class="code diff">${diffHtml(r.fix.patch)}</pre>
      <details style="margin-top:16px"><summary>Regression test: ${esc(r.regression_test?.name)}</summary><pre class="code">${esc(r.regression_test?.code)}</pre></details>
    </section>
    ${e.change_request ? changeCard(e.change_request) : ''}
    <section class="card" aria-label="Next steps">
      <h2 class="section-title">Next steps</h2>
      <ul>${(r.next_steps ?? []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <details><summary>Check against hidden answer key: ${e.score.correct ? 'root cause matches' : 'root cause does not match'}</summary>
        <ul>${e.score.groups.map((g) => `<li>${g.hit ? '✓' : '✗'} mentions ${g.any.map(esc).join(' / ')}</li>`).join('')}<li>${e.score.fix_target_correct ? '✓' : '✗'} fix targets the expected file</li></ul>
      </details>
    </section>`;
  $('#result').querySelectorAll('button[data-ev]').forEach((b) => b.addEventListener('click', () => openSource(r.evidence[Number(b.dataset.ev)], e.checks[Number(b.dataset.ev)])));
  if (e.change_request) bindChangeCard(e.change_request.id);
}

async function openSource(ev, check) {
  showTab('source');
  const data = await getJson(`/api/incidents/${state.current.id}/artifact?path=${encodeURIComponent(ev.artifact)}`);
  if (!data) {
    $('#source').innerHTML = `<div class="source-head"><code>${esc(ev.artifact)}</code><span class="stamp missing_artifact">${STAMP.missing_artifact}</span></div><p class="hint">The agent cited a file that is not part of this incident.</p>`;
    return;
  }
  const span = Math.max(0, ev.end_line - ev.start_line);
  const from = check.found_line ?? ev.start_line;
  const to = check.found_line ? check.found_line + span : ev.end_line;
  $('#source').innerHTML = `
    <div class="source-head"><code>${esc(ev.artifact)}</code><span class="stamp ${check.status}">${STAMP[check.status]}${check.found_line ? ` · L${check.found_line}` : ''}</span></div>
    ${check.status === 'not_found' ? `<p class="notice bad">The quoted text does not appear in this file. Highlighted lines are what the agent cited.</p>` : ''}
    <div class="lines">${data.lines.map((l, i) => {
      const n = i + 1;
      return `<div class="${n >= from && n <= to ? 'hit' : ''}" ${n === from ? 'id="first-hit"' : ''}><span class="ln">${n}</span><span>${esc(l) || ' '}</span></div>`;
    }).join('')}</div>`;
  const hit = $('#first-hit');
  if (hit) $('#source').scrollTop = hit.offsetTop - $('#source').clientHeight / 2;
}

/* Governance: Go / No-Go */
const STATE_LABEL = { awaiting_approval: 'awaiting approval', completed: 'executed', failed: 'execution failed', denied: 'denied', vetoed: 'vetoed', expired: 'expired' };
const STATE_CLASS = { awaiting_approval: 'queued', completed: 'done', failed: 'failed', denied: 'refuted', vetoed: 'refuted', expired: 'cancelled' };
const KIND_LABEL = { remediation: 'production code change', 'skill-change': 'self-repair skill change', 'skill-rollback': 'skill rollback' };

function changeCard(c, compact = false) {
  const approvals = (c.decisions ?? []).filter((d) => d.decision === 'approve' && d.actor !== c.requester).length;
  const pending = c.state === 'awaiting_approval';
  return `<section class="${compact ? 'gate compact' : 'card gate'}" aria-label="Change approval ${esc(c.id)}" data-cr="${esc(c.id)}">
    <h2 class="section-title">${compact ? '' : 'Go / No-Go · '}${esc(c.id)}</h2>
    <p><span class="prio ${c.risk === 'A3' || c.risk === 'A4' ? 'p0' : 'p1'}">${esc(c.risk)}</span> ${esc(KIND_LABEL[c.kind] ?? c.kind)} · ${esc(c.title)}</p>
    <p class="hint">Requested by ${esc(c.requester)} · ${approvals} of ${c.required_approvals} distinct approvals · ${c.execution === 'simulated' ? 'execution simulated on an isolated copy' : 'executes inside IncidentLens'} · expires ${esc(new Date(c.expires_at).toLocaleTimeString())}</p>
    <p class="hint mono">change hash ${esc(c.hash.slice(0, 16))}… · ${esc(c.policy_version)}</p>
    <p><span class="stamp ${STATE_CLASS[c.state] ?? ''}">${esc(STATE_LABEL[c.state] ?? c.state)}</span> <span class="hint">${esc(c.rule ?? '')}</span></p>
    ${pending ? `<div class="actions"><input class="reason" aria-label="Reason for decision" placeholder="Reason (recorded in the audit log)" data-reason>
      <button class="btn small" data-decide="approve">Approve</button><button class="btn secondary small" data-decide="reject">Reject</button><button class="btn danger small" data-decide="veto">Veto</button></div>` : ''}
    <p class="error" data-error role="alert"></p>
    ${c.result?.diff ? `<pre class="code diff">${diffHtml(c.result.diff)}</pre>` : ''}
  </section>`;
}

function bindChangeCard(id) {
  const card = document.querySelector(`[data-cr="${CSS.escape(id)}"]`);
  if (!card) return;
  card.querySelectorAll('[data-decide]').forEach((b) =>
    b.addEventListener('click', async () => {
      const live = (await getJson('/api/changes'))?.changes.find((c) => c.id === id);
      if (!live) {
        card.querySelector('[data-error]').textContent = 'This change request is not in this server ledger (recorded run).';
        return;
      }
      const res = await fetch(`/api/changes/${encodeURIComponent(id)}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: b.dataset.decide, reason: card.querySelector('[data-reason]').value, hash: live.hash }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        card.querySelector('[data-error]').textContent = data.error ?? 'Decision refused.';
        return;
      }
      card.outerHTML = changeCard(data, card.classList.contains('compact'));
      bindChangeCard(id);
    }),
  );
}

/* Health and self-repair */
async function showHealth() {
  state.abort?.abort();
  state.current = null;
  markNav('health');
  $('#case').innerHTML = `<div class="alert-head"><span class="inc-meta">IncidentLens itself</span><h1>Health and self-repair</h1>
    <p class="alert-text">IncidentLens measures its own investigations. When an indicator breaches its objective, it investigates itself, changes only its skills, validates the change on canary incidents, and applies it live with no restart. Its constitution and every self-change are tamper-evident.</p></div><div id="health-body"><p class="hint">Loading…</p></div>`;
  $('#trail').innerHTML = `<p class="hint">Self-repair runs stream here.</p>`;
  showTab('trail');
  await refreshHealth();
}

async function refreshHealth() {
  const [h, skills, audit, changes] = await Promise.all([getJson('/api/health'), getJson('/api/skills'), getJson('/api/audit'), getJson('/api/changes')]);
  if (!h || !$('#health-body')) return;
  const breakers = Object.entries(h.reflexes.breakers ?? {});
  $('#health-body').innerHTML = `
    <section class="card"><h2 class="section-title">Indicators · last ${h.window} runs</h2>
      <table class="ind"><thead><tr><th>Indicator</th><th>Value</th><th>Objective</th><th>Status</th></tr></thead><tbody>
      ${h.slis.map((s) => `<tr><td>${esc(s.name.replace(/_/g, ' '))}</td><td class="num">${s.value ?? 'n/a'}</td><td class="num">${esc(s.objective)}</td><td><span class="stamp ${s.breached ? 'breached' : 'ok'}">${s.breached ? 'breached' : 'ok'}</span></td></tr>`).join('')}
      </tbody></table>
      <p class="hint">Constitution ${h.constitution.ok ? '<span class="stamp ok">hash verified</span>' : '<span class="stamp breached">tampered: self-changes locked</span>'} · Audit log ${h.audit.ok ? `<span class="stamp ok">chain intact · ${h.audit.length} entries</span>` : `<span class="stamp breached">broken at #${h.audit.broken_at}</span>`} · skills revision ${h.revision}</p>
    </section>
    <section class="card"><h2 class="section-title">Reflexes</h2>
      <p>${breakers.length ? breakers.map(([m, b]) => `<span class="chip">${esc(m)}: ${b.open ? 'circuit open' : `${b.failures} recent failures`}</span>`).join(' ') : '<span class="hint">All model circuits closed.</span>'}
      ${h.reflexes.rejected_params.length ? ` <span class="chip">adapted: ${esc(h.reflexes.rejected_params.join(', '))} not sent</span>` : ''}
      ${h.faults.map((f) => ` <span class="chip">fault: ${esc(f.kind)} ${esc(f.model)} until ${esc(new Date(f.until).toLocaleTimeString())}</span>`).join('')}</p>
    </section>
    <section class="card"><h2 class="section-title">Self-repair</h2>
      <div class="actions">
        <button class="btn" id="heal-run" ${isAdmin() ? '' : 'disabled'}>Run self-repair</button>
        <button class="btn secondary small" data-chaos="outage" ${isAdmin() ? '' : 'disabled'}>Simulate deep-model outage</button>
        <button class="btn secondary small" data-chaos="bad-skill" ${isAdmin() ? '' : 'disabled'}>Push a bad skill edit</button>
        <button class="btn secondary small" data-chaos="clear" ${isAdmin() ? '' : 'disabled'}>Clear faults</button>
      </div>
      ${isAdmin() ? '' : '<p class="hint">Self-repair and fault injection need an admin access code.</p>'}
      <ol class="healthlog" id="heal-log"></ol>
    </section>
    <section class="card"><h2 class="section-title">Change requests</h2>
      <p class="hint">Agents and the doctor only propose. Approval is bound to the exact change hash, the requester cannot approve, and a veto or expiry always wins. ${esc(changes?.policy?.version ?? '')}</p>
      <div class="actions"><button class="btn ${changes?.kill?.on ? '' : 'danger'} small" id="kill" ${isAdmin() ? '' : 'disabled'}>${changes?.kill?.on ? 'Lift kill switch' : 'Engage kill switch'}</button><span class="status">${changes?.kill?.on ? `Kill switch on (${esc(changes.kill.by)}): nothing executes except rollbacks` : 'Kill switch off'}</span></div>
      <div id="cr-list">${(changes?.changes ?? []).slice(0, 6).map((c) => changeCard(c, true)).join('') || '<p class="hint">No change requests yet.</p>'}</div>
    </section>
    <section class="card"><h2 class="section-title">Skills · live versions</h2>
      <table class="ind"><thead><tr><th>Skill</th><th>Kind</th><th>Active</th><th>Last change</th></tr></thead><tbody>
      ${(skills ?? []).map((s) => {
        const last = s.activations.at(-1);
        return `<tr><td><button class="linkish" data-skill="${esc(s.name)}" data-v="${s.active}" data-prev="${s.activations.at(-2)?.v ?? ''}">${esc(s.name)}</button></td><td>${esc(s.kind)}</td><td class="num">v${s.active} of ${s.versions.length}</td><td class="hint">${esc(last.author)} · ${esc(last.reason)}</td></tr>`;
      }).join('')}
      </tbody></table>
    </section>
    <section class="card"><h2 class="section-title">Audit log · newest first</h2>
      <table class="ind"><tbody>${(audit?.entries ?? []).slice(0, 12).map((a) => `<tr><td class="num">#${a.seq}</td><td>${esc(a.actor)}</td><td>${esc(a.action)} ${esc(a.target)}</td><td class="num">${esc(a.hash.slice(0, 10))}</td></tr>`).join('') || '<tr><td class="hint">No self-changes yet.</td></tr>'}</tbody></table>
    </section>`;
  $('#heal-run').addEventListener('click', runSelfRepair);
  document.querySelectorAll('[data-chaos]').forEach((b) => b.addEventListener('click', () => chaos(b.dataset.chaos)));
  document.querySelectorAll('[data-skill]').forEach((b) => b.addEventListener('click', () => openSkill(b.dataset.skill, Number(b.dataset.v), Number(b.dataset.prev) || 0)));
  (changes?.changes ?? []).slice(0, 6).forEach((c) => bindChangeCard(c.id));
  $('#kill').addEventListener('click', async () => {
    await fetch('/api/governance/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !changes?.kill?.on, reason: 'set from the health page' }) });
    refreshHealth();
  });
}

async function chaos(fault) {
  const res = await fetch('/api/chaos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fault, model: 'deep', seconds: 180 }) });
  const data = await res.json().catch(() => ({}));
  $('#heal-log').insertAdjacentHTML('beforeend', `<li>${res.ok ? (fault === 'bad-skill' ? `Pushed a bad edit: ${esc(data.skill)} v${data.version} is now live` : fault === 'outage' ? 'Deep model outage simulated for 3 minutes' : 'Faults cleared') : esc(data.error)}</li>`);
  await refreshHealth();
}

async function runSelfRepair() {
  $('#heal-run').disabled = true;
  $('#trail').innerHTML = `<ol class="steps" id="steps"></ol>`;
  const say = (cls, text) => verdict(cls, text);
  try {
    await readStream('/api/heal/run?force=1', (e) => {
      if (e.type === 'step') return line(roleTag(null).replace('Agent', 'Doctor'), esc(e.label), `${e.ms}ms`);
      if (e.type === 'heal') return say('warn', `Reflex · ${esc(HEAL_LABEL[e.kind] ?? e.kind)}: ${esc(e.detail)}`);
      if (e.type !== 'doctor') return;
      if (e.phase === 'assess') say(e.healthy ? 'ok' : 'bad', e.healthy ? 'All indicators within objectives' : `Breached: ${e.breaches.map((b) => `${b.name.replace(/_/g, ' ')} ${b.value}`).join(', ')}`);
      if (e.phase === 'case') say('warn', `Opened self-case ${esc(e.case)}: indicator table, skill diffs, failing-run transcripts`);
      if (e.phase === 'diagnose') say('warn', e.summary ? `Diagnosis: ${esc(e.summary)} → ${esc(e.action)} ${esc(e.skill ?? '')}` : esc(e.detail));
      if (e.phase === 'policy') say(e.ok ? 'ok' : 'bad', e.ok ? 'Policy guard: patch allowed' : `Policy guard blocked: ${esc(e.violations.map((v) => v.rule).join(', '))}`);
      if (e.phase === 'validate') say('warn', `Validating on canaries: ${esc(e.canaries.join(', '))}`);
      if (e.phase === 'validated') say(e.ok ? 'ok' : 'bad', `Validation ${e.ok ? 'passed' : 'failed'}`);
      if (e.phase === 'rollback') say('ok', `Rolled back ${esc(e.skill)} v${e.from} → v${e.to} (${esc(e.by)}): ${esc(e.reason)}. Live on the next run, no restart.`);
      if (e.phase === 'promote') say('ok', `Promoted ${esc(e.skill)} v${e.version}. Live on the next run, no restart.`);
      if (e.phase === 'done') say(e.action === 'rejected' ? 'bad' : 'ok', `Self-repair finished: ${esc(e.action)}${e.detail ? ` — ${esc(e.detail)}` : ''}`);
      if (e.phase === 'error') say('bad', esc(e.message));
    });
  } catch (err) {
    say('bad', esc(err.message));
  }
  await refreshHealth();
}

async function openSkill(name, v, prev) {
  showTab('source');
  const data = await getJson(`/api/skills/${encodeURIComponent(name)}?v=${v}${prev ? `&diff=${prev}` : ''}`);
  if (!data) return;
  const text = data.diff ?? data.content;
  $('#source').innerHTML = `<div class="source-head"><code>${esc(name)} v${v}</code>${prev ? `<span class="hint">changes since v${prev}</span>` : ''}</div>
    <div class="lines">${text.split('\n').map((l, i) => `<div class="${data.diff ? (l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '') : ''}"><span class="ln">${i + 1}</span><span>${esc(l) || ' '}</span></div>`).join('')}</div>`;
}

init();
