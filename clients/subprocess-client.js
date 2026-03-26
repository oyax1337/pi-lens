/**
 * Base class for CLI tool clients that communicate via subprocess.
 *
 * Provides common patterns for:
 * - Availability checking (cached)
 * - File type detection
 * - Running CLI commands
 * - Logging
 *
 * Subclasses implement:
 * - getToolName(): The CLI tool name
 * - getCheckCommand(): Command to check availability
 * - isSupportedFile(): File extensions the tool handles
 * - parseOutput(): Parse CLI output into diagnostics
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
export class SubprocessClient {
    constructor(verbose = false) {
        this.available = null;
        this.toolName = this.getToolName();
        this.log = verbose
            ? (msg) => console.error(`[${this.toolName}] ${msg}`)
            : () => { };
    }
    /**
     * Check if the CLI tool is available (cached)
     */
    isAvailable() {
        if (this.available !== null)
            return this.available;
        const cmd = this.getCheckCommand();
        try {
            const result = spawnSync(cmd[0], cmd.slice(1), {
                encoding: "utf-8",
                timeout: 10000,
                shell: true,
            });
            this.available = !result.error && result.status === 0;
            if (this.available) {
                this.log(`${this.toolName} found`);
            }
            else {
                this.log(`${this.toolName} not available`);
            }
        }
        catch (err) {
            void err;
            this.available = false;
        }
        return this.available;
    }
    /**
     * Check if a file is supported by this tool
     */
    isSupportedFile(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        return this.getSupportedExtensions().includes(ext);
    }
    /**
     * Run a command and return the result
     */
    runCommand(cmd, options = {}) {
        const { cwd, timeout = 15000, input } = options;
        try {
            const result = spawnSync(cmd[0], cmd.slice(1), {
                encoding: "utf-8",
                timeout,
                cwd,
                shell: true,
                input,
            });
            if (result.error) {
                this.log(`Command error: ${result.error.message}`);
            }
            return result;
        }
        catch (err) {
            this.log(`Command failed: ${err.message}`);
            return {
                error: err,
                status: 1,
                stdout: "",
                stderr: err.message,
            };
        }
    }
    /**
     * Resolve a file path to absolute
     */
    resolvePath(filePath) {
        return path.resolve(filePath);
    }
    /**
     * Check if a file exists
     */
    fileExists(filePath) {
        return fs.existsSync(filePath);
    }
}
