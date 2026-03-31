# Features to Add to pi-lens

## Symbol Definition/Reference Extraction via Tree-sitter Queries

### Problem
pi-lens currently has structural pattern matching (detecting slop patterns) but doesn't extract semantic symbols (functions, classes, variables) with their definitions and references. This limits:
- Go-to-definition capabilities
- Symbol-based similarity detection (finding similar functions by signature)
- Better dead code detection (tracking if defined symbols are actually used)
- Cross-reference navigation

### Inspiration
Aider's RepoMap uses tree-sitter queries to extract:
- Function/method definitions (`@definition.function`)
- Class definitions (`@definition.class`)
- Variable definitions
- References to symbols (`@reference.class`, `@reference.function`)

See Aider's queries: `aider/queries/tree-sitter-languages/*.scm`

### Proposed Implementation

Add a symbol extraction layer to tree-sitter-client.ts:

```typescript
// New: Symbol extraction via tree-sitter queries
interface Symbol {
  name: string;
  kind: 'function' | 'class' | 'variable' | 'interface' | 'type';
  filePath: string;
  line: number;
  column: number;
  definition: boolean; // true if definition, false if reference
}

// Tree-sitter queries for symbol extraction
const SYMBOL_QUERIES: Record<string, string> = {
  typescript: `
    (function_declaration
      name: (identifier) @name.definition.function) @definition.function
    (class_declaration
      name: (type_identifier) @name.definition.class) @definition.class
    (new_expression
      constructor: (identifier) @name.reference.class) @reference.class
  `,
  python: `
    (function_definition
      name: (identifier) @name.definition.function) @definition.function
    (class_definition
      name: (identifier) @name.definition.class) @definition.class
  `,
};
```

**Usage in pi-lens:**
1. **Enhanced similarity detection** - Compare function signatures, not just body similarity
2. **Better dead code detection** - Track if defined symbols have any references
3. **Cross-file navigation** - Find where symbols are defined/used across the project
4. **Improved project index** - Store symbol map alongside similarity index

### Open Questions
- Should this be a separate runner or part of tree-sitter-client?
- Cache strategy: SQLite (like Aider) or JSON files?
- Update frequency: On every save or periodic background refresh?

---

## Call Graph Analysis via Tree-sitter Queries

### Problem
pi-lens detects similar functions and dead code, but doesn't understand **call relationships** between functions. This limits:
- Dead code detection (functions that are defined but never called)
- Impact analysis (what breaks if I change this function)
- Understanding code flow (entry points vs utility functions)
- Detecting circular dependencies

### Inspiration
Goose's analyze extension uses tree-sitter queries to extract call relationships:
- `caller → callee` mappings
- Function call chains
- Entry point detection
- Import/call graphs

See Goose's implementation: `crates/goose/src/agents/platform_extensions/analyze/`

### Proposed Implementation

Add call graph extraction to tree-sitter-client.ts:

```typescript
// New: Call graph extraction
interface CallEdge {
  caller: string;      // Function name making the call
  callerFile: string;  // File containing caller
  callerLine: number;  // Line where call happens
  callee: string;      // Function being called
  calleeFile?: string; // Known location of callee (if in project)
}

interface CallGraph {
  nodes: Map<string, Symbol>;      // All functions in project
  edges: CallEdge[];               // All call relationships
  entryPoints: string[];           // Functions never called (main, exports, etc.)
  deadFunctions: string[];         // Functions defined but never called
}

// Tree-sitter queries for call extraction
const CALL_QUERIES: Record<string, string> = {
  typescript: `
    (call_expression 
      function: (identifier) @callee) @call
    (call_expression
      function: (member_expression property: (property_identifier) @callee)) @call
    (call_expression
      function: (scoped_identifier) @callee) @call
  `,
  python: `
    (call function: (identifier) @callee) @call
    (call function: (attribute attribute: (identifier) @callee)) @call
  `,
  rust: `
    (call_expression function: (identifier) @callee) @call
    (call_expression function: (field_expression field: (field_identifier) @callee)) @call
    (macro_invocation macro: (identifier) @callee) @call
  `,
};
```

**Usage in pi-lens:**
1. **Enhanced dead code detection** - Functions defined but never called (excluding exports)
2. **Impact analysis** - When editing a function, warn about all callers that might be affected
3. **Similarity detection** - Functions with similar call patterns (same callees) are likely related
4. **Circular dependency detection** - Cycles in call graph indicate potential architectural issues
5. **Test coverage hints** - Entry points with no test callers flagged for testing

### Integration with Existing Features

| Feature | Enhancement with Call Graph |
|---------|----------------------------|
| Dead code detection | Distinguish "defined but never called" vs "defined but only exported" |
| Similarity detection | Compare call patterns (two functions calling the same helpers) |
| Complexity metrics | Functions with many callers = higher impact |
| /lens-booboo report | Add "orphaned functions" section for dead code |

### Open Questions
- Handle dynamic calls? (function pointers, callbacks, method calls on objects)
- Include standard library calls or only project-internal?
- How to handle exported functions (they're "called" by external code)?
- Update call graph incrementally or rebuild on every save?

---

## Additional Linter/Tools to Add (from OpenCode Research)

### LSP Servers (Language Support)

| Language | OpenCode LSP | pi-lens Status |
|----------|--------------|----------------|
| TypeScript | ✅ typescript-language-server | ✅ (ts-lsp runner) |
| Python | ✅ pyright | ✅ (pyright runner) |
| Go | ✅ gopls | ✅ (go-vet runner) |
| Rust | ✅ rust-analyzer | ✅ (rust-clippy runner) |
| Vue | ✅ vue-language-server | ❌ Not supported |
| Svelte | ✅ svelte-language-server | ❌ Not supported |
| Astro | ✅ astro-language-server | ❌ Not supported |
| Ruby | ✅ ruby-lsp | ❌ Not supported |
| Elixir | ✅ elixir-ls | ❌ Not supported |
| Zig | ✅ zls | ❌ Not supported |
| C# | ✅ csharp-ls | ❌ Not supported |
| F# | ✅ fsautocomplete | ❌ Not supported |
| Swift | ✅ sourcekit-lsp | ❌ Not supported |
| C/C++ | ✅ clangd | ❌ Not supported |
| Java | ✅ jdtls | ❌ Not supported |
| Kotlin | ✅ kotlin-lsp | ❌ Not supported |
| PHP | ✅ intelephense | ❌ Not supported |
| Dart/Flutter | ✅ dart LSP | ❌ Not supported |
| Lua | ✅ lua-ls | ❌ Not supported |
| YAML | ✅ yaml-ls | ❌ Not supported |
| Bash/Shell | ✅ bash-language-server | ✅ shellcheck runner | Shell script linting |
| Terraform | ✅ terraform-ls | ❌ Not supported |
| Prisma | ✅ prisma LSP | ❌ Not supported |
| OCaml | ✅ ocaml-lsp | ❌ Not supported |
| Deno | ✅ deno lsp | ❌ Not supported |

### Lint Tools (Non-LSP)

| Tool | OpenCode | pi-lens | Notes |
|------|----------|---------|-------|
| ESLint | ✅ LSP server | ⚠️ Uses Biome instead | Could add ESLint LSP |
| Oxlint | ✅ LSP server | ✅ oxlint runner | Implemented with tests |
| Biome | ✅ LSP server | ✅ biome runner | Already supported |
| Ruff | ✅ Via formatter | ✅ ruff runner | Already supported |
| Prettier | ✅ Formatter only | ✅ formatters.ts | Already supported |
| typos-cli | ❌ Not shown | ✅ spellcheck runner | Markdown spellcheck |
| hadolint | ⚠️ Icon only | ❌ Not supported | Dockerfile linter |
| stylelint | ⚠️ Icon only | ❌ Not supported | CSS linter |
| markdownlint | ⚠️ Icon only | ❌ Not supported | Markdown linter |
| textlint | ⚠️ Icon only | ❌ Not supported | Text/ prose linter |
| commitlint | ⚠️ Icon only | ❌ Not supported | Commit message linter |
| lintstaged | ⚠️ Icon only | ❌ Not supported | Pre-commit runner |

### High-Priority Additions

#### 1. Vue Language Support
Vue SFC (Single File Components) are common in frontend. Currently pi-lens skips `.vue` files.

**Implementation options:**
- Add Vue LSP runner (like ts-lsp but for Vue)
- Or extract `<script>` sections and run TS diagnostics

#### 2. Dockerfile Linter (hadolint)
Common for containerized projects. Checks Dockerfiles for best practices.

**Example checks:**
- Using latest tag
- Multiple CMD/ENTRYPOINT
- Not using USER
- Not pinning versions

**Note:** May need new file kind `docker` or use `shell` with filename detection for `Dockerfile*`

#### 3. CSS/SCSS Linter (stylelint)
For projects using vanilla CSS/SCSS (not Tailwind).

**Checks:**
- Property order
- Vendor prefixes
- Deprecated properties
- BEM naming conventions

### Medium-Priority Additions

#### 4. Markdown Linter (markdownlint)
For documentation-heavy projects.

**Checks:**
- Heading levels
- Line length
- Link formatting
- Code fence language tags

#### 5. Commit Message Linter (commitlint)
Enforce conventional commit format.

**Checks:**
- `type(scope): subject` format
- Valid types (feat, fix, docs, etc.)
- Line length limits

#### 6. Nix Support
OpenCode has Nix icon and likely support. pi-lens could add:
- nixfmt formatter (already in formatters.ts)
- nil LSP or nix-linter

### Integration Pattern

Most can follow the existing runner pattern:
```typescript
// clients/dispatch/runners/<tool>.ts
const toolRunner: RunnerDefinition = {
  id: "<tool-id>",
  appliesTo: ["file-kind"],
  priority: <number>,
  enabledByDefault: <boolean>,
  skipTestFiles: <boolean>,
  
  async run(ctx: DispatchContext): Promise<RunnerResult> {
    // Check tool availability
    // Run tool on file
    // Parse output to diagnostics
    // Return result
  }
};
```

---

## lens-rmslop Command (Future)

### Problem
Current slop detection (`ts-slop`, `python-slop` runners) only **detects** and reports slop patterns but doesn't **remove** them automatically. Users must manually fix each issue.

### Inspiration
OpenCode's `/rmslop` command uses AI to:
1. Check diff against dev/base branch
2. Identify AI-generated slop in changed code:
   - Extra comments a human wouldn't add
   - Defensive checks/try-catch in trusted codepaths
   - Casts to `any` to bypass type issues
   - Style inconsistent with the rest of the file
   - Unnecessary emoji usage
3. Actually **edits/removes** the slop
4. Reports summary of changes (1-3 sentences)

### Proposed Implementation

**Option A: AI-Driven Command (like opencode)**
- New `/lens-rmslop` command
- Reads git diff of current changes
- Uses LLM to identify slop patterns in the diff
- Calls `edit` tool to remove slop automatically
- Reports what was changed

**Option B: Rule-Based Auto-fix**
- Extend existing slop YAML rules with `fix:` field
- Add `autofix-slop` flag (like `autofix-biome`, `autofix-ruff`)
- Auto-applies fixes during `tool_result` hook
- Example rule:
  ```yaml
  id: ts-double-negation
  pattern: "!!$X"
  fix: "Boolean($X)"  # Auto-replacement
  ```

### Open Questions
- Should this be a command (user-initiated) or auto-fix (on write)?
- How to handle cases where fix might break code (need verification)?
- Should we track "slop score" metrics?

---

## Formatter & Linter Coverage Analysis

### Current Coverage Matrix

| Language | Formatters | Linters | Type Checkers |
|----------|------------|---------|---------------|
| **JavaScript/TypeScript** | Biome, Prettier | Biome (built-in), Oxlint, ast-grep-napi | TS LSP |
| **Python** | Ruff, Black | Ruff, ast-grep (structural), Python slop | Pyright |
| **Go** | gofmt | go vet, ast-grep | - |
| **Rust** | rustfmt | rust-clippy, ast-grep | - |
| **Shell/Bash** | shfmt | shellcheck | - |
| **Zig** | zig fmt | - | - |
| **Dart** | dart format | - | - |
| **Nix** | nixfmt | - | - |
| **Elixir** | mix format | - | - |
| **OCaml** | ocamlformat | - | - |
| **C/C++** | clang-format | - | - |
| **Kotlin** | ktlint | - | - |
| **Terraform** | terraform fmt | - | - |
| **Markdown** | Prettier | spellcheck (typos-cli) | - |

### Gaps: Missing Formatters (Low Priority)

| Language | Missing Formatter | Why Low Priority |
|----------|------------------|------------------|
| **Ruby** | rubocop | Niche user base |
| **PHP** | php-cs-fixer | Niche user base |
| **Java** | google-java-format | Niche user base |
| **Swift** | swiftformat | Niche user base |
| **Scala** | scalafmt | Niche user base |
| **Lua** | stylua | Niche user base |

### Gaps: Missing Linters (Higher Priority)

#### 1. **ESLint** ⭐ MEDIUM PRIORITY

**Gap:** pi-lens uses Biome for JS/TS linting, but many projects use ESLint with custom rules/plugins.

**Why add:**
- Biome doesn't support all ESLint rules (especially plugins)
- Many legacy projects rely on ESLint
- Could use `vscode-eslint-language-server` via LSP

**Implementation:**
```typescript
const eslintRunner: RunnerDefinition = {
  id: "eslint-lsp",
  appliesTo: ["jsts"],
  priority: 14, // After oxlint (12), before slop (25)
  enabledByDefault: false, // Opt-in, biome is default
  // Use LSP: vscode-eslint-language-server
};
```

#### 2. **Python: pylint or flake8** ⭐ LOW PRIORITY

**Gap:** Ruff covers most use cases, but some projects may want stricter checking.

**Why low priority:**
- Ruff is faster and covers 99% of use cases
- pylint/flake8 are being replaced by Ruff in most projects

#### 3. **CSS/SCSS Linter (stylelint)** ⭐ MEDIUM PRIORITY

**Gap:** No CSS linting currently (only formatting via Prettier/Biome).

**Why add:**
- Property order enforcement
- Deprecated property detection
- BEM naming convention checks

#### 4. **Markdown Linter (markdownlint)** ⭐ LOW PRIORITY

**Gap:** Only spellcheck exists for Markdown.

**Checks:**
- Heading levels (no skipping h1→h3)
- Line length limits
- Link formatting
- Code fence language tags

#### 5. **SQL Linter (sqlfluff)** ⭐ LOW PRIORITY

**Gap:** SQL files not covered at all.

**Why low:** SQL usually in migrations, rarely needs linting in same flow.

#### 6. **Dockerfile Linter (hadolint)** ⭐ MEDIUM PRIORITY

**Gap:** Mentioned in earlier section - still valid.

### Summary of Gaps

**Formatters:** Comprehensive coverage ✓ (15 formatters)
- Mainstream: JS/TS, Python, Go, Rust fully covered
- Niche: Elixir, OCaml, Zig, Dart covered
- Missing: Ruby, PHP, Java, Swift, Scala (low priority)

**Linters:** Partial coverage ⚠️
- JS/TS: Biome + Oxlint + ast-grep ✅ (ESLint would be nice-to-have)
- Python: Ruff + Pyright ✅ (comprehensive)
- Go: go vet ✅ (minimal but sufficient)
- Rust: clippy ✅ (comprehensive)
- Shell: shellcheck ✅ (comprehensive)
- **Missing:** CSS/SCSS (stylelint), Markdown (markdownlint), Dockerfile (hadolint)

**Type Checkers:** Good coverage ✓
- JS/TS: TS LSP ✅
- Python: Pyright ✅
- Go/Rust: Built into compilers ✅

### Recommended Priority for New Linters

1. **stylelint** - CSS/SCSS projects need more than formatting
2. **hadolint** - Containerized projects are common
3. **markdownlint** - Documentation-heavy projects
4. **ESLint LSP** - For legacy ESLint-dependent projects

---

## Implementation Order Recommendation

1. **Symbol extraction** - Enhances existing tree-sitter infrastructure
2. **Vue support** - Common frontend framework, high user demand
3. **Hadolint** - Dockerfile linting for containerized projects
4. **Stylelint** - CSS/SCSS projects that don't use Tailwind

---

## Notes

- **LSP approach**: pi-lens already has ts-lsp runner using LSP. Could extend to other languages.
- **CLI approach**: Most linters have CLI output that can be parsed (like ruff, biome).
- **Auto-install**: OpenCode auto-installs some LSPs (gopls, vscode-eslint). pi-lens could do similar.
- **Priority levels**: Lower = runs earlier. Blockers should be < 10, warnings 10-50.
