# Two-Tier Logging for Auto-Installer Implementation Plan

> **For Pi:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Convert noisy auto-installer console logs to a two-tier system (user-facing vs debug-only)

**Architecture:** Add a `log()` helper that checks a debug flag. Keep errors always visible, move success/details to debug-only.

**Tech Stack:** TypeScript, existing flag system in `index.ts`

---

## Context

Currently `clients/installer/index.ts` uses `console.error()` for all logging:
- "Installing..." - keep (user needs to see progress)
- "Verifying..." - **move to debug** (internal detail)
- "Verified: X v1.2.3" - **move to debug** (success spam)
- "Failed..." - keep (user needs to see errors)

The extension already has a flag system in `index.ts` that can be leveraged.

---

### Task 1: Add Debug Flag to Installer

**Files:**
- Modify: `clients/installer/index.ts:1-30` (add near imports)

**Step 1: Add debug flag detection**

Add after imports:
```typescript
// Debug flag - set via PI_LENS_DEBUG=1 or --debug
const DEBUG = process.env.PI_LENS_DEBUG === "1" || process.argv.includes("--debug");

/**
 * Log debug messages only when DEBUG is enabled
 */
function debugLog(...args: unknown[]): void {
	if (DEBUG) {
		console.error("[auto-install:debug]", ...args);
	}
}
```

**Step 2: Verify it compiles**

Run: `npm run build`

Expected: No TypeScript errors

**Step 3: Commit**

```bash
git add clients/installer/index.ts
git commit -m "feat(installer): add debug flag and helper"
```

**Verification:**
- [ ] `DEBUG` constant exists
- [ ] `debugLog()` function exists
- [ ] Compiles without errors
- [ ] Commit made

---

### Task 2: Convert Success Logs to Debug

**Files:**
- Modify: `clients/installer/index.ts:240-255` (verification success logs)
- Modify: `clients/installer/index.ts:285` (installing... keep as-is)
- Modify: `clients/installer/index.ts:325` (verifying... → debug)

**Step 1: Convert verified log**

Line 240-246:
```typescript
// BEFORE:
console.error(
	`[auto-install] Verified: ${binPath} (version: ${stdout.trim()})`,
);

// AFTER:
debugLog(`Verified: ${binPath} (version: ${stdout.trim()})`);
```

**Step 2: Convert verification failed logs (still errors, but debug detail)**

Line 245-253:
```typescript
// BEFORE:
console.error(
	`[auto-install] Verification failed for ${binPath}: exit code ${code}, stderr: ${stderr}`,
);

// AFTER:
console.error(`[auto-install] Verification failed for ${binPath}`);
debugLog("Exit code:", code, "stderr:", stderr);
```

**Step 3: Convert "Verifying..." to debug**

Line 325:
```typescript
// BEFORE:
console.error(`[auto-install] Verifying ${binaryName}...`);

// AFTER:
debugLog(`Verifying ${binaryName}...`);
```

**Step 4: Build and test**

Run: `npm run build`

Expected: No errors

**Step 5: Commit**

```bash
git add clients/installer/index.ts
git commit -m "refactor(installer): move success logs to debug tier"
```

**Verification:**
- [ ] "Verified" uses `debugLog`
- [ ] "Verification failed" still uses `console.error` but simplified
- [ ] "Verifying..." uses `debugLog`
- [ ] "Installing..." still uses `console.error`
- [ ] Builds successfully
- [ ] Commit made

---

### Task 3: Clean Up Failure Messages

**Files:**
- Modify: `clients/installer/index.ts:328-330` (corrupted binary message)
- Modify: `clients/installer/index.ts:360-365` (npm install failure)
- Modify: `clients/installer/index.ts:396-400` (pip install failure)
- Modify: `clients/installer/index.ts:431-437` (generic failures)

**Step 1: Keep error visible, move detail to debug**

Line 328:
```typescript
// BEFORE:
console.error(
	`[auto-install] ${packageName} installed but verification failed. The binary may be corrupted.`,
);

// AFTER:
console.error(`[auto-install] ${packageName} installed but verification failed (binary may be corrupted)`);
```

**Step 2: Error messages - keep concise**

Line 360-365:
```typescript
// BEFORE:
console.error(
	`[auto-install] Failed to install npm tool ${packageName}:`,
	err,
);

// AFTER:
console.error(`[auto-install] Failed to install ${packageName}: ${(err as Error).message}`);
debugLog("Full error:", err);
```

**Step 3: Apply same pattern to pip tool errors**

Line 396-400: Same pattern as npm

**Step 4: Apply to generic install failure**

Line 437:
```typescript
// BEFORE:
console.error(`[auto-install] Failed to install ${tool.name}:`, err);

// AFTER:
console.error(`[auto-install] Failed to install ${tool.name}: ${(err as Error).message}`);
debugLog("Full error:", err);
```

**Step 5: Build and commit**

Run: `npm run build`

Expected: No errors

```bash
git add clients/installer/index.ts
git commit -m "refactor(installer): clean up error messages, move details to debug"
```

**Verification:**
- [ ] All error messages are concise
- [ ] Error details use `debugLog`
- [ ] User still sees what failed
- [ ] Builds successfully
- [ ] Commit made

---

### Task 4: Update Related Client Log Messages

**Files:**
- Modify: `clients/biome-client.ts:128,133,140` (biome auto-install logs)
- Modify: `clients/ruff-client.ts:71,76,81` (ruff auto-install logs)
- Modify: `clients/dependency-checker.ts:77,82,87` (madge auto-install logs)
- Modify: `clients/knip-client.ts:65,71,81` (knip auto-install logs)
- Modify: `clients/sg-runner.ts:71,78,88` (ast-grep auto-install logs)

**Step 1: Check if these use console.error or this.log()**

Read each file to understand their logger pattern. Most use `this.log()` which wraps `console.error`.

**Step 2: For each client, ensure they follow the same two-tier approach**

Example for biome-client.ts:
```typescript
// Line 128:
this.log("Biome not found, attempting auto-install..."); // KEEP - user facing

// Line 133:
this.log(`Biome auto-installed: ${installedPath}`); // KEEP - success is good to know

// Line 140:
this.log("Biome auto-install failed"); // KEEP - error
```

**Decision:** These client logs are already minimal and user-facing. **Leave them as-is.** The noise is primarily in `installer/index.ts` which we already fixed.

**Step 3: Commit (if any changes)**

If no changes needed:
```bash
# Document the decision
echo "Client log messages reviewed - already minimal, no changes needed" >> docs/plans/2025-04-03-auto-install-logging.md
git add docs/plans/2025-04-03-auto-install-logging.md
git commit -m "docs: confirm client logs are already minimal"
```

**Verification:**
- [ ] All 5 client files reviewed
- [ ] Decision documented
- [ ] Commit made (even if no code changes)

---

### Task 5: Document the Debug Flag

**Files:**
- Modify: `AGENTS.md` (add to "Flags" section if exists, or create note)
- Or: Create note in `docs/` about debugging

**Step 1: Add documentation**

Append to `AGENTS.md` or create `docs/debugging.md`:

```markdown
## Debug Logging

Set `PI_LENS_DEBUG=1` to see detailed auto-install logs:

```bash
PI_LENS_DEBUG=1 pi
```

Or use the flag:
```bash
pi --debug
```

Without debug flag, you'll see:
- Tool installation progress
- Errors (with message, not full stack traces)

With debug flag, you'll also see:
- Binary verification details
- Full error stacks
- Internal operation details
```

**Step 2: Commit**

```bash
git add AGENTS.md  # or docs/debugging.md
git commit -m "docs: add debug logging documentation"
```

**Verification:**
- [ ] Documentation exists
- [ ] Explains how to enable debug mode
- [ ] Explains what user sees vs what debug shows
- [ ] Commit made

---

### Task 6: Build and Verify

**Files:**
- Run: `npm run build`
- Run: `npm test`

**Step 1: Build**

```bash
npm run build
```

Expected: No TypeScript errors

**Step 2: Run tests**

```bash
npm test
```

Expected: All tests pass (no tests should break from logging changes)

**Step 3: Manual verification**

Since there's no automated test for "doesn't print too much", manually verify by:
1. Deleting `.pi-lens/tools/` directory
2. Running the extension
3. Observing console output
4. Confirming only user-facing logs appear

**Step 4: Final commit**

```bash
git add .
git commit -m "feat(installer): two-tier logging - user-facing vs debug-only"
```

**Verification:**
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] Manual verification confirms reduced noise
- [ ] Final commit made

---

## Summary of Changes

| Before | After |
|--------|-------|
| `console.error("[auto-install] Verified: X v1.2.3")` | `debugLog("Verified: X v1.2.3")` (hidden) |
| `console.error("[auto-install] Verifying...")` | `debugLog("Verifying...")` (hidden) |
| `console.error("[auto-install] Failed: ...", err)` | `console.error("[auto-install] Failed: ... msg")` + `debugLog(err)` |
| No way to see details | `PI_LENS_DEBUG=1` reveals all |

**User Experience:**
- Normal mode: "Installing ruff... [done]" or "Installing ruff... [failed: message]"
- Debug mode: Full operational details for troubleshooting

---

## Execution

**Use:** superpowers:subagent-driven-development

**Process:**
1. /tree → Branch 1: Implement Task 1 (debug flag)
2. /tree → Branch 2: Implement Task 2 (convert success logs)
3. /tree → Branch 3: Implement Task 3 (clean errors)
4. /tree → Branch 4: Implement Task 4 (review clients)
5. /tree → Branch 5: Implement Task 5 (docs)
6. /tree → Branch 6: Implement Task 6 (verification)
7. /tree → Return to mainline

---

**Plan complete. Ready for execution.**
