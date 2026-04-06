/**
 * Declarative Tool Dispatcher for pi-lens
 *
 * Redesigned to handle the full complexity of pi-lens's tool_result handler:
 * - Multiple tools with different semantics (blocking, warning, silent)
 * - Delta mode (baseline tracking)
 * - Autofix handling
 * - Output aggregation and formatting
 *
 * Key abstractions:
 * - RunnerDefinition: A tool that can be run
 * - Diagnostic: Structured issue representation
 * - OutputSemantic: How to display (blocking, warning, silent, etc.)
 * - BaselineStore: Track pre-existing issues for delta mode
 */

import type { FileKind } from "../file-kinds.js";
import { detectFileKind } from "../file-kinds.js";
import { isTestFile } from "../file-utils.js";
import { logLatency } from "../latency-logger.js";
import { normalizeMapKey } from "../path-utils.js";
import { safeSpawn } from "../safe-spawn.js";
import type {
	BaselineStore,
	Diagnostic,
	DispatchContext,
	DispatchResult,
	OutputSemantic,
	PiAgentAPI,
	RunnerDefinition,
	RunnerGroup,
	RunnerResult,
} from "./types.js";
import { formatDiagnostics } from "./utils/format-utils.js";

// --- In-Memory Baseline Store ---
// DEBUG TEST EDIT - Testing dispatch logging

export function createBaselineStore(): BaselineStore {
	const baselines = new Map<string, unknown[]>();

	return {
		get(filePath) {
			return baselines.get(normalizeMapKey(filePath));
		},
		set(filePath, diagnostics) {
			baselines.set(normalizeMapKey(filePath), diagnostics);
		},
		clear() {
			baselines.clear();
		},
	};
}

// --- Runner Registry ---

const globalRegistry = new Map<string, RunnerDefinition>();

export function registerRunner(runner: RunnerDefinition): void {
	if (globalRegistry.has(runner.id)) return; // Already registered, skip silently
	globalRegistry.set(runner.id, runner);
}

export function getRunner(id: string): RunnerDefinition | undefined {
	return globalRegistry.get(id);
}

export function getRunnersForKind(
	kind: FileKind | undefined,
	filePath?: string,
): RunnerDefinition[] {
	if (!kind) return [];
	const runners: RunnerDefinition[] = [];
	const isTest = filePath ? isTestFile(filePath) : false;

	for (const runner of globalRegistry.values()) {
		// Skip runners that shouldn't run on test files
		if (isTest && runner.skipTestFiles) continue;

		if (runner.appliesTo.includes(kind) || runner.appliesTo.length === 0) {
			runners.push(runner);
		}
	}
	return runners.sort((a, b) => a.priority - b.priority);
}

export function listRunners(): RunnerDefinition[] {
	return Array.from(globalRegistry.values());
}

/**
 * Clear all registered runners. Used primarily for testing.
 */
export function clearRunnerRegistry(): void {
	globalRegistry.clear();
}

// --- Tool Availability Cache ---

const toolCache = new Map<string, boolean>();

function checkToolAvailability(command: string): boolean {
	if (toolCache.has(command)) {
		return toolCache.get(command)!;
	}
	try {
		const result = safeSpawn(command, ["--version"], {
			timeout: 5000,
		});
		const available = result.status === 0;
		toolCache.set(command, available);
		return available;
	} catch {
		toolCache.set(command, false);
		return false;
	}
}

// --- Dispatch Context Factory ---

export function createDispatchContext(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	baselines?: BaselineStore,
	blockingOnly?: boolean,
): DispatchContext {
	// Normalize path for consistent Map key usage on Windows
	const normalizedFilePath = normalizeMapKey(filePath);
	const kind = detectFileKind(normalizedFilePath);

	return {
		filePath: normalizedFilePath,
		cwd,
		kind,
		pi,
		autofix: !!(pi.getFlag("autofix-biome") || pi.getFlag("autofix-ruff")),
		deltaMode: !pi.getFlag("no-delta"),
		baselines: baselines ?? createBaselineStore(),
		blockingOnly,

		async hasTool(command: string): Promise<boolean> {
			return checkToolAvailability(command);
		},

		log(message: string): void {
			console.error(`[dispatch] ${message}`);
		},
	};
}

// --- Delta Mode Logic ---

/**
 * Filter diagnostics to only show NEW issues (delta mode)
 */
function filterDelta<T extends { id: string }>(
	after: T[],
	before: T[] | undefined,
	keyFn: (d: T) => string,
): { new: T[]; fixed: T[] } {
	const beforeSet = new Set((before ?? []).map(keyFn));
	const afterSet = new Set(after.map(keyFn));

	const fixed = (before ?? []).filter((d) => !afterSet.has(keyFn(d)));
	const newItems = after.filter((d) => !beforeSet.has(keyFn(d)));

	return { new: newItems, fixed };
}

// --- Latency Logger ---

export interface RunnerLatency {
	runnerId: string;
	startTime: number;
	endTime: number;
	durationMs: number;
	status: "succeeded" | "failed" | "skipped" | "when_skipped";
	diagnosticCount: number;
	semantic: string;
}

export interface DispatchLatencyReport {
	filePath: string;
	fileKind: string | undefined;
	overallStartMs: number;
	overallEndMs: number;
	totalDurationMs: number;
	runners: RunnerLatency[];
	stoppedEarly: boolean;
	totalDiagnostics: number;
	blockers: number;
	warnings: number;
}

const latencyReports: DispatchLatencyReport[] = [];

export function getLatencyReports(): DispatchLatencyReport[] {
	return [...latencyReports];
}

export function clearLatencyReports(): void {
	latencyReports.length = 0;
}

export function formatLatencyReport(report: DispatchLatencyReport): string {
	const lines: string[] = [];
	lines.push(
		`\n═══════════════════════════════════════════════════════════════`,
	);
	lines.push(`📊 DISPATCH LATENCY REPORT: ${report.filePath.split("/").pop()}`);
	lines.push(
		`   Kind: ${report.fileKind || "unknown"} | Total: ${report.totalDurationMs}ms`,
	);
	lines.push(`───────────────────────────────────────────────────────────────`);
	lines.push(
		`Runner                          Duration  Status    Issues  Semantic`,
	);
	lines.push(`───────────────────────────────────────────────────────────────`);

	for (const r of report.runners) {
		const name = r.runnerId.padEnd(30);
		const dur = `${r.durationMs}ms`.padStart(8);
		const status = r.status.padStart(9);
		const issues = String(r.diagnosticCount).padStart(6);
		const sem = r.semantic.padStart(8);
		const slowMarker =
			r.durationMs > 500 ? " 🔥" : r.durationMs > 100 ? " ⚡" : "";
		lines.push(`${name}${dur}${status}${issues}${sem}${slowMarker}`);
	}

	lines.push(`───────────────────────────────────────────────────────────────`);
	lines.push(
		`Total: ${report.runners.length} runners | Stopped early: ${report.stoppedEarly}`,
	);
	lines.push(
		`Diagnostics: ${report.totalDiagnostics} (${report.blockers} blockers, ${report.warnings} warnings)`,
	);

	// Show top 3 slowest
	const sorted = [...report.runners].sort(
		(a, b) => b.durationMs - a.durationMs,
	);
	if (sorted.length > 0 && sorted[0].durationMs > 100) {
		lines.push(`\n🐌 Slowest runners:`);
		for (const r of sorted.slice(0, 3)) {
			if (r.durationMs > 50) {
				lines.push(`   ${r.runnerId}: ${r.durationMs}ms (${r.status})`);
			}
		}
	}

	lines.push(`═══════════════════════════════════════════════════════════════`);
	return lines.join("\n");
}

// --- Group runner (used by dispatchForFile for parallel execution) ---

interface GroupResult {
	diagnostics: Diagnostic[];
	latencies: RunnerLatency[];
	hadBlocker: boolean;
}

/**
 * Execute all runners in a single group.
 *
 * - mode "fallback": run runners sequentially and stop at the first
 *   one that succeeds (returns status !== "skipped").
 * - mode "all" (default): run all runners in the group sequentially
 *   and collect every diagnostic.
 *
 * Groups themselves are run in parallel by dispatchForFile, so this
 * function must NOT mutate shared state.
 */
async function runGroup(
	ctx: DispatchContext,
	group: RunnerGroup,
): Promise<GroupResult> {
	const diagnostics: Diagnostic[] = [];
	const latencies: RunnerLatency[] = [];
	let hadBlocker = false;

	// Filter runners by kind if specified
	const runnerIds = group.filterKinds
		? group.runnerIds.filter((id) => {
				const runner = getRunner(id);
				return runner && ctx.kind && group.filterKinds?.includes(ctx.kind);
			})
		: group.runnerIds;

	const semantic = group.semantic ?? "warning";

	for (const runnerId of runnerIds) {
		const runnerStart = Date.now();
		const runner = getRunner(runnerId);

		if (!runner) {
			latencies.push({
				runnerId,
				startTime: runnerStart,
				endTime: Date.now(),
				durationMs: 0,
				status: "skipped",
				diagnosticCount: 0,
				semantic: "unknown",
			});
			logLatency({
				type: "runner",
				filePath: ctx.filePath,
				runnerId,
				durationMs: 0,
				status: "not_registered",
				diagnosticCount: 0,
				semantic: "unknown",
			});
			continue;
		}

		// Check preconditions
		if (runner.when && !(await runner.when(ctx))) {
			latencies.push({
				runnerId,
				startTime: runnerStart,
				endTime: Date.now(),
				durationMs: Date.now() - runnerStart,
				status: "when_skipped",
				diagnosticCount: 0,
				semantic: runner.id,
			});
			logLatency({
				type: "runner",
				filePath: ctx.filePath,
				runnerId,
				durationMs: 0,
				status: "when_skipped",
				diagnosticCount: 0,
				semantic: "when_condition",
			});
			continue;
		}

		const result = await runRunner(ctx, runner, semantic);
		const runnerEnd = Date.now();
		const duration = runnerEnd - runnerStart;

		latencies.push({
			runnerId,
			startTime: runnerStart,
			endTime: runnerEnd,
			durationMs: duration,
			status: result.status,
			diagnosticCount: result.diagnostics.length,
			semantic: result.semantic ?? semantic,
		});
		logLatency({
			type: "runner",
			filePath: ctx.filePath,
			runnerId,
			startedAt: new Date(runnerStart).toISOString(),
			durationMs: duration,
			status: result.status,
			diagnosticCount: result.diagnostics.length,
			semantic: result.semantic ?? semantic,
		});

		diagnostics.push(...result.diagnostics);

		const resultSemantic = result.semantic ?? semantic;
		if (
			(resultSemantic === "blocking" && result.diagnostics.length > 0) ||
			result.diagnostics.some((d) => d.semantic === "blocking")
		) {
			hadBlocker = true;
		}

		// mode:"fallback" — stop at first runner that produced results
		if (group.mode === "fallback" && result.status !== "skipped") {
			break;
		}
	}

	return { diagnostics, latencies, hadBlocker };
}

// --- Main Dispatch Function ---

export async function dispatchForFile(
	ctx: DispatchContext,
	groups: RunnerGroup[],
): Promise<DispatchResult> {
	const _overallStart = Date.now();
	const allDiagnostics: Diagnostic[] = [];
	const _fixed: Diagnostic[] = [];
	let stopped = false;
	const runnerLatencies: RunnerLatency[] = [];

	// Debug logging goes to latency log only (not console - avoid noise)
	const allRunnerIds = groups.flatMap((g) => g.runnerIds);
	logLatency({
		type: "phase",
		filePath: ctx.filePath,
		phase: "dispatch_start",
		durationMs: 0,
		metadata: {
			groupCount: groups.length,
			kind: ctx.kind,
			runners: allRunnerIds.join(","),
		},
	});

	// Run all groups in parallel — they are independent and don't depend on
	// each other's results. Within each group, mode:"fallback" semantics are
	// preserved (sequential first-success). Results are merged in original
	// group order so output is deterministic.
	const groupResults = await Promise.all(
		groups.map((group) => runGroup(ctx, group)),
	);

	// Count baseline warnings before filtering (for delta count display)
	const baselineWarnings = ctx.deltaMode
		? (ctx.baselines.get(ctx.filePath) as Diagnostic[] | undefined)?.filter(
				(d) => d.semantic === "warning" || d.semantic === "none",
			)
		: [];
	const baselineWarningCount = baselineWarnings?.length ?? 0;

	for (const {
		diagnostics: groupDiags,
		latencies,
		hadBlocker,
	} of groupResults) {
		runnerLatencies.push(...latencies);

		// Apply delta mode filtering across the accumulated set
		// Both blockers and warnings are delta-filtered so the warning count
		// reflects only NEW issues, not the cumulative baseline.
		let diagnostics = groupDiags;
		if (ctx.deltaMode) {
			const before = ctx.baselines.get(ctx.filePath);
			if (before) {
				const filtered = filterDelta(
					diagnostics,
					before as Diagnostic[],
					(d) => d.id,
				);
				diagnostics = filtered.new;
			}
			// allDiagnostics already contains this group's diagnostics — don't double-count
			ctx.baselines.set(ctx.filePath, [...allDiagnostics]);
		}

		allDiagnostics.push(...diagnostics);
		if (hadBlocker) stopped = true;
	}

	// Categorize results
	const blockers = allDiagnostics.filter((d) => d.semantic === "blocking");
	const warnings = allDiagnostics.filter(
		(d) => d.semantic === "warning" || d.semantic === "none",
	);
	const fixedItems = allDiagnostics.filter((d) => d.semantic === "fixed");

	// Format output — only blocking issues shown inline
	// Warnings tracked but not shown (noise) — surfaced via /lens-booboo
	let output = formatDiagnostics(blockers, "blocking");
	output += formatDiagnostics(fixedItems, "fixed");

	// Generate and store latency report
	const overallEnd = Date.now();
	const latencyReport: DispatchLatencyReport = {
		filePath: ctx.filePath,
		fileKind: ctx.kind,
		overallStartMs: _overallStart,
		overallEndMs: overallEnd,
		totalDurationMs: overallEnd - _overallStart,
		runners: runnerLatencies,
		stoppedEarly: stopped,
		totalDiagnostics: allDiagnostics.length,
		blockers: blockers.length,
		warnings: warnings.length,
	};

	// Store for later analysis
	latencyReports.push(latencyReport);

	// Keep only last 100 reports to prevent memory bloat
	if (latencyReports.length > 100) {
		latencyReports.shift();
	}

	// Runner latencies already logged immediately after execution (line ~329)
	// The runnerLatencies array is stored in latencyReport for aggregate analysis
	// No need to log again here - would create duplicates in the log

	// Log summary to latency log only (not console - avoid noise)
	const sumMs = runnerLatencies.reduce((s, r) => s + r.durationMs, 0);
	const wallClockMs = latencyReport.totalDurationMs;
	logLatency({
		type: "tool_result",
		filePath: ctx.filePath,
		durationMs: wallClockMs,
		wallClockMs,
		sumMs,
		parallelGainMs: Math.max(0, sumMs - wallClockMs),
		result: "dispatch_complete",
		metadata: {
			runners: runnerLatencies.map((r) => ({
				id: r.runnerId,
				startedAt: new Date(r.startTime).toISOString(),
				duration: r.durationMs,
				status: r.status,
			})),
			totalDiagnostics: allDiagnostics.length,
			blockers: blockers.length,
		},
	});

	return {
		diagnostics: allDiagnostics,
		blockers,
		warnings,
		baselineWarningCount,
		fixed: fixedItems,
		output,
		hasBlockers: blockers.length > 0,
	};
}

// --- Run Single Runner ---

async function runRunner(
	ctx: DispatchContext,
	runner: RunnerDefinition,
	defaultSemantic: OutputSemantic,
): Promise<RunnerResult> {
	try {
		const result = await runner.run(ctx);
		return {
			...result,
			semantic: result.semantic ?? defaultSemantic,
		};
	} catch (error) {
		ctx.log(`Runner ${runner.id} failed: ${error}`);
		return {
			status: "failed",
			diagnostics: [],
			semantic: defaultSemantic,
		};
	}
}

// --- Simple Integration Helper ---

export async function dispatchLint(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	baselines?: BaselineStore,
): Promise<string> {
	// By default, only run BLOCKING rules for fast feedback on file write
	const ctx = createDispatchContext(filePath, cwd, pi, baselines, true);

	// Get runners for this file kind
	const runners = getRunnersForKind(ctx.kind);
	if (runners.length === 0) {
		return "";
	}

	// Create groups from registered runners (all in fallback mode)
	const groups: RunnerGroup[] = [
		{
			mode: "fallback",
			runnerIds: runners.map((r) => r.id),
		},
	];

	const result = await dispatchForFile(ctx, groups);
	return result.output;
}
