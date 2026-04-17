import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("lsp launch", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.resetModules();
		vi.clearAllMocks();
	});

	it.runIf(process.platform === "win32")(
		"treats delayed shell-backed startup failure as launch failure",
		async () => {
			vi.useFakeTimers();

			vi.doMock("node:child_process", () => {
				class MockStream extends EventEmitter {}
				class MockChildProcess extends EventEmitter {
					stdin = new MockStream();
					stdout = new MockStream();
					stderr = new MockStream();
					pid = 4321;
					exitCode: number | null = null;
					killed = false;
				}

				return {
					execSync: vi.fn(() => ""),
					spawn: vi.fn(() => {
						const proc = new MockChildProcess();
						setTimeout(() => {
							proc.exitCode = 1;
							proc.emit("exit", 1, null);
							proc.emit("close", 1, null);
						}, 120);
						return proc;
					}),
				};
			});

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			const launchPromise = launchLSP("C:\\fake\\bash-language-server.cmd", ["start"], {
				cwd: "C:\\fake",
			});
			const rejection = expect(launchPromise).rejects.toThrow(
				/exited immediately with code 1/i,
			);

			await vi.advanceTimersByTimeAsync(150);

			await rejection;
		},
	);
});
