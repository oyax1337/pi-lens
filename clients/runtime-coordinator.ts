import * as path from "node:path";
import type { FileComplexity } from "./complexity-client.js";
import type { RuleScanResult } from "./rules-scanner.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import type { ProjectIndex } from "./project-index.js";

export interface ErrorDebtBaseline {
	testsPassed: boolean;
	buildPassed: boolean;
}

export class RuntimeCoordinator {
	private _projectRoot = process.cwd();
	private _errorDebtBaseline: ErrorDebtBaseline | null = null;
	private _pipelineCrashCounts = new Map<string, number>();
	private _cachedExports = new Map<string, string>();
	private _cachedProjectIndex: ProjectIndex | null = null;
	private _lastCascadeOutput = "";
	private _complexityBaselines = new Map<string, FileComplexity>();
	private _fixedThisTurn = new Set<string>();
	private _projectRulesScan: RuleScanResult = {
		rules: [],
		hasCustomRules: false,
	};

	resetForSession(): void {
		this._complexityBaselines.clear();
		this._pipelineCrashCounts.clear();
		this._cachedExports.clear();
		this._cachedProjectIndex = null;
		this._lastCascadeOutput = "";
		this._fixedThisTurn.clear();
	}

	beginTurn(): void {
		this._lastCascadeOutput = "";
	}

	formatPipelineCrashNotice(filePath: string, err: unknown): string {
		const key = path.resolve(filePath);
		const count = (this._pipelineCrashCounts.get(key) ?? 0) + 1;
		this._pipelineCrashCounts.set(key, count);

		const message = err instanceof Error ? err.message : String(err);
		const shortMessage = message.split("\n")[0].slice(0, 220);
		const shouldSurface =
			count <= RUNTIME_CONFIG.crashNotice.alwaysShowFirstN ||
			count % RUNTIME_CONFIG.crashNotice.showEveryNth === 0;
		if (!shouldSurface) return "";

		return [
			"⚠️ pi-lens pipeline crashed while analyzing this write.",
			`File: ${path.basename(filePath)} | crash count this session: ${count}`,
			`Error: ${shortMessage}`,
			"Recovery: LSP service was reset. If this repeats, rerun with --no-lsp and report the file + stack.",
		].join("\n");
	}

	getCrashEntries(): Array<[string, number]> {
		return Array.from(this._pipelineCrashCounts.entries());
	}

	get projectRoot(): string {
		return this._projectRoot;
	}

	set projectRoot(value: string) {
		this._projectRoot = value;
	}

	get errorDebtBaseline(): ErrorDebtBaseline | null {
		return this._errorDebtBaseline;
	}

	set errorDebtBaseline(value: ErrorDebtBaseline | null) {
		this._errorDebtBaseline = value;
	}

	get cachedExports(): Map<string, string> {
		return this._cachedExports;
	}

	get cachedProjectIndex(): ProjectIndex | null {
		return this._cachedProjectIndex;
	}

	set cachedProjectIndex(value: ProjectIndex | null) {
		this._cachedProjectIndex = value;
	}

	get lastCascadeOutput(): string {
		return this._lastCascadeOutput;
	}

	set lastCascadeOutput(value: string) {
		this._lastCascadeOutput = value;
	}

	consumeLastCascadeOutput(): string {
		const current = this._lastCascadeOutput;
		this._lastCascadeOutput = "";
		return current;
	}

	get complexityBaselines(): Map<string, FileComplexity> {
		return this._complexityBaselines;
	}

	get fixedThisTurn(): Set<string> {
		return this._fixedThisTurn;
	}

	get projectRulesScan(): RuleScanResult {
		return this._projectRulesScan;
	}

	set projectRulesScan(value: RuleScanResult) {
		this._projectRulesScan = value;
	}
}
