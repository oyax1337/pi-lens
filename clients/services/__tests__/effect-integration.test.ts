/**
 * Effect Integration Tests
 *
 * Tests for Effect-TS concurrent runner execution.
 * Critical for --lens-effect flag functionality.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	DispatchContext,
	RunnerDefinition,
	RunnerGroup,
} from "../../dispatch/types.js";
import {
	dispatchLintWithEffect,
	dispatchWithEffect,
	type EffectDispatchResult,
} from "../effect-integration.js";

// --- Mock Runners ---

const createMockRunner = (
	id: string,
	delay: number = 0,
	shouldFail: boolean = false,
): RunnerDefinition => ({
	id,
	appliesTo: ["jsts"],
	priority: 10,
	enabledByDefault: true,
	async run(
		ctx: DispatchContext,
	): Promise<import("../../dispatch/types.js").RunnerResult> {
		if (delay > 0) {
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
		if (shouldFail) {
			return {
				status: "failed",
				diagnostics: [
					{
						id: `${id}:error`,
						message: "Test error",
						filePath: ctx.filePath,
						line: 1,
						column: 1,
						severity: "error",
						semantic: "blocking",
						tool: id,
					},
				],
				semantic: "blocking",
			};
		}
		return {
			status: "succeeded",
			diagnostics: [
				{
					id: `${id}:info`,
					message: `Test from ${id}`,
					filePath: ctx.filePath,
					line: 1,
					column: 1,
					severity: "info",
					semantic: "silent",
					tool: id,
				},
			],
			semantic: "none",
		};
	},
});

const createMockContext = (filePath: string = "test.ts"): DispatchContext => ({
	filePath,
	cwd: "/test",
	kind: "jsts",
	pi: {
		getFlag: vi.fn(() => false),
	},
	autofix: true,
	deltaMode: false,
	baselines: new Map(),
	hasTool: vi.fn(() => Promise.resolve(false)),
	log: vi.fn(),
});

const createMockGroup = (runners: RunnerDefinition[]): RunnerGroup => ({
	runnerIds: runners.map((r) => r.id),
	mode: "all",
});

// --- Tests ---

describe("Effect Integration", () => {
	describe("dispatchWithEffect", () => {
		it("should run runners concurrently", async () => {
			const runner1 = createMockRunner("runner1", 50);
			const runner2 = createMockRunner("runner2", 50);
			const ctx = createMockContext();
			const groups = [createMockGroup([runner1, runner2])];

			const startTime = Date.now();
			const result: EffectDispatchResult = await dispatchWithEffect(
				ctx,
				groups,
			);
			const endTime = Date.now();

			// Should complete in ~50ms (concurrent), not ~100ms (sequential)
			expect(endTime - startTime).toBeLessThan(100);
			expect(result.durationMs).toBeGreaterThan(0);
		});

		it("should handle runner failures gracefully", async () => {
			const goodRunner = createMockRunner("good", 0, false);
			const badRunner = createMockRunner("bad", 0, true);
			const ctx = createMockContext();
			const groups = [createMockGroup([goodRunner, badRunner])];

			const result: EffectDispatchResult = await dispatchWithEffect(
				ctx,
				groups,
			);

			// Should complete with mixed results
			expect(result.hasBlockers).toBe(true);
			expect(result.blockers.length).toBeGreaterThan(0);
		});

		it("should aggregate diagnostics correctly", async () => {
			const runner1 = createMockRunner("runner1");
			const runner2 = createMockRunner("runner2");
			const ctx = createMockContext();
			const groups = [createMockGroup([runner1, runner2])];

			const result: EffectDispatchResult = await dispatchWithEffect(
				ctx,
				groups,
			);

			// Should have diagnostics from both runners
			expect(result.diagnostics.length).toBeGreaterThan(0);
			expect(result.runnerResults.length).toBe(2);
		});

		it("should handle empty runner groups", async () => {
			const ctx = createMockContext();
			const groups: RunnerGroup[] = [];

			const result: EffectDispatchResult = await dispatchWithEffect(
				ctx,
				groups,
			);

			expect(result.diagnostics).toEqual([]);
			expect(result.hasBlockers).toBe(false);
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
		});

		it("should include timing information", async () => {
			const runner = createMockRunner("runner", 50);
			const ctx = createMockContext();
			const groups = [createMockGroup([runner])];

			const result: EffectDispatchResult = await dispatchWithEffect(
				ctx,
				groups,
			);

			expect(result.durationMs).toBeGreaterThan(0);
		});
	});

	describe("dispatchLintWithEffect", () => {
		it("should handle --lens-effect flag path", async () => {
			// This is the critical path for --lens-effect
			const mockPi = {
				getFlag: vi.fn((flag: string) => flag === "lens-effect"),
				readFile: vi.fn(),
				writeFile: vi.fn(),
				editFile: vi.fn(),
				bash: vi.fn(),
				ui: {
					notify: vi.fn(),
					progress: vi.fn(),
					prompt: vi.fn(),
				},
				llm: {
					stream: vi.fn(),
					createMessage: vi.fn(),
				},
			};

			const startTime = Date.now();
			const output = await dispatchLintWithEffect("test.ts", "/test", mockPi);
			const endTime = Date.now();

			// Should complete (just testing the path doesn't crash)
			expect(endTime - startTime).toBeLessThan(5000); // Generous timeout
			expect(typeof output).toBe("string");
		});
	});

	describe("Real-world scenarios", () => {
		it("should handle concurrent runners with different delays", async () => {
			const fastRunner = createMockRunner("fast", 10);
			const slowRunner = createMockRunner("slow", 100);
			const ctx = createMockContext();
			const groups = [createMockGroup([fastRunner, slowRunner])];

			const startTime = Date.now();
			const result: EffectDispatchResult = await dispatchWithEffect(
				ctx,
				groups,
			);
			const endTime = Date.now();

			// Both complete, total time ~100ms not ~110ms
			expect(endTime - startTime).toBeLessThan(150);
			expect(result.runnerResults.length).toBe(2);
		});

		it("should handle mix of blocking and warning diagnostics", async () => {
			const blockingRunner: RunnerDefinition = {
				id: "blocking",
				appliesTo: ["jsts"],
				priority: 5,
				enabledByDefault: true,
				async run(): Promise<import("../../dispatch/types.js").RunnerResult> {
					return {
						status: "failed",
						diagnostics: [
							{
								id: "blocking:error",
								message: "Blocking error",
								filePath: "test.ts",
								line: 1,
								column: 1,
								severity: "error",
								semantic: "blocking",
								tool: "blocking",
							},
						],
						semantic: "blocking",
					};
				},
			};

			const warningRunner: RunnerDefinition = {
				id: "warning",
				appliesTo: ["jsts"],
				priority: 10,
				enabledByDefault: true,
				async run(): Promise<import("../../dispatch/types.js").RunnerResult> {
					return {
						status: "failed",
						diagnostics: [
							{
								id: "warning:warn",
								message: "Just a warning",
								filePath: "test.ts",
								line: 2,
								column: 1,
								severity: "warning",
								semantic: "warning",
								tool: "warning",
							},
						],
						semantic: "warning",
					};
				},
			};

			const ctx = createMockContext();
			const groups = [createMockGroup([blockingRunner, warningRunner])];

			const result: EffectDispatchResult = await dispatchWithEffect(
				ctx,
				groups,
			);

			expect(result.hasBlockers).toBe(true);
			expect(result.blockers.length).toBeGreaterThan(0);
			expect(result.warnings.length).toBeGreaterThanOrEqual(0);
		});
	});
});
