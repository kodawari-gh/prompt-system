'use strict';
// Prompt System dashboard. Vanilla JS; all text goes through textContent, never innerHTML.

// ---------- helpers ----------
const h = (tag, attrs, ...kids) => {
  const el = tag === 'svg' || tag === 'polyline' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && !(el instanceof SVGElement)) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const usd = (n) => '$' + (n || 0).toFixed(2);
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
const kt = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const pill = (cls, text) => h('span', { class: `pill p-${cls}` }, text || cls);
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };

async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'X-Runner': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

const VIEWS_IDS = ['overview', 'tasks', 'live', 'costs', 'prompt'];

// ---------- state ----------
const S = {
  cfg: { projects: [], runs: [] }, pid: ls.get('pid', ''), view: ls.get('view', 'overview'),
  todo: { exists: false, raw: '', tasks: [] }, costs: { rows: [], byModel: [], total: 0, runs: 0, committed: 0 }, git: { commits: [], dirty: 0, isRepo: true },
  selected: new Set(), expanded: new Set(), fState: ls.get('fState', 'open'), fTag: ls.get('fTag', 'all'), raw: false, notes: '',
  opts: ls.get('opts', { allowDirty: false, maxTurns: 60, maxBudgetUsd: 1.5, autocompact: 150000, visualFloor: true }), prompt: '',
};
{ // deep links: ?view=tasks&project=my-repo
  const q = new URLSearchParams(location.search);
  if (VIEWS_IDS.includes(q.get('view'))) S.view = q.get('view');
  if (q.get('project')) S.pid = q.get('project');
}
const project = () => S.cfg.projects.find((p) => p.id === S.pid);
const runsOf = () => S.cfg.runs.filter((r) => r.projectId === S.pid);
const activeRun = () => runsOf().find((r) => r.status === 'running');
const latestRun = () => activeRun() || runsOf().slice(-1)[0];

// ---------- data ----------
let lastSig = '';
async function refresh(force) {
  try {
    S.cfg = { ...S.cfg, ...(await api('/api/state')) };
    if (!project()) S.pid = S.cfg.projects[0]?.id || '';
    ls.set('pid', S.pid);
    if (S.pid) {
      const base = `/api/projects/${S.pid}`;
      [S.todo, S.costs, S.git] = await Promise.all([api(`${base}/todo`), api(`${base}/costs`), api(`${base}/git`)]);
    }
  } catch (e) { /* server down: keep the last view */ }
  const sig = JSON.stringify([S.cfg, S.todo.raw, S.costs, S.git, S.pid, S.view]);
  if (force || sig !== lastSig) { lastSig = sig; render(); }
}
function schedule() { setTimeout(async () => { await refresh(); schedule(); }, activeRun() ? 1200 : 5000); }

// ---------- chrome ----------
const VIEWS = [['overview', 'Overview'], ['tasks', 'Tasks'], ['live', 'Live'], ['costs', 'Costs'], ['prompt', 'Update prompt']];
function go(v) { S.view = v; ls.set('view', v); lastSig = ''; refresh(true); }

function renderSide() {
  const side = document.getElementById('side');
  const ar = activeRun();
  const open = S.todo.tasks.filter((t) => t.status === 'open' && t.tag === 'auto').length;
  side.replaceChildren(
    h('div', { class: 'brand' }, h('i', { class: ar ? 'live' : '' }), 'Prompt System'),
    h('div', {},
      h('div', { class: 'label' }, 'Project'),
      S.cfg.projects.length
        ? h('select', { onchange: (e) => { S.pid = e.target.value; S.selected.clear(); ls.set('pid', S.pid); lastSig = ''; refresh(true); } },
          S.cfg.projects.map((p) => h('option', { value: p.id, selected: p.id === S.pid }, p.name)))
        : h('div', { class: 'muted' }, 'None yet'),
      h('div', { class: 'row', style: 'margin-top:.5rem' },
        h('button', { class: 'btn small', onclick: addProjectDialog }, 'Add repo'),
        project() && h('button', { class: 'btn small', onclick: settingsDialog }, 'Settings'))),
    h('nav', { class: 'nav' }, VIEWS.map(([id, name]) => h('button', { class: S.view === id ? 'on' : '', onclick: () => go(id) }, name,
      id === 'tasks' && open ? h('span', { class: 'badge' }, open) : id === 'live' && ar ? h('span', { class: 'badge' }, '●') : null))),
    h('div', { class: 'foot muted' },
      h('div', { class: 'mono' }, S.cfg.claudeBin ? 'claude: found' : 'claude: NOT FOUND'),
      h('div', { class: 'mono' }, S.cfg.bashBin ? 'bash: found' : 'bash: NOT FOUND')));
}
function renderTop() {
  const p = project();
  const title = (VIEWS.find((v) => v[0] === S.view) || [])[1] || '';
  const ar = activeRun();
  const top = document.getElementById('top');
  top.replaceChildren();
  top.append(h('div', {}, h('h1', {}, title), h('div', { class: 'sub mono' }, p ? p.path : 'Add a repo to begin')));
  if (ar) top.append(h('div', { class: 'row' }, pill('run', `running ${ar.currentId || ''}`), h('button', { class: 'btn small', onclick: () => go('live') }, 'Watch')));
}

// ---------- overview ----------
function stat(n, d, label) { return h('div', { class: 'card stat' }, h('h3', {}, label), h('div', { class: 'n' }, n), h('div', { class: 'd' }, d)); }
function viewOverview() {
  if (!project()) return emptyNoProject();
  const t = S.todo.tasks, c = S.costs;
  const openAuto = t.filter((x) => x.status === 'open' && x.tag === 'auto').length;
  const needsYou = t.filter((x) => x.status === 'open' && x.tag !== 'auto').length;
  const done = t.filter((x) => x.status === 'done').length;
  const avg = c.committed ? c.total / c.committed : 0;
  const ar = activeRun();
  return h('div', {},
    !S.todo.exists ? noTodoCard() : null,
    h('div', { class: 'grid' },
      stat(openAuto, 'ready for the runner', 'Open auto tasks'), stat(done, `of ${t.length} tasks`, 'Done'),
      stat(needsYou, 'human checks and owner decisions', 'Waiting on you'), stat(usd(c.total), `${c.runs} run${c.runs === 1 ? '' : 's'}`, 'Spend'),
      stat(usd(avg), 'per committed task', 'Average cost')),
    S.git.dirty ? h('div', { class: 'card', style: 'margin-top:1rem' }, pill('attention', `${S.git.dirty} uncommitted change${S.git.dirty > 1 ? 's' : ''}`), ' ',
      h('span', { class: 'muted' }, 'The runner refuses to start on a dirty tree unless you allow it in the run options.')) : null,
    h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h3', {}, `Recent commits${S.git.branch ? ' · ' + S.git.branch : ''}`),
        S.git.commits.length ? h('table', {}, h('tbody', {}, S.git.commits.map((m) => h('tr', {}, h('td', { class: 'mono' }, m.hash), h('td', {}, m.subject), h('td', { class: 'muted num nowrap' }, m.when))))) : h('div', { class: 'muted' }, S.git.isRepo ? 'No commits' : 'Not a git repo')),
      h('div', { class: 'card' }, h('h3', {}, 'Recent runs'),
        c.rows.length ? runsTable(c.rows.slice(-8).reverse()) : h('div', { class: 'muted' }, 'Nothing has run yet.')),
      ar ? h('div', { class: 'card' }, h('h3', {}, 'Running now'), h('div', {}, `${ar.currentId || '…'} · ${ar.live ? ar.live.turns + ' turns · ' + (ar.live.lastAction || '') : 'starting'}`),
        h('button', { class: 'btn small', style: 'margin-top:.7rem', onclick: () => go('live') }, 'Open live view')) : null));
}
function runsTable(rows) {
  return h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Task'), h('th', {}, 'Model'), h('th', {}, 'Result'), h('th', { class: 'num' }, 'Turns'), h('th', { class: 'num' }, 'Cost'))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', { class: 'mono' }, r.task), h('td', {}, pill(r.model)),
      h('td', {}, pill(r.committed && r.outcome === 'success' ? 'done' : 'attention', r.committed ? (r.outcome === 'success' ? 'committed' : r.outcome) : r.outcome === 'success' ? 'no change' : r.outcome)),
      h('td', { class: 'num' }, r.turns), h('td', { class: 'num' }, usd(r.usd))))));
}
function emptyNoProject() {
  return h('div', { class: 'empty' }, h('div', {}, 'No repo selected.'), h('button', { class: 'btn primary', onclick: addProjectDialog }, 'Add a repo'));
}
function noTodoCard() {
  const p = project();
  return h('div', { class: 'card', style: 'margin-bottom:1rem' }, h('h3', {}, 'No TODO file'),
    h('div', { class: 'muted' }, `Expected ${p.todoFile} in this repo.`),
    h('div', { class: 'row', style: 'margin-top:.7rem' }, h('button', { class: 'btn primary', onclick: async () => { try { await api(`/api/projects/${p.id}/init`, 'POST'); toast('TODO created from the template'); refresh(true); } catch (e) { toast(e.message); } } }, 'Create from template'),
      h('button', { class: 'btn', onclick: () => go('prompt') }, 'Or have Claude write it')));
}

// ---------- tasks ----------
function viewTasks() {
  if (!project()) return emptyNoProject();
  if (!S.todo.exists) return noTodoCard();
  const chip = (key, val, label, setter) => h('button', { class: 'chip' + (S[key] === val ? ' on' : ''), onclick: () => { setter(val); ls.set(key, val); render(); } }, label);
  const tasks = S.todo.tasks.filter((t) => (S.fState === 'all' || t.status === (S.fState === 'open' ? 'open' : 'done')) && (S.fTag === 'all' || t.tag === S.fTag));
  const groups = [...new Set(tasks.map((t) => t.group))];
  return h('div', {},
    h('div', { class: 'row', style: 'margin-bottom:1rem' },
      h('div', { class: 'chips', style: 'margin:0' },
        chip('fState', 'open', 'Open', (v) => (S.fState = v)), chip('fState', 'done', 'Done', (v) => (S.fState = v)), chip('fState', 'all', 'All', (v) => (S.fState = v))),
      h('div', { class: 'chips', style: 'margin:0' },
        ['all', 'auto', 'human', 'owner'].map((t) => chip('fTag', t, t === 'all' ? 'Any tag' : t, (v) => (S.fTag = v)))),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => { S.raw = !S.raw; render(); } }, S.raw ? 'Task list' : 'Raw markdown')),
    S.raw ? h('pre', { class: 'prompt' }, S.todo.raw)
      : tasks.length ? groups.map((g) => [h('div', { class: 'group' }, g), tasks.filter((t) => t.group === g).map(taskRow)]) : h('div', { class: 'empty' }, 'No tasks match.'));
}
function taskRow(t) {
  const runnable = t.status === 'open' && t.tag === 'auto';
  const open = S.expanded.has(t.id);
  const ar = activeRun();
  return h('div', { class: 'task' + (t.status === 'done' ? ' done' : '') },
    runnable ? h('input', { type: 'checkbox', checked: S.selected.has(t.id), disabled: !!ar, onchange: (e) => { e.target.checked ? S.selected.add(t.id) : S.selected.delete(t.id); renderRunbar(); } }) : h('span'),
    h('span', { class: 'id' }, t.id),
    h('span', { class: 'title', onclick: () => { open ? S.expanded.delete(t.id) : S.expanded.add(t.id); render(); } }, t.title),
    h('span', { class: 'meta' }, t.status !== 'open' ? pill(t.status === 'done' ? 'done' : 'deferred') : null, pill(t.tag),
      t.tag === 'auto' ? pill(t.effModel, t.floored ? `${t.effModel} (visual floor)` : t.effModel) : null),
    open ? h('div', { class: 'more' },
      t.files && h('div', {}, h('b', {}, 'Files '), t.files), t.docs && h('div', {}, h('b', {}, 'Docs '), t.docs),
      t.testPattern && h('div', {}, h('b', {}, 'Test pattern '), t.testPattern), t.doneWhen && h('div', {}, h('b', {}, 'Done when '), t.doneWhen)) : null);
}
function renderRunbar() {
  document.getElementById('runbar')?.remove();
  if (S.view !== 'tasks' || !project()) return;
  const ar = activeRun();
  const n = S.selected.size;
  if (!n && !ar) return;
  const o = S.opts;
  const save = () => ls.set('opts', S.opts);
  const num = (key, step) => h('input', { type: 'number', value: o[key], step, onchange: (e) => { o[key] = Number(e.target.value); save(); } });
  const bar = h('div', { class: 'runbar', id: 'runbar' },
    ar ? h('div', { class: 'grow' }, `A run is active (${ar.ids.join(', ')}).`)
      : h('div', { class: 'grow' }, h('div', {}, h('b', {}, `${n} selected`), h('span', { class: 'muted mono' }, '  ' + [...S.selected].join(' '))),
        h('div', { class: 'opts', style: 'margin-top:.4rem' },
          h('label', {}, h('input', { type: 'checkbox', checked: o.allowDirty, onchange: (e) => { o.allowDirty = e.target.checked; save(); } }), 'allow dirty tree'),
          h('label', {}, h('input', { type: 'checkbox', checked: o.visualFloor, onchange: (e) => { o.visualFloor = e.target.checked; save(); } }), 'sonnet floor for visual tasks'),
          h('label', {}, 'turns', num('maxTurns', 5)), h('label', {}, '$ cap', num('maxBudgetUsd', 0.25)), h('label', {}, 'compact at', num('autocompact', 10000)))),
    ar ? h('button', { class: 'btn', onclick: () => go('live') }, 'Watch live')
      : [h('button', { class: 'btn', onclick: () => { S.selected = new Set(S.todo.tasks.filter((t) => t.status === 'open' && t.tag === 'auto').map((t) => t.id)); render(); } }, 'Select all open auto'),
        h('button', { class: 'btn', onclick: () => { S.selected.clear(); render(); } }, 'Clear'),
        h('button', { class: 'btn primary', onclick: startRun }, `Run ${n} task${n > 1 ? 's' : ''}`)]);
  document.body.append(bar);
}
async function startRun() {
  const ids = S.todo.tasks.filter((t) => S.selected.has(t.id)).map((t) => t.id);
  try {
    await api(`/api/projects/${S.pid}/run`, 'POST', { ids, ...S.opts });
    S.selected.clear();
    toast(`Started ${ids.length} task${ids.length > 1 ? 's' : ''}`);
    go('live');
  } catch (e) { toast(e.message); }
}

// ---------- live ----------
function viewLive() {
  if (!project()) return emptyNoProject();
  const r = latestRun();
  if (!r) return h('div', { class: 'empty' }, h('div', {}, 'No run yet in this session.'), h('button', { class: 'btn primary', onclick: () => go('tasks') }, 'Pick tasks to run'));
  const active = r.status === 'running';
  const state = (id) => {
    const x = r.results[id];
    if (x) return x.committed && x.outcome === 'success' ? 'done' : 'attention';
    return id === r.currentId && active ? 'run' : 'queued';
  };
  const live = r.live;
  const cap = r.opts?.autocompact || 150000;
  const pct = live ? Math.min(100, (live.ctx / cap) * 100) : 0;
  const spent = Object.values(r.results).reduce((s, x) => s + x.usd, 0);
  return h('div', {},
    h('div', { class: 'row', style: 'margin-bottom:1rem' }, pill(r.status), h('span', { class: 'muted' }, `${active ? 'started' : 'took'} ${dur((r.endedAt || Date.now()) - r.startedAt)}${active ? ' ago' : ''} · ${usd(spent)} so far`),
      h('div', { class: 'spacer' }), active ? h('button', { class: 'btn danger', onclick: async () => { await api(`/api/runs/${r.id}/stop`, 'POST'); toast('Stopping…'); } }, 'Stop run') : null),
    h('div', { class: 'strip' }, r.ids.map((id) => h('span', { class: `pill p-${state(id)}` }, `${id} · ${state(id) === 'run' ? 'running' : state(id)}`))),
    r.note ? h('div', { class: 'card', style: 'margin-bottom:1rem' }, pill('attention', 'note'), ' ', r.note) : null,
    active && r.currentId ? h('div', { class: 'card', style: 'margin-bottom:1rem' },
      h('div', { class: 'row' }, h('b', {}, r.currentId), live?.model && pill('auto', live.model.replace('claude-', '')), h('span', { class: 'muted' }, live ? `${live.turns} turns · ${dur(Date.now() - live.startedAt)}` : 'starting…')),
      live ? [h('div', { class: 'mono', style: 'margin:.7rem 0 .4rem' }, live.lastAction),
        h('div', { class: 'label', style: 'margin-top:.8rem' }, `Context ${kt(live.ctx)} of ${kt(cap)} compaction threshold`),
        h('div', { class: 'bar' + (pct > 80 ? ' warn' : '') }, h('i', { style: `width:${pct}%` })),
        h('div', { class: 'label', style: 'margin-top:1rem' }, 'Activity'),
        h('div', { class: 'feed' }, live.feed.slice().reverse().slice(0, 25).map((f) => h('div', { class: f.kind }, f.text)))] : null) : null,
    Object.keys(r.results).length ? h('div', { class: 'card', style: 'margin-bottom:1rem' }, h('h3', {}, 'Finished tasks'),
      h('table', {}, h('tbody', {}, Object.entries(r.results).map(([id, x]) => h('tr', {}, h('td', { class: 'mono' }, id), h('td', {}, pill(x.model)), h('td', {}, pill(state(id) === 'done' ? 'done' : 'attention', x.committed ? x.outcome : 'no commit')),
        h('td', { class: 'num nowrap' }, `${x.turns} turns`), h('td', { class: 'num' }, usd(x.usd)), h('td', { class: 'muted' }, x.summary.slice(0, 140))))))) : null,
    h('div', { class: 'label' }, 'Runner output'), h('pre', { class: 'log' }, r.lines.join('\n') || '(no output yet)'));
}

// ---------- costs ----------
function viewCosts() {
  if (!project()) return emptyNoProject();
  const c = S.costs;
  if (!c.rows.length) return h('div', { class: 'empty' }, 'No runs recorded yet. Costs appear here after the first task finishes.');
  const max = Math.max(...c.byModel.map((m) => m.usd), 0.01);
  const pts = c.rows.slice(-40).map((r) => r.usd);
  const top = Math.max(...pts, 0.01);
  const poly = pts.map((v, i) => `${(i / Math.max(1, pts.length - 1)) * 100},${36 - (v / top) * 32}`).join(' ');
  return h('div', {},
    h('div', { class: 'grid' }, stat(usd(c.total), 'all recorded runs', 'Total spend'), stat(c.runs, `${c.committed} committed`, 'Runs'),
      stat(usd(c.committed ? c.total / c.committed : 0), 'per committed task', 'Average'), stat(usd(Math.max(...c.rows.map((r) => r.usd))), 'most expensive run', 'Peak')),
    h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h3', {}, 'By model'),
        c.byModel.map((m) => h('div', { class: 'hbar' }, pill(m.model), h('div', { class: 'bar' }, h('i', { style: `width:${(m.usd / max) * 100}%` })), h('span', { class: 'num mono' }, usd(m.usd))),),
        h('div', { class: 'muted', style: 'font-size:.85rem;margin-top:.6rem' }, c.byModel.map((m) => `${m.model}: ${m.runs} runs, ${(m.turns / m.runs).toFixed(0)} avg turns`).join(' · '))),
      h('div', { class: 'card' }, h('h3', {}, 'Cost per run (latest 40)'),
        pts.length < 2 ? h('div', { class: 'muted' }, 'The chart appears after two runs.') : h('svg', { class: 'spark', viewBox: '0 0 100 40', preserveAspectRatio: 'none' }, h('polyline', { points: poly, fill: 'none', stroke: 'var(--accent)', 'stroke-width': '1.2', 'vector-effect': 'non-scaling-stroke' })))),
    h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', {}, 'All runs'), runsTable(c.rows.slice().reverse())));
}

// ---------- update prompt ----------
const SLOT = '<paste decisions, new goals, or "none">';
function viewPrompt() {
  if (!S.prompt) api('/api/prompt').then((j) => { S.prompt = j.text; render(); }).catch(() => {});
  const composed = () => (S.prompt || 'Loading…').replace(SLOT, S.notes.trim() || 'none');
  const pre = h('pre', { class: 'prompt' }, composed());
  return h('div', {},
    h('div', { class: 'muted', style: 'margin-bottom:1rem;max-width:46rem' }, 'Paste this into a Claude session in the repo to tick finished tasks and add new ones. Anything you write below replaces the “Notes from me” slot. The format it enforces is what the runner parses.'),
    h('div', { class: 'label' }, 'Notes from me'),
    h('textarea', { rows: 4, placeholder: 'Decisions, new goals…', value: S.notes, oninput: (e) => { S.notes = e.target.value; pre.textContent = composed(); } }),
    h('div', { class: 'row', style: 'margin:.8rem 0' }, h('button', { class: 'btn primary', onclick: async () => { await navigator.clipboard.writeText(composed()); toast('Prompt copied'); } }, 'Copy prompt'),
      h('span', { class: 'muted mono' }, 'prompts/update-todo.prompt.md')),
    pre);
}

// ---------- dialogs ----------
const dlg = () => document.getElementById('dlg');
function field(label, input) { return h('div', { class: 'field' }, h('div', { class: 'label' }, label), input); }
function addProjectDialog() {
  const path = h('input', { type: 'text', placeholder: 'C:\\Users\\you\\Documents\\repos\\my-project' });
  const name = h('input', { type: 'text', placeholder: 'defaults to the folder name' });
  const todo = h('input', { type: 'text', value: 'docs/TODO.md' });
  dlg().replaceChildren(h('h2', {}, 'Add a repo'), field('Folder path', path), field('Display name (optional)', name), field('TODO file, relative to the repo', todo),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => dlg().close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        try { const p = await api('/api/projects', 'POST', { path: path.value, name: name.value, todoFile: todo.value }); S.pid = p.id; dlg().close(); toast(`Added ${p.name}`); S.view = 'overview'; refresh(true); } catch (e) { toast(e.message); }
      } }, 'Add')));
  dlg().showModal(); path.focus();
}
function settingsDialog() {
  const p = project();
  const f = {
    name: h('input', { type: 'text', value: p.name }), todoFile: h('input', { type: 'text', value: p.todoFile }), testCmd: h('input', { type: 'text', value: p.testCmd }),
    buildCmd: h('input', { type: 'text', value: p.buildCmd }), allowedBash: h('input', { type: 'text', value: p.allowedBash }),
  };
  const bins = { claudeBin: h('input', { type: 'text', value: S.cfg.claudeBin }), bashBin: h('input', { type: 'text', value: S.cfg.bashBin }) };
  dlg().replaceChildren(h('h2', {}, `Settings · ${p.name}`), field('Name', f.name), field('TODO file', f.todoFile), field('Test command (must pass before each commit)', f.testCmd),
    field('Build command', f.buildCmd), field('Extra allowed Bash patterns (separated by ;)', f.allowedBash),
    h('div', { class: 'label', style: 'margin-top:1rem' }, 'Global'), field('claude executable', bins.claudeBin), field('Git Bash executable', bins.bashBin),
    h('div', { class: 'actions' },
      h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Remove ${p.name} from the dashboard? Files in the repo are untouched.`)) { await api(`/api/projects/${p.id}`, 'DELETE'); dlg().close(); refresh(true); } } }, 'Remove repo'),
      h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => dlg().close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          await api(`/api/projects/${p.id}`, 'PATCH', Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])));
          await api('/api/settings', 'POST', { claudeBin: bins.claudeBin.value, bashBin: bins.bashBin.value });
          dlg().close(); toast('Saved'); refresh(true);
        } catch (e) { toast(e.message); }
      } }, 'Save')));
  dlg().showModal();
}

// ---------- render ----------
function render() {
  renderSide(); renderTop();
  const view = document.getElementById('view');
  const keep = view.scrollTop;
  const fn = { overview: viewOverview, tasks: viewTasks, live: viewLive, costs: viewCosts, prompt: viewPrompt }[S.view] || viewOverview;
  view.replaceChildren(fn());
  view.scrollTop = keep;
  renderRunbar();
}
// the prompt view holds a textarea: avoid rebuilding it on every poll
const _render = render;
render = function () { if (S.view === 'prompt' && document.activeElement?.tagName === 'TEXTAREA') return; _render(); };

refresh(true).then(schedule);
