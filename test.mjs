// Pruebas de restep-action: valida action.yml y ejecuta sus pasos de shell en local, simulando
// el runner de GitHub (variables GITHUB_*, if: de los pasos, salidas), contra el servidor de
// referencia en los puertos 8897-8899. gh y restep-diff se sustituyen por dobles de prueba.
// Uso, desde restep/:  node tools/restep-action/test.mjs
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual } from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'vendor/restep-server.mjs');
const CHECKER = join(here, 'vendor/restep-check.mjs');
const PORT_A = 8897, PORT_B = 8898, PORT_DEAD = 8899;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; console.log(`  FALLO: ${msg}`); }
}

// ── Mini-analizador del subconjunto de YAML que usa action.yml ────────────────
function parseYaml(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (/\t/.test(raw.match(/^\s*/)[0])) throw new Error(`tabulador en la sangría: ${raw}`);
    lines.push({ indent: raw.match(/^ */)[0].length, text: raw.trim() });
  }
  let i = 0;
  const scalar = (s) => {
    if (s.startsWith("'")) { if (!s.endsWith("'") || s.length < 2) throw new Error(`comilla sin cerrar: ${s}`); return s.slice(1, -1).replace(/''/g, "'"); }
    if (s.startsWith('"')) return JSON.parse(s);
    s = s.replace(/\s+#.*$/, '');
    if (s === 'true' || s === 'false') return s === 'true';
    if (s === 'null' || s === '~') return null;
    if (/^[[{&*!|>%@`]/.test(s)) throw new Error(`sintaxis de YAML fuera del subconjunto: ${s}`);
    return s;
  };
  const splitKey = (t) => {
    const m = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(t);
    if (!m) throw new Error(`línea no válida: ${t}`);
    return [m[1], m[2] ?? ''];
  };
  function block(indent) { return lines[i].text.startsWith('- ') ? list(indent) : map(indent); }
  function map(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const [key, rest] = splitKey(lines[i].text);
      if (key in obj) throw new Error(`clave repetida: ${key}`);
      i++;
      if (rest === '') obj[key] = i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null;
      else obj[key] = scalar(rest);
    }
    if (i < lines.length && lines[i].indent > indent) throw new Error(`sangría inesperada: ${lines[i].text}`);
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
  if (i !== lines.length) throw new Error(`no se ha leído entero: ${lines[i].text}`);
  return doc;
}

// ── Simulador del runner para una acción compuesta ────────────────────────────
function evalExpr(expr, ctx) {
  const js = expr.trim()
    .replace(/'([^']*)'/g, (_, s) => JSON.stringify(s))
    .replace(/\binputs\.([A-Za-z0-9_-]+)/g, (_, k) => JSON.stringify(ctx.inputs[k] ?? ''))
    .replace(/\bgithub\.([A-Za-z0-9_]+)/g, (_, k) => JSON.stringify(ctx.github[k] ?? ''))
    .replace(/\bsteps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g, (_, s, k) => JSON.stringify(ctx.steps[s]?.outputs?.[k] ?? ''))
    .replace(/\balways\(\)/g, 'true').replace(/\bsuccess\(\)/g, String(!ctx.failed)).replace(/\bfailure\(\)/g, String(ctx.failed))
    .replace(/!=/g, '!==').replace(/==/g, '===').replace(/!===/g, '!==').replace(/====/g, '===');
  if (/[^\s"'()!=&|]/.test(js.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/\b(true|false)\b/g, ''))) throw new Error(`expresión no admitida por el simulador: ${expr}`);
  return Function(`return (${js});`)();
}
const interpolate = (s, ctx) => String(s).replace(/\$\{\{([^}]*)\}\}/g, (_, e) => String(evalExpr(e, ctx)));

function runAction(action, inputs, sim) {
  const ctx = { inputs: {}, github: { token: 'token-de-prueba' }, steps: {}, failed: false };
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

// ── Dobles de gh y restep-diff ────────────────────────────────────────────────
function writeStubs(bin) {
  mkdirSync(bin, { recursive: true });
  // gh: guarda cada llamada en GH_STUB_LOG y los comentarios en GH_STUB_STATE.
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
  // restep-diff con la CLI supuesta: restep-diff <viejo> <nuevo> --markdown --fail-on breaking.
  writeFileSync(join(bin, 'restep-diff-stub.mjs'), `import fs from 'node:fs';
const [a, b, ...rest] = process.argv.slice(2);
if (rest.join(' ') !== '--markdown --fail-on breaking') { console.error('argumentos inesperados: ' + rest.join(' ')); process.exit(2); }
const old = JSON.parse(fs.readFileSync(a, 'utf8')), now = JSON.parse(fs.readFileSync(b, 'utf8'));
const gone = Object.keys(old.collections ?? {}).filter((c) => !(c in (now.collections ?? {})));
if (gone.length) { console.log('#### Incompatibles\\n' + gone.map((c) => '- Se elimina la colección ' + c).join('\\n')); process.exit(1); }
console.log('Sin cambios incompatibles.');
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

// ── Pruebas ───────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'restep-action-'));
let serverB = null;
try {
  console.log('1. action.yml: sintaxis y estructura');
  const text = readFileSync(join(here, 'action.yml'), 'utf8');
  const action = parseYaml(text);
  const ruby = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(STDIN.read))'], { input: text, encoding: 'utf8' });
  if (ruby.status === 0) {
    try { deepStrictEqual(action, JSON.parse(ruby.stdout)); ok(true); } catch (e) { ok(false, `el analizador de Ruby lee otra cosa: ${e.message.slice(0, 500)}`); }
  } else console.log('  (sin Ruby: solo el analizador propio)');
  ok(typeof action.name === 'string' && typeof action.description === 'string', 'name y description');
  ok(action.runs?.using === 'composite', 'runs.using: composite');
  for (const k of ['url', 'start-command', 'wait-for', 'profiles', 'writes', 'base-discovery', 'comment']) ok(action.inputs[k], `input ${k}`);
  for (const [k, v] of Object.entries(action.inputs)) ok(typeof v.description === 'string', `input ${k} con description`);
  const ids = action.runs.steps.map((s) => s.id).filter(Boolean);
  ok(new Set(ids).size === ids.length, 'ids de paso únicos');
  for (const s of action.runs.steps) {
    ok(s.shell === 'bash' && typeof s.run === 'string', `paso «${s.name}» con shell y run`);
    ok(!/\$\{\{/.test(s.run), `paso «${s.name}»: sin expresiones dentro del script (inyección)`);
    for (const [k, v] of Object.entries(s.env ?? {})) {
      const m = /^\$\{\{ inputs\.([a-z-]+) \}\}$/.exec(v);
      if (m) {
        ok(m[1] in action.inputs, `paso «${s.name}»: el input ${m[1]} existe`);
        ok(k === `INPUT_${m[1].toUpperCase().replace(/-/g, '_')}` || k === 'GH_TOKEN', `paso «${s.name}»: ${k} se llama como su input`);
      }
    }
  }
  for (const m of text.matchAll(/inputs\.([a-z0-9-]+)/g)) ok(m[1] in action.inputs, `referencia a un input declarado: ${m[1]}`);
  for (const [k, o] of Object.entries(action.outputs)) {
    const m = /steps\.([a-z-]+)\.outputs/.exec(o.value);
    ok(m && ids.includes(m[1]), `la salida ${k} apunta a un paso que existe`);
  }
  const syntax = spawnSync(process.execPath, ['--check', join(here, 'action.mjs')], { encoding: 'utf8' });
  ok(syntax.status === 0, `action.mjs compila: ${syntax.stderr}`);

  // Entorno simulado del runner.
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

  // Descubrimiento base: el mismo que sirve el servidor (sin cambios) y otro con una colección más.
  const tmpServer = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT_A) }, stdio: 'ignore' });
  await waitUp(PORT_A);
  const disc = await (await fetch(`http://localhost:${PORT_A}/`)).json();
  tmpServer.kill();
  await isDown(PORT_A);
  writeFileSync(join(workspace, 'base-same.json'), JSON.stringify(disc));
  writeFileSync(join(workspace, 'base-more.json'), JSON.stringify({ ...disc, collections: { ...disc.collections, authors: { path: '/authors' } } }));

  console.log('2. Arranca la API, comprueba, compara sin cambios y comenta en la PR');
  const sa = sim('a');
  const a = runAction(action, {
    ...common, url: `http://localhost:${PORT_A}/`, 'start-command': startCmd(PORT_A), 'wait-for': `http://localhost:${PORT_A}/health`,
    profiles: 'core,query,writes', 'base-discovery': 'base-same.json', comment: 'true',
  }, sa);
  ok(!a.failed, `no falla ningún paso: ${a.log.filter((s) => s.exit).map((s) => `${s.name}: ${s.stdout}${s.stderr}`).join('\n')}`);
  ok(a.outputs.result === 'pass', `result = pass (${a.outputs.result})`);
  ok(a.outputs['check-failures'] === '0' && a.outputs.breaking === 'false', 'sin fallos ni cambios incompatibles');
  const sumA = readFileSync(sa.summary, 'utf8');
  ok(sumA.includes(`## Restep correcto: http://localhost:${PORT_A}/`), 'el resumen del job lleva el título');
  ok(sumA.includes('| Perfiles | core, query, writes |') && sumA.includes('sin cambios incompatibles'), 'el resumen lleva perfiles y compatibilidad');
  ok(sumA.includes('Sin cambios incompatibles.'), 'el resumen incluye la salida de restep-diff');
  ok(existsSync(a.outputs['summary-file']), 'summary-file existe');
  let calls = ghCalls();
  ok(calls.length === 2 && calls[0].method === 'GET' && calls[1].method === 'POST' && calls[1].path === 'repos/restep-spec/ejemplo/issues/42/comments', 'comentario nuevo en la PR 42');
  ok(calls[1].token === 'token-de-prueba', 'gh recibe el github-token');
  ok(calls[1].body.startsWith(`<!-- restep-action: http://localhost:${PORT_A}/ -->`), 'el comentario lleva el marcador');
  ok(a.step('Parar la API').exit === 0, 'para la API');
  ok(await isDown(PORT_A), 'la API ya no responde');

  console.log('3. Cambio incompatible, perfil que falta y --writes: falla y actualiza el mismo comentario');
  const sb = sim('b');
  const b = runAction(action, {
    ...common, url: `http://localhost:${PORT_A}/`, 'start-command': startCmd(PORT_A),
    profiles: 'core, query, writes, sync', writes: 'true', 'base-discovery': 'base-more.json', comment: 'true',
  }, sb);
  ok(b.step('Informe').exit === 1, 'el informe termina con 1');
  ok(b.outputs.result === 'fail' && b.outputs.breaking === 'true', 'result = fail y breaking = true');
  const sumB = readFileSync(sb.summary, 'utf8');
  ok(sumB.includes('no anuncia: sync') && sumB.includes('Se elimina la colección authors') && sumB.includes('con --writes'), 'el resumen explica el perfil, el cambio y --writes');
  ok(b.step('Informe').stdout.includes('::error title=restep-diff::'), 'anotación de error para el cambio incompatible');
  calls = ghCalls();
  ok(calls.length === 4 && calls[3].method === 'PATCH' && calls[3].path === 'repos/restep-spec/ejemplo/issues/comments/1000', 'actualiza el comentario 1000');
  ok(JSON.parse(readFileSync(join(tmp, 'gh.json'), 'utf8')).length === 1, 'sigue habiendo un solo comentario');
  ok(b.step('Parar la API').exit === 0 && await isDown(PORT_A), 'para la API aunque falle');

  console.log('4. Con url ya arrancada, oauth y cabeceras; fuera de una PR');
  serverB = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT_B), RESTEP_TOKEN: 'secreto' }, stdio: 'ignore' });
  await waitUp(PORT_B);
  const sc = sim('c', { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: join(tmp, 'push.json') });
  writeFileSync(join(tmp, 'push.json'), JSON.stringify({ ref: 'refs/heads/master' }));
  const c = runAction(action, { ...common, url: `http://localhost:${PORT_B}/`, headers: 'Authorization: Bearer secreto', profiles: 'oauth', comment: 'true' }, sc);
  ok(c.step('Arrancar la API').skipped && c.step('restep-diff').skipped && c.step('Parar la API').skipped, 'se saltan arrancar, diff y parar');
  ok(c.outputs.result === 'pass', `result = pass con el token (${readFileSync(sc.summary, 'utf8').slice(0, 800)})`);
  ok(readFileSync(sc.summary, 'utf8').includes('core, query, writes, oauth'), 'anuncia oauth');
  ok(c.step('Informe').stdout.includes('no es una PR'), 'fuera de una PR no comenta');
  ok(ghCalls().length === 4, 'no llama a gh');
  ok(!c.step('restep-check').stdout.includes('secreto'), 'el token no sale en el registro');
  // Sin token el descubrimiento da 401: restep-check solo ve core y oauth, así que falta query.
  const sc2 = sim('c2');
  const c2 = runAction(action, { ...common, url: `http://localhost:${PORT_B}/`, profiles: 'core,query' }, sc2);
  ok(c2.outputs.result === 'fail' && c2.failed, 'sin token falla');
  ok(readFileSync(sc2.summary, 'utf8').includes('no anuncia: query'), 'sin token no ve query');

  console.log('5. La API no arranca');
  const sd = sim('d');
  const d = runAction(action, { ...common, url: `http://localhost:${PORT_DEAD}/`, 'start-command': 'echo "fallo al arrancar"; exit 3', 'wait-timeout': '5' }, sd);
  ok(d.step('Arrancar la API').exit !== 0 && d.step('Arrancar la API').stdout.includes('fallo al arrancar'), 'el arranque falla y enseña el registro');
  ok(d.step('restep-check').skipped, 'restep-check se salta');
  ok(d.step('Informe').exit === 1 && readFileSync(sd.summary, 'utf8').includes('no ha llegado a ejecutarse'), 'el informe corre igualmente y lo explica');
  ok(d.step('Parar la API').exit === 0, 'parar corre igualmente');

  console.log('6. fail-on-error: false y restep-diff que no puede comparar');
  const se = sim('e');
  const e = runAction(action, {
    ...common, url: `http://localhost:${PORT_A}/`, 'start-command': startCmd(PORT_A), 'base-discovery': 'no-existe.json', 'fail-on-error': 'false',
  }, se);
  ok(!e.failed && e.outputs.result === 'fail', 'result = fail pero el job sigue');
  ok(readFileSync(se.summary, 'utf8').includes('No existe el descubrimiento base no-existe.json'), 'explica el error del diff');
  ok(await isDown(PORT_A), 'para la API');

  console.log('7. Un DEBE que falla: tabla de fallos y anotación');
  const fake = join(bin, 'check-stub.mjs');
  writeFileSync(fake, `console.log(JSON.stringify({ root: process.argv[2], profiles: ['core'], extensions: [], writes: false, version: '9.9.9', results: [
    { id: 'core.put', status: 'fail', level: 'MUST', section: '5.1', target: 'books', message: 'PUT da 200 | no 405', evidence: null },
    { id: 'passive.error.detail', status: 'warn', level: 'SHOULD', section: '5.4', target: null, message: 'sin detail', evidence: null }] }));
process.exit(1);`);
  const sf = sim('f');
  const f = runAction(action, { url: 'http://localhost:1/', 'restep-check': `node ${JSON.stringify(fake)}` }, sf);
  const sumF = readFileSync(sf.summary, 'utf8');
  ok(f.outputs['check-failures'] === '1' && f.outputs.result === 'fail', 'cuenta el fallo');
  ok(sumF.includes('| `core.put` | books | PUT da 200 \\| no 405 | MUST · [§5.1]('), 'fila de la tabla con la barra escapada');
  ok(sumF.includes('<summary>Avisos (1)</summary>'), 'avisos plegados');
  ok(f.step('Informe').stdout.includes('::error title=restep core.put::[books] PUT da 200 | no 405 (§5.1)'), 'anotación del fallo');
} catch (err) {
  failed++;
  console.log(`  ERROR: ${err.stack}`);
} finally {
  serverB?.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nrestep-action: ${passed} comprobaciones correctas, ${failed} fallidas.`);
process.exit(failed ? 1 : 0);
