#!/usr/bin/env node
// restep-action · Pasos de la GitHub Action compuesta (action.yml). Node 18+, sin dependencias.
//
//   node action.mjs start    arranca la API (INPUT_START_COMMAND) y espera a INPUT_WAIT_FOR
//   node action.mjs check    ejecuta restep-check --json y comprueba INPUT_PROFILES
//   node action.mjs diff     compara INPUT_BASE_DISCOVERY con el descubrimiento actual (restep-diff)
//   node action.mjs report   escribe el resumen del job y, con INPUT_COMMENT, el comentario de la PR
//   node action.mjs stop     para la API arrancada con start
//
// Los pasos se pasan los datos por archivos en $RUNNER_TEMP/restep-action. check y diff terminan
// con 0 aunque encuentren fallos: decide report, que corre siempre, para que el resumen salga
// también cuando algo falla.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const env = process.env;
const WORK = join(env.RUNNER_TEMP || tmpdir(), 'restep-action');
const file = (name) => join(WORK, name);
const MARKER = '<!-- restep-action -->';
const COMMENT_MAX = 60000; // GitHub admite 65536 caracteres por comentario
const SUMMARY_MAX = 900000; // y 1 MiB por resumen de paso

const input = (name) => (env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? '').trim();
const bool = (name) => /^(true|yes|1|on)$/i.test(input(name));
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg) {
  console.log(`::error title=restep-action::${escapeCommand(msg)}`);
  process.exit(1);
}
const escapeCommand = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function setOutput(name, value) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

function apiUrl() {
  const u = input('url');
  if (!u) die('Falta el input url (la raíz de la API).');
  try { return new URL(u).href; } catch { die(`El input url no es una URL: ${u}`); }
}

// Cabeceras: una por línea, «Nombre: valor». Las líneas vacías y las que empiezan por # se ignoran.
function headers() {
  const out = [];
  for (const line of input('headers').split('\n').map((l) => l.trim())) {
    if (!line || line.startsWith('#')) continue;
    if (line.indexOf(':') < 1) die(`Cabecera sin dos puntos en el input headers: ${line.split(':')[0]}`);
    out.push(line);
  }
  return out;
}
const headerObject = () => Object.fromEntries(headers().map((h) => [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()]));

// Ejecuta una orden del usuario (como "npx --yes restep-check@0.4") con argumentos sin pasar por
// la shell: bash -c '<orden> "$@"' -- args…
// La salida estándar va a un archivo y no a una tubería: un proceso de Node que termina con
// process.exit() pierde lo que no ha vaciado en una tubería (restep-check 0.8.0 corta su JSON en
// 64 KiB así), mientras que la escritura en un archivo es síncrona.
function runCommand(command, args) {
  const out = file(`stdout-${process.pid}.txt`);
  const r = spawnSync('bash', ['-c', `${command} "$@" > "$RESTEP_ACTION_STDOUT"`, 'restep-action', ...args],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...env, RESTEP_ACTION_STDOUT: out } });
  const stdout = existsSync(out) ? readFileSync(out, 'utf8') : '';
  rmSync(out, { force: true });
  return { exit: r.status ?? 2, stdout, stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
}

// ── start / stop ──────────────────────────────────────────────────────────────
async function start() {
  const command = input('start-command');
  if (!command) return;
  const url = apiUrl();
  const waitFor = input('wait-for') || url;
  const timeout = Number(input('wait-timeout') || 60);
  if (!Number.isFinite(timeout) || timeout <= 0) die(`wait-timeout no es un número de segundos: ${input('wait-timeout')}`);
  const log = file('server.log');
  const fd = openSync(log, 'w');
  // detached: la API queda en su propio grupo de procesos y sobrevive al final de este paso.
  const child = spawn('bash', ['-c', command], { detached: true, stdio: ['ignore', fd, fd], cwd: env.GITHUB_WORKSPACE || process.cwd(), env });
  child.unref();
  writeFileSync(file('server.pid'), String(child.pid));
  console.log(`API arrancada (pid ${child.pid}): ${command}`);
  const deadline = Date.now() + timeout * 1000;
  let last = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(waitFor, { headers: headerObject(), signal: AbortSignal.timeout(5000) });
      console.log(`${waitFor} responde ${res.status}.`);
      return;
    } catch (e) { last = e.cause?.code ?? e.message; }
    await sleep(500);
  }
  const tail = readFileSync(log, 'utf8').split('\n').slice(-30).join('\n');
  console.log(`Últimas líneas de la API:\n${tail}`);
  stop();
  die(child.exitCode !== null ? `La API terminó con código ${child.exitCode} antes de responder en ${waitFor}.`
    : `${waitFor} no responde tras ${timeout} s (${last}).`);
}

function stop() {
  const p = file('server.pid');
  if (!existsSync(p)) return;
  const pid = Number(readFileSync(p, 'utf8'));
  try { process.kill(-pid, 'SIGTERM'); console.log(`API parada (pid ${pid}).`); } catch { /* ya no estaba */ }
  rmSync(p, { force: true });
}

// ── check ─────────────────────────────────────────────────────────────────────
async function check() {
  const url = apiUrl();
  rmSync(file('check.json'), { force: true });
  const args = [url, '--json'];
  if (bool('writes')) args.push('--writes');
  for (const h of headers()) args.push('-H', h);
  const command = input('restep-check') || 'npx --yes restep-check@0.9';
  console.log(`${command} ${args.map((a) => (/^authorization:/i.test(a) ? 'Authorization: ***' : a)).join(' ')}`);
  const r = runCommand(command, args);
  if (r.stderr) process.stderr.write(r.stderr);
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* restep-check no pudo correr: lo cuenta report */ }
  const announced = report ? [...(report.profiles ?? []), ...(report.extensions ?? [])] : [];
  const required = input('profiles').split(/[\s,]+/).filter(Boolean);
  const missing = report ? required.filter((p) => !announced.includes(p)) : [];
  // La versión que declara la API, para el resumen (restep-check no la da en su JSON).
  let declared = null;
  if (report) {
    try { declared = (await fetchDiscovery(url, headerObject())).restep; } catch { /* sin descubrimiento legible: no hay fila */ }
  }
  writeJson(file('check.json'), { url, exit: r.exit, stderr: r.stderr.slice(-4000), report, required, missing, declared });
  if (!report) console.log(`restep-check no ha dado un informe JSON (código ${r.exit}).`);
  else {
    const n = (s) => report.results.filter((x) => x.status === s).length;
    console.log(`restep-check: ${n('fail')} fallos, ${n('warn')} avisos, ${n('pass')} correctas, ${n('skip')} omitidas.`);
    if (missing.length) console.log(`La API no anuncia: ${missing.join(', ')}.`);
  }
}

// ── diff ──────────────────────────────────────────────────────────────────────
const isDiscovery = (d) => d && typeof d === 'object' && !Array.isArray(d) && typeof d.restep === 'string';

// La versión declarada en «restep» (§1.1): gramática ABNF, mayor 1 para ser Restep 1, y sufijo
// -draft.N o -rc.N para un borrador o un candidato, que no da las garantías de una versión publicada.
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(draft|rc)\.(0|[1-9][0-9]*))?$/;
function describeVersion(v) {
  if (typeof v !== 'string') return null;
  const m = VERSION_RE.exec(v);
  if (!m) return { value: v, text: 'no sigue la gramática de §1.1: no es un documento de descubrimiento de Restep 1', restep1: false };
  if (m[1] !== '1') return { value: v, text: `versión mayor ${m[1]}: no es Restep 1 (§1.1)`, restep1: false };
  const base = `${m[1]}.${m[2]}`;
  if (m[3] === 'draft') return { value: v, text: `borrador ${m[4]} de ${base}: sin las garantías de una versión publicada (§1.1)`, restep1: true };
  if (m[3] === 'rc') return { value: v, text: `candidata ${m[4]} de ${base}: sin las garantías de una versión publicada (§1.1)`, restep1: true };
  return { value: v, text: 'versión publicada', restep1: true };
}

function linkTargets(header, rel) {
  if (!header) return [];
  return header.split(/,(?=\s*<)/).flatMap((part) => {
    const m = part.match(/<([^>]*)>(.*)/);
    if (!m) return [];
    return (m[2].match(/rel="?([^";]+)"?/)?.[1] ?? '').split(/\s+/).includes(rel) ? [m[1]] : [];
  });
}

// §3: no se sigue un enlace cuyo esquema no sea https ni el de la raíz (data:, file:…); §4.3: las
// cabeceras (credenciales) solo van al origen de la URL pedida.
async function fetchDiscovery(url, hdrs) {
  let res = await fetch(url, { headers: { accept: 'application/json', ...hdrs } });
  let doc = await res.json().catch(() => null);
  if (!isDiscovery(doc)) {
    const root = new URL(url);
    for (const href of linkTargets(res.headers.get('link'), 'service-desc')) {
      let target;
      try { target = new URL(href, url); } catch { continue; }
      if (target.protocol !== 'https:' && target.protocol !== root.protocol) continue;
      const same = target.origin === root.origin;
      const r = await fetch(target, { headers: { accept: 'application/json', ...(same ? hdrs : {}) } });
      const d = await r.json().catch(() => null);
      if (isDiscovery(d)) { doc = d; res = r; break; }
    }
  }
  if (!isDiscovery(doc)) throw new Error(`${url} no sirve un documento de descubrimiento (respondió ${res.status}).`);
  return doc;
}

async function diff() {
  const url = apiUrl();
  rmSync(file('diff.json'), { force: true });
  const base = input('base-discovery');
  if (!base) return;
  const record = (v) => writeJson(file('diff.json'), { base, ...v });
  try {
    writeJson(file('new-discovery.json'), await fetchDiscovery(url, headerObject()));
    let basePath;
    if (/^https?:\/\//i.test(base)) {
      // Las cabeceras (credenciales) solo van al origen de la API (§4.3).
      const same = new URL(base).origin === new URL(url).origin;
      writeJson(file('base-discovery.json'), await fetchDiscovery(base, same ? headerObject() : {}));
      basePath = file('base-discovery.json');
    } else {
      basePath = resolve(env.GITHUB_WORKSPACE || process.cwd(), base);
      if (!existsSync(basePath)) throw new Error(`No existe el descubrimiento base ${base}.`);
      if (!isDiscovery(readJson(basePath))) throw new Error(`${base} no es un documento de descubrimiento (le falta restep).`);
    }
    const command = input('restep-diff') || 'npx --yes github:restep-spec/restep-diff#v0.2.0';
    const args = [basePath, file('new-discovery.json'), '--markdown', '--fail-on', 'breaking'];
    console.log(`${command} ${args.join(' ')}`);
    const r = runCommand(command, args);
    if (r.stderr) process.stderr.write(r.stderr);
    console.log(r.stdout);
    record({ exit: r.exit, markdown: r.stdout, stderr: r.stderr.slice(-4000) });
  } catch (e) {
    console.log(e.message);
    record({ exit: 2, markdown: '', stderr: e.message });
  }
}

// ── report ────────────────────────────────────────────────────────────────────
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 400);
const SPEC = 'https://restep.wubytes.com/1/';

function checkSection(c) {
  const lines = [];
  if (!c) return { ok: false, failures: 0, lines: ['**restep-check no ha llegado a ejecutarse** (¿falló el arranque de la API?).', ''] };
  if (!c.report) {
    return { ok: false, failures: 0, lines: [`**restep-check no ha podido comprobar la API** (código ${c.exit}).`, '', '```', c.stderr.trim().slice(-2000), '```', ''] };
  }
  const rs = c.report.results;
  const by = (s) => rs.filter((r) => r.status === s);
  const fails = by('fail'), warns = by('warn');
  const row = (r) => `| \`${r.id}\` | ${cell(r.target)} | ${cell(r.message)} | ${r.level} · [§${r.section}](${SPEC}) |`;
  if (fails.length) {
    lines.push(`### Fallos (${fails.length})`, '', '| Comprobación | Dónde | Detalle | Nivel |', '|---|---|---|---|', ...fails.map(row), '');
  }
  if (warns.length) {
    lines.push(`<details><summary>Avisos (${warns.length})</summary>`, '', '| Comprobación | Dónde | Detalle | Nivel |', '|---|---|---|---|', ...warns.map(row), '', '</details>', '');
  }
  return { ok: !fails.length && !c.missing.length, failures: fails.length, warnings: warns.length, passed: by('pass').length, skipped: by('skip').length, lines };
}

async function report() {
  mkdirSync(WORK, { recursive: true });
  const c = readJson(file('check.json'));
  const d = input('base-discovery') ? readJson(file('diff.json')) : null;
  const url = c?.url ?? input('url');
  const cs = checkSection(c);
  const breaking = d?.exit === 1;
  const diffError = d && d.exit !== 0 && d.exit !== 1;
  const ok = cs.ok && !breaking && !diffError && !(input('base-discovery') && !d);

  const rows = [];
  if (c?.report) {
    const r = c.report;
    rows.push(`| Conformidad | ${cs.failures ? `**${cs.failures} DEBE fallan**` : 'sin fallos de DEBE'} · ${cs.warnings} avisos · ${cs.passed} correctas · ${cs.skipped} omitidas (restep-check ${r.version}${r.writes ? ', con --writes' : ', solo lectura'}) |`);
    const announced = [...(r.profiles ?? []), ...(r.extensions ?? [])].join(', ');
    const v = describeVersion(c.declared);
    if (v) rows.push(`| Versión declarada | \`${cell(v.value)}\`: ${v.restep1 ? v.text : `**${v.text}**`} |`);
    rows.push(`| Perfiles | ${announced}${c.missing.length ? ` · **no anuncia: ${c.missing.join(', ')}**` : ''} |`);
  } else rows.push('| Conformidad | **no se ha podido comprobar** |');
  if (input('base-discovery')) {
    rows.push(`| Compatibilidad | ${!d ? '**no se ha podido comparar**' : breaking ? '**cambios incompatibles**' : diffError ? `**restep-diff no ha podido comparar** (código ${d.exit})` : 'sin cambios incompatibles'} con \`${cell(input('base-discovery'))}\` |`);
  }

  const md = [MARKER, `## Restep ${ok ? 'correcto' : 'con problemas'}: ${url}`, '', '| | |', '|---|---|', ...rows, '', ...cs.lines];
  if (d) {
    md.push('### Compatibilidad (restep-diff)', '');
    if (d.markdown.trim()) md.push(d.markdown.trim(), '');
    if (diffError) md.push('```', (d.stderr || '').trim().slice(-2000), '```', '');
  }
  let text = md.join('\n');
  writeFileSync(file('summary.md'), text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}\n\n(recortado)` : text}\n`);
  else console.log(text);

  // Anotaciones en la ejecución: los primeros fallos, con su apartado de la especificación.
  for (const r of (c?.report?.results ?? []).filter((x) => x.status === 'fail').slice(0, 10)) {
    console.log(`::error title=${escapeCommand(`restep ${r.id}`)}::${escapeCommand(`${r.target ? `[${r.target}] ` : ''}${r.message} (§${r.section})`)}`);
  }
  for (const p of c?.missing ?? []) console.log(`::error title=restep perfiles::${escapeCommand(`La API no anuncia ${p}.`)}`);
  if (breaking) console.log('::error title=restep-diff::Hay cambios incompatibles con el descubrimiento base.');

  setOutput('result', ok ? 'pass' : 'fail');
  setOutput('check-failures', String(cs.failures));
  setOutput('breaking', String(breaking));
  setOutput('summary-file', file('summary.md'));

  if (bool('comment')) {
    if (text.length > COMMENT_MAX) text = `${text.slice(0, COMMENT_MAX)}\n\n(recortado: el informe completo está en el resumen del job)`;
    comment(text, url);
  }
  if (!ok && !/^(false|no|0|off)$/i.test(input('fail-on-error'))) process.exit(1);
}

// Comentario de PR: uno por API (marcador con la URL), que se actualiza en cada ejecución.
function comment(text, url) {
  const event = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH) ? readJson(env.GITHUB_EVENT_PATH) : null;
  const number = event?.pull_request?.number ?? (event?.issue?.pull_request ? event.issue.number : null);
  if (!number) { console.log(`comment: el evento ${env.GITHUB_EVENT_NAME ?? '(desconocido)'} no es una PR; solo se escribe el resumen del job.`); return; }
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) { console.log('::warning title=restep-action::Falta GITHUB_REPOSITORY; no se comenta.'); return; }
  const marker = `<!-- restep-action: ${url} -->`;
  const body = `${marker}\n${text}`;
  const gh = (args, inputJson) => {
    let path = null;
    if (inputJson) { path = file('comment.json'); writeJson(path, inputJson); args.push('--input', path); }
    return spawnSync('gh', args, { encoding: 'utf8', env });
  };
  const list = gh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate', '--jq', `.[] | select(.body | contains(${JSON.stringify(marker)})) | .id`]);
  if (list.status !== 0) {
    console.log(`::warning title=restep-action::No se pueden leer los comentarios de la PR (¿falta permissions: pull-requests: write?): ${escapeCommand((list.stderr || list.error || '').toString().trim())}`);
    return;
  }
  const id = list.stdout.split('\n').map((s) => s.trim()).find(Boolean);
  const r = id ? gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${id}`], { body })
    : gh(['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`], { body });
  if (r.status !== 0) console.log(`::warning title=restep-action::No se puede publicar el comentario: ${escapeCommand((r.stderr || r.error || '').toString().trim())}`);
  else console.log(id ? `Comentario ${id} actualizado.` : 'Comentario publicado.');
}

// ── Principal ─────────────────────────────────────────────────────────────────
const steps = { start, check, diff, report, stop };
const step = process.argv[2];
if (!steps[step]) {
  console.error(`Uso: node action.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
mkdirSync(WORK, { recursive: true });
try { await steps[step](); } catch (e) { die(`${step}: ${e.message}`); }
