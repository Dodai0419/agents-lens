'use strict';
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { resolveInstructions, analyze, auditChain } = require('../agents_lens.js');

const EX = path.join(__dirname, '..', 'examples');
const REPO = path.join(EX, 'demo-repo');
const CLI = path.join(__dirname, '..', 'agents_lens.js');
const upstream = (name) => require(path.join(__dirname, name));
// Recorded upstream output uses <EX> for the examples folder and forward slashes.
const norm = (v) => typeof v === 'string' ? v.split(EX).join('<EX>').split(path.sep).join('/')
  : Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v;
const chainView = (r) => norm({ ...r, files: r.files.map(({ content, ...f }) => f) });

test('chain matches which-agents for every target and fallback', () => {
  const want = upstream('upstream_chain.json');
  for (const t of ['.', 'services/payments/handler.ts', 'web/src/app.ts', 'services', 'docs/style.md']) {
    for (const fb of [[], ['style.md']]) {
      const r = resolveInstructions({ target: path.join(REPO, t), root: REPO, codexHome: path.join(EX, 'codex-home'), fallbackNames: fb });
      assert.deepEqual(chainView(r), want[`${t}|${fb.join(',')}`], `${t} ${fb}`);
    }
  }
  const small = resolveInstructions({ target: path.join(REPO, 'services/payments/handler.ts'), root: REPO, includeGlobal: false, maxBytes: 100 });
  assert.deepEqual(norm(small), want.budget100);
});

test('audit matches skill-sunset (English) on the demo repo', () => {
  const { locale, ...want } = upstream('upstream_audit.json');  // locale is added by skill-sunset's translator
  assert.deepEqual(norm(analyze(REPO)), want);
});

test('chain audit only reports files that apply to the target', () => {
  const r = resolveInstructions({ target: path.join(REPO, 'services/payments/handler.ts'), root: REPO, includeGlobal: false });
  const ids = auditChain(r).map((f) => `${f.file}:${f.ruleId}`).sort();
  assert.deepEqual(ids, ['AGENTS.md:broken-reference', 'AGENTS.md:context7-assumption', 'AGENTS.md:unconditional-tooling',
    `${path.join('services', 'payments', 'AGENTS.override.md')}:model-version-coupling`,
    `${path.join('services', 'payments', 'AGENTS.override.md')}:role-play-scaffold`].sort());
});

test('cli: text chain, json, fail-on, and bad flags', () => {
  const env = { ...process.env, CODEX_HOME: path.join(EX, 'codex-home') };
  const text = execFileSync(process.execPath, [CLI, path.join(REPO, 'web/src/app.ts'), '--root', REPO], { env, encoding: 'utf8' });
  assert.match(text, /2\. \[\.\] AGENTS\.md/);
  assert.match(text, /CRITICAL UPDATE .*possible-secret/);
  const audit = spawnSync(process.execPath, [CLI, 'audit', REPO, '--fail-on', 'critical'], { encoding: 'utf8' });
  assert.equal(audit.status, 2);
  assert.match(audit.stdout, /Health {8}55\/100/);
  const bad = spawnSync(process.execPath, [CLI, '--print', '--json'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /cannot be used together/);
});
