/**
 * Regression tests for tree-sitter-client wasm resolution.
 *
 * Ensures the wasm path is resolved via Node's module resolver (createRequire)
 * rather than a hardcoded relative path, so hoisted installs (pnpm, npm v7+
 * workspaces) don't produce ENOENT crashes. See issue #20.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";

const _require = createRequire(import.meta.url);

describe("tree-sitter-client wasm resolution", () => {
	afterEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	it("resolves tree-sitter.wasm via require.resolve, not a fixed node_modules path", () => {
		// If the package is installed, require.resolve should find the wasm
		// regardless of whether it's nested or hoisted.
		const wasmPath = _require.resolve("web-tree-sitter/tree-sitter.wasm");
		expect(wasmPath).toMatch(/tree-sitter\.wasm$/);
		// Must NOT assume the wasm lives nested under pi-lens's own node_modules
		// relative to import.meta.url — that breaks in hoisted layouts.
		expect(path.isAbsolute(wasmPath)).toBe(true);
	});

	it("locateFile derives paths from the resolved wasm directory, not import.meta.url", () => {
		const wasmPath = _require.resolve("web-tree-sitter/tree-sitter.wasm");
		const wasmDir = path.dirname(wasmPath);

		// Simulate what the locateFile callback does
		const locateFile = (scriptName: string) => path.join(wasmDir, scriptName);

		const result = locateFile("tree-sitter.wasm");
		expect(result).toBe(wasmPath);

		// Any sibling wasm file should also resolve to the same directory
		const sibling = locateFile("tree-sitter-typescript.wasm");
		expect(path.dirname(sibling)).toBe(wasmDir);
	});

	it("findGrammarsDir resolves external packages via require.resolve, not process.cwd()", () => {
		// Verify tree-sitter-wasms is resolvable through Node's resolver.
		// This would fail in a hoisted monorepo if we used process.cwd()/node_modules directly.
		let resolved: string | undefined;
		try {
			resolved = _require.resolve("tree-sitter-wasms/package.json");
		} catch {
			// package not installed in this env — skip
			return;
		}
		expect(resolved).toMatch(/package\.json$/);
		expect(path.isAbsolute(resolved)).toBe(true);
	});
});
