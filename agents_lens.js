#!/usr/bin/env node
'use strict';
// agents-lens: which AGENTS.md files apply to a path, and which of their rules are broken or stale.
// Chain resolution follows which-agents (MIT); audit rules follow skill-sunset (MIT). Read-only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELP = `agents-lens

Usage:
  agents-lens [chain] [path] [--json | --print] [--root dir] [--fallback name] [--max-bytes n] [--no-global]
  agents-lens audit [dir | --codex | --claude] [--json] [--fail-on critical|high|medium|low]

chain (default)  Show which AGENTS.md files apply to a file, in precedence order, and check each one.
audit            Check every AGENTS.md, CLAUDE.md and SKILL.md under a directory.
Nothing is written to disk. Findings never authorize deletion.
`;

// ---------------------------------------------------------------- chain (which-agents)
const PRIMARY_NAMES = ['AGENTS.override.md', 'AGENTS.md'];
const DEFAULT_MAX_BYTES = 32 * 1024;
const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };
const isFile = (p) => !!stat(p)?.isFile();

function targetDirectory(target) {
  const absolute = path.resolve(target || '.');
  return stat(absolute)?.isDirectory() ? absolute : path.dirname(absolute);
}

function findProjectRoot(start) {
  for (let current = path.resolve(start); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    if (path.dirname(current) === current) return start;
  }
}

function directoryChain(root, leaf) {
  const relative = path.relative(root, leaf);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Target is outside project root: ${leaf}`);
  const dirs = [root];
  if (relative) for (const segment of relative.split(path.sep)) dirs.push(path.join(dirs[dirs.length - 1], segment));
  return dirs;
}

function selectInstruction(directory, fallbackNames = []) {
  const names = [...PRIMARY_NAMES, ...fallbackNames];
  const skipped = [];
  for (let i = 0; i < names.length; i += 1) {
    const file = path.join(directory, names[i]);
    if (!isFile(file)) continue;
    const buffer = fs.readFileSync(file);
    if (!buffer.toString('utf8').trim()) { skipped.push({ path: file, reason: 'empty' }); continue; }
    for (const name of names.slice(i + 1)) {
      if (isFile(path.join(directory, name))) skipped.push({ path: path.join(directory, name), reason: 'shadowed' });
    }
    return { selected: { path: file, buffer }, skipped };
  }
  return { selected: null, skipped };
}

function takeUtf8(buffer, maxBytes) {
  let end = Math.min(buffer.length, maxBytes);
  if (end < buffer.length) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;  // never split a character
  return buffer.subarray(0, end).toString('utf8');
}

function normalizeFallbacks(names) {
  const unique = [];
  for (const raw of names || []) {
    const clean = String(raw).trim();
    if (clean.includes('/') || clean.includes('\\')) throw new Error(`Fallback must be a filename, not a path: ${clean}`);
    if (clean && !PRIMARY_NAMES.includes(clean) && !unique.includes(clean)) unique.push(clean);
  }
  return unique;
}

function resolveInstructions(options = {}) {
  const target = path.resolve(options.target || '.');
  const directory = targetDirectory(target);
  const root = path.resolve(options.root || findProjectRoot(directory));
  const fallbackNames = normalizeFallbacks(options.fallbackNames);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('--max-bytes must be a positive integer');
  if (!stat(root)?.isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  const files = [];
  const skipped = [];
  if (options.includeGlobal !== false) {
    const codexHome = path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    const global = selectInstruction(codexHome);
    skipped.push(...global.skipped.map((s) => ({ ...s, scope: 'global' })));
    if (global.selected) {
      const { buffer } = global.selected;
      files.push({ scope: 'global', directory: codexHome, path: global.selected.path, relativePath: path.basename(global.selected.path),
        bytes: buffer.length, includedBytes: buffer.length, truncated: false, content: buffer.toString('utf8') });
    }
  }
  let remaining = maxBytes;
  for (const current of directoryChain(root, directory)) {
    const result = selectInstruction(current, fallbackNames);
    skipped.push(...result.skipped.map((s) => ({ ...s, scope: 'project' })));
    if (!result.selected) continue;
    const { buffer } = result.selected;
    const includedBytes = Math.min(buffer.length, remaining);
    files.push({ scope: 'project', directory: current, path: result.selected.path,
      relativePath: path.relative(root, result.selected.path) || path.basename(result.selected.path),
      bytes: buffer.length, includedBytes, truncated: includedBytes < buffer.length, content: takeUtf8(buffer, includedBytes) });
    remaining -= includedBytes;
  }
  return { target, targetDirectory: directory, projectRoot: root, maxBytes, projectBytesUsed: maxBytes - remaining, fallbackNames, files, skipped };
}

// ---------------------------------------------------------------- audit (skill-sunset)
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set(['.git', '.skill-sunset', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt',
  '.cache', 'vendor', 'target', '__pycache__', 'test', 'tests', 'fixtures', 'examples']);
// Domain words are matched as-is in skill names/descriptions, including the original's Chinese markers.
const DOMAIN_MARKERS = ['medical', 'medicine', 'health', 'legal', 'finance', 'astrology', 'parenting', 'seo', 'marketing',
  'fengshui', 'ziwei', 'xiaohongshu', '\u4e2d\u533b', '\u533b\u7597', '\u80b2\u513f', '\u7d2b\u5fae', '\u98ce\u6c34',
  '\u547d\u7406', '\u6bcd\u5a74', '\u6cd5\u5f8b', '\u91d1\u878d'];
const GENERIC_MARKERS = ['agent', 'browser', 'code', 'coding', 'debug', 'deploy', 'document', 'file', 'git', 'image', 'markdown',
  'mcp', 'memory', 'note', 'pdf', 'plan', 'plugin', 'postgres', 'presentation', 'react', 'skill', 'spreadsheet', 'test', 'ui',
  'vercel', 'video', 'web', 'workflow', '\u5199\u4ee3\u7801', '\u8c03\u8bd5', '\u6d4f\u89c8\u5668', '\u6587\u6863'];
const MED = { severity: 'medium', confidence: 'medium' };
const SEMANTIC_RULES = [
  { id: 'legacy-reasoning-scaffold', verdict: 'TEST', ...MED,
    pattern: /chain[ -]of[ -]thought|show your reasoning|step-by-step reasoning|\u601d\u7ef4\u94fe|\u9010\u6b65\u601d\u8003|\u5c55\u793a.*\u63a8\u7406/i,
    title: 'Possible legacy reasoning scaffold',
    evidence: 'Found a rule requiring explicit chain-of-thought or a fixed step-by-step reasoning format.',
    action: 'Run representative A/B tasks with and without the rule; do not remove it from wording alone.' },
  { id: 'role-play-scaffold', verdict: 'TEST', severity: 'low', confidence: 'medium',
    pattern: /act as (?:a|an)|you are a \d+[- ]year|\d+\s*\u5e74.*(?:\u5de5\u7a0b\u5e08|\u4e13\u5bb6)/i,
    title: 'Possible low-information role prompt',
    evidence: 'Found a generic role or seniority claim without observable acceptance criteria.',
    action: 'Replace role adjectives with observable acceptance criteria, or remove them only after regression evaluation.' },
  { id: 'unconditional-tooling', verdict: 'TEST', ...MED,
    pattern: /(?:always|for every task).{0,50}\b(?:use|run|search|call)\b|(?:\u6bcf\u4e2a|\u6240\u6709|\u4efb\u4f55).{0,18}(?:\u4efb\u52a1|\u8bf7\u6c42).{0,18}(?:\u5fc5\u987b|\u90fd\u8981|\u5148).{0,30}(?:\u8c03\u7528|\u4f7f\u7528|\u641c\u7d22|\u8fd0\u884c)/i,
    title: 'Unconditional tool use may impose a context tax', evidence: 'The rule binds tool use to every or all tasks.',
    action: 'Use triggers based on version sensitivity, risk, or task type, then compare tool calls and task success.' },
  { id: 'mandatory-subagent', verdict: 'TEST', ...MED,
    pattern: /(?:always|must).{0,35}sub-?agents?|(?:\u5fc5\u987b|\u4e00\u5f8b|\u4e13\u4e1a).{0,25}\u5b50\u4ee3\u7406/i,
    title: 'Mandatory subagent routing may be excessive', evidence: 'Found a broad or unconditional requirement to use subagents.',
    action: 'Enable subagents only for independently useful work packages; compare latency, tokens, and acceptance results.' },
  { id: 'context7-assumption', verdict: 'UPDATE', ...MED, pattern: /context7/i,
    title: 'Recheck the Context7 dependency',
    evidence: 'The instruction references Context7; verify its availability and scope in the current runtime.',
    action: 'Inspect the current tool list. If unavailable, remove the mandate and consult first-party documentation only when version sensitivity requires it.' },
  { id: 'model-version-coupling', verdict: 'UPDATE', severity: 'low', confidence: 'medium',
    pattern: /\b(?:gpt-[345](?:\.\d+)?(?:-[a-z0-9-]+)?|claude-(?:2|3|3\.5|sonnet|opus)-?[a-z0-9.-]*)\b/i,
    title: 'Instruction is coupled to a model version', evidence: 'Found a concrete model name that may drift as providers update.',
    action: 'Verify against current first-party documentation and prefer capability conditions over old model identifiers.' },
];
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const lineOf = (content, index) => content.slice(0, index).split('\n').length;

function walk(directory, inv) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
    inv.readErrors.push({ path: directory, error: error.code ?? 'READ_ERROR' });
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) inv.skippedSymlinks += 1;
    else if (entry.isDirectory()) { if (SKIP_DIRECTORIES.has(entry.name)) inv.skippedDirectories += 1; else walk(absolute, inv); }
    else if (['AGENTS.md', 'CLAUDE.md', 'SKILL.md'].includes(entry.name)) inv.paths.push(absolute);
  }
}

function parseFrontmatter(content) {
  if (!content.startsWith('---')) return { metadata: {}, status: 'missing' };
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/);
  if (!match) return { metadata: {}, status: 'malformed' };
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^\s/.test(line) ? null : line.match(/^([a-zA-Z0-9_-]+):\s*(.*?)\s*$/);
    if (field) metadata[field[1]] = field[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return { metadata, status: metadata.name && metadata.description ? 'valid' : 'incomplete' };
}

function maskMarkdownCode(content) {
  const chars = [...content];
  const mask = (start, end) => { for (let i = start; i < end; i += 1) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' '; };
  for (const m of content.matchAll(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2(?:\n|$)|$)/g)) mask(m.index, m.index + m[0].length);
  for (const m of chars.join('').matchAll(/`[^`\n]*`/g)) mask(m.index, m.index + m[0].length);
  return chars.join('');
}

function skillScope(metadata, relativePath, status) {
  if (!relativePath.endsWith('SKILL.md')) return 'generic';
  if (status !== 'valid') return 'manual-review';
  const hay = `${metadata.name ?? ''} ${metadata.description ?? ''}`.toLowerCase();
  if (DOMAIN_MARKERS.some((m) => hay.includes(m))) return 'domain-excluded';
  return GENERIC_MARKERS.some((m) => hay.includes(m)) ? 'generic' : 'manual-review';
}

const finding = (file, d) => ({ file: file.relativePath, line: d.line ?? 1, verdict: d.verdict, severity: d.severity,
  confidence: d.confidence, ruleId: d.ruleId, title: d.title, evidence: d.evidence, action: d.action, data: d.data ?? {}, scope: file.scope });
const HIGH = { verdict: 'UPDATE', severity: 'high', confidence: 'high' };

function staticFindings(file, root) {
  const out = [];
  if (file.oversized) out.push(finding(file, { ...HIGH, ruleId: 'file-too-large', data: { bytes: file.bytes, limit: MAX_FILE_BYTES },
    title: 'Instruction file exceeds the safe scan limit', evidence: `${file.bytes} bytes exceeds the ${MAX_FILE_BYTES}-byte limit; the body was not loaded.`,
    action: 'Split the file or explicitly raise a controlled limit; do not count an unscanned file as healthy.' }));
  if (file.kind === 'skill' && file.frontmatterStatus !== 'valid') out.push(finding(file, { ...HIGH, ruleId: 'invalid-frontmatter',
    data: { status: file.frontmatterStatus }, title: 'Skill frontmatter is missing or malformed', evidence: `Frontmatter status: ${file.frontmatterStatus}.`,
    action: 'Add parseable YAML frontmatter with non-empty name and description fields.' }));
  if (file.scope !== 'generic' || file.oversized || file.readError) return out;
  const { content } = file;
  const inspectable = maskMarkdownCode(content);
  const skill = file.kind === 'skill';
  if (file.lines > (skill ? 400 : 220) || file.estimatedTokens > (skill ? 8000 : 6000)) out.push(finding(file, {
    verdict: 'DEMOTE', severity: 'medium', confidence: 'high', ruleId: 'progressive-disclosure',
    data: { lines: file.lines, estimatedTokens: file.estimatedTokens, kind: file.kind },
    title: `${skill ? 'Skill entry file' : 'Agent instruction file'} may need progressive disclosure`,
    evidence: `${file.lines} lines and about ${file.estimatedTokens} tokens; these counts are review signals only.`,
    action: 'Keep triggers, critical boundaries, and acceptance criteria in the entry file; move examples, long templates, and platform detail to on-demand references.' }));
  for (const rule of SEMANTIC_RULES) {
    const m = inspectable.match(rule.pattern);
    if (m) out.push(finding(file, { ...rule, ruleId: rule.id, line: lineOf(content, m.index) }));
  }
  for (const m of inspectable.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    let decoded;
    try { decoded = decodeURIComponent(raw.split('#')[0]); } catch {
      out.push(finding(file, { verdict: 'UPDATE', severity: 'medium', confidence: 'high', ruleId: 'malformed-link-encoding', line: lineOf(content, m.index),
        title: 'Invalid link encoding', evidence: 'A local Markdown link contains undecodable percent encoding.',
        action: 'Repair the link encoding; scanning continued for other files.' }));
      continue;
    }
    const resolved = path.resolve(path.dirname(file.absolutePath), decoded);
    const rel = path.relative(root, resolved);
    const inside = rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
    if (inside && !fs.existsSync(resolved)) out.push(finding(file, { ...HIGH, ruleId: 'broken-reference', line: lineOf(content, m.index),
      title: 'Referenced local file does not exist',
      evidence: 'A local Markdown reference cannot be resolved. The original target is not repeated to avoid leaking path parameters.',
      action: 'Update or remove the stale reference; do not let an Agent execute the affected workflow until repaired.' }));
  }
  for (const m of content.matchAll(/`((?:\/Users\/|\/home\/|[A-Za-z]:\\)[^`\n]+)`/g)) {
    if (!fs.existsSync(m[1])) out.push(finding(file, { ...HIGH, ruleId: 'stale-absolute-path', line: lineOf(content, m.index),
      title: 'Absolute path is no longer valid', evidence: 'The instruction contains an absolute path that does not exist on the current filesystem.',
      action: 'Use a project-relative path, Skill-root path, or another currently verifiable location.' }));
  }
  const secret = [/(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i, /https?:\/\/[^\s/:]+:[^\s/@]+@/i]
    .map((p) => inspectable.match(p)).find(Boolean);
  if (secret) out.push(finding(file, { verdict: 'UPDATE', severity: 'critical', confidence: 'medium', ruleId: 'possible-secret',
    line: lineOf(content, secret.index), title: 'Possible plaintext credential',
    evidence: 'Detected a credential-like structure. The report does not repeat the value and did not test whether it is valid.',
    action: 'Review manually. If real, rotate it first and remove it from Markdown; if it is an example, replace it with an obvious placeholder.' }));
  return out;
}

function addDuplicateFindings(files, findings) {
  const group = (key) => {
    const map = new Map();
    for (const f of files) if (f.kind === 'skill' && f.scope === 'generic' && !f.oversized && !f.readError && key(f)) {
      map.set(key(f), [...(map.get(key(f)) ?? []), f]);
    }
    return map;
  };
  for (const same of group((f) => f.hash).values()) {
    if (same.length < 2) continue;
    const [canonical] = same;
    if (same.every((f) => f.metadata.name === canonical.metadata.name && f.bundleHash && f.bundleHash === canonical.bundleHash)) {
      for (const f of same.slice(1)) findings.push(finding(f, { verdict: 'RETIRE', severity: 'high', confidence: 'high',
        ruleId: 'exact-bundle-duplicate-same-name', data: { canonicalPath: canonical.relativePath }, title: 'Complete, same-name generic Skill duplicate',
        evidence: `The entry and complete bundle manifest/hash match inside one scan root; canonical candidate: ${canonical.relativePath}.`,
        action: 'Confirm both discovery paths are in the actual loading scope, then move only the duplicate to a recoverable archive and retain the bundle hash and rollback manifest.' }));
    } else {
      for (const f of same) findings.push(finding(f, { verdict: 'MERGE', severity: 'medium', confidence: 'high', ruleId: 'same-entry-different-bundle',
        title: 'Skill entry matches but complete bundles differ',
        evidence: 'SKILL.md matches, but scripts, references, assets, or other bundle files are not all identical.',
        action: 'Compare the bundle file by file. Do not retire either complete Skill as a duplicate.' }));
    }
  }
  for (const same of group((f) => f.metadata.name).values()) {
    if (same.length < 2 || new Set(same.map((f) => f.hash)).size === 1) continue;
    for (const f of same) findings.push(finding(f, { verdict: 'MERGE', severity: 'medium', confidence: 'high', ruleId: 'duplicate-skill-name',
      data: { count: same.length }, title: 'Skill name is duplicated but content differs',
      evidence: `${same.length} Skills share the same name but contain different content.`,
      action: 'Inspect actual discovery and loading order, merge intentional overlap, or rename genuinely distinct capabilities.' }));
  }
}

function fingerprintSkillBundle(skillFile) {
  const root = path.dirname(skillFile);
  const entries = [];
  let totalBytes = 0;
  let complete = true;
  const visit = (directory) => {
    let children;
    try { children = fs.readdirSync(directory, { withFileTypes: true }); } catch { complete = false; return; }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name === '.git' || child.name === '.skill-sunset') continue;
      const absolute = path.join(directory, child.name);
      if (child.isSymbolicLink()) { complete = false; continue; }
      if (child.isDirectory()) { visit(absolute); continue; }
      if (!child.isFile()) continue;
      try {
        totalBytes += fs.statSync(absolute).size;
        if (totalBytes > 20 * 1024 * 1024) { complete = false; return; }
        entries.push(`${path.relative(root, absolute).split(path.sep).join('/')}\0${sha256(fs.readFileSync(absolute))}`);
      } catch { complete = false; }
    }
  };
  visit(root);
  return { bundleHash: complete ? sha256(entries.join('\n')) : null, bundleFiles: entries.length, bundleBytes: totalBytes };
}

const RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function score(findings, genericFiles) {
  if (genericFiles === 0) return null;
  const weights = { critical: 35, high: 22, medium: 10, low: 4 };
  const perFile = new Map();
  for (const f of findings) perFile.set(f.file, Math.min(45, (perFile.get(f.file) ?? 0) + (weights[f.severity] ?? 0)));
  let health = Math.max(0, Math.round(100 - [...perFile.values()].reduce((s, v) => s + v, 0) / genericFiles));
  const caps = { critical: 55, high: 75, medium: 88, low: 95 };
  const worst = Object.keys(caps).find((sev) => findings.some((f) => f.severity === sev));
  return worst ? Math.min(health, caps[worst]) : health;
}

function loadFile(root, absolutePath) {
  const relativePath = path.relative(root, absolutePath) || path.basename(absolutePath);
  const kind = path.basename(absolutePath) === 'SKILL.md' ? 'skill' : 'agent-instructions';
  const base = { absolutePath, relativePath, kind, bytes: 0, lines: 0, estimatedTokens: 0, content: '', metadata: {},
    scope: kind === 'skill' ? 'manual-review' : 'generic' };
  let st;
  try { st = fs.statSync(absolutePath); } catch (e) { return { ...base, frontmatterStatus: 'unreadable', readError: e.code ?? 'READ_ERROR' }; }
  const sized = { ...base, bytes: st.size, estimatedTokens: Math.ceil(st.size / 4) };
  if (st.size > MAX_FILE_BYTES) return { ...sized, frontmatterStatus: 'not-read', oversized: true };
  let content;
  try { content = fs.readFileSync(absolutePath, 'utf8'); } catch (e) { return { ...sized, frontmatterStatus: 'unreadable', readError: e.code ?? 'READ_ERROR' }; }
  const parsed = kind === 'skill' ? parseFrontmatter(content) : { metadata: {}, status: 'not-applicable' };
  const scope = skillScope(parsed.metadata, relativePath, parsed.status);
  return { absolutePath, relativePath, kind, content, metadata: parsed.metadata, frontmatterStatus: parsed.status,
    lines: content.split(/\r?\n/).length, bytes: Buffer.byteLength(content), estimatedTokens: Math.ceil(content.length / 4),
    hash: sha256(content), scope, ...(kind === 'skill' && scope === 'generic' ? fingerprintSkillBundle(absolutePath) : {}) };
}

function analyze(target) {
  const root = path.resolve(target);
  if (!fs.existsSync(root)) throw new Error(`target does not exist: ${root}`);
  if (!fs.statSync(root).isDirectory()) throw new Error(`target must be a directory: ${root}`);
  const inv = { paths: [], skippedSymlinks: 0, skippedDirectories: 0, readErrors: [] };
  walk(root, inv);
  const files = inv.paths.map((p) => loadFile(root, p));
  const findings = files.flatMap((f) => staticFindings(f, root));
  addDuplicateFindings(files, findings);
  findings.sort((a, b) => (RANK[a.severity] - RANK[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line);
  const count = (pred) => files.filter(pred).length;
  const genericFiles = count((f) => f.scope === 'generic');
  const verdicts = { KEEP: 0, MERGE: 0, UPDATE: 0, DEMOTE: 0, RETIRE: 0, TEST: 0 };
  for (const f of findings) verdicts[f.verdict] += 1;
  return {
    schemaVersion: 2, target: root,
    summary: {
      healthScore: score(findings, genericFiles),
      scanStatus: !files.length ? 'no-auditable-files'
        : (inv.readErrors.length || inv.skippedSymlinks || files.some((f) => f.oversized || f.readError)) ? 'partial' : 'complete',
      scannedFiles: files.length, genericFiles, domainExcluded: count((f) => f.scope === 'domain-excluded'),
      manualReview: count((f) => f.scope === 'manual-review'), oversizedFiles: count((f) => f.oversized),
      skippedSymlinks: inv.skippedSymlinks, skippedDirectories: inv.skippedDirectories,
      readErrors: inv.readErrors.length + count((f) => f.readError),
      estimatedTokens: files.reduce((s, f) => s + f.estimatedTokens, 0), findingCount: findings.length, verdicts,
    },
    files: files.map(({ content, absolutePath, metadata, ...f }) => f),
    findings,
    limitations: [
      'Static findings do not prove that removing an instruction improves task quality.',
      'Model and runtime obsolescence requires current first-party capability evidence.',
      'Domain Skills, safety rules, authorization gates, and project invariants are excluded from automatic retirement.',
      'RETIRE requires a complete identical Skill bundle, the same generic Skill name, and both discovery paths inside the same scan root.',
      'No finding authorizes deletion; changes should be archived, reviewed, tested, and reversible.',
    ],
  };
}

// The fusion: run the per-file audit rules on exactly the files that apply to one target.
function auditChain(result) {
  return result.files.flatMap((f) => staticFindings(loadFile(f.scope === 'global' ? f.directory : result.projectRoot, f.path),
    f.scope === 'global' ? f.directory : result.projectRoot)).sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

// ---------------------------------------------------------------- CLI
function displayPath(p, root) {
  const rel = path.relative(root, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? rel || '.' : p;
}

function printFindings(findings, out) {
  for (const f of findings) out.push(`- ${f.severity.toUpperCase()} ${f.verdict} ${f.file}:${f.line} ${f.ruleId}: ${f.title}`);
}

function chainCommand(args) {
  const o = { target: '.', fallbackNames: [], includeGlobal: true };
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const value = () => { if (i + 1 >= args.length) throw new Error(`${a} requires a value`); return args[++i]; };
    if (a === '-p' || a === '--print') o.print = true;
    else if (a === '-j' || a === '--json') o.json = true;
    else if (a === '--no-global') o.includeGlobal = false;
    else if (a === '--root') o.root = value();
    else if (a === '--fallback') o.fallbackNames.push(...value().split(',').map((v) => v.trim()).filter(Boolean));
    else if (a === '--max-bytes') o.maxBytes = Number(value());
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else positionals.push(a);
  }
  if (positionals.length > 1) throw new Error('only one target path is allowed');
  if (positionals.length) o.target = positionals[0];
  if (o.print && o.json) throw new Error('--print and --json cannot be used together');
  const r = resolveInstructions(o);
  const label = (f) => (f.scope === 'global' ? 'global' : displayPath(f.directory, r.projectRoot));
  if (o.json) return console.log(JSON.stringify({ ...r, files: r.files.map(({ content, ...f }) => f), findings: auditChain(r) }, null, 2));
  if (o.print) {
    const parts = r.files.filter((f) => f.includedBytes > 0).map((f) => `# Instructions from ${label(f)} (${f.path})\n\n`
      + f.content.replace(/\s+$/, '') + (f.truncated ? '\n\n[truncated by --max-bytes]' : ''));
    if (parts.length) process.stdout.write(`${parts.join('\n\n')}\n`);
    return;
  }
  const out = [`Target:       ${displayPath(r.target, r.projectRoot)}`, `Project root: ${r.projectRoot}`,
    `Budget:       ${r.projectBytesUsed}/${r.maxBytes} project bytes`, ''];
  if (!r.files.length) out.push('No active instruction files found.');
  else {
    out.push('Effective chain (low -> high precedence):');
    r.files.forEach((f, i) => out.push(`${i + 1}. [${label(f)}] ${displayPath(f.path, r.projectRoot)} (${f.bytes} bytes${f.truncated ? `, truncated to ${f.includedBytes}` : ''})`));
  }
  if (r.skipped.length) out.push('', 'Ignored:', ...r.skipped.map((s) => `- ${displayPath(s.path, r.projectRoot)} (${s.reason})`));
  const findings = auditChain(r);
  out.push('', findings.length ? `Findings in this chain (${findings.length}):` : 'No findings in this chain.');
  printFindings(findings, out);
  console.log(out.join('\n'));
}

function auditCommand(args) {
  let target = '.';
  let source;
  let json = false;
  let failOn;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--fail-on') {
      failOn = args[++i];
      if (!(failOn in RANK)) throw new Error('--fail-on must be critical, high, medium, or low');
    } else if (a === '--codex' || a === '--claude' || !a.startsWith('-')) {
      if (source) throw new Error('choose exactly one target: a path, --codex, or --claude');
      source = a;
      target = a.startsWith('--') ? path.join(os.homedir(), a === '--codex' ? '.codex' : '.claude') : a;
    } else throw new Error(`unknown option: ${a}`);
  }
  const r = analyze(target);
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    const s = r.summary;
    const out = ['', `  Health        ${s.healthScore === null ? 'not scored' : `${s.healthScore}/100`}`, `  Status        ${s.scanStatus}`,
      `  Scanned       ${s.scannedFiles} files (${s.genericFiles} generic, ${s.domainExcluded} domain-excluded, ${s.manualReview} manual)`,
      `  Skipped       ${s.skippedSymlinks} symlinks, ${s.oversizedFiles} oversized, ${s.readErrors} read errors`, `  Findings      ${s.findingCount}`, ''];
    printFindings(r.findings, out);
    console.log(out.join('\n'));
  }
  if (failOn && r.findings.some((f) => RANK[f.severity] <= RANK[failOn])) process.exitCode = 2;
}

function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return process.stdout.write(HELP);
  if (argv[0] === 'audit') return auditCommand(argv.slice(1));
  return chainCommand(argv[0] === 'chain' ? argv.slice(1) : argv);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`agents-lens: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { resolveInstructions, analyze, auditChain };
