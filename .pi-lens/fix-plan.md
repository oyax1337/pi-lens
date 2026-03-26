# Fix Plan — Iteration 3

📋 BOOBOO FIX PLAN — Iteration 3/3 (24 fixable items remaining)
✅ Fixed 20 issues since last iteration.

⚡ Auto-fixed: Biome --write --unsafe, Ruff --fix + format already ran.

## 🔁 Duplicate code [20 block(s)] — fix first
→ Extract duplicated blocks into shared utilities before fixing violations in them.
  - 7 lines: `clients/typescript-client.ts:321` ↔ `clients/typescript-client.ts:286`
  - 9 lines: `clients/typescript-client.ts:453` ↔ `clients/typescript-client.ts:364`
  - 9 lines: `clients/typescript-client.ts:476` ↔ `clients/typescript-client.ts:400`
  - 7 lines: `clients/todo-scanner.test.ts:92` ↔ `clients/todo-scanner.test.ts:29`
  - 9 lines: `clients/todo-scanner.test.ts:106` ↔ `clients/todo-scanner.test.ts:29`
  - 13 lines: `clients/test-runner-client.ts:578` ↔ `clients/test-runner-client.ts:505`
  - 31 lines: `clients/test-runner-client.ts:590` ↔ `clients/test-runner-client.ts:517`
  - 6 lines: `clients/ruff-client.ts:263` ↔ `clients/rust-client.ts:185`
  - 10 lines: `clients/ruff-client.test.ts:37` ↔ `clients/rust-client.test.ts:38`
  - 7 lines: `clients/go-client.ts:186` ↔ `clients/rust-client.ts:185`
  ... and 10 more

## 🤖 AI Slop indicators [4 files]
  - `clients/ruff-client.ts`: Many try/catch blocks (6)
  - `clients/subprocess-client.ts`: Excessive comments (34%), Over-abstraction (6 single-use helpers)
  - `clients/test-runner-client.ts`: Many try/catch blocks (7)
  - `index.ts`: Excessive comments (35%), Many try/catch blocks (14)

## ⏭️ Skip [103 items — architectural]
  - **long-method** (75): Extraction requires understanding the function's purpose.
  - **large-class** (16): Splitting a class requires architectural decisions.
  - **long-parameter-list** (6): Redesigning the signature requires an API decision.
  - **no-non-null-assertion** (6): Each `!` needs nullability analysis in context.

---
Fix the items above in order, then run `/lens-booboo-fix` again for the next iteration.
If an item is not safe to fix, skip it with one sentence why.