# Changelog

All notable changes to pi-lens will be documented in this file.

## [2.0.0] - 2026-03-25

### Added
- **`/lens-metrics` command**: Measure complexity metrics for all files. Exports a full `report.md` with A-F grades, summary stats, AI slop aggregate table, and top 10 worst files with actionable warnings.
- **`/lens-booboo` saves full report**: Results saved to `.pi-lens/reviews/booboo-<timestamp>.md` — no truncation, all issues, agent-readable.
- **AI slop indicators**: Four new real-time and report-based detectors:
  - `AI-style comments` — emoji and boilerplate comment phrases
  - `Many try/catch blocks` — lazy error handling pattern
  - `Over-abstraction` — single-use helper functions
  - `Long parameter list` — functions with > 6 params
- **`SubprocessClient` base class**: Shared foundation for CLI tool clients (availability check, logging, command execution).
- **Shared test utilities**: `createTempFile` and `setupTestEnvironment` extracted to `clients/test-utils.ts`, eliminating copy-paste across 13 test files.

### Changed
- **Delta mode for real-time feedback**: ast-grep and Biome now only show *new* violations introduced by the current edit — not all pre-existing ones. Fixed violations shown as `✓ Fixed: rule-name (-N)`. No change = silent.
- **Removed redundant pre-write hints**: ast-grep and Biome pre-write counts removed (delta mode makes them obsolete). TypeScript pre-write warning kept (blocking errors).
- **Test files excluded from AI slop warnings**: MI/complexity thresholds are inherently low in test files — warnings suppressed for `*.test.ts` / `*.spec.ts`.
- **Test files excluded from TODO scanner**: Test fixture annotations (`FIXME`, `BUG`, etc.) no longer appear in TODO reports.
- **ast-grep excludes test files and `.pi-lens/`**: Design smell scan in `/lens-booboo` skips test files (no magic-numbers noise) and internal review reports.
- **jscpd excludes non-code files**: `.md`, `.json`, `.yaml`, `.yml`, `.toml`, `.lock`, and `.pi-lens/` excluded from duplicate detection — no more false positives from report files.
- **Removed unused dependencies**: `vscode-languageserver-protocol` and `vscode-languageserver-types` removed; `@sinclair/typebox` added (was unlisted).

### Fixed
- Removed 3 unconditional `console.log` calls leaking `[scan_exports]` to terminal.
- Duplicate Biome scan in `tool_call` hook eliminated (was scanning twice for pre-write hint + baseline).

## [1.3.14] - 2026-03-25

### Added
- **Actionable feedback messages**: All real-time warnings now include specific guidance on what to do.
- **Code entropy metric**: Shannon entropy in bits (threshold: >3.5 indicates risky AI-induced complexity).
- **Advanced pattern matching**: `/lens-booboo` now finds structurally similar functions (e.g., `formatDate` and `formatTimestamp`).
- **Duplicate export detection**: Warns when redefining a function that already exists in the codebase.
- **Biome formatting noise removed**: Only lint issues shown in real-time; use `/lens-format` for formatting.

## [1.3.10] - 2026-03-25

### Added
- **Actionable complexity warnings**: Real-time feedback when metrics break limits with specific fix guidance.

## [1.3.9] - 2026-03-25

### Fixed
- **Entropy calculation**: Corrected to use bits with 3.5-bit threshold for AI-induced complexity.

## [1.3.8] - 2026-03-25

### Added
- **Code entropy metric**: Shannon entropy to detect repetitive or unpredictable code patterns.

## [1.3.7] - 2026-03-25

### Added
- **Advanced pattern matching in `/lens-booboo`**: Finds structurally similar functions across the codebase.

## [1.3.6] - 2026-03-25

### Added
- **Duplicate export detection on write**: Warns when defining a function that already exists elsewhere.

## [1.3.5] - 2026-03-25

### Changed
- **Consistent command prefix**: All commands now start with `lens-`.
  - `/find-todos` → `/lens-todos`
  - `/dead-code` → `/lens-dead-code`
  - `/check-deps` → `/lens-deps`
  - `/format` → `/lens-format`
  - `/design-review` + `/lens-metrics` → `/lens-booboo`

## [1.5.0] - 2026-03-23

### Added
- **Real-time jscpd duplicate detection**: Code duplication is now detected on every write. Duplicates involving the edited file are shown to the agent in real-time.
- **`/lens-review` command**: Combined code review: design smells + complexity metrics in one command.

### Changed
- **Consistent command prefix**: All commands now start with `lens-`.
  - `/find-todos` → `/lens-todos`
  - `/dead-code` → `/lens-dead-code`
  - `/check-deps` → `/lens-deps`
  - `/format` → `/lens-format`
  - `/design-review` + `/lens-metrics` → `/lens-review`

## [1.4.0] - 2026-03-23

### Added
- **Test runner feedback**: Runs corresponding test file on every write (vitest, jest, pytest). Silent if no test file exists. Disable with `--no-tests`.
- **Complexity metrics**: AST-based analysis: Maintainability Index, Cyclomatic/Cognitive Complexity, Halstead Volume, nesting depth, function length.
- **`/lens-metrics` command**: Full project complexity scan.
- **Design smell rules**: New `long-method`, `long-parameter-list`, and `large-class` rules for structural quality checks.
- **`/design-review` command**: Analyze files for design smells. Usage: `/design-review [path]`
- **Go language support**: New Go client for Go projects.
- **Rust language support**: New Rust client for Rust projects.

### Changed
- **Improved ast-grep tool descriptions**: Better pattern guidance to prevent overly broad searches.

## [1.3.0] - 2026-03-23

### Changed
- **Biome auto-fix disabled by default**: Biome still provides linting feedback, but no longer auto-fixes on write. Use `/format` to apply fixes or enable with `--autofix-biome`.

### Added
- **ast-grep search/replace tools**: New `ast_grep_search` and `ast_grep_replace` tools for AST-aware code pattern matching. Supports meta-variables and 24 languages.
- **Rule descriptions in diagnostics**: ast-grep violations now include the rule's message and note, making feedback more actionable for the agent.

### Changed
- **Reduced console noise**: Extension no longer prints to console by default. Enable with `--lens-verbose`.

## [1.2.0] - 2026-03-23

### Added
- GitHub repository link in npm package

## [1.1.2] - Previous

- See git history for earlier releases
