import * as childProcess from "node:child_process";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { ArchitectClient } from "../clients/architect-client.js";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import type { ComplexityClient } from "../clients/complexity-client.js";
import type { DependencyChecker } from "../clients/dependency-checker.js";
import type { JscpdClient } from "../clients/jscpd-client.js";
import type { KnipClient } from "../clients/knip-client.js";
import { EXCLUDED_DIRS, isTestFile } from "../clients/file-utils.js";
import {
	buildProjectIndex,
	type ProjectIndex,
} from "../clients/project-index.js";
import { getSourceFiles } from "../clients/scan-utils.js";
import { calculateSimilarity } from "../clients/state-matrix.js";
import type { TodoScanner } from "../clients/todo-scanner.js";
import type { TypeCoverageClient } from "../clients/type-coverage-client.js";

const getExtensionDir = () => {
	if (typeof __dirname !== "undefined") {
		return __dirname;
	}
	return ".";
};

export async function handleBooboo(
	args: string,
	ctx: ExtensionContext,
	clients: {
		astGrep: AstGrepClient;
		complexity: ComplexityClient;
		todo: TodoScanner;
		knip: KnipClient;
		jscpd: JscpdClient;
		typeCoverage: TypeCoverageClient;
		depChecker: DependencyChecker;
		architect: ArchitectClient;
	},
	pi: ExtensionAPI,
) {
	const targetPath = args.trim() || ctx.cwd || process.cwd();
	ctx.ui.notify("🔍 Running full codebase review...", "info");

	// Load false positives from fix session to filter them out
	const sessionFile = path.join(process.cwd(), ".pi-lens", "fix-session.json");
	let falsePositives: string[] = [];
	try {
		const sessionData = JSON.parse(
			nodeFs.readFileSync(sessionFile, "utf-8") || "{}"
		);
		falsePositives = sessionData.falsePositives || [];
	} catch {
		// No session file yet
	}

	// Helper to check if an issue is marked as false positive
	const isFalsePositive = (category: string, file: string, line?: number): boolean => {
		const fpKey = line !== undefined 
			? `${category}:${file}:${line}`
			: `${category}:${file}`;
		return falsePositives.some((fp) => fp === fpKey || fp.startsWith(`${category}:${file}`));
	};

	// Summary counts for terminal display
	const summaryItems: {
		category: string;
		count: number;
		severity: "🔴" | "🟡" | "🟢" | "ℹ️";
		fixable: boolean; // true = can be fixed via /lens-booboo-fix
	}[] = [];
	const fullReport: string[] = [];
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const reviewDir = path.join(process.cwd(), ".pi-lens", "reviews");

	// Part 1: Design smells via ast-grep
	if (clients.astGrep.isAvailable()) {
		const configPath = path.join(
			getExtensionDir(),
			"..",
			"rules",
			"ast-grep-rules",
			".sgconfig.yml",
		);

		try {
			const result = childProcess.spawnSync(
				"npx",
				[
					"sg",
					"scan",
					"--config",
					configPath,
					"--json",
					"--globs",
					"!**/*.test.ts",
					"--globs",
					"!**/*.spec.ts",
					"--globs",
					"!**/*.poc.test.ts",
					"--globs",
					"!**/test-utils.ts",
					"--globs",
					"!**/test-*.ts",
					"--globs",
					"!**/__tests__/**",
					"--globs",
					"!**/tests/**",
					"--globs",
					"!**/.pi-lens/**",
					"--globs",
					"!**/.pi/**",
					"--globs",
					"!**/node_modules/**",
					"--globs",
					"!**/.git/**",
					"--globs",
					"!**/.ruff_cache/**",
					targetPath,
				],
				{
					encoding: "utf-8",
					timeout: 30000,
					shell: process.platform === "win32",
					maxBuffer: 32 * 1024 * 1024, // 32MB
				},
			);

			const output = result.stdout || result.stderr || "";
			if (output.trim() && result.status !== undefined) {
				const issues: Array<{
					file: string;
					line: number;
					rule: string;
					message: string;
				}> = [];

				const parseItems = (raw: string): Record<string, any>[] => {
					const trimmed = raw.trim();
					if (trimmed.startsWith("[")) {
						try {
							return JSON.parse(trimmed);
						} catch (err) {
							void err;
							return [];
						}
					}
					return raw.split("\n").flatMap((l: string) => {
						try {
							return [JSON.parse(l)];
						} catch (err) {
							void err;
							return [];
						}
					});
				};

				for (const item of parseItems(output)) {
					const ruleId =
						item.ruleId || item.rule?.title || item.name || "unknown";
					const ruleDesc = clients.astGrep.getRuleDescription?.(ruleId);
					const message = ruleDesc?.message || item.message || ruleId;
					const lineNum =
						item.labels?.[0]?.range?.start?.line ||
						item.spans?.[0]?.range?.start?.line ||
						item.range?.start?.line ||
						0;

					issues.push({
						file: item.file || item.path || targetPath,
						line: lineNum + 1,
						rule: ruleId,
						message: message,
					});
				}

				// Filter out false positives
				const filteredIssues = issues.filter((issue) => 
					!isFalsePositive("ast_issues", issue.file, issue.line)
				);
				
				if (filteredIssues.length > 0) {
					summaryItems.push({
						category: "ast-grep",
						count: filteredIssues.length,
						severity: filteredIssues.length > 10 ? "🔴" : "🟡",
						fixable: true,
					});

					let fullSection = `## ast-grep (Structural Issues)\n\n**${filteredIssues.length} issue(s) found**\n\n`;
					fullSection +=
						"| Line | Rule | Message |\n|------|------|--------|\n";
					for (const issue of filteredIssues) {
						fullSection += `| ${issue.line} | ${issue.rule} | ${issue.message} |\n`;
					}
					
					// Add fix guidance for rules that have it
					fullSection += "\n### 💡 How to Fix\n\n";
					const seenRules = new Set<string>();
					for (const issue of filteredIssues.slice(0, 5)) { // Show first 5 unique fixes
						if (seenRules.has(issue.rule)) continue;
						seenRules.add(issue.rule);
						const ruleDesc = clients.astGrep.getRuleDescription?.(issue.rule);
						if (ruleDesc?.note || ruleDesc?.fix) {
							fullSection += `**${issue.rule}:**\n`;
							if (ruleDesc.note) fullSection += `${ruleDesc.note}\n\n`;
							if (ruleDesc.fix) fullSection += `Suggested fix:\n\`\`\`typescript\n${ruleDesc.fix}\n\`\`\`\n\n`;
						}
					}
					
					fullReport.push(fullSection);
				}
			}
			ctx.ui.notify(`✓ Part 1: Design smells (${summaryItems.find(s => s.category === "ast-grep")?.count ?? 0} issues)`, "info");
		} catch (err) {
			// Ast-grep scan failed, skip this section
			void err;
		}
	}

	// Part 2: Similar functions
	if (clients.astGrep.isAvailable()) {
		const similarGroups = await clients.astGrep.findSimilarFunctions(
			targetPath,
			"typescript",
		);
		if (similarGroups.length > 0) {
			summaryItems.push({
				category: "Similar Functions",
				count: similarGroups.length,
				severity: "🟡",
				fixable: true,
			});

			let fullSection = `## Similar Functions\n\n**${similarGroups.length} group(s) of structurally similar functions**\n\n`;
			for (const group of similarGroups) {
				fullSection += `### Pattern: ${group.functions.map((f) => f.name).join(", ")}\n\n`;
				fullSection +=
					"| Function | File | Line |\n|----------|------|------|\n";
				for (const fn of group.functions) {
					fullSection += `| ${fn.name} | ${fn.file} | ${fn.line} |\n`;
				}
				fullSection += "\n";
			}
			fullReport.push(fullSection);
		}
		const simCount = summaryItems.find(s => s.category === "Similar Functions")?.count ?? 0;
		ctx.ui.notify(`✓ Part 2: Similar functions (${simCount} groups)`, "info");
	}

	// Part 2b: Semantic similarity (Amain 57×72 matrix)
	try {
		ctx.ui.notify("🔍 Analyzing semantic code similarity...", "info");
		const { glob } = await import("glob");
		const sourceFiles = await glob("**/*.ts", {
			cwd: targetPath,
			ignore: [
				"**/node_modules/**",
				"**/*.test.ts",
				"**/*.spec.ts",
				"**/dist/**",
			],
		});

		if (sourceFiles.length > 0) {
			const absoluteFiles = sourceFiles.map((f) => path.join(targetPath, f));
			const index = await buildProjectIndex(targetPath, absoluteFiles);

			// Find top similar pairs
			const topPairs = findTopSimilarPairs(index, 10);

			if (topPairs.length > 0) {
				summaryItems.push({
					category: "Semantic Duplicates",
					count: topPairs.length,
					severity: "🟡",
					fixable: true,
				});

				let fullSection = `## Semantic Duplicates (Amain Algorithm)\n\n`;
				fullSection += `**${topPairs.length} pair(s) with >75% semantic similarity**\n\n`;
				fullSection +=
					"Functions with different names/variables but similar logic structures.\n\n";

				for (const pair of topPairs) {
					fullSection += `### ${pair.func1} ↔ ${pair.func2}\n\n`;
					fullSection += `- Similarity: **${(pair.similarity * 100).toFixed(1)}%**\n`;
					fullSection += `- Consider consolidating or extracting shared logic\n\n`;
				}
				fullReport.push(fullSection);
			}
		}
		const semCount = summaryItems.find(s => s.category === "Semantic Duplicates")?.count ?? 0;
		ctx.ui.notify(`✓ Part 2b: Semantic similarity (${semCount} pairs)`, "info");
	} catch (err) {
		// Skip if similarity analysis fails
		console.error("[booboo] Semantic similarity analysis failed:", err);
	}

	// Part 3: Complexity metrics
	const results: import("../clients/complexity-client.js").FileComplexity[] =
		[];
	const aiSlopIssues: string[] = [];
	const isTsProject = nodeFs.existsSync(path.join(targetPath, "tsconfig.json"));
	const files = getSourceFiles(targetPath, isTsProject);

	for (const fullPath of files) {
		if (clients.complexity.isSupportedFile(fullPath)) {
			const metrics = clients.complexity.analyzeFile(fullPath);
			if (metrics) {
				results.push(metrics);
				if (!/\.(test|spec)\.[jt]sx?$/.test(path.basename(fullPath))) {
					const warnings = clients.complexity.checkThresholds(metrics);
					if (warnings.length > 0) {
						aiSlopIssues.push(`  ${metrics.filePath}:`);
						for (const w of warnings) {
							aiSlopIssues.push(`    ⚠ ${w}`);
						}
					}
				}
			}
		}
	}

	if (results.length > 0) {
		const avgMI =
			results.reduce((a, b) => a + b.maintainabilityIndex, 0) / results.length;
		const avgCognitive =
			results.reduce((a, b) => a + b.cognitiveComplexity, 0) / results.length;
		const avgCyclomatic =
			results.reduce((a, b) => a + b.cyclomaticComplexity, 0) / results.length;
		const maxNesting = Math.max(...results.map((r) => r.maxNestingDepth));
		const maxCognitive = Math.max(...results.map((r) => r.cognitiveComplexity));
		const minMI = Math.min(...results.map((r) => r.maintainabilityIndex));

		const lowMI = results
			.filter((r) => r.maintainabilityIndex < 60 && !isTestFile(r.filePath))
			.sort((a, b) => a.maintainabilityIndex - b.maintainabilityIndex);
		const highCognitive = results
			.filter((r) => r.cognitiveComplexity > 20 && !isTestFile(r.filePath))
			.sort((a, b) => b.cognitiveComplexity - a.cognitiveComplexity);

		let _summary = `[Complexity] ${results.length} file(s) scanned\n`;
		_summary += `  Maintainability: ${avgMI.toFixed(1)} avg | Cognitive: ${avgCognitive.toFixed(1)} avg | Max Nesting: ${maxNesting} levels\n`;

		if (lowMI.length > 0) {
			_summary += `\n  Low Maintainability (MI < 60):\n`;
			for (const f of lowMI.slice(0, 5)) {
				_summary += `    ✗ ${f.filePath}: MI ${f.maintainabilityIndex.toFixed(1)}\n`;
			}
			if (lowMI.length > 5)
				_summary += `    ... and ${lowMI.length - 5} more\n`;
		}

		if (highCognitive.length > 0) {
			_summary += `\n  High Cognitive Complexity (> 20):\n`;
			for (const f of highCognitive.slice(0, 5)) {
				_summary += `    ⚠ ${f.filePath}: ${f.cognitiveComplexity}\n`;
			}
			if (highCognitive.length > 5)
				_summary += `    ... and ${highCognitive.length - 5} more\n`;
		}

		if (aiSlopIssues.length > 0) {
			_summary += `\n[AI Slop Indicators]\n${aiSlopIssues.join("\n")}`;
		}
		// Add complexity summary items
		if (lowMI.length > 0) {
			summaryItems.push({
				category: "Low MI",
				count: lowMI.length,
				severity: lowMI.some((f) => f.maintainabilityIndex < 20) ? "🔴" : "🟡",
				fixable: false,
			});
		}
		if (highCognitive.length > 0) {
			summaryItems.push({
				category: "High Complexity",
				count: highCognitive.length,
				severity: "🟡",
				fixable: true,
			});
		}
		if (aiSlopIssues.length > 0) {
			summaryItems.push({
				category: "AI Slop",
				count: (aiSlopIssues.length / 2) | 0,
				severity: "🟡",
				fixable: true,
			}); // Each issue is 2 lines
		}

		let fullSection = `## Complexity Metrics\n\n**${results.length} file(s) scanned**\n\n`;
		fullSection += `### Summary\n\n| Metric | Value |\n|--------|-------|\n| Avg Maintainability Index | ${avgMI.toFixed(1)} |\n| Min Maintainability Index | ${minMI.toFixed(1)} |\n| Avg Cognitive Complexity | ${avgCognitive.toFixed(1)} |\n| Max Cognitive Complexity | ${maxCognitive} |\n| Avg Cyclomatic Complexity | ${avgCyclomatic.toFixed(1)} |\n| Max Nesting Depth | ${maxNesting} |\n| Total Files | ${results.length} |\n\n`;

		if (lowMI.length > 0) {
			fullSection += `### Low Maintainability (MI < 60)\n\n| File | MI | Cognitive | Cyclomatic | Nesting |\n|------|-----|-----------|------------|--------|\n`;
			for (const f of lowMI) {
				fullSection += `| ${f.filePath} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} |\n`;
			}
			fullSection += "\n";
		}

		if (highCognitive.length > 0) {
			fullSection += `### High Cognitive Complexity (> 20)\n\n| File | Cognitive | MI | Cyclomatic | Nesting |\n|------|-----------|-----|------------|--------|\n`;
			for (const f of highCognitive) {
				fullSection += `| ${f.filePath} | ${f.cognitiveComplexity} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} |\n`;
			}
			fullSection += "\n";
		}

		fullSection += `### All Files\n\n| File | MI | Cognitive | Cyclomatic | Nesting | Entropy |\n|------|-----|-----------|------------|---------|--------|\n`;
		for (const f of results.sort(
			(a, b) => a.maintainabilityIndex - b.maintainabilityIndex,
		)) {
			fullSection += `| ${f.filePath} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} | ${f.codeEntropy.toFixed(2)} |\n`;
		}
		fullSection += "\n";

		if (aiSlopIssues.length > 0) {
			fullSection += `### AI Slop Indicators\n\n`;
			for (const issue of aiSlopIssues) {
				fullSection += `${issue}\n`;
			}
			fullSection += "\n";
		}
		fullReport.push(fullSection);
	}
	const complexityCount = summaryItems.find(s => s.category === "Complexity")?.count ?? 0;
	ctx.ui.notify(`✓ Part 3: Complexity metrics (${results.length} files, ${complexityCount} issues)`, "info");

	// Part 4: TODOs
	const todoResult = clients.todo.scanDirectory(targetPath);
	if (todoResult.items.length > 0) {
		summaryItems.push({
			category: "TODOs",
			count: todoResult.items.length,
			severity: "ℹ️",
			fixable: false,
		});
		let fullSection = `## TODOs / Annotations\n\n`;
		if (todoResult.items.length > 0) {
			fullSection += `**${todoResult.items.length} annotation(s) found**\n\n| Type | File | Line | Text |\n|------|------|------|------|\n`;
			for (const item of todoResult.items) {
				fullSection += `| ${item.type} | ${item.file} | ${item.line} | ${item.message} |\n`;
			}
		} else {
			fullSection += `No annotations found.\n`;
		}
		fullSection += "\n";
		fullReport.push(fullSection);
	}
	const todoCount = summaryItems.find(s => s.category === "TODOs")?.count ?? 0;
	ctx.ui.notify(`✓ Part 4: TODOs (${todoCount} items)`, "info");

	// Part 5: Dead code
	if (clients.knip.isAvailable()) {
		const knipResult = clients.knip.analyze(targetPath);
		if (knipResult.issues.length > 0) {
			summaryItems.push({
				category: "Dead Code",
				count: knipResult.issues.length,
				severity: "🟡",
				fixable: true,
			});
			let fullSection = `## Dead Code (Knip)\n\n`;
			if (knipResult.issues.length > 0) {
				fullSection += `**${knipResult.issues.length} issue(s) found**\n\n| Type | Name | File |\n|------|------|------|\n`;
				for (const issue of knipResult.issues) {
					fullSection += `| ${issue.type} | ${issue.name} | ${issue.file ?? ""} |\n`;
				}
			} else {
				fullSection += `No dead code issues found.\n`;
			}
			fullSection += "\n";
			fullReport.push(fullSection);
		}
	}
	const deadCodeCount = summaryItems.find(s => s.category === "Dead Code")?.count ?? 0;
	ctx.ui.notify(`✓ Part 5: Dead code (${deadCodeCount} issues)`, "info");

	// Part 6: Duplicate code
	if (clients.jscpd.isAvailable()) {
		const jscpdResult = clients.jscpd.scan(targetPath);
		if (jscpdResult.clones.length > 0) {
			summaryItems.push({
				category: "Duplicates",
				count: jscpdResult.clones.length,
				severity: "🟡",
				fixable: true,
			});
			let fullSection = `## Code Duplication (jscpd)\n\n`;
			if (jscpdResult.clones.length > 0) {
				fullSection += `**${jscpdResult.clones.length} duplicate block(s) found** (${jscpdResult.duplicatedLines}/${jscpdResult.totalLines} lines, ${jscpdResult.percentage.toFixed(1)}%)\n\n| File A | Line A | File B | Line B | Lines | Tokens |\n|--------|--------|--------|--------|-------|--------|\n`;
				for (const dup of jscpdResult.clones) {
					fullSection += `| ${dup.fileA} | ${dup.startA} | ${dup.fileB} | ${dup.startB} | ${dup.lines} | ${dup.tokens} |\n`;
				}
			} else {
				fullSection += `No duplicate code found.\n`;
			}
			fullSection += "\n";
			fullReport.push(fullSection);
		}
	}
	const dupeCount = summaryItems.find(s => s.category === "Duplicates")?.count ?? 0;
	ctx.ui.notify(`✓ Part 6: Duplicate code (${dupeCount} blocks)`, "info");

	// Part 7: Type coverage (report as percentage, not individual any types)
	if (clients.typeCoverage.isAvailable()) {
		const tcResult = clients.typeCoverage.scan(targetPath);
		if (tcResult.percentage < 100) {
			// Count files with <90% coverage instead of individual any types
			const filesWithLowCoverage = new Set(
				tcResult.untypedLocations
					.filter(() => tcResult.percentage < 90)
					.map(u => u.file)
			).size;
			summaryItems.push({
				category: "Type Coverage",
				count: filesWithLowCoverage || 1, // At least 1 if any issues
				severity: tcResult.percentage < 90 ? "🟡" : "ℹ️",
				fixable: false,
			});
			let fullSection = `## Type Coverage\n\n**${tcResult.percentage.toFixed(1)}% typed** (${tcResult.typed}/${tcResult.total} identifiers)\n\n`;
			// Group by file and show top 10 files only
			const byFile: Record<string, number> = {};
			for (const u of tcResult.untypedLocations) {
				byFile[u.file] = (byFile[u.file] || 0) + 1;
			}
			const sortedFiles = Object.entries(byFile)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10);
			if (sortedFiles.length > 0) {
				fullSection += `### Top Files by Untyped Count\n\n| File | Untyped Count |\n|------|---------------|\n`;
				for (const [file, count] of sortedFiles) {
					fullSection += `| ${file} | ${count} |\n`;
				}
				if (Object.keys(byFile).length > 10) {
					fullSection += `| ... | +${Object.keys(byFile).length - 10} more files |\n`;
				}
			}
			fullSection += "\n";
			fullReport.push(fullSection);
		}
	}
	const typeCoverageCount = summaryItems.find(s => s.category === "Type Coverage")?.count ?? 0;
	ctx.ui.notify(`✓ Part 7: Type coverage (${typeCoverageCount} files low)`, "info");

	// Part 8: Circular deps
	if (!pi.getFlag("no-madge") && clients.depChecker.isAvailable()) {
		const { circular } = clients.depChecker.scanProject(targetPath);
		if (circular.length > 0) {
			summaryItems.push({
				category: "Circular Deps",
				count: circular.length,
				severity: "🔴",
				fixable: false,
			});
			let fullSection = `## Circular Dependencies (Madge)\n\n**${circular.length} circular chain(s) found**\n\n`;
			for (const dep of circular) {
				fullSection += `- ${dep.path.join(" → ")}\n`;
			}
			fullReport.push(`${fullSection}\n`);
		}
	}
	const circularCount = summaryItems.find(s => s.category === "Circular Deps")?.count ?? 0;
	ctx.ui.notify(`✓ Part 8: Circular deps (${circularCount} chains)`, "info");

	// Part 9: Arch rules
	if (!clients.architect.hasConfig()) {
		clients.architect.loadConfig(process.cwd());
	}
	if (clients.architect.hasConfig()) {
		const archViolations: Array<{ file: string; message: string }> = [];
		const archScanDir = (dir: string) => {
			for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					// Use centralized exclusions from file-utils
					if (EXCLUDED_DIRS.includes(entry.name)) continue;
					archScanDir(full);
				} else if (/\.(ts|tsx|js|jsx|py|go|rs)$/.test(entry.name)) {
					// Skip test files using centralized checker
					if (isTestFile(full)) continue;
					const relPath = path.relative(targetPath, full).replace(/\\/g, "/");
					const content = nodeFs.readFileSync(full, "utf-8");
					const lineCount = content.split("\n").length;
					for (const v of clients.architect.checkFile(relPath, content)) {
						archViolations.push({ file: relPath, message: v.message });
					}
					const sizeV = clients.architect.checkFileSize(relPath, lineCount);
					if (sizeV)
						archViolations.push({ file: relPath, message: sizeV.message });
				}
			}
		};
		archScanDir(targetPath);
		if (archViolations.length > 0) {
			summaryItems.push({
				category: "Architectural",
				count: archViolations.length,
				severity: "🔴",
				fixable: false,
			});
			let fullSection = `## Architectural Rules\n\n**${archViolations.length} violation(s) found**\n\n`;
			for (const v of archViolations) {
				fullSection += `- **${v.file}**: ${v.message}\n`;
			}
			fullReport.push(`${fullSection}\n`);
		}
	}
	const archCount = summaryItems.find(s => s.category === "Architectural")?.count ?? 0;
	ctx.ui.notify(`✓ Part 9: Arch rules (${archCount} violations)`, "info");

	// --- Create structured JSON report (for AI processing) ---
	nodeFs.mkdirSync(reviewDir, { recursive: true });
	const projectName = path.basename(process.cwd());

	const totalIssues = summaryItems.reduce((sum, s) => sum + s.count, 0);
	const fixableCount = summaryItems
		.filter((s) => s.fixable)
		.reduce((sum, s) => sum + s.count, 0);
	const refactorNeeded = summaryItems
		.filter((s) => !s.fixable)
		.reduce((sum, s) => sum + s.count, 0);

	const jsonReport = {
		meta: {
			timestamp: new Date().toISOString(),
			project: projectName,
			path: targetPath,
			totalIssues,
			fixableCount,
			refactorNeeded,
		},
		byCategory: summaryItems.reduce(
			(acc, item) => {
				acc[item.category] = {
					count: item.count,
					severity: item.severity,
					fixable: item.fixable,
					falsePositivePrefix: `${item.category.toLowerCase().replace(/\s+/g, "-")}:`,
				};
				return acc;
			},
			{} as Record<
				string,
				{
					count: number;
					severity: string;
					fixable: boolean;
					falsePositivePrefix: string;
				}
			>,
		),
		howToMarkFalsePositive: {
			command: "/lens-booboo-fix --false-positive",
			format: "<category>:<file>[:<line>]",
			examples: [
				"similarity:clients/runners/utils.ts:49",
				"dead-code:clients/subprocess-client.ts",
				"unused:architect-client.ts:ArchitectRule",
			],
		},
		sessionFile: path.join(process.cwd(), ".pi-lens", "fix-session.json"),
		details: fullReport.join("\n"),
	};

	const jsonPath = path.join(reviewDir, `booboo-${timestamp}.json`);
	nodeFs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), "utf-8");

	// --- Create markdown report (for human reading) ---
	const mdReport = `# Code Review: ${projectName}

**Scanned:** ${jsonReport.meta.timestamp}

**Path:** \`${targetPath}\`

**Summary:** ${jsonReport.meta.totalIssues} issues | ${jsonReport.meta.fixableCount} fixable | ${jsonReport.meta.refactorNeeded} need refactor

---

${fullReport.join("\n")}`;
	const mdPath = path.join(reviewDir, `booboo-${timestamp}.md`);
	nodeFs.writeFileSync(mdPath, mdReport, "utf-8");

	// --- Brief terminal summary (triggers AI to read JSON) ---
	if (summaryItems.length === 0) {
		ctx.ui.notify("✓ Code review clean", "info");
	} else {
		const { totalIssues, fixableCount, refactorNeeded } = jsonReport.meta;
		const summaryLines = [
			`📊 Code Review: ${totalIssues} issues`,
			`  🔧 ${fixableCount} fixable | 🏗️ ${refactorNeeded} refactor`,
			`📄 JSON: ${jsonPath}`,
			`📄 MD: ${mdPath}`,
			`🚀 Run \`/lens-booboo-fix\` to auto-fix`,
			`🚫 Mark false positive: \`/lens-booboo-fix --false-positive "<category>:<file>"\``,
		];

		ctx.ui.notify(summaryLines.join("\n"), "info");
	}
}

// ============================================================================
// Semantic Similarity Helper
// ============================================================================

interface SimilarPair {
	func1: string;
	func2: string;
	similarity: number;
}

/**
 * Find top N most similar function pairs in the project index
 * Uses canonical pair ordering to avoid duplicates (A,B) vs (B,A)
 */
function findTopSimilarPairs(
	index: ProjectIndex,
	maxPairs: number,
): SimilarPair[] {
	const entries = Array.from(index.entries.values());
	const seenPairs = new Set<string>();
	const pairs: SimilarPair[] = [];

	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const entry1 = entries[i];
			const entry2 = entries[j];

			// Skip if same file (we want cross-file duplicates)
			if (entry1.filePath === entry2.filePath) continue;

			const similarity = calculateSimilarity(entry1.matrix, entry2.matrix);

			if (similarity >= 0.75) {
				// Canonical pair key (sorted to avoid duplicates)
				const pairKey = [entry1.id, entry2.id].sort().join("::");
				if (seenPairs.has(pairKey)) continue;
				seenPairs.add(pairKey);

				pairs.push({
					func1: entry1.id,
					func2: entry2.id,
					similarity,
				});
			}
		}
	}

	// Sort by similarity descending, take top N
	return pairs.sort((a, b) => b.similarity - a.similarity).slice(0, maxPairs);
}
