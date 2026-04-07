import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ error: null, status: 0, stdout: "", stderr: "" })),
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: (command: string) => ({
		isAvailable: () => true,
		getCommand: () => command,
	}),
}));

function createCtx(kind: "yaml" | "sql", filePath: string) {
	return {
		filePath,
		cwd: process.cwd(),
		kind,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		baselines: { get: () => undefined, set: () => {}, clear: () => {} },
		hasTool: async () => true,
		log: () => {},
	};
}

describe("yaml/sql runners", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawn).mockReset();
	});

	it("yamllint runner maps error severity to blocking", async () => {
		const runner = (await import(
			"../../../../clients/dispatch/runners/yamllint.js"
		)).default;
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");

		vi.mocked(safeSpawnMod.safeSpawn).mockReturnValue({
			error: null,
			status: 1,
			stdout:
				"a.yaml:3:5: [error] syntax error: mapping values are not allowed (syntax)\n",
			stderr: "",
		});

		const result = await runner.run(createCtx("yaml", "a.yaml") as never);
		expect(result.status).toBe("failed");
		expect(result.semantic).toBe("blocking");
		expect(result.diagnostics[0]?.tool).toBe("yamllint");
	});

	it("sqlfluff runner returns warning diagnostics", async () => {
		const runner = (await import(
			"../../../../clients/dispatch/runners/sqlfluff.js"
		)).default;
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");

		vi.mocked(safeSpawnMod.safeSpawn).mockReturnValue({
			error: null,
			status: 1,
			stdout: JSON.stringify([
				{
					filepath: "query.sql",
					violations: [
						{
							code: "LT01",
							description: "Expected single whitespace between keywords",
							line_no: 1,
							line_pos: 7,
						},
					],
				},
			]),
			stderr: "",
		});

		const result = await runner.run(createCtx("sql", "query.sql") as never);
		expect(result.status).toBe("failed");
		expect(result.semantic).toBe("warning");
		expect(result.diagnostics[0]?.rule).toBe("LT01");
	});
});
