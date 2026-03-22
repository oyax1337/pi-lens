/**
 * AstGrep Client for pi-lens
 *
 * Structural code analysis using ast-grep CLI.
 * Scans files against YAML rule definitions.
 *
 * Requires: npm install -D @ast-grep/cli
 * Rules: ./rules/ directory
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

// --- Types ---

export interface AstGrepDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  rule: string;
  file: string;
  fix?: string;
}

// New ast-grep JSON format
interface AstGrepJsonDiagnostic {
  ruleId: string;
  severity: string;
  message: string;
  note?: string;
  labels: Array<{
    text: string;
    range: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
    file?: string;
    style: string;
  }>;
  // Legacy format support
  Message?: { text: string };
  Severity?: string;
  spans?: Array<{
    context: string;
    range: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
    file: string;
  }>;
  name?: string;
}

// --- Client ---

export class AstGrepClient {
  private available: boolean | null = null;
  private ruleDir: string;
  private log: (msg: string) => void;

  constructor(ruleDir?: string, verbose = false) {
    this.ruleDir = ruleDir || path.join(typeof __dirname !== "undefined" ? __dirname : ".", "..", "rules");
    this.log = verbose
      ? (msg: string) => console.log(`[ast-grep] ${msg}`)
      : () => {};
    try {
      const nodeFs2 = require("node:fs") as typeof import("node:fs");
      nodeFs2.appendFileSync("C:/Users/R3LiC/Desktop/pi-lens-debug.log",
        `[${new Date().toISOString()}] AstGrepClient constructed, __dirname=${typeof __dirname !== "undefined" ? __dirname : "undefined"}, ruleDir=${this.ruleDir}\n`);
    } catch {}
  }

  /**
   * Check if ast-grep CLI is available
   */
  isAvailable(): boolean {
    if (this.available !== null) return this.available;

    const result = spawnSync("npx", ["sg", "--version"], {
      encoding: "utf-8",
      timeout: 10000,
      shell: true,
    });

    this.available = !result.error && result.status === 0;
    if (this.available) {
      this.log("ast-grep available");
    }

    return this.available;
  }

  /**
   * Scan a file against all rules
   */
  scanFile(filePath: string): AstGrepDiagnostic[] {
    if (!this.isAvailable()) return [];

    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) return [];

    const configPath = path.join(this.ruleDir, ".sgconfig.yml");

    try {
      const result = spawnSync("npx", [
        "sg",
        "scan",
        "--config", configPath,
        "--json",
        absolutePath,
      ], {
        encoding: "utf-8",
        timeout: 15000,
        shell: true,
      });

      // ast-grep exits 1 when it finds issues
      const output = result.stdout || result.stderr || "";
      if (!output.trim()) return [];

      return this.parseOutput(output, absolutePath);
    } catch (err: any) {
      this.log(`Scan error: ${err.message}`);
      return [];
    }
  }

  /**
   * Format diagnostics for LLM consumption
   */
  formatDiagnostics(diags: AstGrepDiagnostic[]): string {
    if (diags.length === 0) return "";

    const errors = diags.filter(d => d.severity === "error");
    const warnings = diags.filter(d => d.severity === "warning");

    let output = `[ast-grep] ${diags.length} structural issue(s)`;
    if (errors.length) output += ` — ${errors.length} error(s)`;
    if (warnings.length) output += ` — ${warnings.length} warning(s)`;
    output += ":\n";

    for (const d of diags.slice(0, 15)) {
      const loc = d.line === d.endLine
        ? `L${d.line}`
        : `L${d.line}-${d.endLine}`;
      const fix = d.fix ? " [fixable]" : "";
      output += `  [${d.rule}] ${loc} ${d.message}${fix}\n`;
    }

    if (diags.length > 15) {
      output += `  ... and ${diags.length - 15} more\n`;
    }

    return output;
  }

  // --- Internal ---

  private parseOutput(output: string, filterFile: string): AstGrepDiagnostic[] {
    const diagnostics: AstGrepDiagnostic[] = [];
    const resolvedFilterFile = path.resolve(filterFile);

    // Try parsing as JSON array first (new format)
    try {
      const items: AstGrepJsonDiagnostic[] = JSON.parse(output);
      if (Array.isArray(items)) {
        for (const item of items) {
          const diag = this.parseDiagnostic(item, resolvedFilterFile);
          if (diag) diagnostics.push(diag);
        }
        return diagnostics;
      }
    } catch {
      // Not a JSON array, try ndjson format (legacy)
    }

    // Parse ndjson (one JSON object per line) - legacy format
    const lines = output.split("\n").filter(l => l.trim());

    for (const line of lines) {
      try {
        const item: AstGrepJsonDiagnostic = JSON.parse(line);
        const diag = this.parseDiagnostic(item, resolvedFilterFile);
        if (diag) diagnostics.push(diag);
      } catch {
        // Skip unparseable lines
      }
    }

    return diagnostics;
  }

  private parseDiagnostic(item: AstGrepJsonDiagnostic, filterFile: string): AstGrepDiagnostic | null {
    // New format uses labels array
    if (item.labels && item.labels.length > 0) {
      const label = item.labels.find(l => l.style === "primary") || item.labels[0];
      const filePath = path.resolve(label.file || filterFile);

      // Filter to our file
      if (filePath !== filterFile) return null;

      const start = label.range?.start || { line: 0, column: 0 };
      const end = label.range?.end || start;

      return {
        line: start.line + 1, // ast-grep is 0-indexed, we want 1-indexed
        column: start.column,
        endLine: end.line + 1,
        endColumn: end.column,
        severity: this.mapSeverity(item.severity),
        message: item.message || "Unknown issue",
        rule: item.ruleId || "unknown",
        file: filePath,
      };
    }

    // Legacy format uses spans array
    if (item.spans && item.spans.length > 0) {
      const span = item.spans[0];
      const filePath = path.resolve(span.file || filterFile);

      // Filter to our file
      if (filePath !== filterFile) return null;

      const start = span.range?.start || { line: 0, column: 0 };
      const end = span.range?.end || start;

      return {
        line: start.line + 1,
        column: start.column,
        endLine: end.line + 1,
        endColumn: end.column,
        severity: this.mapSeverity(item.severity || item.Severity || "warning"),
        message: item.Message?.text || item.message || "Unknown issue",
        rule: item.name || item.ruleId || "unknown",
        file: filePath,
      };
    }

    return null;
  }

  private mapSeverity(severity: string): AstGrepDiagnostic["severity"] {
    const lower = severity.toLowerCase();
    if (lower === "error") return "error";
    if (lower === "warning") return "warning";
    if (lower === "info") return "info";
    return "hint";
  }
}
