const T = window.CONSOLE_TOKEN;
const $ = id => document.getElementById(id);
const api = (p, q = '', opts = {}) => fetch(`/api/${p}?t=${T}${q}`, opts).then(r => r.json());
const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

const STATUSES = [
  { k: 'active', label: 'Active', match: i => i.status !== 'done' },
  { k: 'inprogress', label: 'In progress', match: i => i.status === 'inprogress' },
  { k: 'waiting', label: 'Waiting', match: i => i.status === 'waiting' },
  { k: 'done', label: 'Done', match: i => i.status === 'done' },
  { k: 'all', label: 'All', match: () => true }
];
const STATUS_LABEL = { open: 'open', inprogress: 'in progress', waiting: 'waiting', done: 'done' };
const PRIO_RANK = { high: 0, medium: 1, low: 2 };

let db = { version: 1, nextNum: 1, issues: [] };
let statusTab = 'active', todayFilter = null, openId = null, search = '', areaFilter = '';
let saveTimer = null, armedDelete = null;

/* ------------------------------------------------------------------ storage */

const todayStr = () => new Date().toLocaleDateString('en-CA');
const uid = () => 'i' + Math.random().toString(36).slice(2, 10);

function normalizeIssue(raw, idx) {
  const pick = (...keys) => { for (const k of keys) { if (raw[k] != null && raw[k] !== '') return raw[k]; } return undefined; };
  const subsRaw = pick('subtasks', 'tasks', 'checklist', 'steps') || [];
  const comsRaw = pick('comments', 'notes', 'log', 'entries') || [];
  const status = String(pick('status', 'state') || 'open').toLowerCase().replace(/[\s_-]/g, '');
  const prio = String(pick('priority', 'prio', 'severity') || 'medium').toLowerCase();
  return {
    id: pick('id', 'uid') || uid(),
    num: Number(pick('num', 'number', 'n', 'index')) || idx + 1,
    key: pick('key', 'ticket', 'jira', 'ticketKey') || '',
    title: pick('title', 'name', 'summary') || '(untitled)',
    description: pick('description', 'desc', 'body', 'details') || '',
    area: pick('area', 'category', 'component') || '',
    priority: ['high', 'medium', 'low'].includes(prio) ? prio : 'medium',
    status: ['open', 'inprogress', 'waiting', 'done'].includes(status) ? status : 'open',
    deadline: (pick('deadline', 'due', 'dueDate', 'due_date') || '').slice(0, 10),
    subtasks: (Array.isArray(subsRaw) ? subsRaw : []).map(s => typeof s === 'string'
      ? { text: s, done: false }
      : { text: s.text || s.label || s.title || '', done: !!(s.done ?? s.checked ?? s.complete) }),
    comments: (Array.isArray(comsRaw) ? comsRaw : []).map(c => typeof c === 'string'
      ? { at: '', text: c }
      : { at: c.at || c.date || c.when || c.createdAt || '', text: c.text || c.body || c.comment || c.note || '' }),
    createdAt: pick('createdAt', 'created') || '',
    updatedAt: pick('updatedAt', 'updated') || ''
  };
}

function normalizeDb(raw) {
  let issues = null;
  if (Array.isArray(raw)) issues = raw;
  else for (const path of [r => r.issues, r => r.data && r.data.issues, r => r.state && r.state.issues, r => r.tracker && r.tracker.issues]) {
    const v = path(raw || {});
    if (Array.isArray(v)) { issues = v; break; }
  }
  if (!issues) throw new Error('No issues array found in that file.');
  const list = issues.map(normalizeIssue);
  return { version: 1, nextNum: Math.max(0, ...list.map(i => i.num)) + 1, issues: list };
}

async function loadDb() {
  const raw = await api('tracker');
  db = (raw && Array.isArray(raw.issues)) ? raw : { version: 1, nextNum: 1, issues: [] };
  if (!db.nextNum) db.nextNum = Math.max(0, ...db.issues.map(i => i.num || 0)) + 1;
  renderTracker();
}

function save() {
  $('saveflag').textContent = 'saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const r = await api('tracker', '', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db)
    });
    $('saveflag').textContent = r.ok ? 'saved ' + new Date().toLocaleTimeString() : 'SAVE FAILED';
  }, 350);
}

function touch(issue) { issue.updatedAt = new Date().toISOString(); save(); }

/* ------------------------------------------------------------------ tracker render */

function dueClass(d, status) {
  if (!d || status === 'done') return '';
  const t = todayStr();
  if (d < t) return 'over';
  const in7 = new Date(Date.now() + 7 * 864e5).toLocaleDateString('en-CA');
  return d <= in7 ? 'soon' : '';
}

function counters() {
  const t = todayStr(), in7 = new Date(Date.now() + 7 * 864e5).toLocaleDateString('en-CA');
  const live = db.issues.filter(i => i.status !== 'done');
  return {
    overdue: live.filter(i => i.deadline && i.deadline < t).length,
    soon: live.filter(i => i.deadline && i.deadline >= t && i.deadline <= in7).length,
    high: live.filter(i => i.priority === 'high').length,
    inprogress: db.issues.filter(i => i.status === 'inprogress').length
  };
}

const TODAY_DEFS = [
  { k: 'overdue', label: 'Overdue', alert: true, match: i => i.status !== 'done' && i.deadline && i.deadline < todayStr() },
  { k: 'soon', label: 'Due in 7 days', match: i => i.status !== 'done' && i.deadline && i.deadline >= todayStr() && i.deadline <= new Date(Date.now() + 7 * 864e5).toLocaleDateString('en-CA') },
  { k: 'high', label: 'High priority', match: i => i.status !== 'done' && i.priority === 'high' },
  { k: 'inprogress', label: 'In progress', match: i => i.status === 'inprogress' }
];

function matchesSearch(i, q) {
  if (!q) return true;
  if (q.startsWith('#')) return String(i.num) === q.slice(1);
  const hay = [i.title, i.description, i.key, i.area, '#' + i.num,
    ...i.subtasks.map(s => s.text), ...i.comments.map(c => c.text)].join('\n').toLowerCase();
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}

function visibleIssues() {
  const st = STATUSES.find(s => s.k === statusTab);
  const tf = TODAY_DEFS.find(d => d.k === todayFilter);
  return db.issues
    .filter(i => (tf ? tf.match(i) : st.match(i)))
    .filter(i => !areaFilter || i.area === areaFilter)
    .filter(i => matchesSearch(i, search))
    .sort((a, b) => (a.status === 'done') - (b.status === 'done')
      || PRIO_RANK[a.priority] - PRIO_RANK[b.priority]
      || (a.deadline || '9999').localeCompare(b.deadline || '9999')
      || a.num - b.num);
}

function renderTracker() {
  const c = counters();
  $('today').innerHTML = TODAY_DEFS.map(d =>
    `<button data-today="${d.k}" class="${d.alert && c[d.k] ? 'alert ' : ''}${todayFilter === d.k ? 'on' : ''}">
       <div class="n">${c[d.k]}</div><div class="l">${d.label}</div></button>`).join('');

  $('statustabs').innerHTML = STATUSES.map(s =>
    `<button data-status="${s.k}" class="${statusTab === s.k && !todayFilter ? 'on' : ''}">${s.label}
       <span class="c">${db.issues.filter(s.match).length}</span></button>`).join('');

  const areas = [...new Set(db.issues.map(i => i.area).filter(Boolean))].sort();
  $('areaFilter').innerHTML = '<option value="">All areas</option>' +
    areas.map(a => `<option${a === areaFilter ? ' selected' : ''}>${esc(a)}</option>`).join('');

  const list = visibleIssues();
  $('issues').innerHTML = list.length
    ? list.map(renderIssue).join('')
    : '<div class="empty">Nothing here. Clear the filters, or add an issue.</div>';
}

function renderIssue(i) {
  const doneSubs = i.subtasks.filter(s => s.done).length;
  const open = i.id === openId;
  return `<div class="issue${open ? ' open' : ''}" data-id="${i.id}">
    <div class="irow" data-act="toggle">
      <div class="inum">#${i.num}</div>
      <div class="imain">
        <div class="ititle${i.status === 'done' ? ' done' : ''}">${esc(i.title)}</div>
        <div class="imeta">
          <span class="chip st-${i.status}">${STATUS_LABEL[i.status]}</span>
          ${i.priority !== 'low' ? `<span class="chip ${i.priority === 'high' ? 'hi' : 'med'}">${i.priority}</span>` : ''}
          ${i.area ? `<span class="chip">${esc(i.area)}</span>` : ''}
          ${i.key ? `<span class="chip">${esc(i.key)}</span>` : ''}
          ${i.subtasks.length ? `<span>☑ ${doneSubs}/${i.subtasks.length}</span>` : ''}
          ${i.deadline ? `<span class="due ${dueClass(i.deadline, i.status)}">due ${i.deadline}</span>` : ''}
        </div>
      </div>
    </div>
    ${open ? renderDetail(i) : ''}
  </div>`;
}

function renderDetail(i) {
  return `<div class="idetail">
    <div class="sect">
      <label class="f">Title</label>
      <input style="width:100%" data-field="title" value="${esc(i.title)}">
    </div>
    <div class="fields">
      <div><label class="f">Status</label>
        <select data-field="status" style="width:100%">${['open', 'inprogress', 'waiting', 'done']
          .map(s => `<option value="${s}"${i.status === s ? ' selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></div>
      <div><label class="f">Priority</label>
        <select data-field="priority" style="width:100%">${['high', 'medium', 'low']
          .map(s => `<option value="${s}"${i.priority === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label class="f">Area</label><input style="width:100%" data-field="area" value="${esc(i.area)}"></div>
      <div><label class="f">Ticket</label><input style="width:100%" data-field="key" value="${esc(i.key)}"></div>
      <div><label class="f">Deadline</label><input type="date" style="width:100%" data-field="deadline" value="${esc(i.deadline)}"></div>
    </div>
    <div class="sect">
      <label class="f">Description</label>
      <textarea data-field="description">${esc(i.description)}</textarea>
    </div>
    <div class="sect">
      <h4>Subtasks ${i.subtasks.length ? `(${i.subtasks.filter(s => s.done).length}/${i.subtasks.length})` : ''}</h4>
      ${i.subtasks.map((s, n) => `<div class="subtask">
          <input type="checkbox" data-act="subtoggle" data-n="${n}"${s.done ? ' checked' : ''}>
          <span class="${s.done ? 'done' : ''}">${esc(s.text)}</span>
          <button class="link" data-act="subdel" data-n="${n}">remove</button>
        </div>`).join('')}
      <div class="addrow">
        <input data-act="subinput" placeholder="Add a subtask, press Enter">
        <button data-act="subadd">Add</button>
      </div>
    </div>
    <div class="sect">
      <h4>Comments &mdash; private, local only</h4>
      ${i.comments.length ? i.comments.map((c, n) => `<div class="comment">
          <div class="when">${esc(c.at ? new Date(c.at).toLocaleString() : '')}
            <button class="link" data-act="comdel" data-n="${n}">delete</button></div>
          <div class="body">${esc(c.text)}</div>
        </div>`).join('') : '<div class="sub">No comments yet.</div>'}
      <div class="addrow">
        <input data-act="cominput" placeholder="Add a comment, press Enter">
        <button data-act="comadd">Add</button>
      </div>
    </div>
    <div class="foot">
      <span class="sub">${i.updatedAt ? 'updated ' + new Date(i.updatedAt).toLocaleString() : ''}</span>
      <span class="spacer"></span>
      <button class="danger" data-act="del">${armedDelete === i.id ? 'Click again to delete #' + i.num : 'Delete issue'}</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ tracker events */

$('issues').addEventListener('click', e => {
  const wrap = e.target.closest('.issue');
  if (!wrap) return;
  const issue = db.issues.find(i => i.id === wrap.dataset.id);
  const act = e.target.closest('[data-act]')?.dataset.act;
  const n = Number(e.target.closest('[data-act]')?.dataset.n);

  if (act === 'toggle') { openId = openId === issue.id ? null : issue.id; armedDelete = null; renderTracker(); return; }
  if (act === 'subtoggle') { issue.subtasks[n].done = e.target.checked; touch(issue); renderTracker(); return; }
  if (act === 'subdel') { issue.subtasks.splice(n, 1); touch(issue); renderTracker(); return; }
  if (act === 'subadd') { addSubtask(issue, wrap.querySelector('[data-act=subinput]')); return; }
  if (act === 'comdel') { issue.comments.splice(n, 1); touch(issue); renderTracker(); return; }
  if (act === 'comadd') { addComment(issue, wrap.querySelector('[data-act=cominput]')); return; }
  if (act === 'del') {
    if (armedDelete !== issue.id) { armedDelete = issue.id; renderTracker(); setTimeout(() => { if (armedDelete === issue.id) { armedDelete = null; renderTracker(); } }, 6000); return; }
    db.issues = db.issues.filter(x => x.id !== issue.id);
    armedDelete = null; openId = null; save(); renderTracker();
  }
});

function addSubtask(issue, input) {
  const v = input.value.trim();
  if (!v) return;
  issue.subtasks.push({ text: v, done: false });
  input.value = '';
  touch(issue); renderTracker();
}
function addComment(issue, input) {
  const v = input.value.trim();
  if (!v) return;
  issue.comments.push({ at: new Date().toISOString(), text: v });
  input.value = '';
  touch(issue); renderTracker();
}

$('issues').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const act = e.target.dataset.act;
  const issue = db.issues.find(i => i.id === e.target.closest('.issue').dataset.id);
  if (act === 'subinput') { e.preventDefault(); addSubtask(issue, e.target); }
  if (act === 'cominput') { e.preventDefault(); addComment(issue, e.target); }
});

$('issues').addEventListener('input', e => {
  const f = e.target.dataset.field;
  if (!f) return;
  const issue = db.issues.find(i => i.id === e.target.closest('.issue').dataset.id);
  issue[f] = e.target.value;
  touch(issue);
});

$('issues').addEventListener('change', e => {
  if (['status', 'priority', 'deadline'].includes(e.target.dataset.field)) renderTracker();
});

$('today').addEventListener('click', e => {
  const b = e.target.closest('[data-today]');
  if (!b) return;
  todayFilter = todayFilter === b.dataset.today ? null : b.dataset.today;
  renderTracker();
});
$('statustabs').addEventListener('click', e => {
  const b = e.target.closest('[data-status]');
  if (!b) return;
  statusTab = b.dataset.status; todayFilter = null; renderTracker();
});
$('q').addEventListener('input', e => { search = e.target.value.trim(); renderTracker(); });
$('areaFilter').addEventListener('change', e => { areaFilter = e.target.value; renderTracker(); });

$('newIssue').addEventListener('click', () => {
  const issue = normalizeIssue({ title: '', status: 'open', priority: 'medium' }, 0);
  issue.num = db.nextNum++;
  issue.title = 'New issue';
  issue.createdAt = new Date().toISOString();
  db.issues.unshift(issue);
  openId = issue.id; statusTab = 'active'; todayFilter = null; search = ''; $('q').value = '';
  save(); renderTracker();
  document.querySelector(`[data-id="${issue.id}"] [data-field=title]`)?.select();
});

$('backup').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `accessng-tracker-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('restore').addEventListener('click', () => $('restoreFile').click());
$('restoreFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const incoming = normalizeDb(JSON.parse(await file.text()));
    const keep = db.issues.length;
    if (keep && !window.confirm(`Replace the ${keep} issue(s) in this console with ${incoming.issues.length} from ${file.name}?\n\nThe current data is kept in data\\backups\\.`)) return;
    db = incoming;
    save(); renderTracker();
    $('saveflag').textContent = `imported ${incoming.issues.length}`;
  } catch (err) {
    alert('Could not import that file: ' + err.message);
  } finally { e.target.value = ''; }
});

/* ------------------------------------------------------------------ deploy */

let dstate = null, offset = 0, armed = false, tailing = false, lastPhase = null;

function renderChanges(el, list, label) {
  if (!list || !list.length) { el.innerHTML = ''; return; }
  const items = list.slice(0, 25).map(c => `<li><code>${esc(c.short)}</code> ${esc(c.subject)}</li>`).join('');
  const more = list.length > 25 ? `<li>&hellip; and ${list.length - 25} more</li>` : '';
  el.innerHTML = `<details class="changes"><summary>${list.length} commit${list.length === 1 ? '' : 's'} ${label}</summary><ul>${items}${more}</ul></details>`;
}

function renderDeploy(s) {
  dstate = s;
  if (!s.ok) {
    $('m-ref').textContent = s.error || 'repo unavailable';
    $('go-test').disabled = $('go-ng').disabled = true;
    return;
  }
  $('fetched').textContent = 'fetched ' + new Date(s.fetchedAt).toLocaleTimeString();
  $('m-ref').innerHTML = `structure_update <span class="sha">${esc(s.master.short)}</span>`;
  $('m-sub').textContent = s.master.subject;

  const cell = (node, pill, info) => {
    if (!info) { $(node).textContent = 'nothing deployed yet'; $(pill).innerHTML = ''; return; }
    $(node).innerHTML = `${esc(info.name)} <span class="sha">${esc(info.short)}</span>`;
    $(pill).innerHTML = info.current ? '<span class="pill ok">up to date with master</span>'
                                     : '<span class="pill warn">behind master</span>';
  };
  cell('t-ref', 't-pill', s.test);
  cell('p-ref', 'p-pill', s.prod);

  const tp = s.plans.accesstest;
  const verb = { create: 'Cut', update: 'Fast-forward', redeploy: 'Re-deploy' }[tp.action];
  $('test-plan').innerHTML = `${verb} <span class="ref">${esc(tp.branch)}</span> at <span class="sha">${esc(tp.short)}</span>, then build and upload to <b>accesstest</b>.`;
  renderChanges($('test-changes'), tp.changes, 'since the last test release');

  const np = s.plans.accessNG;
  if (np.ready) {
    $('ng-plan').innerHTML =
      `Promote <span class="ref">${esc(np.source)}</span> <span class="sha">${esc(np.short)}</span> to <span class="ref">${esc(np.branch)}</span>, then build and upload to <b>accessNG</b>.`
      + (np.alreadyLive ? '<br><b>This exact commit is already live in production.</b>' : '')
      + (np.staleCandidate ? '<br><b>The candidate is behind master</b> — work merged since it was cut will not ship.' : '');
    renderChanges($('ng-changes'), np.changes, 'not yet in production');
  } else {
    $('ng-plan').textContent = np.reason;
    $('ng-changes').innerHTML = '';
  }

  const running = s.job.running;
  $('go-test').disabled = running;
  $('go-ng').disabled = running || !np.ready;
  if (running) disarm();
  if (s.job.hasLog) $('console').classList.add('on');
  if (running && !tailing) startTail();
}

function disarm() { armed = false; $('ng-arm').innerHTML = ''; $('go-ng').textContent = 'Promote & deploy accessNG'; }

$('go-ng').addEventListener('click', () => {
  const np = dstate.plans.accessNG;
  if (!armed) {
    armed = true;
    $('ng-arm').innerHTML = `<div class="arm"><b>This goes to production.</b>Confirm accesstest was tested and signed off on
      <code>${esc(np.source)}</code> (<code>${esc(np.short)}</code>). Click again to deploy.</div>`;
    $('go-ng').textContent = 'Yes — deploy to production';
    setTimeout(() => { if (armed) disarm(); }, 20000);
    return;
  }
  disarm();
  startDeploy('accessNG');
});
$('go-test').addEventListener('click', () => startDeploy('accesstest'));
$('refresh').addEventListener('click', () => loadDeploy(true));

async function startDeploy(env) {
  $('go-test').disabled = $('go-ng').disabled = true;
  banner('', null);
  const r = await api('deploy', `&env=${env}`);
  if (!r.ok) { banner(r.error, 'bad'); loadDeploy(); return; }
  offset = 0; lastPhase = null;
  $('c-log').textContent = '';
  $('c-prog').style.width = '0';
  $('console').classList.add('on');
  $('c-status').textContent = `deploying ${env} — ${r.branch}`;
  startTail();
}

function banner(text, kind) {
  const b = $('banner');
  b.className = 'banner' + (kind ? ' on ' + kind : '');
  b.textContent = text;
}

function progressFrom(text) {
  let phase = null, pct = null;
  for (const l of text.split('\n')) {
    const p = l.match(/^===\s*(.+?)\s*===/);
    if (p) { phase = p[1]; pct = null; }
    const m = l.match(/\[(backup|upload)\]\s+\d+\/\d+\s+\(([\d.]+)%\)/);
    if (m) pct = parseFloat(m[2]);
    if (/\[(backup|upload)\] DONE/.test(l)) pct = 100;
  }
  return { phase, pct };
}

function startTail() {
  if (tailing) return;
  tailing = true;
  const tick = async () => {
    const r = await api('log', `&from=${offset}`);
    if (r.text) {
      offset = r.offset;
      const pre = $('c-log');
      const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
      pre.textContent += r.text;
      if (stick) pre.scrollTop = pre.scrollHeight;
      const p = progressFrom(r.text);
      if (p.phase) lastPhase = p.phase;
      if (lastPhase) $('c-status').textContent = lastPhase;
      if (p.pct != null) { $('c-prog').style.width = p.pct + '%'; $('c-pct').textContent = p.pct.toFixed(0) + '%'; }
    }
    if (r.job.running) { setTimeout(tick, 1200); return; }
    const final = await api('log', `&from=${offset}`);
    if (final.text) {
      offset = final.offset;
      $('c-log').textContent += final.text;
      $('c-log').scrollTop = $('c-log').scrollHeight;
    }
    tailing = false;
    const ok = final.job.exitCode === 0;
    $('c-prog').style.width = ok ? '100%' : '0';
    $('c-status').textContent = ok ? 'finished' : 'failed';
    banner(ok ? `${final.job.branch} deployed to ${final.job.env}.`
              : `Deploy of ${final.job.branch} to ${final.job.env} failed — see the log above. The previous release is still live.`,
           ok ? 'ok' : 'bad');
    loadDeploy(true);
  };
  tick();
}

async function loadDeploy(refresh) {
  $('refresh').disabled = true;
  $('refresh').textContent = refresh ? 'Fetching…' : 'Refresh from origin';
  try { renderDeploy(await api('state', refresh ? '&refresh=1' : '')); }
  finally { $('refresh').disabled = false; $('refresh').textContent = 'Refresh from origin'; }
}

/* ------------------------------------------------------------------ shell */

let deployLoaded = false;
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + b.dataset.view));
  localStorage.setItem('console-tab', b.dataset.view);
  if (b.dataset.view === 'deploy' && !deployLoaded) { deployLoaded = true; loadDeploy(true); }
}));

const startTabName = localStorage.getItem('console-tab');
if (startTabName === 'deploy') document.querySelector('.tabs button[data-view=deploy]').click();

loadDb();
setInterval(() => { if (deployLoaded && !tailing) loadDeploy(); }, 30000);
