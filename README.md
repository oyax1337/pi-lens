# pi-lens

Real-time code quality feedback for [pi](https://github.com/mariozechner/pi-coding-agent). Every write and edit is automatically analysed — diagnostics are injected directly into the tool result so the agent sees them without any extra steps.

## Install

```bash
pi install npm:pi-lens
```

Or directly from git:

```bash
pi install git:github.com/apmantza/pi-lens
```

---

## Features

### On every write / edit

Every file write is automatically checked. Blocking issues appear inline:

```
🔴 STOP — 1 issue(s) must be fixed:
  L23: var total = sum(items); — use 'let' or 'const'
```

**Runners:** TypeScript type-checking, Python type-checking (pyright), linting (ruff, biome), secrets scan, architectural rules, slop detection.

### Automated Fixes

```
/lens-booboo-fix
```

Sequential automated fixing:
1. Biome/Ruff auto-fixes (mechanical issues)
2. jscpd duplicate resolution
3. knip dead code removal
4. AST-grep structural fixes
5. AI-guided slop cleanup

### Interactive Refactoring

```
/lens-booboo-refactor
```

Interactive architectural refactoring session. Scans for worst offenders by debt score, opens browser interview with AI-generated options, and implements changes with user confirmation.

### Delta-mode feedback

First edit: full feedback. Subsequent edits: only NEW issues. Pre-existing issues are tracked and excluded from inline output.

---

## Architecture

### Runner System

pi-lens uses a **dispatcher-runner architecture** for extensible multi-language support:

```
┌─────────────────────────────────────────────────────────────┐
│                     DISPATCHER                              │
│  Routes files to appropriate runners based on file kind     │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐    ┌─────────────────┐    ┌──────────────┐
│  ts-lsp      │    │  ast-grep-napi  │    │   biome      │
│  (priority 5)│    │  (priority 15)  │    │ (priority 10)│
└──────────────┘    └─────────────────┘    └──────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────┐    ┌─────────────────┐    ┌──────────────┐
│  pyright     │    │   python-slop   │    │   ruff       │
│  (priority 5)│    │  (priority 25)  │    │ (priority 10)│
└──────────────┘    └─────────────────┘    └──────────────┘
        │                     │
        ▼                     ▼
┌──────────────┐    ┌─────────────────┐
│  go-vet      │    │  rust-clippy    │
│  (priority 20)│   │  (priority 20)  │
└──────────────┘    └─────────────────┘
```

### Available Runners

| Runner | Language | Priority | Output | Description |
|--------|----------|----------|--------|-------------|
| **ts-lsp** | TypeScript | 5 | Blocking | TypeScript errors (hard stops) |
| **pyright** | Python | 5 | Blocking | Python type errors (hard stops) |
| **biome** | TS/JS | 10 | Warning | Linting issues (delta-tracked) |
| **ruff** | Python | 10 | Warning | Python linting (delta-tracked) |
| **ast-grep-napi** | TS/JS | 15 | Warning | **100x faster** structural analysis |
| **python-slop** | Python | 25 | Warning | AI slop detection (~40 patterns) |
| **go-vet** | Go | 20 | Warning | Go static analysis |
| **rust-clippy** | Rust | 20 | Warning | Rust linting |
| **similarity** | TS | 35 | Silent | Semantic duplicate detection (metrics only) |
| **architect** | All | 40 | Warning | Architectural rule violations |
| **secrets** | All | - | Blocking | Secret scanning (hard stops) |
| **type-safety** | TS | 20 | Mixed | Switch exhaustiveness (blocking), other (warning) |

> **Note:** `ts-slop` and `ast-grep-cli` runners are disabled — functionality merged into `ast-grep-napi` (100x faster).

### Runner Output Semantics

- **Blocking:** Hard stop — agent must fix before continuing (🔴 STOP)
- **Warning:** Tracked in delta mode, surfaced via `/lens-booboo` (not inline to reduce noise)
- **Delta mode:** Only NEW issues since turn start are tracked (pre-existing issues don't spam)

---

## Language Support

### JavaScript / TypeScript

Fully supported with multiple runners:
- TypeScript language server (type checking)
- Biome (linting + formatting)
- @ast-grep/napi (structural analysis, 100x faster than CLI)
- Knip (dead code)
- jscpd (duplicates)
- type-coverage (`any` detection)

### Python

- Pyright (type checking)
- Ruff (linting)
- Python slop detection (40+ AI patterns)

### Go

- `go vet` (static analysis)
- Full support via go-vet runner

### Rust

- `cargo clippy` (linting)
- Full support via rust-clippy runner

---

## Dependent Tools

pi-lens works out of the box for TypeScript/JavaScript. For full language support, install these tools — **all are optional and gracefully skip if not installed**:

### JavaScript / TypeScript

| Tool | Install | What it does |
|------|---------|--------------|
| `@biomejs/biome` | `npm i -D @biomejs/biome` | Linting + formatting |
| `knip` | `npm i -D knip` | Dead code / unused exports |
| `jscpd` | `npm i -D jscpd` | Copy-paste detection |
| `type-coverage` | `npm i -D type-coverage` | TypeScript `any` coverage % |
| `@ast-grep/napi` | `npm i -D @ast-grep/napi` | Fast structural analysis (TS/JS) |
| `@ast-grep/cli` | `npm i -D @ast-grep/cli` | Structural pattern matching (all languages) |

### Python

| Tool | Install | What it does |
|------|---------|--------------|
| `ruff` | `pip install ruff` | Linting + formatting |
| `pyright` | `pip install pyright` | Type-checking (catches type errors) |

### Go

| Tool | Install | What it does |
|------|---------|--------------|
| `go` | [golang.org](https://golang.org) | Built-in `go vet` for static analysis |

### Rust

| Tool | Install | What it does |
|------|---------|--------------|
| `rust` + `clippy` | [rustup.rs](https://rustup.rs) | Linting via `cargo clippy` |

---

## Commands

| Command | Status | Description |
|---------|--------|-------------|
| `/lens-booboo` | ✅ Active | Full codebase review (8-part analysis) |
| `/lens-booboo-fix` | ✅ Active | Automated mechanical fixes |
| `/lens-booboo-refactor` | ✅ Active | Interactive architectural refactoring |
| `/lens-format` | ✅ Active | Apply Biome formatting |
| `/lens-tdi` | ✅ Active | Technical Debt Index and trends |
| `/lens-rate` | ⚠️ Deprecated | ~~Code quality score~~ — use `/lens-booboo` |
| `/lens-metrics` | ⚠️ Deprecated | ~~Complexity metrics~~ — use `/lens-booboo` |

---

## Slop Detection

pi-lens detects "AI slop" — low-quality patterns common in AI-generated code:

### TypeScript/JavaScript Slop Rules (30+)

| Rule | Description |
|------|-------------|
| `ts-for-index-length` | `for (let i=0; i<arr.length; i++)` → prefer `for...of` |
| `ts-empty-array-check` | `arr.length === 0` → prefer `!arr.length` |
| `ts-unnecessary-array-isarray` | Redundant `Array.isArray()` checks |
| `ts-redundant-filter-map` | `.filter().map()` chains → use `flatMap` |
| `ts-double-negation` | `!!value` → prefer `Boolean(value)` |
| `ts-unnecessary-array-from` | `Array.from(iterable)` in for-of |
| `no-default-export` | Prefer named exports |

### Python Slop Rules (40+)

| Rule | Description |
|------|-------------|
| `py-chained-comparison` | `a < b and b < c` → `a < b < c` |
| `py-manual-min-max` | Manual min/max loops → `min()`/`max()` |
| `py-redundant-if-else` | Unnecessary if/else blocks |
| `py-list-comprehension` | Filter/map loops → list comprehensions |
| `py-unnecessary-else` | Else after return/raise |

*Note: Some rules disabled due to false positives (e.g., `ts-for-index-length`, `ts-unnecessary-array-isarray`)*

---

## Rules

### AST-grep Rules (80+)

Rules live in `rules/ast-grep-rules/rules/`. All rules are YAML files you can edit or extend.

**Security**
`no-eval`, `no-implied-eval`, `no-hardcoded-secrets`, `no-insecure-randomness`, `no-open-redirect`, `no-sql-in-code`, `no-inner-html`, `no-dangerously-set-inner-html`, `no-javascript-url`

**TypeScript**
`no-any-type`, `no-as-any`, `no-non-null-assertion`

**Style** (Biome handles `no-var`, `prefer-const`, `prefer-template`, `no-useless-concat` natively)
`prefer-nullish-coalescing`, `prefer-optional-chain`, `nested-ternary`

**Correctness**
`no-debugger`, `no-throw-string`, `no-return-await`, `no-await-in-loop`, `no-await-in-promise-all`, `require-await`, `empty-catch`, `strict-equality`, `strict-inequality`

**Patterns**
`no-console-log`, `no-alert`, `no-delete-operator`, `no-shadow`, `no-star-imports`, `switch-needs-default`, `switch-without-default`

**Type Safety** (type-aware checks via `type-safety-client.ts`)
`switch-exhaustiveness` — detects missing cases in union type switches (inline blocker)

**Design Smells** (architectural — handled by `/lens-booboo-refactor`)
`long-method`, `long-parameter-list`, `large-class`

**AI Slop Detection**
`no-param-reassign`, `no-single-char-var`, `no-process-env`, `no-architecture-violation`

---

## TypeScript LSP — tsconfig detection

The LSP walks up from the edited file's directory until it finds a `tsconfig.json`. If found, it uses that project's exact `compilerOptions` (paths, strict settings, lib, etc.). If not found, it falls back to sensible defaults:

- `target: ES2020`
- `lib: ["es2020", "dom", "dom.iterable"]`
- `moduleResolution: bundler`
- `strict: true`

The compiler options are refreshed automatically when you switch between projects within a session.

---

## Flags

| Flag | Description |
|------|-------------|
| `--lens-verbose` | Enable console logging |
| `--autofix-biome` | Auto-fix lint issues with Biome |
| `--no-tests` | Disable test runner on write |

---

## Project Structure

```
pi-lens/
├── clients/              # Lint tool wrappers and utilities
│   ├── dispatch/         # Dispatcher and runners
│   │   ├── dispatcher.ts
│   │   └── runners/      # Individual runners
│   │       ├── ast-grep-napi.ts      # Fast TS/JS runner
│   │       ├── python-slop.ts        # Python slop detection
│   │       ├── ts-slop.ts            # TS slop (CLI fallback)
│   │       ├── biome.ts
│   │       ├── ruff.ts
│   │       ├── pyright.ts
│   │       ├── go-vet.ts
│   │       └── rust-clippy.ts
│   ├── complexity-client.ts
│   ├── type-safety-client.ts
│   └── secrets-scanner.ts
├── commands/             # pi commands
│   ├── booboo.ts
│   ├── fix-simplified.ts
│   └── lens-booboo.ts
├── rules/                # AST-grep rules
│   ├── ast-grep-rules/   # General structural rules
│   ├── ts-slop-rules/    # TypeScript slop patterns
│   └── python-slop-rules/# Python slop patterns
├── index.ts              # Main entry point
└── package.json
```

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for full history.

### Latest Highlights

- **NAPI Runner:** 100x faster TypeScript/JavaScript analysis (~9ms vs ~1200ms)
- **Slop Detection:** 30+ TypeScript and 40+ Python patterns for AI-generated code quality issues
- **Deprecated Commands:** `/lens-rate` and `/lens-metrics` deprecated in favor of `/lens-booboo`

---

## License

MIT
