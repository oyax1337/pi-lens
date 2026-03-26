/**
 * jscpd Client for pi-lens
 *
 * Detects copy-paste / duplicate code blocks across the project.
 * Helps the agent avoid unknowingly duplicating logic that already exists.
 *
 * Requires: npm install -D jscpd
 * Docs: https://github.com/kucherenko/jscpd
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// --- Client ---
export class JscpdClient {
    constructor(verbose = false) {
        this.available = null;
        this.log = verbose ? (msg) => console.error(`[jscpd] ${msg}`) : () => { };
    }
    isAvailable() {
        if (this.available !== null)
            return this.available;
        const result = spawnSync("npx", ["jscpd", "--version"], {
            encoding: "utf-8",
            timeout: 10000,
            shell: true,
        });
        this.available = !result.error && result.status === 0;
        return this.available;
    }
    /**
     * Scan a directory for duplicate code blocks.
     * Uses a temp output dir to capture JSON report.
     */
    scan(cwd, minLines = 5, minTokens = 50) {
        if (!this.isAvailable()) {
            return {
                success: false,
                clones: [],
                duplicatedLines: 0,
                totalLines: 0,
                percentage: 0,
            };
        }
        const outDir = path.join(os.tmpdir(), `pi-lens-jscpd-${Date.now()}`);
        fs.mkdirSync(outDir, { recursive: true });
        try {
            spawnSync("npx", [
                "jscpd",
                ".",
                "--min-lines",
                String(minLines),
                "--min-tokens",
                String(minTokens),
                "--reporters",
                "json",
                "--output",
                outDir,
                "--ignore",
                "**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/.pi-lens/**,**/*.md,**/*.txt,**/*.json,**/*.yaml,**/*.yml,**/*.toml,**/*.lock",
            ], {
                encoding: "utf-8",
                timeout: 30000,
                cwd,
                shell: true,
            });
            const reportPath = path.join(outDir, "jscpd-report.json");
            if (!fs.existsSync(reportPath)) {
                return {
                    success: true,
                    clones: [],
                    duplicatedLines: 0,
                    totalLines: 0,
                    percentage: 0,
                };
            }
            return this.parseReport(reportPath);
        }
        catch (err) {
            this.log(`Scan error: ${err.message}`);
            return {
                success: false,
                clones: [],
                duplicatedLines: 0,
                totalLines: 0,
                percentage: 0,
            };
        }
        finally {
            try {
                fs.rmSync(outDir, { recursive: true, force: true });
            }
            catch (err) {
                void err;
            }
        }
    }
    formatResult(result, maxClones = 8) {
        if (!result.success || result.clones.length === 0)
            return "";
        const pct = result.percentage.toFixed(1);
        let output = `[jscpd] ${result.clones.length} duplicate block(s) — ${pct}% of codebase (${result.duplicatedLines}/${result.totalLines} lines):\n`;
        for (const clone of result.clones.slice(0, maxClones)) {
            const a = `${path.basename(clone.fileA)}:${clone.startA}`;
            const b = `${path.basename(clone.fileB)}:${clone.startB}`;
            output += `  ${clone.lines} lines — ${a} ↔ ${b}\n`;
        }
        if (result.clones.length > maxClones) {
            output += `  ... and ${result.clones.length - maxClones} more\n`;
        }
        return output;
    }
    // --- Internal ---
    parseReport(reportPath) {
        try {
            const data = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
            // Stats live in statistics.total, not statistics.clones
            const total = data.statistics?.total ?? {};
            const duplicatedLines = total.duplicatedLines ?? 0;
            const totalLines = total.lines ?? 0;
            const percentage = total.percentage ??
                (totalLines > 0 ? (duplicatedLines / totalLines) * 100 : 0);
            const rawClones = data.duplicates ?? [];
            const clones = rawClones.map((c) => ({
                fileA: c.firstFile?.name ?? "",
                startA: c.firstFile?.start ?? 0,
                fileB: c.secondFile?.name ?? "",
                startB: c.secondFile?.start ?? 0,
                lines: c.lines ?? 0,
                tokens: c.tokens ?? 0,
            }));
            return { success: true, clones, duplicatedLines, totalLines, percentage };
        }
        catch (err) {
            void err;
            return {
                success: false,
                clones: [],
                duplicatedLines: 0,
                totalLines: 0,
                percentage: 0,
            };
        }
    }
}
