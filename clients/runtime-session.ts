import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { ArchitectClient } from "./architect-client.js";
import type { AstGrepClient } from "./ast-grep-client.js";
import type { BiomeClient } from "./biome-client.js";
import type { CacheManager } from "./cache-manager.js";
import type { DependencyChecker } from "./dependency-checker.js";
import { getDiagnosticTracker } from "./diagnostic-tracker.js";
import type { GoClient } from "./go-client.js";
import type { JscpdClient } from "./jscpd-client.js";
import type { KnipClient } from "./knip-client.js";
import type { MetricsClient } from "./metrics-client.js";
import {
	buildProjectIndex,
	isIndexFresh,
	loadIndex,
	saveIndex,
} from "./project-index.js";
import { scanProjectRules } from "./rules-scanner.js";
import type { RuffClient } from "./ruff-client.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import type { RustClient } from "./rust-client.js";
import { getKnipIgnorePatterns } from "./file-utils.js";
import { getSourceFiles } from "./scan-utils.js";
import { resolveStartupScanContext } from "./startup-scan.js";
import type { TestRunnerClient } from "./test-runner-client.js";
import type { TodoScanner } from "./todo-scanner.js";
import type { TypeCoverageClient } from "./type-coverage-client.js";

interface SessionStartDeps {
	ctxCwd?: string;
	getFlag: (name: string) => boolean | string | undefined;
	notify: (msg: string, level: "info" | "warning" | "error") => void;
	dbg: (msg: string) => void;
	log: (msg: string) => void;
	runtime: RuntimeCoordinator;
	metricsClient: MetricsClient;
	cacheManager: CacheManager;
	todoScanner: TodoScanner;
	astGrepClient: AstGrepClient;
	biomeClient: BiomeClient;
	ruffClient: RuffClient;
	knipClient: KnipClient;
	jscpdClient: JscpdClient;
	typeCoverageClient: TypeCoverageClient;
	depChecker: DependencyChecker;
	architectClient: ArchitectClient;
	testRunnerClient: TestRunnerClient;
	goClient: GoClient;
	rustClient: RustClient;
	ensureTool: (name: string) => Promise<string | null | undefined>;
	cleanStaleTsBuildInfo: (cwd: string) => string[];
	resetDispatchBaselines: () => void;
	resetLSPService: () => void;
}

export async function handleSessionStart(deps: SessionStartDeps): Promise<void> {
	const {
		ctxCwd,
		getFlag,
		notify,
		dbg,
		log,
		runtime,
		metricsClient,
		cacheManager,
		todoScanner,
		astGrepClient,
		biomeClient,
		ruffClient,
		knipClient,
		jscpdClient,
		typeCoverageClient,
		depChecker,
		architectClient,
		testRunnerClient,
		goClient,
		rustClient,
		ensureTool,
		cleanStaleTsBuildInfo,
		resetDispatchBaselines,
		resetLSPService,
	} = deps;

	metricsClient.reset();
	getDiagnosticTracker().reset();
	runtime.complexityBaselines.clear();
	resetDispatchBaselines();
	runtime.resetForSession();

	if (getFlag("lens-lsp")) {
		resetLSPService();
		dbg("session_start: LSP service reset");
	}

	const tools: string[] = [];
	tools.push("TypeScript LSP");
	if (biomeClient.isAvailable()) tools.push("Biome");
	if (astGrepClient.isAvailable()) tools.push("ast-grep");
	if (ruffClient.isAvailable()) tools.push("Ruff");
	if (knipClient.isAvailable()) tools.push("Knip");
	if (depChecker.isAvailable()) tools.push("Madge");
	if (jscpdClient.isAvailable()) tools.push("jscpd");
	if (typeCoverageClient.isAvailable()) tools.push("type-coverage");

	log(`Active tools: ${tools.join(", ")}`);
	dbg(`session_start tools: ${tools.join(", ")}`);

	if (getFlag("lens-lsp")) {
		const cleaned = cleanStaleTsBuildInfo(ctxCwd ?? process.cwd());
		if (cleaned.length > 0) {
			notify(
				`🧹 Deleted stale TypeScript build cache (${cleaned.map((f) => path.basename(f)).join(", ")}) — phantom errors suppressed.`,
				"info",
			);
			dbg(`session_start: cleaned stale tsbuildinfo: ${cleaned.join(", ")}`);
		}
	}

	if (getFlag("lens-lsp")) {
		dbg("session_start: pre-installing TypeScript LSP...");
		ensureTool("typescript-language-server")
			.then((toolPath) => {
				if (toolPath) {
					dbg(`session_start: TypeScript LSP ready at ${toolPath}`);
				} else {
					console.error("[lens] TypeScript LSP installation failed");
				}
			})
			.catch((err) => {
				console.error("[lens] TypeScript LSP pre-install error:", err);
			});
	}

	const cwd = ctxCwd ?? process.cwd();
	const startupScan = resolveStartupScanContext(cwd);
	const scanRoot = startupScan.projectRoot ?? cwd;
	const analysisRoot = scanRoot;
	runtime.projectRoot = scanRoot;
	dbg(`session_start cwd: ${cwd}`);
	dbg(
		`session_start scan root: ${scanRoot} (warmCaches=${startupScan.canWarmCaches}${startupScan.reason ? `, reason=${startupScan.reason}` : ""})`,
	);
	if (analysisRoot !== cwd) {
		dbg(`session_start: monorepo analysis root override -> ${analysisRoot}`);
	}

	{
		const pkgPath = path.join(analysisRoot, "package.json");
		try {
			const raw = await nodeFs.promises.readFile(pkgPath, "utf-8");
			const pkg = JSON.parse(raw) as {
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
				prettier?: unknown;
			};
			const usesPrettier =
				!!pkg.devDependencies?.prettier ||
				!!pkg.dependencies?.prettier ||
				pkg.prettier !== undefined;
			if (usesPrettier) {
				dbg("session_start: project uses prettier, ensuring install...");
				ensureTool("prettier")
					.then((p) => {
						if (p) dbg(`session_start: prettier ready at ${p}`);
						else dbg("session_start: prettier install failed silently");
					})
					.catch((err) =>
						dbg(`session_start: prettier install error: ${err}`),
					);
			}
		} catch {
			// no package.json at cwd root
		}
	}

	const hasArchitectRules = architectClient.loadConfig(analysisRoot);
	if (hasArchitectRules) tools.push("Architect rules");

	const detectedRunner = testRunnerClient.detectRunner(analysisRoot);
	if (detectedRunner) {
		tools.push(`Test runner (${detectedRunner.runner})`);
	}
	if (goClient.isGoAvailable()) tools.push("Go (go vet)");
	if (rustClient.isAvailable()) tools.push("Rust (cargo)");
	log(`Active tools: ${tools.join(", ")}`);
	dbg(`session_start tools: ${tools.join(", ")}`);

	const condensedGuidance =
		"## Code Tool Selection\n- Navigation (definitions, references): lsp_navigation\n- Pattern search (functions, imports): ast_grep_search\n- Text/TODOs: grep\n- Full guides: skills/ast-grep, skills/lsp-navigation";

	const parts: string[] = [];
	parts.push(
		"📌 Remember: If you find ANY errors (test failures, compile errors, lint issues) in this codebase, fix them — even if you didn't cause them. Don't skip errors as 'not my fault'.",
	);
	parts.push(condensedGuidance);

	runtime.projectRulesScan = scanProjectRules(analysisRoot);
	if (runtime.projectRulesScan.hasCustomRules) {
		const ruleCount = runtime.projectRulesScan.rules.length;
		const sources = [...new Set(runtime.projectRulesScan.rules.map((r) => r.source))];
		dbg(
			`session_start: found ${ruleCount} project rule(s) from ${sources.join(", ")}`,
		);
		parts.push(
			`📋 Project rules found: ${ruleCount} file(s) in ${sources.join(", ")}. These apply alongside pi-lens defaults.`,
		);
	} else {
		dbg("session_start: no project rules found");
	}

	const todoResult = todoScanner.scanDirectory(analysisRoot);
	dbg(
		`session_start TODO scan: ${todoResult.items.length} items (baseline stored)`,
	);
	cacheManager.writeCache("todo-baseline", { items: todoResult.items }, analysisRoot);

	if (!startupScan.canWarmCaches) {
		dbg(`session_start: skipping heavy scans (${startupScan.reason ?? "unknown"})`);
	} else {
		if (await knipClient.ensureAvailable()) {
			const cached = cacheManager.readCache<ReturnType<KnipClient["analyze"]>>(
				"knip",
				analysisRoot,
			);
			if (cached) {
				dbg(
					`session_start Knip: cache hit (${Math.round((Date.now() - new Date(cached.meta.timestamp).getTime()) / 1000)}s ago)`,
				);
			} else {
				const startMs = Date.now();
				const knipResult = knipClient.analyze(
					analysisRoot,
					getKnipIgnorePatterns(),
				);
				cacheManager.writeCache("knip", knipResult, analysisRoot, {
					scanDurationMs: Date.now() - startMs,
				});
				dbg("session_start Knip scan done");
			}
		} else {
			dbg("session_start Knip: not available");
		}

		if (await jscpdClient.ensureAvailable()) {
			const cached = cacheManager.readCache<ReturnType<JscpdClient["scan"]>>(
				"jscpd",
				analysisRoot,
			);
			if (cached) {
				dbg("session_start jscpd: cache hit");
			} else {
				const startMs = Date.now();
				const jscpdResult = jscpdClient.scan(analysisRoot);
				cacheManager.writeCache("jscpd", jscpdResult, analysisRoot, {
					scanDurationMs: Date.now() - startMs,
				});
				dbg("session_start jscpd scan done");
			}
		} else {
			dbg("session_start jscpd: not available");
		}

		if (await astGrepClient.ensureAvailable()) {
			const exports = await astGrepClient.scanExports(analysisRoot, "typescript");
			dbg(`session_start exports scan: ${exports.size} functions found`);
			for (const [name, file] of exports) {
				runtime.cachedExports.set(name, file);
			}
		}

		try {
			const existing = await loadIndex(analysisRoot);
			if (
				existing &&
				existing.entries.size > 0 &&
				(await isIndexFresh(analysisRoot))
			) {
				runtime.cachedProjectIndex = existing;
				dbg(
					`session_start: loaded fresh project index (${existing.entries.size} entries)`,
				);
			} else {
				const sourceFiles = getSourceFiles(analysisRoot, true);
				const tsFiles = sourceFiles.filter(
					(f) => f.endsWith(".ts") || f.endsWith(".tsx"),
				);
				if (tsFiles.length > 0 && tsFiles.length <= 500) {
					runtime.cachedProjectIndex = await buildProjectIndex(
						analysisRoot,
						tsFiles,
					);
					await saveIndex(runtime.cachedProjectIndex, analysisRoot);
					dbg(
						`session_start: built project index (${runtime.cachedProjectIndex.entries.size} entries from ${tsFiles.length} files)`,
					);
				} else {
					dbg(`session_start: skipped project index (${tsFiles.length} files)`);
				}
			}
		} catch (err) {
			dbg(`session_start: project index build failed: ${err}`);
		}
	}

	dbg(`session_start: scans complete (${parts.length} part(s)), cached for commands`);

	const errorDebtEnabled = getFlag("error-debt");
	const pendingDebt = cacheManager.readCache<{
		pendingCheck: boolean;
		baselineTestsPassed: boolean;
	}>("errorDebt", analysisRoot);

	if (errorDebtEnabled && detectedRunner && pendingDebt?.data?.pendingCheck) {
		dbg("session_start: running pending error debt check");
		const testResult = testRunnerClient.runTestFile(
			".",
			analysisRoot,
			detectedRunner.runner,
			detectedRunner.config,
		);
		const testsPassed = testResult.failed === 0 && !testResult.error;
		const baselinePassed = pendingDebt.data.baselineTestsPassed;

		if (baselinePassed && !testsPassed) {
			const msg = `🔴 ERROR DEBT: Tests were passing but now failing (${testResult.failed} failure(s)). Fix before continuing.`;
			dbg(`session_start ERROR DEBT: ${msg}`);
			parts.push(msg);
		}

		runtime.errorDebtBaseline = {
			testsPassed,
			buildPassed: true,
		};
		cacheManager.writeCache(
			"errorDebt",
			{
				pendingCheck: false,
				baselineTestsPassed: testsPassed,
			},
			analysisRoot,
		);
	} else if (errorDebtEnabled && detectedRunner) {
		dbg("session_start: establishing fresh error debt baseline");
		const testResult = testRunnerClient.runTestFile(
			".",
			analysisRoot,
			detectedRunner.runner,
			detectedRunner.config,
		);
		const testsPassed = testResult.failed === 0 && !testResult.error;
		runtime.errorDebtBaseline = {
			testsPassed,
			buildPassed: true,
		};
		dbg(
			`session_start error debt baseline: testsPassed=${runtime.errorDebtBaseline.testsPassed}`,
		);
	}

	if (parts.length > 0) {
		for (const part of parts) {
			notify(part, "info");
		}
	}
}
