# Fix Plan — Iteration 1

📋 BOOBOO FIX PLAN — Iteration 1/3 (293 fixable items remaining)

⚡ Auto-fixed: Biome --write --unsafe, Ruff --fix + format already ran.

## 🔁 Duplicate code [40 block(s)] — fix first
→ Extract duplicated blocks into shared utilities before fixing violations in them.
  - 10 lines: `clients/typescript-client.ts:355` ↔ `clients/typescript-client.ts:312`
  - 10 lines: `clients/typescript-client.ts:379` ↔ `clients/typescript-client.ts:312`
  - 10 lines: `clients/typescript-client.ts:441` ↔ `clients/typescript-client.ts:312`
  - 14 lines: `clients/typescript-client.ts:467` ↔ `clients/typescript-client.ts:351`
  - 9 lines: `clients/typescript-client.ts:496` ↔ `clients/typescript-client.ts:404`
  - 8 lines: `clients/typescript-client.js:304` ↔ `clients/typescript-client.js:269`
  - 8 lines: `clients/typescript-client.js:324` ↔ `clients/typescript-client.js:269`
  - 8 lines: `clients/typescript-client.js:373` ↔ `clients/typescript-client.js:269`
  - 8 lines: `clients/typescript-client.js:395` ↔ `clients/typescript-client.js:269`
  - 7 lines: `clients/typescript-client.js:416` ↔ `clients/typescript-client.js:345`
  ... and 30 more

## 🔨 Fix these [244 items]

### no-console-log (14)
→ Remove or replace with class logger method
  - `clients/subprocess-client.ts:41`
  - `clients/jscpd-client.ts:42`
  - `clients/knip-client.ts:43`
  - `clients/rust-client.ts:67`
  - `clients/go-client.ts:50`
  - `clients/type-coverage-client.ts:40`
  - `clients/dependency-checker.ts:54`
  - `clients/ruff-client.ts:47`
  - `clients/biome-client.ts:48`
  - `clients/metrics-client.ts:64`
  - `clients/ast-grep-client.ts:67`
  - `clients/test-runner-client.ts:206`
  - `clients/complexity-client.ts:158`
  - `index.ts:61`

### raw-strings (230)
→ Fix this violation
  - `clients/jscpd-client.ts:47`
  - `clients/jscpd-client.ts:76`
  - `clients/jscpd-client.ts:99`
  - `clients/jscpd-client.ts:152`
  - `clients/knip-client.ts:53`
  - `clients/knip-client.ts:87`
  - `clients/knip-client.ts:227`
  - `clients/knip-client.ts:228`
  - `clients/knip-client.ts:229`
  - `clients/knip-client.ts:230`
  - `clients/knip-client.ts:231`
  - `clients/knip-client.ts:232`
  - `clients/rust-client.ts:46`
  - `clients/rust-client.ts:46`
  - `clients/rust-client.ts:46`
  ... and 215 more

## 🤖 AI Slop indicators [9 files]
  - `clients/ruff-client.js`: Many try/catch blocks (6)
  - `clients/ruff-client.ts`: Many try/catch blocks (6)
  - `clients/subprocess-client.js`: Excessive comments (31%)
  - `clients/subprocess-client.ts`: Excessive comments (34%), Over-abstraction (6 single-use helpers)
  - `clients/test-runner-client.js`: Many try/catch blocks (7)
  - `clients/test-runner-client.ts`: Many try/catch blocks (7)
  - `clients/types.js`: Excessive comments (36%)
  - `index.js`: Excessive comments (32%), Many try/catch blocks (14)
  - `index.ts`: Excessive comments (34%), Many try/catch blocks (14)

## ⏭️ Skip [104 items — architectural]
  - **long-method** (76): Extraction requires understanding the function's purpose.
  - **large-class** (16): Splitting a class requires architectural decisions.
  - **no-non-null-assertion** (6): Each `!` needs nullability analysis in context.
  - **long-parameter-list** (6): Redesigning the signature requires an API decision.

---
Fix the items above in order, then run `/lens-booboo-fix` again for the next iteration.
If an item is not safe to fix, skip it with one sentence why.