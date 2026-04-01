# Design: Symbol Extraction & Call Graph Service

## Overview

Add symbol definition/reference extraction and call graph analysis to pi-lens via a shared service layer that integrates with existing caching infrastructure.

**Primary Use Cases:**
1. **Enhanced Similarity Detection** — Compare functions by signature + body similarity
2. **Symbol-based Project Index** — Searchable symbol map for cross-file navigation
3. **Impact Analysis** — When editing a function, warn about callers that might break
4. **Circular Dependency Detection** — Find cycles in call graph

**Approach:** Hybrid service layer with incremental caching

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                   Existing Cache Layer                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ CacheManager│  │ ProjectIndex│  │ TurnState   │         │
│  │ (scanners)  │  │ (similarity)│  │ (edits)     │         │
│  └─────────────┘  └──────┬──────┘  └──────┬──────┘         │
│                          │                │                │
└──────────────────────────┼────────────────┼────────────────┘
                           │                │
                           ▼                │
              ┌─────────────────────┐       │
              │   SymbolService     │       │
              │ ─────────────────── │       │
              │ symbol-index.json   │◄──────┘ (invalidate on
              │ 24hr TTL            │        file changes)
              │ ─────────────────── │
              │ extractDefs()       │
              │ extractRefs()       │
              │ buildCallGraph()    │
              │ incrementalUpdate() │
              └──────────┬──────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐
    │ similarity│   │ tree-sitter│   │ impact   │
    │  runner   │   │  runner    │   │  runner  │
    │ (enhanced)│   │ (enhanced) │   │  (new)   │
    └──────────┘   └──────────┘   └──────────┘
```

---

## Components

### 1. SymbolService (`clients/symbol-service.ts`)

**Core Types:**
```typescript
interface Symbol {
  id: string;              // filePath:name:kind
  name: string;
  kind: 'function' | 'class' | 'variable' | 'interface' | 'type' | 'method';
  filePath: string;
  line: number;
  column: number;
  signature?: string;      // For functions: params + return type
  isExported: boolean;
  doc?: string;            // JSDoc comment if available
}

interface SymbolRef {
  symbolId: string;        // Reference to which symbol
  filePath: string;
  line: number;
  column: number;
  context?: string;        // Surrounding code snippet
}

interface SymbolIndex {
  version: string;
  createdAt: string;
  symbols: Map<string, Symbol>;       // id -> Symbol
  refs: Map<string, SymbolRef[]>;    // symbolId -> references
  byFile: Map<string, string[]>;      // filePath -> symbolIds
  callGraph?: CallGraphData;         // Built on-demand
}

interface CallGraphData {
  edges: CallEdge[];
  adjacency: Map<string, string[]>;   // caller -> callees
  reverse: Map<string, string[]>;     // callee -> callers (for impact)
  cycles: string[][];                 // Detected circular chains
  orphans: string[];                  // Dead code candidates
  entryPoints: string[];              // Never called (exports, main)
}

interface CallEdge {
  caller: string;        // symbolId
  callerLocation: { file: string, line: number, column: number };
  callee: string;        // symbolId or external name
  calleeResolved: boolean;
}
```

**Service API:**
```typescript
class SymbolService {
  // Index management
  async getIndex(): Promise<SymbolIndex>;           // Load or build
  async update(): Promise<void>;                     // Incremental (changed files only)
  async rebuild(): Promise<void>;                    // Full rebuild
  
  // Symbol queries
  findDefinition(name: string, file?: string): Symbol | null;
  findReferences(symbolId: string): SymbolRef[];
  findInFile(filePath: string): Symbol[];
  findExported(projectRoot: string): Symbol[];
  
  // Call graph queries
  findCallers(symbolId: string): string[];           // Direct callers
  findCallees(symbolId: string): string[];           // Direct callees
  findImpact(symbolId: string): string[];            // All transitive callers
  findCycles(): string[][];                          // Circular dependencies
  findOrphans(): Symbol[];                           // Defined but never called
  
  // For runners
  getSignature(symbolId: string): string | undefined;
  isExported(symbolId: string): boolean;
}
```

### 2. Tree-sitter Queries for Symbols

Add to `rules/tree-sitter-queries/typescript/symbols.yml`:

```yaml
# === DEFINITIONS ===
---
id: symbol-function-def
language: typescript
query: |
  (function_declaration
    name: (identifier) @name
    parameters: (formal_parameters) @params
    body: (statement_block) @body) @def
metavars: [name, params, body, def]
kind: function
extract: signature

---
id: symbol-arrow-def
language: typescript
query: |
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function
      parameters: (formal_parameters) @params
      body: (_) @body)) @def
metavars: [name, params, body, def]
kind: function
extract: signature

---
id: symbol-class-def
language: typescript
query: |
  (class_declaration
    name: (type_identifier) @name) @def
metavars: [name, def]
kind: class

---
id: symbol-method-def
language: typescript
query: |
  (method_definition
    name: (property_identifier) @name
    parameters: (formal_parameters) @params) @def
metavars: [name, params, def]
kind: method
extract: signature

# === REFERENCES ===
---
id: symbol-function-call
language: typescript
query: |
  (call_expression
    function: (identifier) @callee) @ref
metavars: [callee, ref]
kind: call

---
id: symbol-method-call
language: typescript
query: |
  (call_expression
    function: (member_expression
      property: (property_identifier) @callee)) @ref
metavars: [callee, ref]
kind: method-call
```

Python and Rust queries follow same pattern.

### 3. Storage Format

**File:** `.pi-lens/symbol-index.json`

```json
{
  "version": "1.0",
  "createdAt": "2026-04-01T10:30:00Z",
  "symbols": [
    ["src/utils/date.ts:formatDate", {
      "id": "src/utils/date.ts:formatDate",
      "name": "formatDate",
      "kind": "function",
      "filePath": "src/utils/date.ts",
      "line": 15,
      "column": 0,
      "signature": "(date: Date, format: string): string",
      "isExported": true
    }],
    ...
  ],
  "refs": [
    ["src/utils/date.ts:formatDate", [
      {
        "symbolId": "src/utils/date.ts:formatDate",
        "filePath": "src/components/DatePicker.ts",
        "line": 42,
        "column": 8
      }
    ]],
    ...
  ],
  "byFile": [
    ["src/utils/date.ts", ["src/utils/date.ts:formatDate", "src/utils/date.ts:parseDate"]],
    ...
  ],
  "callGraph": {
    "edges": [...],
    "adjacency": [["src/app.ts:main", ["src/utils/date.ts:formatDate", ...]], ...],
    "reverse": [["src/utils/date.ts:formatDate", ["src/app.ts:main", ...]], ...],
    "cycles": [],
    "orphans": ["src/old.ts:unusedFn"],
    "entryPoints": ["src/app.ts:main", "src/api.ts:handler"]
  }
}
```

**TTL:** 24 hours (same pattern as `project-index.ts`)

---

## Caching Strategy

### Integration with Existing Infrastructure

| Component | Role | Integration |
|-----------|------|-------------|
| `CacheManager` | Turn-state tracking | Read modified files for invalidation |
| `project-index.ts` | Pattern reference | Same Map serialization, 24hr TTL |
| `TreeSitterClient` | Parser | Shared instance for queries |

### Invalidation Flow

```
1. File saved
   │
   ▼
2. TurnState updated (existing)
   - files[filePath].modifiedRanges updated
   │
   ▼
3. SymbolService.update() called
   │
   ▼
4. Read turnState.files for changed files
   │
   ▼
5. For each changed file:
   - Get symbolIds from byFile[file]
   - Remove from symbols, refs
   - Remove from callGraph edges/adjacency/reverse
   │
   ▼
6. Re-parse changed files
   - Extract new symbols
   - Extract new references
   │
   ▼
7. Update callGraph
   - If was cached, rebuild affected portions
   │
   ▼
8. Save symbol-index.json
```

### Performance Targets

| Scenario | Target | Notes |
|----------|--------|-------|
| Cache hit | <50ms | Load from disk |
| Incremental update | <200ms | 1-5 files changed |
| Full rebuild | <5s | 1000 files, medium project |
| Call graph query | <10ms | From cached graph |

---

## Runner Integration

### Enhanced: `tree-sitter.ts` Runner

**Current:** Pattern queries for slop detection  
**Added:** Symbol extraction queries

```typescript
async run(ctx: DispatchContext): Promise<RunnerResult> {
  // ... existing pattern query execution ...
  
  // NEW: Update symbol index
  const symbolService = new SymbolService();
  await symbolService.update(); // Incremental update
  
  return { ...existingResult };
}
```

### Enhanced: `similarity.ts` Runner

**Current:** State matrix only  
**Added:** Signature pre-filter from SymbolService

```typescript
async run(ctx: DispatchContext): Promise<RunnerResult> {
  // Load symbol index for signature data
  const symbols = new SymbolService();
  const index = await symbols.getIndex();
  
  for (const func of newFunctions) {
    // NEW: Get signature from symbol index
    const symbolId = `${relativePath}:${func.name}`;
    const signature = symbols.getSignature(symbolId);
    
    // Use signature for faster pre-filter before matrix comparison
    const matches = findSimilarWithSignature(func, index, signature);
    ...
  }
}
```

### New: `impact.ts` Runner

**Purpose:** Warn when editing functions with callers

```typescript
const impactRunner: RunnerDefinition = {
  id: "impact",
  appliesTo: ["jsts", "python"],
  priority: 25, // After type-checking, before similarity
  enabledByDefault: true,
  
  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const symbols = new SymbolService();
    const index = await symbols.getIndex();
    
    // Find symbols defined in this file
    const fileSymbols = symbols.findInFile(ctx.filePath);
    
    const diagnostics: Diagnostic[] = [];
    
    for (const sym of fileSymbols) {
      if (!sym.isExported) continue; // Only warn for exported functions
      
      const callers = symbols.findCallers(sym.id);
      if (callers.length === 0) continue;
      
      diagnostics.push({
        id: `impact:${sym.id}`,
        tool: "impact",
        filePath: ctx.filePath,
        line: sym.line,
        column: sym.column,
        message: `Function '${sym.name}' has ${callers.length} caller(s). ` +
                 `Changes may affect: ${callers.slice(0, 3).join(', ')}${callers.length > 3 ? '...' : ''}`,
        severity: "info",
        semantic: "none", // Non-blocking
      });
    }
    
    return { status: "succeeded", diagnostics, semantic: "none" };
  }
};
```

---

## Tradeoffs Considered

| Approach | Pros | Cons | Chosen |
|----------|------|------|--------|
| **Separate runners** | Clean separation, disable individually | More files, duplicate parsing | No |
| **Extend existing** | Less code, reuse infrastructure | Tight coupling, harder to test | No |
| **Hybrid service** | Shared parsing, flexible consumption, cache integration | More upfront design | **Yes** |

| Storage | Pros | Cons | Chosen |
|---------|------|------|--------|
| **In-memory only** | Fast, simple | Lost on restart, rebuild every session | No |
| **File cache (24hr)** | Persists, fast startup, incremental updates | Disk I/O | **Yes** |
| **SQLite** | Fast queries, ACID | Dependency, complexity | Future |

---

## Success Criteria

1. **Symbol extraction works for TypeScript, Python, Rust**
   - Functions, classes, methods detected
   - References tracked for function calls

2. **Cache integration functional**
   - 24hr TTL respected
   - Incremental updates <200ms for typical changes
   - Turn-state invalidation works

3. **Similarity runner enhanced**
   - Signature data available for pre-filtering
   - No regression in existing matrix similarity

4. **Impact runner functional**
   - Shows caller count for exported functions
   - Non-blocking (info severity)

5. **Circular dependency detection**
   - `findCycles()` returns actual cycles
   - Exposed via command or report

---

## Future Extensions

1. **Cross-file navigation command** (`/lens-goto`)
2. **Dead code report** (orphan functions)
3. **Test coverage hints** (entry points with no test callers)
4. **SQLite backend** (if index grows >10MB)
5. **Import graph** (ESM/CJS dependency cycles)

---

## References

- Aider's RepoMap: `aider/queries/tree-sitter-languages/*.scm`
- Goose analyze: `crates/goose/src/agents/platform_extensions/analyze/`
- Existing: `clients/project-index.ts` (state matrix pattern)
- Existing: `clients/cache-manager.ts` (turn-state tracking)
