# AGENTS.md: agents-lens

Use when an agent is about to edit a file in a repo with nested AGENTS.md files, or when the user asks to clean up, audit or debug AGENTS.md / CLAUDE.md / SKILL.md instructions.

## How to use
From the repo root of agents-lens (Node 18+):
- Which rules apply to a file: `node agents_lens.js path/to/file`
  - `--print` prints the merged instruction text, `--json` gives structured output with findings.
  - `--fallback NAME` adds a fallback filename, `--max-bytes N` sets the budget, `--no-global` skips `~/.codex`.
- Audit a folder: `node agents_lens.js audit path/to/dir` (or `--codex`, `--claude`). Add `--json`, `--fail-on high` for CI.

## Rules
- Never delete or rewrite an instruction because of a finding alone. `TEST` items need an A/B check; `UPDATE` items need the real path or tool checked first.
- Do not repeat values flagged as `possible-secret`; tell the user to rotate them.
- The tool is read-only; any change is your separate, reviewed edit.
