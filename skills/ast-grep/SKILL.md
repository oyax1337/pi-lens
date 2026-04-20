---
name: ast-grep
description: Use when searching or replacing code patterns - use ast-grep instead of text search for semantic accuracy
---

# AST-Grep Code Search

Use `ast_grep_search` and `ast_grep_replace` for semantic code search/replace. ast-grep understands code structure, not just text.

## When to Use

- Function calls, imports, class methods (structured code)
- Safe replacements across files
- "X inside Y" patterns (e.g., console.log inside classes)
- **Use grep for:** comments/strings, URLs, or when ast-grep fails twice

## Golden Rules

1. **Be specific** — `fetchMetrics($ARGS)` not `fetchMetrics`
2. **Scope it** — Always specify `paths` to relevant files
3. **Dry-run first** — Use `apply: false` before `apply: true`
4. **Valid code only** — `function $NAME($$$) { $$$ }` not `function $NAME(`
5. **Use metavariables** — `$X` for single node, `$$$` for multiple

## Quick Reference

### Patterns

| Pattern | Matches |
|---------|---------|
| `fetchMetrics($ARGS)` | Function call with any args |
| `function $NAME($$$) { $$$ }` | Function declaration |
| `import { $NAMES } from "$PATH"` | Import statement |
| `const $X = $Y` | Variable declaration |

### Composite (inside/has)

```yaml
# console.log inside class methods
pattern: console.log($$$)
inside:
  kind: method_definition
  stopBy: end
```

### Metavariables

| Use | Example | Matches |
|-----|---------|---------|
| Single | `console.log($MSG)` | `console.log("hi")` |
| Multiple | `console.log($$$ARGS)` | `console.log("hi", obj, 42)` |

Whitespace is normalized — tabs vs spaces don't matter.

## Common Gotchas

```typescript
// ❌ Multiple AST nodes — use metavariables
pattern: "it"test name""           → use `it($TEST)`
pattern: "function $NAME("        → use `function $NAME($$$) { $$$ }`

// ❌ Trailing comma in objects
pattern: "{ type: $T, }"            → use `{ type: $T }`

// ❌ Shorthand property mismatch  
pattern: "{ runnerId: $RID }"      → won't match `{ runnerId }`
// Use: `{ runnerId }` or widen with `{ runnerId, $$$REST }`
```

**Progressive narrowing:** Start wide (`logLatency($$$)`), then add constraints.

**No matches?** Simplify and retry: `console.log($$$)` → `console` → narrow down.  
**Fails twice?** Fall back to `grep`.

## Debug

Test patterns: https://ast-grep.github.io/playground.html
