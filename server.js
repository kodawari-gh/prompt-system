'use strict';
// Prompt System dashboard server. Zero dependencies. Binds to 127.0.0.1 only.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUB = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const WIN = process.platform === 'win32';
fs.mkdirSync(DATA, { recursive: true });

// ---------- config ----------
const CFG_FILE = path.join(DATA, 'config.json');
let cfg = { projects: [], claudeBin: '', bashBin: '' };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }; } catch { /* first run */ }
const saveCfg = () => fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
const posix = (p) => (WIN ? p.replace(/\\/g, '/') : p);

function which(cmd) {
  try {
    const r = cp.spawnSync(WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.split(/\r?\n/).find(Boolean) || null;
  } catch { /* not found */ }
  return null;
}
function detectClaude() {
  const w = which('claude');
  if (w) return w;
  const ext = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const dirs = fs.readdirSync(ext).filter((n) => n.startsWith('anthropic.claude-code-')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const d of dirs.reverse()) {
      for (const bin of ['claude.exe', 'claude']) {
        const p = path.join(ext, d, 'resources', 'native-binary', bin);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch { /* no extension */ }
  return '';
}
function detectBash() {
  if (!WIN) return 'bash';
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return ''; // never fall back to System32\bash.exe: that is WSL
}
if (!cfg.claudeBin || !fs.existsSync(cfg.claudeBin)) cfg.claudeBin = detectClaude();
if (!cfg.bashBin) cfg.bashBin = detectBash();
saveCfg();

// ---------- projects ----------
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
const getProject = (id) => cfg.projects.find((p) => p.id === id);
const dataDirOf = (p) => path.join(DATA, p.id);
const logsDirOf = (p) => path.join(dataDirOf(p), 'logs');
const todoPathOf = (p) => path.join(p.path, p.todoFile);

function git(p, args) {
  const r = cp.spawnSync('git', ['-C', p.path, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

// ---------- TODO parsing ----------
const TASK_RE = /^- \[( |x|~)\] ([A-Z]+\d+) \[(auto|human|owner)\](?: \{(haiku|sonnet|opus)\})? (.*)$/;
const VISUAL_RE = /src\/render|\.tsx|\.css|PartArt|Hud\.|NetPanel|screenshot|visual/;
function parseTodo(raw) {
  const tasks = [];
  let group = '';
  for (const line of raw.split(/\r?\n/)) {
    const h = /^##+ (.*)$/.exec(line);
    if (h) { group = h[1].trim(); continue; }
    const m = TASK_RE.exec(line);
    if (!m) continue;
    const rest = m[5];
    const field = (name) => {
      const f = new RegExp(`${name}:\\s*(.*?)(?=\\s(?:Files|Docs|Test pattern|Done when):|$)`).exec(rest);
      return f ? f[1].trim() : '';
    };
    const model = m[4] || '';
    const eff = !model || model === 'haiku' ? (VISUAL_RE.test(rest) ? 'sonnet' : 'haiku') : model;
    tasks.push({
      id: m[2], status: m[1] === 'x' ? 'done' : m[1] === '~' ? 'deferred' : 'open', tag: m[3], model, effModel: eff,
      floored: (!model || model === 'haiku') && eff === 'sonnet',
      title: rest.split(/ (?:Files|Docs|Test pattern|Done when):/)[0].trim(), files: field('Files'), docs: field('Docs'),
      testPattern: field('Test pattern'), doneWhen: field('Done when'), group,
    });
  }
  return tasks;
}
function readTodo(p) {
  try { const raw = fs.readFileSync(todoPathOf(p), 'utf8'); return { exists: true, raw, tasks: parseTodo(raw) }; }
  catch { return { exists: false, raw: '', tasks: [] }; }
}

// ---------- costs ----------
function readCosts(p) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(logsDirOf(p), 'costs.tsv'), 'utf8'); } catch { /* none yet */ }
  const rows = txt.split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
    const c = l.split('\t');
    return { task: c[0], model: c[1], outcome: c[2], usd: Number(c[3]) || 0, turns: Number(c[4]) || 0, committed: c[5] === 'yes', time: c[6] || '' };
  });
  const byModel = {};
  for (const r of rows) {
    const m = (byModel[r.model] ||= { model: r.model, runs: 0, usd: 0, turns: 0, committed: 0 });
    m.runs++; m.usd += r.usd; m.turns += r.turns; if (r.committed) m.committed++;
  }
  const total = rows.reduce((s, r) => s + r.usd, 0);
  return { rows, byModel: Object.values(byModel), total, runs: rows.length, committed: rows.filter((r) => r.committed).length };
}

// ---------- runs ----------
const runs = new Map();
let runSeq = 0;
const isActive = (r) => r.status === 'running';

function startRun(p, ids, opts) {
  if ([...runs.values()].some((r) => r.projectId === p.id && isActive(r))) throw Object.assign(new Error('a run is already active for this project'), { code: 409 });
  if (!cfg.claudeBin) throw Object.assign(new Error('claude executable not found; set it in Settings'), { code: 400 });
  if (!cfg.bashBin) throw Object.assign(new Error('Git Bash not found; set it in Settings'), { code: 400 });
  fs.mkdirSync(logsDirOf(p), { recursive: true });
  const env = {
    ...process.env, REPO: posix(p.path), TODO_FILE: p.todoFile, DATA_DIR: posix(dataDirOf(p)), CLAUDE_BIN: posix(cfg.claudeBin),
    TEST_CMD: p.testCmd, BUILD_CMD: p.buildCmd, ALLOWED_BASH: p.allowedBash,
  };
  if (opts.allowDirty) env.ALLOW_DIRTY = '1';
  if (opts.maxTurns) env.MAX_TURNS = String(opts.maxTurns);
  if (opts.maxBudgetUsd) env.MAX_BUDGET_USD = String(opts.maxBudgetUsd);
  if (opts.autocompact) env.AUTOCOMPACT = String(opts.autocompact);
  if (opts.visualFloor === false) env.VISUAL_FLOOR = '0';
  const child = cp.spawn(cfg.bashBin, [posix(path.join(ROOT, 'runner', 'run-todos.sh')), ...ids], { cwd: p.path, env, windowsHide: true, detached: !WIN });
  const run = {
    id: `r${++runSeq}`, projectId: p.id, ids, startedAt: Date.now(), endedAt: null, status: 'running', pid: child.pid, stopped: false,
    lines: [], currentId: null, results: {}, live: null, opts, note: '',
  };
  runs.set(run.id, run);
  const onData = (buf) => {
    run.partial = (run.partial || '') + buf.toString('utf8');
    const parts = run.partial.split(/\r?\n/);
    run.partial = parts.pop();
    for (const line of parts) ingest(run, line);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => { ingest(run, `runner failed to start: ${e.message}`); finish(run, 1); });
  child.on('close', (code) => finish(run, code));
  return run;
}
function ingest(run, line) {
  if (!line.trim()) return;
  run.lines.push(line);
  if (run.lines.length > 400) run.lines.shift();
  const mk = /^== (\S+) ==$/.exec(line);
  if (mk) { run.currentId = mk[1]; run.live = null; return; }
  const rs = /^(\S+) \[(\w+)\] (\S+) \$([\d.]+) (\d+) turns, committed=(yes|no) \| (.*)$/.exec(line);
  if (rs) run.results[rs[1]] = { model: rs[2], outcome: rs[3], usd: Number(rs[4]), turns: Number(rs[5]), committed: rs[6] === 'yes', summary: rs[7] };
  if (/, stopping|refusing|working tree is dirty|did not run/.test(line)) run.note = line;
}
function finish(run, code) {
  if (!isActive(run)) return;
  run.endedAt = Date.now();
  const bad = Object.values(run.results).some((r) => !r.committed || r.outcome !== 'success');
  run.status = run.stopped ? 'stopped' : code !== 0 ? 'failed' : bad || run.note ? 'attention' : 'done';
  run.currentId = null;
}
function stopRun(run) {
  if (!isActive(run)) return;
  run.stopped = true;
  try {
    if (WIN) cp.spawn('taskkill', ['/pid', String(run.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-run.pid, 'SIGTERM');
  } catch { /* already gone */ }
}

// live view: tail the current task's stream-json log
function pollLive(run) {
  const p = getProject(run.projectId);
  if (!p || !run.currentId) return;
  const file = path.join(logsDirOf(p), `${run.currentId}.jsonl`);
  let live = run.live;
  if (!live || live.file !== file) live = run.live = { file, offset: 0, tail: '', turns: 0, ctx: 0, model: '', lastAction: 'starting', feed: [], startedAt: Date.now() };
  let st;
  try { st = fs.statSync(file); } catch { return; }
  if (st.size < live.offset) live.offset = 0;
  if (st.size === live.offset) return;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(st.size - live.offset);
  fs.readSync(fd, buf, 0, buf.length, live.offset);
  fs.closeSync(fd);
  live.offset = st.size;
  const parts = (live.tail + buf.toString('utf8')).split('\n');
  live.tail = parts.pop();
  for (const l of parts) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type !== 'assistant' || !j.message) continue;
    live.turns++;
    const u = j.message.usage;
    if (u) live.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (j.message.model) live.model = j.message.model;
    for (const c of j.message.content || []) {
      if (c.type === 'tool_use') {
        const i = c.input || {};
        const arg = i.command || i.file_path || i.pattern || i.path || '';
        live.lastAction = `${c.name} ${String(arg).replace(/\s+/g, ' ').slice(0, 110)}`.trim();
        live.feed.push({ kind: 'tool', text: live.lastAction });
      } else if (c.type === 'text' && c.text.trim()) {
        live.feed.push({ kind: 'text', text: c.text.replace(/\s+/g, ' ').trim().slice(0, 220) });
      }
    }
    if (live.feed.length > 40) live.feed.splice(0, live.feed.length - 40);
  }
}
setInterval(() => { for (const r of runs.values()) if (isActive(r)) { try { pollLive(r); } catch { /* ignore */ } } }, 700);

const runView = (r) => ({
  id: r.id, projectId: r.projectId, ids: r.ids, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, currentId: r.currentId,
  results: r.results, live: r.live && { turns: r.live.turns, ctx: r.live.ctx, model: r.live.model, lastAction: r.live.lastAction, feed: r.live.feed, startedAt: r.live.startedAt },
  lines: r.lines.slice(-120), opts: r.opts, note: r.note,
});

// ---------- http ----------
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type + (type.startsWith('text') || type.includes('json') ? '; charset=utf-8' : ''), 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 65536) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('bad json')); } });
});
const cleanStr = (v, max = 200) => (typeof v === 'string' && !/[\r\n]/.test(v) && v.length <= max ? v.trim() : null);
const STATIC = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // Only answer to localhost names (DNS rebinding) and require a custom header on writes (cross-site POSTs).
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'forbidden host' });
  if (req.method !== 'GET' && req.headers['x-runner'] !== '1') return send(res, 403, { error: 'missing X-Runner header' });
  const p = url.pathname;
  if (req.method === 'GET' && STATIC[p]) return send(res, 200, fs.readFileSync(path.join(PUB, STATIC[p][0])), STATIC[p][1]);
  if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  try {
    if (p === '/api/state' && req.method === 'GET') {
      return send(res, 200, { projects: cfg.projects, claudeBin: cfg.claudeBin, bashBin: cfg.bashBin, runs: [...runs.values()].slice(-12).map(runView) });
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      for (const k of ['claudeBin', 'bashBin']) { const v = cleanStr(b[k], 400); if (v !== null) cfg[k] = v; }
      saveCfg();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/prompt' && req.method === 'GET') {
      return send(res, 200, { text: fs.readFileSync(path.join(ROOT, 'prompts', 'update-todo.prompt.md'), 'utf8') });
    }
    if (p === '/api/projects' && req.method === 'POST') {
      const b = await readBody(req);
      const dir = typeof b.path === 'string' ? path.resolve(b.path.trim()) : '';
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 400, { error: 'that folder does not exist' });
      if (cfg.projects.some((x) => path.resolve(x.path) === dir)) return send(res, 400, { error: 'already added' });
      let id = slug(path.basename(dir)); const base = id; let n = 2;
      while (getProject(id)) id = `${base}-${n++}`;
      const proj = { id, name: cleanStr(b.name, 60) || path.basename(dir), path: dir, todoFile: cleanStr(b.todoFile, 200) || 'docs/TODO.md', testCmd: 'npm test', buildCmd: 'npm run build', allowedBash: 'npm run *;npm test;npx vitest:*;npx tsc:*' };
      cfg.projects.push(proj); saveCfg();
      return send(res, 200, proj);
    }
    const m = /^\/api\/projects\/([a-z0-9-]+)(?:\/(\w+))?$/.exec(p);
    if (m) {
      const proj = getProject(m[1]);
      if (!proj) return send(res, 404, { error: 'unknown project' });
      const sub = m[2];
      if (!sub && req.method === 'DELETE') { cfg.projects = cfg.projects.filter((x) => x.id !== proj.id); saveCfg(); return send(res, 200, { ok: true }); }
      if (!sub && req.method === 'PATCH') {
        const b = await readBody(req);
        for (const [k, max] of [['name', 60], ['todoFile', 200], ['testCmd', 200], ['buildCmd', 200], ['allowedBash', 400]]) { const v = cleanStr(b[k], max); if (v) proj[k] = v; }
        saveCfg(); return send(res, 200, proj);
      }
      if (sub === 'todo' && req.method === 'GET') return send(res, 200, readTodo(proj));
      if (sub === 'init' && req.method === 'POST') {
        const f = todoPathOf(proj);
        if (fs.existsSync(f)) return send(res, 400, { error: 'a TODO file already exists there' });
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, fs.readFileSync(path.join(ROOT, 'templates', 'TODO.template.md'), 'utf8'));
        return send(res, 200, { ok: true });
      }
      if (sub === 'costs' && req.method === 'GET') return send(res, 200, readCosts(proj));
      if (sub === 'git' && req.method === 'GET') {
        const log = git(proj, ['log', '--pretty=format:%h\t%ar\t%s', '-8']);
        const st = git(proj, ['status', '--porcelain']);
        return send(res, 200, {
          isRepo: log !== null, branch: (git(proj, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim(), dirty: st ? st.split('\n').filter(Boolean).length : 0,
          commits: (log || '').split('\n').filter(Boolean).map((l) => { const c = l.split('\t'); return { hash: c[0], when: c[1], subject: c[2] }; }),
        });
      }
      if (sub === 'run' && req.method === 'POST') {
        const b = await readBody(req);
        const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string' && /^[A-Z]+\d+$/.test(x)) : [];
        if (!ids.length) return send(res, 400, { error: 'no valid task ids' });
        const num = (v, lo, hi) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : 0);
        const run = startRun(proj, ids, {
          allowDirty: !!b.allowDirty, maxTurns: Math.floor(num(b.maxTurns, 1, 500)), maxBudgetUsd: num(b.maxBudgetUsd, 0.01, 100),
          autocompact: Math.floor(num(b.autocompact, 100000, 1000000)), visualFloor: b.visualFloor !== false,
        });
        return send(res, 200, runView(run));
      }
    }
    const rm = /^\/api\/runs\/(r\d+)\/stop$/.exec(p);
    if (rm && req.method === 'POST') {
      const run = runs.get(rm[1]);
      if (!run) return send(res, 404, { error: 'unknown run' });
      stopRun(run);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, e.code === 409 || e.code === 400 ? e.code : 500, { error: e.message });
  }
}

http.createServer((req, res) => { handle(req, res); }).listen(PORT, '127.0.0.1', () => {
  console.log(`Prompt System dashboard: http://localhost:${PORT}`);
  if (!cfg.claudeBin) console.log('warning: claude executable not found; set it in Settings');
  if (!cfg.bashBin) console.log('warning: Git Bash not found; set it in Settings');
});
process.on('exit', () => { for (const r of runs.values()) if (isActive(r)) stopRun(r); });
