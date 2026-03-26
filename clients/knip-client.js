/**
 * Knip Client for pi-local
 *
 * Detects unused exports, files, dependencies, and more.
 * Essential for safe refactoring — I need to know what's dead code
 * before I can clean it up.
 *
 * Requires: npm install -D knip
 * Docs: https://knip.dev/
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
// --- Client ---
export class KnipClient {
    constructor(verbose = false) {
        this.knipAvailable = null;
        this.log = verbose
            ? (msg) => console.error(`[knip] ${msg}`)
            : () => { };
    }
    /**
     * Check if knip CLI is available
     */
    isAvailable() {
        if (this.knipAvailable !== null)
            return this.knipAvailable;
        const result = spawnSync("npx", ["knip", "--version"], {
            encoding: "utf-8",
            timeout: 10000,
            shell: true,
        });
        this.knipAvailable = !result.error && result.status === 0;
        if (this.knipAvailable) {
            this.log(`Knip available`);
        }
        return this.knipAvailable;
    }
    /**
     * Run knip analysis on the project
     */
    analyze(cwd) {
        if (!this.isAvailable()) {
            return {
                success: false,
                issues: [],
                unusedExports: [],
                unusedFiles: [],
                unusedDeps: [],
                unlistedDeps: [],
                summary: "Knip not available. Install with: npm install -D knip",
            };
        }
        const targetDir = cwd || process.cwd();
        try {
            const result = spawnSync("npx", [
                "knip",
                "--reporter=json",
                "--include",
                "exports,types,dependencies,unlisted",
            ], {
                encoding: "utf-8",
                timeout: 30000,
                cwd: targetDir,
                shell: true,
            });
            // Knip exits 0 on success (even with issues), 1 on errors
            const output = result.stdout || "";
            if (!output.trim()) {
                return {
                    success: true,
                    issues: [],
                    unusedExports: [],
                    unusedFiles: [],
                    unusedDeps: [],
                    unlistedDeps: [],
                    summary: "No issues found",
                };
            }
            return this.parseOutput(output);
        }
        catch (err) {
            this.log(`Analysis error: ${err.message}`);
            return {
                success: false,
                issues: [],
                unusedExports: [],
                unusedFiles: [],
                unusedDeps: [],
                unlistedDeps: [],
                summary: `Error: ${err.message}`,
            };
        }
    }
    /**
     * Find unused exports in a specific file
     */
    findUnusedExports(filePath) {
        const result = this.analyze(path.dirname(filePath));
        const basename = path.basename(filePath);
        return result.unusedExports
            .filter((e) => e.file?.includes(basename))
            .map((e) => e.name);
    }
    /**
     * Format results for LLM consumption
     */
    formatResult(result, maxItems = 20) {
        if (!result.success)
            return `[Knip] ${result.summary}`;
        if (result.issues.length === 0)
            return "";
        let output = `[Knip] ${result.issues.length} issue(s)`;
        if (result.unusedExports.length)
            output += ` — ${result.unusedExports.length} unused export(s)`;
        if (result.unusedFiles.length)
            output += ` — ${result.unusedFiles.length} unused file(s)`;
        if (result.unusedDeps.length)
            output += ` — ${result.unusedDeps.length} unused dep(s)`;
        if (result.unlistedDeps.length)
            output += ` — ${result.unlistedDeps.length} unlisted dep(s)`;
        output += ":\n";
        // Show unused exports first (most useful for refactoring)
        if (result.unusedExports.length > 0) {
            output += "\n  Unused exports:\n";
            for (const issue of result.unusedExports.slice(0, maxItems)) {
                const loc = issue.file ? ` (${path.basename(issue.file)})` : "";
                output += `    - ${issue.name}${loc}\n`;
            }
            if (result.unusedExports.length > maxItems) {
                output += `    ... and ${result.unusedExports.length - maxItems} more\n`;
            }
        }
        // Show unused files
        if (result.unusedFiles.length > 0) {
            output += "\n  Unused files:\n";
            for (const issue of result.unusedFiles.slice(0, 10)) {
                output += `    - ${issue.name}\n`;
            }
        }
        // Show unused deps (might be worth removing)
        if (result.unusedDeps.length > 0) {
            output += "\n  Unused dependencies:\n";
            for (const issue of result.unusedDeps) {
                output += `    - ${issue.package || issue.name}\n`;
            }
        }
        return output;
    }
    // --- Internal ---
    parseOutput(output) {
        try {
            const data = JSON.parse(output);
            const issues = [];
            const unusedExports = [];
            const unusedFiles = [];
            const unusedDeps = [];
            const unlistedDeps = [];
            // Knip JSON format: { issues: [ { file, exports:[], files:[], dependencies:[], ... } ] }
            const fileEntries = data.issues ?? [];
            for (const entry of fileEntries) {
                const file = entry.file ?? "";
                const push = (arr, type, target) => {
                    for (const item of arr) {
                        const issue = {
                            type,
                            name: item.name ?? item.symbol ?? String(item),
                            file,
                            line: item.line,
                            package: item.package,
                        };
                        issues.push(issue);
                        target.push(issue);
                    }
                };
                push(entry.exports ?? [], "export", unusedExports);
                push(entry.types ?? [], "export", unusedExports);
                push(entry.files ?? [], "file", unusedFiles);
                push(entry.dependencies ?? [], "dependency", unusedDeps);
                push(entry.devDependencies ?? [], "devDependency", unusedDeps);
                push(entry.unlisted ?? [], "unlisted", unlistedDeps);
            }
            return {
                success: true,
                issues,
                unusedExports,
                unusedFiles,
                unusedDeps,
                unlistedDeps,
                summary: `Found ${issues.length} issues`,
            };
        }
        catch (err) {
            void err;
            this.log("Failed to parse knip JSON output");
            return {
                success: false,
                issues: [],
                unusedExports: [],
                unusedFiles: [],
                unusedDeps: [],
                unlistedDeps: [],
                summary: "Failed to parse output",
            };
        }
    }
}
