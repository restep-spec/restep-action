// Tests for restep-action: validates action.yml and runs its shell steps locally, simulating
// the GitHub runner (GITHUB_* variables, the steps' if:, outputs), against the reference server
// on free ports chosen by the system. gh and restep-diff are replaced by test doubles.
// RESTEP_REF names another copy of the reference server to test against.
// Usage, from restep/:  node tools/restep-action/test.mjs
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual } from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = process.env.RESTEP_REF || join(here, 'vendor/restep-server.mjs');
const CHECKER = join(here, 'vendor/restep-check.mjs');
const { createServer: createPortProbe } = await import('node:http');
const freePort = () => new Promise((resolve) => { const s = createPortProbe().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const PORT_A = await freePort(), PORT_B = await freePort(), PORT_DEAD = await freePort();

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; console.log(`  FAIL: ${msg}`); }
}

// ── Mini parser for the YAML subset action.yml uses ───────────────────────────
function parseYaml(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (/\t/.test(raw.match(/^\s*/)[0])) throw new Error(`tab in the indentation: ${raw}`);
    lines.push({ indent: raw.match(/^ */)[0].length, text: raw.trim() });
  }
  let i = 0;
  const scalar = (s) => {
    if (s.startsWith("'")) { if (!s.endsWith("'") || s.length < 2) throw new Error(`unclosed quote: ${s}`); return s.slice(1, -1).replace(/''/g, "'"); }
    if (s.startsWith('"')) return JSON.parse(s);
    s = s.replace(/\s+#.*$/, '');
    if (s === 'true' || s === 'false') return s === 'true';
    if (s === 'null' || s === '~') return null;
    if (/^[[{&*!|>%@`]/.test(s)) throw new Error(`YAML syntax outside the subset: ${s}`);
    return s;
  };
  const splitKey = (t) => {
    const m = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(t);
    if (!m) throw new Error(`invalid line: ${t}`);
    return [m[1], m[2] ?? ''];
  };
  function block(indent) { return lines[i].text.startsWith('- ') ? list(indent) : map(indent); }
  function map(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const [key, rest] = splitKey(lines[i].text);
      if (key in obj) throw new Error(`repeated key: ${key}`);
      i++;
      if (rest === '') obj[key] = i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null;
      else obj[key] = scalar(rest);
    }
    if (i < lines.length && lines[i].indent > indent) throw new Error(`unexpected indentation: ${lines[i].text}`);
    return obj;
  }
  function list(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
      const t = lines[i].text.slice(2);
      if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(t)) { lines[i] = { indent: indent + 2, text: t }; arr.push(map(indent + 2)); }
      else { arr.push(scalar(t)); i++; }
    }
    return arr;
  }
  const doc = map(0);
  if (i !== lines.length) throw new Error(`not read to the end: ${lines[i].text}`);
  return doc;
}

// ── Runner simulator for a composite action ───────────────────────────────────
function evalExpr(expr, ctx) {
  const js = expr.trim()
    .replace(/'([^']*)'/g, (_, s) => JSON.stringify(s))
    .replace(/\binputs\.([A-Za-z0-9_-]+)/g, (_, k) => JSON.stringify(ctx.inputs[k] ?? ''))
    .replace(/\bgithub\.([A-Za-z0-9_]+)/g, (_, k) => JSON.stringify(ctx.github[k] ?? ''))
    .replace(/\bsteps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g, (_, s, k) => JSON.stringify(ctx.steps[s]?.outputs?.[k] ?? ''))
    .replace(/\balways\(\)/g, 'true').replace(/\bsuccess\(\)/g, String(!ctx.failed)).replace(/\bfailure\(\)/g, String(ctx.failed))
    .replace(/!=/g, '!==').replace(/==/g, '===').replace(/!===/g, '!==').replace(/====/g, '===');
  if (/[^\s"'()!=&|]/.test(js.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/\b(true|false)\b/g, ''))) throw new Error(`expression not supported by the simulator: ${expr}`);
  return Function(`return (${js});`)();
}
const interpolate = (s, ctx) => String(s).replace(/\$\{\{([^}]*)\}\}/g, (_, e) => String(evalExpr(e, ctx)));

function runAction(action, inputs, sim) {
  const ctx = { inputs: {}, github: { token: 'test-token' }, steps: {}, failed: false };
  for (const [k, decl] of Object.entries(action.inputs)) ctx.inputs[k] = k in inputs ? inputs[k] : interpolate(decl.default ?? '', ctx);
  const log = [];
  for (const step of action.runs.steps) {
    const cond = step.if ?? 'success()';
    const run = evalExpr(/always\(\)|success\(\)|failure\(\)|cancelled\(\)/.test(cond) ? cond : `success() && (${cond})`, ctx);
    if (!run) { log.push({ name: step.name, skipped: true }); continue; }
    const out = join(sim.dir, `output-${step.id ?? log.length}`);
    writeFileSync(out, '');
    const stepEnv = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, interpolate(v, ctx)]));
    const r = spawnSync('bash', ['-e', '-c', step.run], {
      encoding: 'utf8', cwd: sim.workspace,
      env: { ...process.env, ...sim.env, ...stepEnv, GITHUB_OUTPUT: out, GITHUB_ACTION_PATH: here, PATH: `${sim.bin}:${process.env.PATH}` },
    });
    const outputs = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    if (step.id) ctx.steps[step.id] = { outputs, outcome: r.status === 0 ? 'success' : 'failure' };
    if (r.status !== 0) ctx.failed = true;
    log.push({ name: step.name, exit: r.status, stdout: r.stdout, stderr: r.stderr });
  }
  const outputs = Object.fromEntries(Object.entries(action.outputs).map(([k, o]) => [k, interpolate(o.value, ctx)]));
  return { log, outputs, failed: ctx.failed, step: (n) => log.find((s) => s.name === n) };
}

// ── gh and restep-diff doubles ────────────────────────────────────────────────
function writeStubs(bin) {
  mkdirSync(bin, { recursive: true });
  // gh: saves every call in GH_STUB_LOG and the comments in GH_STUB_STATE.
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = fs.existsSync(process.env.GH_STUB_STATE) ? JSON.parse(fs.readFileSync(process.env.GH_STUB_STATE, 'utf8')) : [];
const i = args.indexOf('--input');
const body = i >= 0 ? JSON.parse(fs.readFileSync(args[i + 1], 'utf8')).body : null;
const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
const path = args.find((a) => a.startsWith('repos/'));
fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify({ method, path, token: process.env.GH_TOKEN, body, args }) + '\\n');
if (!process.env.GH_TOKEN) { console.error('gh: no token'); process.exit(4); }
if (method === 'GET') {
  const marker = /contains\\((".*?")\\)/.exec(args[args.indexOf('--jq') + 1]);
  for (const c of state) if (c.body.includes(JSON.parse(marker[1]))) console.log(c.id);
} else if (method === 'POST') {
  const id = 1000 + state.length; state.push({ id, body }); console.log(JSON.stringify({ id }));
} else if (method === 'PATCH') {
  const id = Number(path.split('/').pop()); state.find((c) => c.id === id).body = body;
}
fs.writeFileSync(process.env.GH_STUB_STATE, JSON.stringify(state));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  // restep-diff with the assumed CLI: restep-diff <old> <new> --markdown --fail-on breaking.
  writeFileSync(join(bin, 'restep-diff-stub.mjs'), `import fs from 'node:fs';
const [a, b, ...rest] = process.argv.slice(2);
if (rest.join(' ') !== '--markdown --fail-on breaking') { console.error('unexpected arguments: ' + rest.join(' ')); process.exit(2); }
const old = JSON.parse(fs.readFileSync(a, 'utf8')), now = JSON.parse(fs.readFileSync(b, 'utf8'));
const gone = Object.keys(old.collections ?? {}).filter((c) => !(c in (now.collections ?? {})));
if (gone.length) { console.log('### Breaking\\n' + gone.map((c) => '- The collection “' + c + '” disappears with no prior notice in deprecations').join('\\n')); process.exit(1); }
console.log('No changes in discovery.');
`);
}

async function waitUp(port) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://localhost:${port}/health`); return true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}
async function isDown(port) {
  for (let i = 0; i < 30; i++) {
    try { await fetch(`http://localhost:${port}/health`); await new Promise((r) => setTimeout(r, 100)); } catch { return true; }
  }
  return false;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'restep-action-'));
let serverB = null;
try {
  console.log('1. action.yml: syntax and structure');
  const text = readFileSync(join(here, 'action.yml'), 'utf8');
  const action = parseYaml(text);
  const ruby = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(STDIN.read))'], { input: text, encoding: 'utf8' });
  if (ruby.status === 0) {
    try { deepStrictEqual(action, JSON.parse(ruby.stdout)); ok(true); } catch (e) { ok(false, `the Ruby parser reads something else: ${e.message.slice(0, 500)}`); }
  } else console.log('  (no Ruby: own parser only)');
  ok(typeof action.name === 'string' && typeof action.description === 'string', 'name and description');
  ok(action.runs?.using === 'composite', 'runs.using: composite');
  for (const k of ['url', 'start-command', 'wait-for', 'profiles', 'writes', 'base-discovery', 'comment']) ok(action.inputs[k], `input ${k}`);
  for (const [k, v] of Object.entries(action.inputs)) ok(typeof v.description === 'string', `input ${k} with description`);
  const ids = action.runs.steps.map((s) => s.id).filter(Boolean);
  ok(new Set(ids).size === ids.length, 'unique step ids');
  for (const s of action.runs.steps) {
    ok(s.shell === 'bash' && typeof s.run === 'string', `step "${s.name}" with shell and run`);
    ok(!/\$\{\{/.test(s.run), `step "${s.name}": no expressions inside the script (injection)`);
    for (const [k, v] of Object.entries(s.env ?? {})) {
      const m = /^\$\{\{ inputs\.([a-z-]+) \}\}$/.exec(v);
      if (m) {
        ok(m[1] in action.inputs, `step "${s.name}": input ${m[1]} exists`);
        ok(k === `INPUT_${m[1].toUpperCase().replace(/-/g, '_')}` || k === 'GH_TOKEN', `step "${s.name}": ${k} is named after its input`);
      }
    }
  }
  for (const m of text.matchAll(/inputs\.([a-z0-9-]+)/g)) ok(m[1] in action.inputs, `reference to a declared input: ${m[1]}`);
  for (const [k, o] of Object.entries(action.outputs)) {
    const m = /steps\.([a-z-]+)\.outputs/.exec(o.value);
    ok(m && ids.includes(m[1]), `output ${k} points to an existing step`);
  }
  // The defaults point at this repository's versions: restep-check and restep-diff of draft 6.
  // On the web, the generated restep-check package; in the mirror, the copy in vendor/.
  const checkPkg = join(here, '../restep-check/npm/package.json');
  const checkVersion = existsSync(checkPkg)
    ? JSON.parse(readFileSync(checkPkg, 'utf8')).version
    : /VERSION = '([0-9.]+)'/.exec(readFileSync(join(here, 'vendor/restep-check.mjs'), 'utf8'))[1];
  ok(action.inputs['restep-check'].default === `npx --yes restep-check@${checkVersion.split('.').slice(0, 2).join('.')}`, `default restep-check at ${checkVersion}`);
  // restep-diff is only next to it in the web repository; in the mirror it cannot be checked.
  const diffPkg = join(here, '../restep-diff/package.json');
  if (existsSync(diffPkg) && existsSync(join(here, '../restep-check/npm'))) {
    const diffVersion = JSON.parse(readFileSync(diffPkg, 'utf8')).version;
    ok(action.inputs['restep-diff'].default === `npx --yes restep-diff@${diffVersion.split(".").slice(0, 2).join(".")}`, `default restep-diff at v${diffVersion}`);
  }
  ok(readFileSync(join(here, 'action.mjs'), 'utf8').includes(`'${action.inputs['restep-diff'].default}'`), 'action.mjs uses the same default restep-diff');
  const syntax = spawnSync(process.execPath, ['--check', join(here, 'action.mjs')], { encoding: 'utf8' });
  ok(syntax.status === 0, `action.mjs compiles: ${syntax.stderr}`);

  // Simulated runner environment.
  const bin = join(tmp, 'bin');
  writeStubs(bin);
  const workspace = join(tmp, 'workspace');
  mkdirSync(workspace);
  const event = join(tmp, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { number: 42 } }));
  const sim = (name, extra = {}) => {
    const dir = join(tmp, name);
    mkdirSync(join(dir, 'runner'), { recursive: true });
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    return {
      dir, bin, workspace, summary,
      env: {
        RUNNER_TEMP: join(dir, 'runner'), GITHUB_STEP_SUMMARY: summary, GITHUB_WORKSPACE: workspace,
        GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'restep-spec/ejemplo',
        GH_STUB_LOG: join(tmp, 'gh.log'), GH_STUB_STATE: join(tmp, 'gh.json'), ...extra,
      },
    };
  };
  const ghCalls = () => (existsSync(join(tmp, 'gh.log')) ? readFileSync(join(tmp, 'gh.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const startCmd = (port, extra = '') => `PORT=${port} ${extra}node ${JSON.stringify(SERVER)}`;
  const common = { 'restep-check': `node ${JSON.stringify(CHECKER)}`, 'restep-diff': `node ${JSON.stringify(join(bin, 'restep-diff-stub.mjs'))}` };

  // Base discovery document: the same one the server serves (unchanged) and another with one more collection.
  const tmpServer = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT_A) }, stdio: 'ignore' });
  await waitUp(PORT_A);
  const disc = await (await fetch(`http://localhost:${PORT_A}/`)).json();
  tmpServer.kill();
  await isDown(PORT_A);
  writeFileSync(join(workspace, 'base-same.json'), JSON.stringify(disc));
  // What the reference announces (in draft 6, also cache and the inherit extension), as
  // the summary writes it: profiles and extensions separated by commas.
  const announcedRef = [...disc.profiles, ...(disc.extensions ?? [])].join(', ');
  // A collection the reference does not have (since it has authors, that one no longer works).
  writeFileSync(join(workspace, 'base-more.json'), JSON.stringify({ ...disc, collections: { ...disc.collections, publishers: { path: '/publishers' } } }));

  console.log('2. Starts the API, checks, compares with no changes and comments on the PR');
  const sa = sim('a');
  const a = runAction(action, {
    ...common, url: `http://localhost:${PORT_A}/`, 'start-command': startCmd(PORT_A), 'wait-for': `http://localhost:${PORT_A}/health`,
    profiles: 'core,query,writes', 'base-discovery': 'base-same.json', comment: 'true',
  }, sa);
  ok(!a.failed, `no step fails: ${a.log.filter((s) => s.exit).map((s) => `${s.name}: ${s.stdout}${s.stderr}`).join('\n')}`);
  ok(a.outputs.result === 'pass', `result = pass (${a.outputs.result})`);
  ok(a.outputs['check-failures'] === '0' && a.outputs.breaking === 'false', 'no failures and no breaking changes');
  const sumA = readFileSync(sa.summary, 'utf8');
  ok(sumA.includes(`## Restep passing: http://localhost:${PORT_A}/`), 'the job summary carries the title');
  ok(sumA.includes(`| Profiles | ${announcedRef} |`) && sumA.includes('no breaking changes'), `the summary carries profiles and compatibility (${announcedRef})`);
  const draftN = /^1\.0-draft\.(\d+)$/.exec(disc.restep)?.[1];
  ok(draftN && sumA.includes(`| Declared version | \`${disc.restep}\`: draft ${draftN} of 1.0: without the guarantees of a published version (§1.1) |`),
    `the summary carries the declared version (${disc.restep}) and says it is a draft`);
  ok(sumA.includes('No changes in discovery.'), 'the summary includes the restep-diff output');
  ok(existsSync(a.outputs['summary-file']), 'summary-file exists');
  let calls = ghCalls();
  ok(calls.length === 2 && calls[0].method === 'GET' && calls[1].method === 'POST' && calls[1].path === 'repos/restep-spec/ejemplo/issues/42/comments', 'new comment on PR 42');
  ok(calls[1].token === 'test-token', 'gh gets the github-token');
  ok(calls[1].body.startsWith(`<!-- restep-action: http://localhost:${PORT_A}/ -->`), 'the comment carries the marker');
  ok(a.step('Stop the API').exit === 0, 'stops the API');
  ok(await isDown(PORT_A), 'the API no longer answers');

  console.log('3. Breaking change, missing profile and --writes: fails and updates the same comment');
  const sb = sim('b');
  const b = runAction(action, {
    ...common, url: `http://localhost:${PORT_A}/`, 'start-command': startCmd(PORT_A),
    profiles: 'core, query, writes, sync', writes: 'true', 'base-discovery': 'base-more.json', comment: 'true',
  }, sb);
  ok(b.step('Report').exit === 1, 'the report exits with 1');
  ok(b.outputs.result === 'fail' && b.outputs.breaking === 'true', 'result = fail and breaking = true');
  const sumB = readFileSync(sb.summary, 'utf8');
  ok(sumB.includes('does not announce: sync') && sumB.includes('The collection “publishers” disappears') && sumB.includes('with --writes'), 'the summary explains the profile, the change and --writes');
  ok(b.step('Report').stdout.includes('::error title=restep-diff::'), 'error annotation for the breaking change');
  calls = ghCalls();
  ok(calls.length === 4 && calls[3].method === 'PATCH' && calls[3].path === 'repos/restep-spec/ejemplo/issues/comments/1000', 'updates comment 1000');
  ok(JSON.parse(readFileSync(join(tmp, 'gh.json'), 'utf8')).length === 1, 'there is still a single comment');
  ok(b.step('Stop the API').exit === 0 && await isDown(PORT_A), 'stops the API even when failing');

  console.log('4. With an already running url, oauth and headers; outside a PR');
  serverB = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT_B), RESTEP_TOKEN: 'secret' }, stdio: 'ignore' });
  await waitUp(PORT_B);
  const sc = sim('c', { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: join(tmp, 'push.json') });
  writeFileSync(join(tmp, 'push.json'), JSON.stringify({ ref: 'refs/heads/master' }));
  const c = runAction(action, { ...common, url: `http://localhost:${PORT_B}/`, headers: 'Authorization: Bearer secret', profiles: 'oauth', comment: 'true' }, sc);
  ok(c.step('Start the API').skipped && c.step('restep-diff').skipped && c.step('Stop the API').skipped, 'start, diff and stop are skipped');
  ok(c.outputs.result === 'pass', `result = pass with the token (${readFileSync(sc.summary, 'utf8').slice(0, 800)})`);
  ok(readFileSync(sc.summary, 'utf8').includes(`| Profiles | ${announcedRef}, oauth |`), 'announces oauth');
  ok(c.step('Report').stdout.includes('is not a PR'), 'outside a PR it does not comment');
  ok(ghCalls().length === 4, 'does not call gh');
  ok(!c.step('restep-check').stdout.includes('secret'), 'the token does not appear in the log');
  // Without a token discovery gives 401: restep-check only sees core and oauth, so query is missing.
  const sc2 = sim('c2');
  const c2 = runAction(action, { ...common, url: `http://localhost:${PORT_B}/`, profiles: 'core,query' }, sc2);
  ok(c2.outputs.result === 'fail' && c2.failed, 'fails without a token');
  ok(readFileSync(sc2.summary, 'utf8').includes('does not announce: query'), 'without a token it does not see query');

  console.log('5. The API does not start');
  const sd = sim('d');
  const d = runAction(action, { ...common, url: `http://localhost:${PORT_DEAD}/`, 'start-command': 'echo "startup failure"; exit 3', 'wait-timeout': '5' }, sd);
  ok(d.step('Start the API').exit !== 0 && d.step('Start the API').stdout.includes('startup failure'), 'start fails and shows the log');
  ok(d.step('restep-check').skipped, 'restep-check is skipped');
  ok(d.step('Report').exit === 1 && readFileSync(sd.summary, 'utf8').includes('did not run'), 'the report runs anyway and explains it');
  ok(d.step('Stop the API').exit === 0, 'stop runs anyway');

  console.log('6. fail-on-error: false and restep-diff that cannot compare');
  const se = sim('e');
  const e = runAction(action, {
    ...common, url: `http://localhost:${PORT_A}/`, 'start-command': startCmd(PORT_A), 'base-discovery': 'missing.json', 'fail-on-error': 'false',
  }, se);
  ok(!e.failed && e.outputs.result === 'fail', 'result = fail but the job goes on');
  ok(readFileSync(se.summary, 'utf8').includes('The base discovery document missing.json does not exist'), 'explains the diff error');
  ok(await isDown(PORT_A), 'stops the API');

  console.log('7. A failing MUST: failure table and annotation');
  const fake = join(bin, 'check-stub.mjs');
  writeFileSync(fake, `console.log(JSON.stringify({ root: process.argv[2], profiles: ['core'], extensions: [], writes: false, version: '9.9.9', results: [
    { id: 'core.put', status: 'fail', level: 'MUST', section: '5.1', target: 'books', message: 'PUT da 200 | no 405', evidence: null },
    { id: 'passive.error.detail', status: 'warn', level: 'SHOULD', section: '5.4', target: null, message: 'no detail', evidence: null }] }));
process.exit(1);`);
  const sf = sim('f');
  const f = runAction(action, { url: 'http://localhost:1/', 'restep-check': `node ${JSON.stringify(fake)}` }, sf);
  const sumF = readFileSync(sf.summary, 'utf8');
  ok(f.outputs['check-failures'] === '1' && f.outputs.result === 'fail', 'counts the failure');
  ok(sumF.includes('| `core.put` | books | PUT da 200 \\| no 405 | MUST · [§5.1]('), 'table row with the escaped bar');
  ok(sumF.includes('<summary>Warnings (1)</summary>'), 'folded warnings');
  ok(f.step('Report').stdout.includes('::error title=restep core.put::[books] PUT da 200 | no 405 (§5.1)'), 'failure annotation');

  console.log('8. Major version 2 and service-desc with data: or on another origin');
  // A minimal server: / is not discovery and points with service-desc first to data: (§3: not
  // followed), then to another origin (§4.3: no credentials) and finally to its own /d.json.
  const seen = [];
  const { createServer } = await import('node:http');
  const mk = (handler) => new Promise((r) => { const sv = createServer(handler); sv.listen(0, '127.0.0.1', () => r(sv)); });
  const other = await mk((req, res) => { seen.push({ host: 'otro', path: req.url, auth: req.headers.authorization ?? null }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"no": "descubrimiento"}'); });
  const otherUrl = `http://127.0.0.1:${other.address().port}/d.json`;
  const api = await mk((req, res) => {
    seen.push({ host: 'api', path: req.url, auth: req.headers.authorization ?? null });
    if (req.url === '/d.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ restep: '2.0', profiles: ['core'], collections: {} })); return; }
    res.writeHead(200, { 'content-type': 'application/json', link: `<data:application/json,%7B%22restep%22%3A%221.0%22%7D>; rel="service-desc", <${otherUrl}>; rel="service-desc", </d.json>; rel="service-desc"` });
    res.end('{}');
  });
  const apiUrl = `http://127.0.0.1:${api.address().port}/`;
  const fake2 = join(bin, 'check-stub2.mjs');
  writeFileSync(fake2, `console.log(JSON.stringify({ root: process.argv[2], profiles: ['core'], extensions: [], writes: false, version: '9.9.9', results: [] }));`);
  // The steps run in a separate, asynchronous process: runAction uses spawnSync, which would block
  // the event loop and these servers, which live in this process, would not answer.
  const env8 = { ...process.env, ...sim('g2').env, INPUT_URL: apiUrl, INPUT_HEADERS: 'Authorization: Bearer secret', INPUT_RESTEP_CHECK: `node ${JSON.stringify(fake2)}` };
  const child = spawn(process.execPath, [join(here, 'action.mjs'), 'check'], { env: env8, stdio: 'ignore' });
  await new Promise((r) => child.on('exit', r));
  const check8 = JSON.parse(readFileSync(join(env8.RUNNER_TEMP, 'restep-action', 'check.json'), 'utf8'));
  ok(check8.declared === '2.0', `follows its own service-desc and reads the version (${check8.declared})`);
  ok(!seen.some((x) => x.host === 'otro' && x.auth), 'sends no credentials to the service-desc on another origin');
  ok(seen.some((x) => x.host === 'api' && x.path === '/d.json' && x.auth === 'Bearer secret'), 'sends credentials to the one on its origin');
  const rep8 = spawn(process.execPath, [join(here, 'action.mjs'), 'report'], { env: { ...env8, INPUT_FAIL_ON_ERROR: 'false' }, stdio: 'ignore' });
  await new Promise((r) => rep8.on('exit', r));
  ok(readFileSync(env8.GITHUB_STEP_SUMMARY, 'utf8').includes('| Declared version | `2.0`: **major version 2: not Restep 1 (§1.1)** |'), 'a major version 2 is flagged as not Restep 1');
  api.close(); other.close();

  console.log('9. Discovery of draft 7: the first service-desc of Restep 1, and only a 2xx (§4.2)');
  // The root answers 401 with a body that has restep (not a 2xx: not a discovery document) and links a
  // major version 2 first and a Restep 1 document after it.
  const api9 = await mk((req, res) => {
    const send = (s, d, h = {}) => { res.writeHead(s, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(d)); };
    if (req.url === '/v2.json') return send(200, { restep: '2.0', collections: {} });
    if (req.url === '/v1.json') return send(200, { restep: '1.0-draft.7', profiles: ['core'], collections: {} });
    send(401, { restep: '1.0', status: 401, code: 'unauthenticated' }, { link: '</v2.json>; rel="service-desc", </v1.json>; rel="service-desc"' });
  });
  const env9 = { ...process.env, ...sim('h').env, INPUT_URL: `http://127.0.0.1:${api9.address().port}/`, INPUT_RESTEP_CHECK: `node ${JSON.stringify(fake2)}` };
  const child9 = spawn(process.execPath, [join(here, 'action.mjs'), 'check'], { env: env9, stdio: 'ignore' });
  await new Promise((r) => child9.on('exit', r));
  const check9 = JSON.parse(readFileSync(join(env9.RUNNER_TEMP, 'restep-action', 'check.json'), 'utf8'));
  ok(check9.declared === '1.0-draft.7', `skips the 401 body and the major version 2, and reads the Restep 1 document (${check9.declared})`);
  api9.close();
} catch (err) {
  failed++;
  console.log(`  ERROR: ${err.stack}`);
} finally {
  serverB?.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nrestep-action: ${passed} checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
