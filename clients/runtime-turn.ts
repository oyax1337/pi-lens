import * as path from "node:path";
import { resolveRunnerPath, toRunnerDisplayPath } from "./dispatch/runner-context.js";
import { getDiagnosticTracker } from "./diagnostic-tracker.js";
import { formatSessionSummary } from "./session-summary.js";
import type { CacheManager } from "./cache-manager.js";
import type { DependencyChecker } from "./dependency-checker.js";
import type { JscpdClient } from "./jscpd-client.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";

interface TurnEndDeps {
	ctxCwd?: string;
	getFlag: (name: string) => boolean | string | undefined;
	dbg: (msg: string) => void;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	jscpdClient: JscpdClient;
	depChecker: DependencyChecker;
	resetLSPService: () => void;
	resetFormatService: () => void;
}

export async function handleTurnEnd(deps: TurnEndDeps): Promise<void> {
	const {
		ctxCwd,
		getFlag,
		dbg,
		runtime,
		cacheManager,
		jscpdClient,
		depChecker,
		resetLSPService,
		resetFormatService,
	} = deps;

	const cwd = ctxCwd ?? process.cwd();
	const turnState = cacheManager.readTurnState(cwd);
	const files = Object.keys(turnState.files);

	if (files.length === 0) {
		if (getFlag("lens-lsp")) {
			resetLSPService();
		}
		resetFormatService();
		return;
	}

	dbg(
		`turn_end: ${files.length} file(s) modified, cycles: ${turnState.turnCycles}/${turnState.maxCycles}`,
	);

	if (cacheManager.isMaxCyclesExceeded(cwd)) {
		dbg("turn_end: max cycles exceeded, clearing state and forcing through");
		cacheManager.clearTurnState(cwd);
		runtime.fixedThisTurn.clear();
		resetFormatService();
		return;
	}

	const parts: string[] = [];

	if (runtime.lastCascadeOutput) {
		parts.push(runtime.consumeLastCascadeOutput());
	}

	if (jscpdClient.isAvailable()) {
		const jscpdFiles = cacheManager.getFilesForJscpd(cwd);
		if (jscpdFiles.length > 0) {
			dbg(`turn_end: jscpd scanning ${jscpdFiles.length} file(s)`);
			const result = jscpdClient.scan(cwd);
			const jscpdFileSet = new Set(
				jscpdFiles.map((f) => resolveRunnerPath(cwd, f)),
			);
			const filtered = result.clones.filter((clone) => {
				const resolvedA = resolveRunnerPath(cwd, clone.fileA);
				if (!jscpdFileSet.has(resolvedA)) return false;
				const state = cacheManager.getTurnFileState(resolvedA, cwd);
				if (!state) return false;
				return cacheManager.isLineInModifiedRange(
					clone.startA,
					state.modifiedRanges,
				);
			});
			if (filtered.length > 0) {
				let report = `🔴 New duplicates in modified code:\n`;
				for (const clone of filtered.slice(0, 5)) {
					const displayA = toRunnerDisplayPath(cwd, clone.fileA);
					const displayB = toRunnerDisplayPath(cwd, clone.fileB);
					report += `  ${displayA}:${clone.startA} ↔ ${displayB}:${clone.startB} (${clone.lines} lines)\n`;
				}
				parts.push(report);
			}
			cacheManager.writeCache("jscpd", result, cwd);
		}
	}

	if (await depChecker.ensureAvailable()) {
		const madgeFiles = cacheManager.getFilesForMadge(cwd);
		if (madgeFiles.length > 0) {
			dbg(
				`turn_end: madge checking ${madgeFiles.length} file(s) for circular deps`,
			);
			for (const file of madgeFiles) {
				const absPath = path.resolve(cwd, file);
				const depResult = depChecker.checkFile(absPath);
				if (depResult.hasCircular && depResult.circular.length > 0) {
					const circularDeps = depResult.circular
						.flatMap((d) => d.path)
						.filter((p: string) => !absPath.endsWith(path.basename(p)));
					const uniqueDeps = [...new Set(circularDeps)];
					if (uniqueDeps.length > 0) {
						parts.push(
							`🟡 Circular dependency in ${file}: imports ${uniqueDeps.join(", ")}`,
						);
					}
				}
			}
		}
	}

	if (runtime.errorDebtBaseline && files.length > 0) {
		dbg("turn_end: marking error debt check for next session");
		cacheManager.writeCache(
			"errorDebt",
			{
				pendingCheck: true,
				baselineTestsPassed: runtime.errorDebtBaseline.testsPassed,
			},
			cwd,
		);
	}

	const tracker = getDiagnosticTracker();
	const stats = tracker.getStats();
	if (stats.totalShown > 0) {
		const summary = formatSessionSummary(stats);
		if (summary) {
			parts.push(summary);
			dbg(
				`turn_end: diagnostic summary added (${stats.totalShown} shown, ${stats.totalAutoFixed} auto-fixed, ${stats.totalAgentFixed} agent-fixed)`,
			);
		}
	}

	cacheManager.incrementTurnCycle(cwd);

	if (parts.length > 0) {
		dbg(`turn_end: ${parts.length} issue(s) found, persisting for next context`);
		cacheManager.writeCache("turn-end-findings", { content: parts.join("\n\n") }, cwd);
	} else {
		cacheManager.clearTurnState(cwd);
	}

	runtime.fixedThisTurn.clear();
	resetFormatService();
}
