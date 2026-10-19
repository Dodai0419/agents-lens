<div align="center">

# agents-lens

**See which AGENTS.md rules apply to a file, then catch the broken, stale and risky ones.**

Codex-style AGENTS.md discovery from which-agents plus the instruction audit from skill-sunset, in one read-only file with no dependencies.

Works with **Claude Code** and **Codex**.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg) ![Status: prototype](https://img.shields.io/badge/status-prototype-orange.svg)

</div>

## Quick start
```bash
git clone https://github.com/Dodai0419/agents-lens && cd agents-lens
node agents_lens.js examples/demo-repo/services/payments/handler.ts --root examples/demo-repo --no-global
```
```
Effective chain (low -> high precedence):
1. [.] AGENTS.md (175 bytes)
2. [services/payments] services/payments/AGENTS.override.md (142 bytes)

Ignored:
- services/AGENTS.md (empty)
- services/payments/AGENTS.md (shadowed)

Findings in this chain (5):
- HIGH UPDATE AGENTS.md:5 broken-reference: Referenced local file does not exist
- MEDIUM TEST AGENTS.md:4 unconditional-tooling: Unconditional tool use may impose a context tax
...
```
Audit a whole folder (or `--codex` / `--claude` for your home config):
```bash
node agents_lens.js audit examples/demo-repo --fail-on high
```

## The problem
- In a monorepo with nested `AGENTS.md` files, overrides, and a 32 KiB budget, you cannot tell which rules an agent actually sees for a given file.
- Old rules rot: links to deleted docs, absolute paths from another laptop, "always use X for every task", pinned model names, pasted credentials.
- The two tools that solve these live in separate repos, and the audit one writes 10 report files into the folder you scan.

## The solution
| Idea | Fixes |
|------|-------|
| **`chain` = which-agents discovery** | Root-to-leaf chain, `AGENTS.override.md` before `AGENTS.md`, `--fallback` names, `--max-bytes` budget, `~/.codex` global file |
| **`chain` also audits the chain** | You see the problems only in the rules that apply to this file, not the whole repo |
| **`audit` = skill-sunset checks** | Broken links, stale absolute paths, possible secrets, malformed SKILL.md frontmatter, oversized files, duplicate skills, model-era rules marked `TEST` |
| **Read-only, one file** | Nothing is written to disk; `--json` and `--fail-on` for CI |

Findings never authorize deletion. `TEST` means "run an A/B check", not "obsolete". Domain skills (medical, legal, finance, ...) are excluded from the generic rules, as upstream does.

## Use with Claude Code
```bash
/plugin marketplace add Dodai0419/agents-lens
/plugin install agents-lens@agents-lens
```

## Use with Codex (ChatGPT)
```bash
git clone https://github.com/Dodai0419/agents-lens && cp -r agents-lens/skills/* ~/.codex/skills/
```
Or copy `AGENTS.md` into your project root.

## Benchmarks
| | original (2 repos) | this repo |
|-|-|-|
| runtime source lines | 335 (which-agents) + 1,216 (skill-sunset) = 1,551 | 484 |
| dependencies | 0 + 0 | 0 |
| chain for one file | 158 / 176 ms (no audit) | 196 / 183 ms (with audit of the chain) |
| audit `examples/demo-repo`, `--json` | 302 / 295 ms | 224 / 219 ms |
| audit a 116-file `~/.claude` folder (size at measurement time) | 877 / 888 ms | 810 / 819 ms |
| files written during audit | 10 report files | 0 |

Median wall time of 11 interleaved runs, two separate runs per cell, Windows 11, Node 24, a busy laptop. Script: run each CLI with `subprocess` and time it; skill-sunset run with `--format json --lang en --out <temp>`. Part of the audit speedup is not writing the HTML/Markdown report bundle. Output equality is checked in `tests/` (11 chain cases and the full audit JSON vs recorded upstream output); it was also identical on skill-sunset's own fixtures and on the 116-file folder.

Not included from skill-sunset: the HTML/Markdown report bundle, Chinese UI text, agent hand-off prompts, and the `test` experiment runner.

## Inspired by
- [JKD914-oss/which-agents](https://github.com/JKD914-oss/which-agents) — AGENTS.md discovery order, overrides, fallbacks, byte budget
- [ooocooc/open-skill-sunset](https://github.com/ooocooc/open-skill-sunset) — deterministic audit rules, verdicts, health score

## Roadmap
- [ ] Follow `CLAUDE.md` imports (`@path`) in the chain view
- [ ] `--diff` mode: only findings added since the last commit

## License
MIT. Discovery logic from which-agents (MIT, which-agents contributors); audit rules from skill-sunset (MIT, Skill Sunset contributors). See LICENSE.
