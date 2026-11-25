#!/usr/bin/env node
// restep-action · Steps of the composite GitHub Action (action.yml). Node 18+, no dependencies.
//
//   node action.mjs start    starts the API (INPUT_START_COMMAND) and waits for INPUT_WAIT_FOR
//   node action.mjs check    runs restep-check --json and checks INPUT_PROFILES
//   node action.mjs diff     compares INPUT_BASE_DISCOVERY with the current discovery document (restep-diff)
//   node action.mjs report   writes the job summary and, with INPUT_COMMENT, the PR comment
//   node action.mjs stop     stops the API started by start
//
// The steps pass data to each other through files in $RUNNER_TEMP/restep-action. check and diff finish
// with 0 even if they find failures: report decides, and it always runs, so that the summary
// also appears when something fails.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const env = process.env;
const WORK = join(env.RUNNER_TEMP || tmpdir(), 'restep-action');
const file = (name) => join(WORK, name);
const MARKER = '<!-- restep-action -->';
const COMMENT_MAX = 60000; // GitHub allows 65536 characters per comment
const SUMMARY_MAX = 900000; // and 1 MiB per step summary

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
  if (!u) die('Missing the url input (the API root).');
  try { return new URL(u).href; } catch { die(`The url input is not a URL: ${u}`); }
}

// Headers: one per line, «Name: value». Empty lines and those starting with # are ignored.
function headers() {
  const out = [];
  for (const line of input('headers').split('\n').map((l) => l.trim())) {
    if (!line || line.startsWith('#')) continue;
    if (line.indexOf(':') < 1) die(`Header without a colon in the headers input: ${line.split(':')[0]}`);
    out.push(line);
  }
  return out;
}
const headerObject = () => Object.fromEntries(headers().map((h) => [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()]));

// Runs a user command (such as "npx --yes restep-check@0.4") with arguments without going through
// the shell: bash -c '<command> "$@"' -- args…
// Standard output goes to a file and not a pipe: a Node process that ends with
// process.exit() loses whatever it has not flushed to a pipe (restep-check 0.8.0 cuts its JSON at
// 64 KiB that way), while writing to a file is synchronous.
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
  if (!Number.isFinite(timeout) || timeout <= 0) die(`wait-timeout is not a number of seconds: ${input('wait-timeout')}`);
  const log = file('server.log');
  const fd = openSync(log, 'w');
  // detached: the API stays in its own process group and survives the end of this step.
  const child = spawn('bash', ['-c', command], { detached: true, stdio: ['ignore', fd, fd], cwd: env.GITHUB_WORKSPACE || process.cwd(), env });
  child.unref();
  writeFileSync(file('server.pid'), String(child.pid));
  console.log(`API started (pid ${child.pid}): ${command}`);
  const deadline = Date.now() + timeout * 1000;
  let last = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(waitFor, { headers: headerObject(), signal: AbortSignal.timeout(5000) });
      console.log(`${waitFor} answers ${res.status}.`);
      return;
    } catch (e) { last = e.cause?.code ?? e.message; }
    await sleep(500);
  }
  const tail = readFileSync(log, 'utf8').split('\n').slice(-30).join('\n');
  console.log(`Last lines from the API:\n${tail}`);
  stop();
  die(child.exitCode !== null ? `The API exited with code ${child.exitCode} before answering at ${waitFor}.`
    : `${waitFor} does not answer after ${timeout} s (${last}).`);
}

function stop() {
  const p = file('server.pid');
  if (!existsSync(p)) return;
  const pid = Number(readFileSync(p, 'utf8'));
  try { process.kill(-pid, 'SIGTERM'); console.log(`API stopped (pid ${pid}).`); } catch { /* it was already gone */ }
  rmSync(p, { force: true });
}

// ── check ─────────────────────────────────────────────────────────────────────
async function check() {
  const url = apiUrl();
  rmSync(file('check.json'), { force: true });
  const args = [url, '--json'];
  if (bool('writes')) args.push('--writes');
  for (const h of headers()) args.push('-H', h);
  const command = input('restep-check') || 'npx --yes restep-check@0.10';
  console.log(`${command} ${args.map((a) => (/^authorization:/i.test(a) ? 'Authorization: ***' : a)).join(' ')}`);
  const r = runCommand(command, args);
  if (r.stderr) process.stderr.write(r.stderr);
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* restep-check could not run: report tells it */ }
  const announced = report ? [...(report.profiles ?? []), ...(report.extensions ?? [])] : [];
  const required = input('profiles').split(/[\s,]+/).filter(Boolean);
  const missing = report ? required.filter((p) => !announced.includes(p)) : [];
  // The version the API declares, for the summary (restep-check does not give it in its JSON).
  let declared = null;
  if (report) {
    try { declared = (await fetchDiscovery(url, headerObject())).restep; } catch { /* no readable discovery document: no row */ }
  }
  writeJson(file('check.json'), { url, exit: r.exit, stderr: r.stderr.slice(-4000), report, required, missing, declared });
  if (!report) console.log(`restep-check gave no JSON report (code ${r.exit}).`);
  else {
    const n = (s) => report.results.filter((x) => x.status === s).length;
    console.log(`restep-check: ${n('fail')} failures, ${n('warn')} warnings, ${n('pass')} passed, ${n('skip')} skipped.`);
    if (missing.length) console.log(`The API does not announce: ${missing.join(', ')}.`);
  }
}

// ── diff ──────────────────────────────────────────────────────────────────────
const isDiscovery = (d) => d && typeof d === 'object' && !Array.isArray(d) && typeof d.restep === 'string';

// The version declared in «restep» (§1.1): ABNF grammar, major 1 to be Restep 1, and a suffix
// -draft.N or -rc.N for a draft or a candidate, which does not give the guarantees of a published version.
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(draft|rc)\.(0|[1-9][0-9]*))?$/;
function describeVersion(v) {
  if (typeof v !== 'string') return null;
  const m = VERSION_RE.exec(v);
  if (!m) return { value: v, text: 'does not follow the grammar of §1.1: not a Restep 1 discovery document', restep1: false };
  if (m[1] !== '1') return { value: v, text: `major version ${m[1]}: not Restep 1 (§1.1)`, restep1: false };
  const base = `${m[1]}.${m[2]}`;
  if (m[3] === 'draft') return { value: v, text: `draft ${m[4]} of ${base}: without the guarantees of a published version (§1.1)`, restep1: true };
  if (m[3] === 'rc') return { value: v, text: `release candidate ${m[4]} of ${base}: without the guarantees of a published version (§1.1)`, restep1: true };
  return { value: v, text: 'published version', restep1: true };
}

function linkTargets(header, rel) {
  if (!header) return [];
  return header.split(/,(?=\s*<)/).flatMap((part) => {
    const m = part.match(/<([^>]*)>(.*)/);
    if (!m) return [];
    return (m[2].match(/rel="?([^";]+)"?/)?.[1] ?? '').split(/\s+/).includes(rel) ? [m[1]] : [];
  });
}

// §3: a link whose scheme is neither https nor the root's (data:, file:…) is not followed; §4.3: the
// headers (credentials) only go to the origin of the requested URL.
// §4.2: only a 2xx whose body is a JSON object with a string restep is a discovery document. Of several
// service-desc links, the first target that is a discovery document of Restep 1 is the one; if none is,
// the first discovery document of another version is kept, only to report that it is not Restep 1.
async function fetchDiscovery(url, hdrs) {
  const read = async (target, h) => {
    const r = await fetch(target, { headers: { accept: 'application/json', ...h } });
    const d = await r.json().catch(() => null);
    return { res: r, doc: r.ok && isDiscovery(d) ? d : null };
  };
  const first = await read(url, hdrs);
  const restep1 = (d) => d && describeVersion(d.restep)?.restep1;
  if (restep1(first.doc)) return first.doc;
  let other = first.doc;
  const root = new URL(url);
  for (const href of linkTargets(first.res.headers.get('link'), 'service-desc')) {
    let target;
    try { target = new URL(href, url); } catch { continue; }
    if (target.protocol !== 'https:' && target.protocol !== root.protocol) continue;
    const { doc } = await read(target, target.origin === root.origin ? hdrs : {});
    if (restep1(doc)) return doc;
    other ??= doc;
  }
  if (!other) throw new Error(`${url} does not serve a discovery document (it answered ${first.res.status}).`);
  return other;
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
      // Headers (credentials) only go to the API's origin (§4.3).
      const same = new URL(base).origin === new URL(url).origin;
      writeJson(file('base-discovery.json'), await fetchDiscovery(base, same ? headerObject() : {}));
      basePath = file('base-discovery.json');
    } else {
      basePath = resolve(env.GITHUB_WORKSPACE || process.cwd(), base);
      if (!existsSync(basePath)) throw new Error(`The base discovery document ${base} does not exist.`);
      if (!isDiscovery(readJson(basePath))) throw new Error(`${base} is not a discovery document (it lacks restep).`);
    }
    const command = input('restep-diff') || 'npx --yes restep-diff@0.3';
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
  if (!c) return { ok: false, failures: 0, lines: ['**restep-check did not run** (did the API fail to start?).', ''] };
  if (!c.report) {
    return { ok: false, failures: 0, lines: [`**restep-check could not check the API** (code ${c.exit}).`, '', '```', c.stderr.trim().slice(-2000), '```', ''] };
  }
  const rs = c.report.results;
  const by = (s) => rs.filter((r) => r.status === s);
  const fails = by('fail'), warns = by('warn');
  const row = (r) => `| \`${r.id}\` | ${cell(r.target)} | ${cell(r.message)} | ${r.level} · [§${r.section}](${SPEC}) |`;
  if (fails.length) {
    lines.push(`### Failures (${fails.length})`, '', '| Check | Where | Detail | Level |', '|---|---|---|---|', ...fails.map(row), '');
  }
  if (warns.length) {
    lines.push(`<details><summary>Warnings (${warns.length})</summary>`, '', '| Check | Where | Detail | Level |', '|---|---|---|---|', ...warns.map(row), '', '</details>', '');
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
    rows.push(`| Conformance | ${cs.failures ? `**${cs.failures} MUST failing**` : 'no MUST failures'} · ${cs.warnings} warnings · ${cs.passed} passed · ${cs.skipped} skipped (restep-check ${r.version}${r.writes ? ', with --writes' : ', read-only'}) |`);
    const announced = [...(r.profiles ?? []), ...(r.extensions ?? [])].join(', ');
    const v = describeVersion(c.declared);
    if (v) rows.push(`| Declared version | \`${cell(v.value)}\`: ${v.restep1 ? v.text : `**${v.text}**`} |`);
    rows.push(`| Profiles | ${announced}${c.missing.length ? ` · **does not announce: ${c.missing.join(', ')}**` : ''} |`);
  } else rows.push('| Conformance | **could not be checked** |');
  if (input('base-discovery')) {
    rows.push(`| Compatibility | ${!d ? '**could not be compared**' : breaking ? '**breaking changes**' : diffError ? `**restep-diff could not compare** (code ${d.exit})` : 'no breaking changes'} against \`${cell(input('base-discovery'))}\` |`);
  }

  const md = [MARKER, `## Restep ${ok ? 'passing' : 'with problems'}: ${url}`, '', '| | |', '|---|---|', ...rows, '', ...cs.lines];
  if (d) {
    md.push('### Compatibility (restep-diff)', '');
    if (d.markdown.trim()) md.push(d.markdown.trim(), '');
    if (diffError) md.push('```', (d.stderr || '').trim().slice(-2000), '```', '');
  }
  let text = md.join('\n');
  writeFileSync(file('summary.md'), text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}\n\n(truncated)` : text}\n`);
  else console.log(text);

  // Annotations on the run: the first failures, with their section of the specification.
  for (const r of (c?.report?.results ?? []).filter((x) => x.status === 'fail').slice(0, 10)) {
    console.log(`::error title=${escapeCommand(`restep ${r.id}`)}::${escapeCommand(`${r.target ? `[${r.target}] ` : ''}${r.message} (§${r.section})`)}`);
  }
  for (const p of c?.missing ?? []) console.log(`::error title=restep profiles::${escapeCommand(`The API does not announce ${p}.`)}`);
  if (breaking) console.log('::error title=restep-diff::There are breaking changes against the base discovery document.');

  setOutput('result', ok ? 'pass' : 'fail');
  setOutput('check-failures', String(cs.failures));
  setOutput('breaking', String(breaking));
  setOutput('summary-file', file('summary.md'));

  if (bool('comment')) {
    if (text.length > COMMENT_MAX) text = `${text.slice(0, COMMENT_MAX)}\n\n(truncated: the full report is in the job summary)`;
    comment(text, url);
  }
  if (!ok && !/^(false|no|0|off)$/i.test(input('fail-on-error'))) process.exit(1);
}

// PR comment: one per API (marker with the URL), updated on every run.
function comment(text, url) {
  const event = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH) ? readJson(env.GITHUB_EVENT_PATH) : null;
  const number = event?.pull_request?.number ?? (event?.issue?.pull_request ? event.issue.number : null);
  if (!number) { console.log(`comment: the ${env.GITHUB_EVENT_NAME ?? '(unknown)'} event is not a PR; only the job summary is written.`); return; }
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) { console.log('::warning title=restep-action::GITHUB_REPOSITORY is missing; no comment.'); return; }
  const marker = `<!-- restep-action: ${url} -->`;
  const body = `${marker}\n${text}`;
  const gh = (args, inputJson) => {
    let path = null;
    if (inputJson) { path = file('comment.json'); writeJson(path, inputJson); args.push('--input', path); }
    return spawnSync('gh', args, { encoding: 'utf8', env });
  };
  const list = gh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate', '--jq', `.[] | select(.body | contains(${JSON.stringify(marker)})) | .id`]);
  if (list.status !== 0) {
    console.log(`::warning title=restep-action::Cannot read the PR comments (is permissions: pull-requests: write missing?): ${escapeCommand((list.stderr || list.error || '').toString().trim())}`);
    return;
  }
  const id = list.stdout.split('\n').map((s) => s.trim()).find(Boolean);
  const r = id ? gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${id}`], { body })
    : gh(['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`], { body });
  if (r.status !== 0) console.log(`::warning title=restep-action::Cannot post the comment: ${escapeCommand((r.stderr || r.error || '').toString().trim())}`);
  else console.log(id ? `Comment ${id} updated.` : 'Comment posted.');
}

// ── Principal ─────────────────────────────────────────────────────────────────
const steps = { start, check, diff, report, stop };
const step = process.argv[2];
if (!steps[step]) {
  console.error(`Usage: node action.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
mkdirSync(WORK, { recursive: true });
try { await steps[step](); } catch (e) { die(`${step}: ${e.message}`); }
