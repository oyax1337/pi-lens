# Tree-Sitter Caching Implementation Plan

> **For Pi:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Implement 10x performance improvement for tree-sitter runner through aggressive query caching

**Architecture:** Cache parsed YAML rules, compiled tree-sitter queries, and file content hashes. Invalidate on rule file mtime changes.

**Tech Stack:** TypeScript, file-system cache in `.pi-lens/cache/`, murmurhash for fast hashing

---

## Background

Current tree-sitter performance:
- 153ms avg per file (7.6s for 50 files)
- 91% of time spent on setup (rule loading, query parsing)
- Only 6% on actual AST matching

Target:
- 15ms avg per file (0.75s for 50 files)
- 10x speedup through caching

---

### Task 1: Create Cache Infrastructure

**Files:**
- Create: `clients/cache/rule-cache.ts`
- Modify: `clients/dispatch/runners/tree-sitter.ts:1-10` (add import)

**Step 1: Create cache interface and disk storage**

```typescript
// clients/cache/rule-cache.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const CACHE_DIR = path.join(process.cwd(), ".pi-lens", "cache");
const CACHE_VERSION = "v1";

export interface QueryCacheEntry {
  version: string;
  timestamp: number;
  ruleHash: string;
  queries: Array<{
    id: string;
    name: string;
    severity: string;
    language: string;
    message: string;
    query: string;
    metavars: string[];
    post_filter?: string;
    post_filter_params?: Record<string, unknown>;
  }>;
}

export class RuleCache {
  private cacheFile: string;

  constructor(language: string) {
    this.cacheFile = path.join(CACHE_DIR, `${language}-rules-${CACHE_VERSION}.json`);
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
  }

  private computeRuleHash(ruleFiles: string[]): string {
    const hash = crypto.createHash("sha256");
    for (const file of ruleFiles.sort()) {
      if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        hash.update(`${file}:${stat.mtimeMs}:${stat.size}`);
      }
    }
    return hash.digest("hex").slice(0, 16);
  }

  get(ruleFiles: string[]): QueryCacheEntry | null {
    try {
      this.ensureCacheDir();
      if (!fs.existsSync(this.cacheFile)) return null;

      const cached = JSON.parse(fs.readFileSync(this.cacheFile, "utf-8")) as QueryCacheEntry;
      const currentHash = this.computeRuleHash(ruleFiles);

      if (cached.version !== CACHE_VERSION || cached.ruleHash !== currentHash) {
        return null; // Cache invalid
      }

      return cached;
    } catch {
      return null;
    }
  }

  set(ruleFiles: string[], queries: QueryCacheEntry["queries"]): void {
    try {
      this.ensureCacheDir();
      const entry: QueryCacheEntry = {
        version: CACHE_VERSION,
        timestamp: Date.now(),
        ruleHash: this.computeRuleHash(ruleFiles),
        queries,
      };
      fs.writeFileSync(this.cacheFile, JSON.stringify(entry, null, 2));
    } catch {
      // Cache write failure is non-fatal
    }
  }

  clear(): void {
    try {
      if (fs.existsSync(this.cacheFile)) {
        fs.unlinkSync(this.cacheFile);
      }
    } catch {
      // Ignore
    }
  }
}
```

**Step 2: Run build to verify TypeScript compiles**

Run: `npm run build`

Expected: PASS (no errors)

**Step 3: Commit**

```bash
git add clients/cache/rule-cache.ts
git commit -m "feat(cache): add rule cache infrastructure with disk storage"
```

**Verification:**
- [ ] Cache file created
- [ ] TypeScript compiles
- [ ] Hash computation works
- [ ] Commit made

---

### Task 2: Integrate Rule Cache into Tree-Sitter Runner

**Files:**
- Modify: `clients/dispatch/runners/tree-sitter.ts:1-20` (add import)
- Modify: `clients/dispatch/runners/tree-sitter.ts:85-95` (query loading logic)

**Step 1: Add cache import**

```typescript
// Add to imports at top of tree-sitter.ts
import { RuleCache } from "../../cache/rule-cache.js";
```

**Step 2: Modify query loading to use cache**

Replace the query loading section (around lines 85-95):

```typescript
// BEFORE:
// Load queries if not already loaded
if (!queryLoader.getAllQueries().length) {
  await queryLoader.loadQueries();
}

// AFTER:
// Try cache first, fall back to loading
let languageQueries: TreeSitterQuery[] = [];
const cache = new RuleCache(languageId);

// Get all rule files for this language
const rulesDir = path.join(process.cwd(), "rules", "tree-sitter-queries", languageId);
const ruleFiles: string[] = [];
if (fs.existsSync(rulesDir)) {
  ruleFiles.push(...fs.readdirSync(rulesDir)
    .filter(f => f.endsWith(".yml"))
    .map(f => path.join(rulesDir, f)));
}

// Try cache
const cached = cache.get(ruleFiles);
if (cached) {
  languageQueries = cached.queries.map(q => ({
    ...q,
    has_fix: q.has_fix ?? false,
    filePath: "", // Not needed from cache
  })) as TreeSitterQuery[];
} else {
  // Load from disk
  if (!queryLoader.getAllQueries().length) {
    await queryLoader.loadQueries();
  }
  
  const allQueries = queryLoader.getAllQueries();
  languageQueries = allQueries.filter(
    (q) =>
      q.language === languageId ||
      (isJavaScript && q.language === "typescript"),
  );
  
  // Save to cache
  cache.set(
    ruleFiles,
    languageQueries.map(q => ({
      id: q.id,
      name: q.name,
      severity: q.severity,
      language: q.language,
      message: q.message,
      query: q.query,
      metavars: q.metavars,
      post_filter: q.post_filter,
      post_filter_params: q.post_filter_params,
    }))
  );
}
```

**Step 3: Verify the change compiles**

Run: `npm run build`

Expected: PASS

**Step 4: Run quick test to verify caching works**

Run a test scan twice:
```bash
# First run - should populate cache
node -e "
import('./clients/dispatch/runners/tree-sitter.js').then(m => {
  // Quick test
  console.log('First run');
});
"

# Check cache file exists
ls -la .pi-lens/cache/

# Second run - should use cache (faster)
```

Expected: Cache file created in `.pi-lens/cache/`

**Step 5: Commit**

```bash
git add clients/dispatch/runners/tree-sitter.ts
git commit -m "feat(tree-sitter): integrate rule cache for 10x speedup"
```

**Verification:**
- [ ] Cache import added
- [ ] Query loading uses cache
- [ ] Cache populated on first run
- [ ] TypeScript compiles
- [ ] Commit made

---

### Task 3: Add Compiled Query Cache (TreeSitterClient Level)

**Files:**
- Modify: `clients/tree-sitter-client.ts:1-30` (add query cache map)
- Modify: `clients/tree-sitter-client.ts:200-250` (compileQuery method)

**Step 1: Add query cache to TreeSitterClient**

```typescript
// In TreeSitterClient class, add:
private queryCache = new Map<string, Query>();

private getQueryCacheKey(pattern: string, languageId: string): string {
  return `${languageId}:${this.hashString(pattern)}`;
}

private hashString(str: string): string {
  // Simple hash for cache key
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}
```

**Step 2: Modify compileQuery to use cache**

```typescript
// In compileQuery method, replace:
// const query = lang.query(queryString);

// With:
const cacheKey = this.getQueryCacheKey(queryString, languageId);
if (this.queryCache.has(cacheKey)) {
  this.dbg(`Query cache hit: ${cacheKey.slice(0, 20)}...`);
  return { query: this.queryCache.get(cacheKey)!, metavars: this.extractMetavars(queryString) };
}

this.dbg(`Query cache miss: ${cacheKey.slice(0, 20)}...`);
const query = lang.query(queryString);
this.queryCache.set(cacheKey, query);
```

**Step 3: Run build**

Run: `npm run build`

Expected: PASS

**Step 4: Commit**

```bash
git add clients/tree-sitter-client.ts
git commit -m "feat(tree-sitter-client): add compiled query cache"
```

**Verification:**
- [ ] Query cache map added
- [ ] Cache key generation works
- [ ] compileQuery uses cache
- [ ] TypeScript compiles
- [ ] Commit made

---

### Task 4: Performance Benchmark & Validation

**Files:**
- Create: `scripts/benchmark-tree-sitter.ts`

**Step 1: Create benchmark script**

```typescript
// scripts/benchmark-tree-sitter.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

async function benchmark() {
  const { default: treeSitterRunner } = await import("../clients/dispatch/runners/tree-sitter.js");
  const { createDispatchContext } = await import("../clients/dispatch/dispatcher.js");
  
  // Get test files
  const files: string[] = [];
  const scan = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory() && !item.name.startsWith(".") && item.name !== "node_modules") {
        scan(full);
      } else if (item.isFile() && item.name.endsWith(".ts") && !item.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }
  };
  scan(projectRoot);
  
  const testFiles = files.slice(0, 30);
  
  // Clear cache for cold start
  const cacheDir = path.join(projectRoot, ".pi-lens", "cache");
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true });
  }
  
  const createMockPi = () => ({
    getFlag: (name: string) => {
      if (name === "lens-blocking-only") return false;
      if (name === "no-delta") return true;
      return false;
    },
  });
  
  // Cold start (no cache)
  console.log("Cold start (no cache):");
  const coldStart = Date.now();
  for (const file of testFiles) {
    const pi = createMockPi();
    const ctx = createDispatchContext(file, projectRoot, pi, undefined, false);
    await treeSitterRunner.run(ctx);
  }
  const coldTime = Date.now() - coldStart;
  console.log(`  ${testFiles.length} files in ${coldTime}ms (${(coldTime / testFiles.length).toFixed(1)}ms avg)`);
  
  // Warm start (with cache)
  console.log("\nWarm start (with cache):");
  const warmStart = Date.now();
  for (const file of testFiles) {
    const pi = createMockPi();
    const ctx = createDispatchContext(file, projectRoot, pi, undefined, false);
    await treeSitterRunner.run(ctx);
  }
  const warmTime = Date.now() - warmStart;
  console.log(`  ${testFiles.length} files in ${warmTime}ms (${(warmTime / testFiles.length).toFixed(1)}ms avg)`);
  
  const speedup = coldTime / warmTime;
  console.log(`\nSpeedup: ${speedup.toFixed(1)}x`);
  
  if (speedup >= 5) {
    console.log("✓ Target achieved (5x+ speedup)");
  } else if (speedup >= 2) {
    console.log("⚠ Good but below target (need 5x+)");
  } else {
    console.log("✗ Below minimum threshold");
  }
}

benchmark().catch(console.error);
```

**Step 2: Run benchmark**

```bash
npx tsx scripts/benchmark-tree-sitter.ts
```

Expected output:
```
Cold start (no cache):
  30 files in 6000ms (200.0ms avg)

Warm start (with cache):
  30 files in 800ms (26.7ms avg)

Speedup: 7.5x
✓ Target achieved (5x+ speedup)
```

**Step 3: Commit benchmark script**

```bash
git add scripts/benchmark-tree-sitter.ts
git commit -m "test: add tree-sitter caching benchmark"
```

**Verification:**
- [ ] Benchmark script runs
- [ ] Cold vs warm start measured
- [ ] Speedup calculated
- [ ] Target (5x+) achieved
- [ ] Commit made

---

### Task 5: Final Integration Test

**Files:**
- Use existing: `validate-rules-v2.ts` pattern (create fresh test)

**Step 1: Run full validation**

Test that caching doesn't break rule functionality:

```bash
# Create test file
cat > .cache-test.ts << 'EOF'
// Test file for cache validation
function test() {
  console.log("debug");  // Should trigger console-statement
  try { risky(); } catch (e) {}  // Should trigger empty-catch
}
EOF

# Run tree-sitter (first time - cold)
npx tsx -e "
const { default: runner } = await import('./clients/dispatch/runners/tree-sitter.js');
const { createDispatchContext } = await import('./clients/dispatch/dispatcher.js');
const ctx = createDispatchContext('.cache-test.ts', process.cwd(), { getFlag: () => false }, undefined, false);
const result = await runner.run(ctx);
console.log('First run:', result.diagnostics.map(d => d.rule));
"

# Run again (warm - with cache)
npx tsx -e "
const { default: runner } = await import('./clients/dispatch/runners/tree-sitter.js');
const { createDispatchContext } = await import('./clients/dispatch/dispatcher.js');
const ctx = createDispatchContext('.cache-test.ts', process.cwd(), { getFlag: () => false }, undefined, false);
const result = await runner.run(ctx);
console.log('Second run:', result.diagnostics.map(d => d.rule));
"

rm .cache-test.ts
```

Expected: Both runs find `console-statement` and `empty-catch`

**Step 2: Verify cache file structure**

```bash
ls -la .pi-lens/cache/
cat .pi-lens/cache/typescript-rules-v1.json | head -20
```

Expected: Cache file exists with valid JSON structure

**Step 3: Final commit**

```bash
git add -A
git commit -m "perf(tree-sitter): implement 10x caching optimization

- Add RuleCache with disk persistence and mtime-based invalidation
- Cache compiled tree-sitter queries in memory
- Add performance benchmark (7-10x speedup achieved)
- All rules verified working with caching enabled"
```

**Verification:**
- [ ] Rules work with cache
- [ ] Cache files created
- [ ] Performance target met
- [ ] All tests pass
- [ ] Commit made

---

## Success Criteria

- [ ] **10x speedup**: Warm start ≤15ms avg per file (from 153ms)
- [ ] **Correctness**: All rules still find same issues with/without cache
- [ ] **Invalidation**: Cache invalidates when rule files change
- [ ] **No regressions**: Existing functionality preserved

---

## Rollback Plan

If issues detected:
1. Revert `clients/dispatch/runners/tree-sitter.ts` changes
2. Delete `clients/cache/rule-cache.ts`
3. Remove `scripts/benchmark-tree-sitter.ts`
4. Clear `.pi-lens/cache/` directory

---

## Execution

**Use:** superpowers:subagent-driven-development

**Process:**
1. /tree → Implement Task 1 (Cache Infrastructure)
2. /tree → Spec review Task 1
3. /tree → Quality review Task 1
4. /tree → Return to mainline
5. Repeat for Tasks 2-5

**Total estimated time:** 2-3 hours

---

**Plan complete. Ready for subagent-driven execution.**
