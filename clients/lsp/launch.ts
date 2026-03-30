/**
 * LSP Process Launch Utilities
 * 
 * Handles spawning LSP servers via various methods:
 * - Direct binary execution
 * - Node.js scripts (npx/bun)
 * - Package manager execution
 */

import { spawn, type SpawnOptions, type ChildProcess } from "child_process";
import path from "path";

export interface LSPProcess {
	process: ChildProcess;
	stdin: NodeJS.WritableStream;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	pid: number;
}

/**
 * Spawn an LSP server process
 * 
 * @param command - Command to run (e.g., "typescript-language-server")
 * @param args - Arguments (e.g., ["--stdio"])
 * @param options - Spawn options including cwd, env
 * @returns LSPProcess handle
 */
export function launchLSP(
	command: string,
	args: string[] = [],
	options: SpawnOptions = {}
): LSPProcess {
	const cwd = options.cwd ?? process.cwd();
	const env = { ...process.env, ...options.env };

	const isWindows = process.platform === "win32";

	const proc = isWindows
		? spawn(`${command} ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`, [], {
				cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				detached: false,
				windowsHide: true,
				shell: true,
			})
		: spawn(command, args, {
				cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				detached: false,
				windowsHide: true,
			});

	if (!proc.stdin || !proc.stdout || !proc.stderr) {
		throw new Error(`Failed to spawn LSP server: ${command}`);
	}

	return {
		process: proc,
		stdin: proc.stdin,
		stdout: proc.stdout,
		stderr: proc.stderr,
		pid: proc.pid ?? 0,
	};
}

/**
 * Spawn via package manager (npx/bun)
 */
export function launchViaPackageManager(
	packageName: string,
	args: string[] = [],
	options: SpawnOptions = {}
): LSPProcess {
	// Prefer bun if available, fall back to npx (use .cmd on Windows)
	const isWindows = process.platform === "win32";
	const manager = process.env.BUN_INSTALL
		? { cmd: isWindows ? "bun.exe" : "bun", args: ["x", packageName, ...args] }
		: { cmd: isWindows ? "npx.cmd" : "npx", args: ["-y", packageName, ...args] };

	return launchLSP(manager.cmd, manager.args, options);
}

/**
 * Spawn via Node.js directly
 */
export function launchViaNode(
	scriptPath: string,
	args: string[] = [],
	options: SpawnOptions = {}
): LSPProcess {
	return launchLSP(process.execPath, [scriptPath, ...args], options);
}

/**
 * Spawn via Python module
 */
export function launchViaPython(
	moduleName: string,
	args: string[] = [],
	options: SpawnOptions = {}
): LSPProcess {
	// On Windows, prefer 'py' launcher, fall back to 'python'
	const pythonCmd = process.platform === "win32" ? "py" : "python3";
	return launchLSP(pythonCmd, ["-m", moduleName, ...args], options);
}

/**
 * Stop an LSP process gracefully
 */
export async function stopLSP(handle: LSPProcess): Promise<void> {
	return new Promise((resolve) => {
		// Send SIGTERM first
		handle.process.kill("SIGTERM");

		// Force kill after timeout
		const timeout = setTimeout(() => {
			if (!handle.process.killed) {
				handle.process.kill("SIGKILL");
			}
		}, 5000);

		handle.process.on("exit", () => {
			clearTimeout(timeout);
			resolve();
		});

		handle.process.on("error", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
}
