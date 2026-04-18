import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: (command: string) => ({
		isAvailable: () => true,
		getCommand: () => command,
	}),
}));

function createCtx(
	kind: "dart" | "zig" | "gleam",
	filePath: string,
	cwd: string,
) {
	return {
		filePath,
		cwd,
		kind,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("secondary language fallback runners", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("surfaces a warning when dart analyze exits non-zero without machine diagnostics", async () => {
		const env = setupTestEnvironment("pi-lens-dart-runner-");
		try {
			const filePath = path.join(env.tmpDir, "lib", "main.dart");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "void main() {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "dart analyze failed unexpectedly",
			});

			const runner = (await import(
				"../../../../clients/dispatch/runners/dart-analyze.js"
			)).default;

			const result = await runner.run(
				createCtx("dart", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.message).toContain("dart analyze failed");
		} finally {
			env.cleanup();
		}
	});

	it("surfaces a warning when zig exits non-zero without structured diagnostics", async () => {
		const env = setupTestEnvironment("pi-lens-zig-runner-");
		try {
			const filePath = path.join(env.tmpDir, "src", "main.zig");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "pub fn main() void {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "zig failed before emitting diagnostics",
			});

			const runner = (await import(
				"../../../../clients/dispatch/runners/zig-check.js"
			)).default;

			const result = await runner.run(
				createCtx("zig", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.message).toContain("zig failed");
		} finally {
			env.cleanup();
		}
	});

	it("surfaces a blocking diagnostic when gleam exits non-zero without structured output", async () => {
		const env = setupTestEnvironment("pi-lens-gleam-runner-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.gleam");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "pub fn main() { Nil }\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "gleam check failed unexpectedly",
			});

			const runner = (await import(
				"../../../../clients/dispatch/runners/gleam-check.js"
			)).default;

			const result = await runner.run(
				createCtx("gleam", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.message).toContain("gleam check failed");
		} finally {
			env.cleanup();
		}
	});
});
