# pi-lens Features & Research Notes

This document tracks feature ideas, research findings, and external tools that influence pi-lens development.

---

## External Tools & Research

### AutoHarness (GitHub: [aiming-lab/AutoHarness](https://github.com/aiming-lab/AutoHarness))

**What it is:** A governance framework for AI agents that wraps LLM clients with safety and observability layers.

**Key Concepts:**

| Feature | Description |
|---------|-------------|
| **Constitution Pattern** | Declarative YAML governance rules (rules, permissions, risk, hooks, audit) |
| **Pipeline Modes** | Core (6-step) → Standard (8-step) → Enhanced (14-step) governance pipelines |
| **Risk Classification** | `low/medium/high/critical` tiers with different automatic actions |
| **Progressive Trust** | "ask" permission model — block dangerous, confirm medium, allow safe |
| **Audit Trail** | Every decision logged to JSONL with full provenance |

**Sample Constitution:**
```yaml
rules:
  - id: confirm-destructive-ops
    triggers:
      - tool: Bash
        pattern: "rm\s+-rf|git\s+push.*--force"
    severity: error
    enforcement: hook  # Actually blocks it

permissions:
  Bash:
    policy: restricted
    deny_patterns:
      - "rm\s+-rf\s+/"
      - "curl\s+.*\|\s*sh"
```

**Relevance to pi-lens:**
- **Constitution pattern:** pi could benefit from formalized behavioral rules in YAML
- **Risk tiers:** Lint issues could be classified (info/warning/error) rather than binary pass/fail
- **Audit structure:** The JSONL logging pattern with CLI summaries (`autoharness audit summary`) is worth adopting
- **Progressive trust:** More nuanced than pi's current all-or-nothing approach

**Verdict:** Most comprehensive agent governance framework seen. The 6-step Core mode hits the right balance; 14-step Enhanced is likely overkill for most use cases.

**Agent = Model + Harness** — their positioning is spot-on.

---

## pi-lens Features

*(To be populated with existing and planned features)*

### Implemented

- Auto-installer for core tools (typescript-language-server, pyright, ruff, biome, madge, jscpd, ast-grep, knip)
- Two-tier logging system (user-facing vs debug-only with `PI_LENS_DEBUG=1`)
- Post-write pipeline (format → fix → lint → test)
- LSP integration for multiple languages
- AST-grep structural search rules

### Planned / Under Consideration

- Risk classification for lint issues (low/medium/high/critical)
- Structured audit trail (JSONL format)
- Constitution-style configuration for behavioral rules
- More granular permission system for tool execution

---

*Last updated: 2025-04-03*
