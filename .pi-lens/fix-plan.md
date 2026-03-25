# Fix Plan — Iteration 1

📋 BOOBOO FIX PLAN — Iteration 1/3 (96 fixable items remaining)

⚡ Auto-fixed: Biome --write --unsafe, Ruff --fix + format already ran.

## 🔨 Fix these [91 items]

### silent-failure (56)
→ Add this.log('Error: ' + err.message) or rethrow
  - `clients/subprocess-client.ts:87`
  - `clients/subprocess-client.ts:134`
  - `clients/type-coverage-client.ts:91`
  - `clients/jscpd-client.ts:111`
  - `clients/jscpd-client.ts:123`
  - `clients/jscpd-client.ts:173`
  - `clients/knip-client.ts:117`
  - `clients/knip-client.ts:244`
  - `clients/rust-client.ts:98`
  - `clients/rust-client.ts:150`
  - `clients/rust-client.ts:176`
  - `clients/rust-client.ts:270`
  - `clients/dependency-checker.ts:282`
  - `clients/dependency-checker.ts:360`
  - `clients/ruff-client.ts:67`
  ... and 41 more

### no-console-log (14)
→ Remove or replace with class logger method
  - `clients/subprocess-client.ts:41`
  - `clients/type-coverage-client.ts:40`
  - `clients/jscpd-client.ts:42`
  - `clients/knip-client.ts:43`
  - `clients/metrics-client.ts:59`
  - `clients/rust-client.ts:67`
  - `clients/dependency-checker.ts:54`
  - `clients/ruff-client.ts:47`
  - `clients/go-client.ts:50`
  - `clients/biome-client.ts:48`
  - `clients/test-runner-client.ts:206`
  - `clients/ast-grep-client.ts:93`
  - `clients/complexity-client.ts:158`
  - `index.ts:64`

### empty-catch (21)
→ Add this.log('Error: ' + err.message) to the catch block
  - `clients/jscpd-client.ts:173`
  - `clients/ruff-client.ts:150`
  - `clients/ruff-client.ts:212`
  - `clients/ruff-client.ts:253`
  - `clients/biome-client.ts:173`
  - `clients/biome-client.ts:247`
  - `clients/biome-client.ts:316`
  - `clients/typescript-client.ts:84`
  - `clients/test-runner-client.ts:265`
  - `clients/test-runner-client.ts:294`
  - `clients/test-runner-client.ts:369`
  - `clients/test-runner-client.ts:550`
  - `clients/test-runner-client.ts:622`
  - `clients/ast-grep-client.ts:357`
  - `clients/ast-grep-client.ts:602`
  ... and 6 more

## 🤖 AI Slop indicators [5 files]
  - `clients/ast-grep-client.ts`: Many try/catch blocks (10)
  - `clients/ruff-client.ts`: Many try/catch blocks (6)
  - `clients/subprocess-client.ts`: Excessive comments (34%), Over-abstraction (6 single-use helpers)
  - `clients/test-runner-client.ts`: Many try/catch blocks (7)
  - `index.ts`: Excessive comments (33%), Many try/catch blocks (9)

## ⏭️ Skip [31 items — architectural]
  - **large-class** (14): Splitting a class requires architectural decisions.
  - **no-non-null-assertion** (6): Each `!` needs nullability analysis in context.
  - **long-method** (5): Extraction requires understanding the function's purpose.
  - **long-parameter-list** (6): Redesigning the signature requires an API decision.

---
Fix the items above, then run `/lens-booboo-fix` again for the next iteration.
If an item in '🔨 Fix these' is not safe to fix, skip it with one sentence why.