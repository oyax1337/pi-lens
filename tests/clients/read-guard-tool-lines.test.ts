import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	countFileLines,
	getTouchedLinesForGuard,
} from "../../clients/read-guard-tool-lines.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("read-guard tool line helpers", () => {
	it("returns undefined for text-replacement edits without explicit ranges", () => {
		const event = {
			toolName: "edit",
			input: {
				path: "/src/file.ts",
				edits: [{ oldText: "foo", newText: "bar" }],
			},
		};

		expect(getTouchedLinesForGuard(event)).toBeUndefined();
	});

	it("uses only edits that actually provide ranges", () => {
		const event = {
			toolName: "edit",
			input: {
				path: "/src/file.ts",
				edits: [
					{ oldText: "foo", newText: "bar" },
					{
						range: {
							start: { line: 10 },
							end: { line: 12 },
						},
					},
				],
			},
		};

		expect(getTouchedLinesForGuard(event)).toEqual([10, 12]);
	});

	it("uses actual on-disk line count for writes", () => {
		const env = setupTestEnvironment("read-guard-lines-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "line1\nline2\nline3\n");

			expect(countFileLines(filePath)).toBe(4);
			expect(
				getTouchedLinesForGuard(
					{ toolName: "write", input: { path: filePath } },
					filePath,
				),
			).toEqual([1, 4]);
		} finally {
			env.cleanup();
		}
	});
});
