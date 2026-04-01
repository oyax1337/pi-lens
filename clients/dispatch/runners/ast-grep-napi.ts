/**
 * ast-grep NAPI runner for dispatch system
 *
 * Uses @ast-grep/napi for programmatic parsing instead of CLI.
 * Handles TypeScript/JavaScript/CSS/HTML files with YAML rule support.
 *
 * Replaces CLI-based runners for faster performance (100x speedup).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Lazy load the napi package
let sg: typeof import("@ast-grep/napi") | undefined;

async function loadSg(): Promise<typeof import("@ast-grep/napi") | undefined> {
	if (sg) return sg;
	try {
		sg = await import("@ast-grep/napi");
		return sg;
	} catch {
		return undefined;
	}
}

// Supported extensions for NAPI
const SUPPORTED_EXTS = [".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".htm"];

/** Maximum matches per rule to prevent excessive false positives */
const MAX_MATCHES_PER_RULE = 10;

/** Maximum total diagnostics per file to prevent output spam */
const MAX_TOTAL_DIAGNOSTICS = 50;

/** Threshold for warning about overly broad patterns that match everything */
const _EXCESSIVE_MATCHES_THRESHOLD = 50;

/** Maximum recursion depth for structured rule execution to prevent stack overflow */
const _MAX_RECURSION_DEPTH = 10;

/** Maximum AST depth to traverse to prevent stack overflow on deeply nested files */
const _MAX_AST_DEPTH = 50;

/** Maximum recursion depth for structured rule execution */
const _MAX_RULE_DEPTH = 5;

/** Overly broad patterns that match everything (cause false positive explosions) */
const OVERLY_BROAD_PATTERNS = [
	"$NAME", // Matches every identifier
	"$FIELD", // Matches every field access
	"$_", // Matches every node
	"$X", // Common catch-all variable
	"$VAR", // Common catch-all variable
	"$EXPR", // Common catch-all expression
];

/** Check if a pattern is overly broad and will cause false positive explosions */
function isOverlyBroadPattern(pattern: string | undefined): boolean {
	if (!pattern) return false;
	// Check exact matches and simple patterns that are just variables
	if (OVERLY_BROAD_PATTERNS.includes(pattern.trim())) return true;
	// Check if pattern is just a single meta-variable (starts with $ and has no other content)
	if (/^\$[A-Z_]+$/i.test(pattern.trim())) return true;
	return false;
}

/** Check if a rule condition is valid (not empty) */
function _isValidCondition(condition: YamlRuleCondition | undefined): boolean {
	if (!condition) return false;
	// Check for empty 'all' or 'any' arrays
	if (condition.all !== undefined && condition.all.length === 0) return false;
	if (condition.any !== undefined && condition.any.length === 0) return false;
	// Check for overly broad pattern
	if (isOverlyBroadPattern(condition.pattern)) return false;
	return true;
}

function canHandle(filePath: string): boolean {
	return SUPPORTED_EXTS.includes(path.extname(filePath).toLowerCase());
}

function getLang(
	filePath: string,
	sgModule: typeof import("@ast-grep/napi"),
): any {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".ts":
			return sgModule.Lang.TypeScript;
		case ".tsx":
			return sgModule.Lang.Tsx;
		case ".js":
		case ".jsx":
			return sgModule.Lang.JavaScript;
		case ".css":
			return sgModule.Lang.Css;
		case ".html":
		case ".htm":
			return sgModule.Lang.Html;
		default:
			return undefined;
	}
}

// YAML rule types
interface YamlRuleCondition {
	kind?: string;
	pattern?: string;
	regex?: string;
	has?: YamlRuleCondition;
	any?: YamlRuleCondition[];
	all?: YamlRuleCondition[];
	not?: YamlRuleCondition;
}

interface YamlRule {
	id: string;
	language?: string;
	severity?: string;
	message?: string;
	metadata?: { weight?: number; category?: string };
	rule?: YamlRuleCondition;
}

function loadYamlRules(ruleDir: string): YamlRule[] {
	const rules: YamlRule[] = [];
	if (!fs.existsSync(ruleDir)) return rules;

	const files = fs.readdirSync(ruleDir).filter((f) => f.endsWith(".yml"));

	for (const file of files) {
		try {
			const content = fs.readFileSync(path.join(ruleDir, file), "utf-8");
			// Split by --- to handle multiple YAML documents in one file
			const documents = content.split(/^---$/m).filter((d) => d.trim());

			for (const doc of documents) {
				const rule = parseSimpleYaml(doc.trim());
				if (rule?.id) {
					rules.push(rule);
				}
			}
		} catch {
			// Skip invalid files
		}
	}

	return rules;
}

function parseSimpleYaml(content: string): YamlRule | null {
	const lines = content.split("\n");
	const rule: YamlRule = { id: "", metadata: {} };
	let _currentSection: "root" | "rule" | "metadata" = "root";
	const sectionStack: Array<{ name: string; indent: number; obj: any }> = [];
	let multilineBuffer: string[] = [];
	let multilineKey = "";

	function getCurrentObj(): any {
		if (sectionStack.length === 0) return rule;
		return sectionStack[sectionStack.length - 1].obj;
	}

	function getIndent(line: string): number {
		let count = 0;
		for (const char of line) {
			if (char === " ") count++;
			else if (char === "\t") count += 2;
			else break;
		}
		return count;
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		if (trimmed === "---") continue;

		const indent = getIndent(line);

		// Pop stack if indent decreased
		while (
			sectionStack.length > 0 &&
			indent <= sectionStack[sectionStack.length - 1].indent
		) {
			sectionStack.pop();
		}

		// Check for multiline continuation
		if (line.startsWith(" ") && !trimmed.includes(":") && multilineKey) {
			multilineBuffer.push(trimmed);
			continue;
		}

		// Flush multiline buffer
		if (multilineKey && multilineBuffer.length > 0) {
			const value = multilineBuffer.join("\n");
			const current = getCurrentObj();
			if (multilineKey === "pattern" && current) {
				current.pattern = value;
			}
			multilineKey = "";
			multilineBuffer = [];
		}

		const colonIndex = trimmed.indexOf(":");
		const key =
			colonIndex > 0 ? trimmed.substring(0, colonIndex).trim() : trimmed;
		const value =
			colonIndex > 0 ? trimmed.substring(colonIndex + 1).trim() : "";

		if (key === "id") {
			rule.id = value.replace(/^["']|["']$/g, "");
		} else if (key === "language") {
			rule.language = value;
		} else if (key === "severity") {
			rule.severity = value;
		} else if (key === "message") {
			if (value === "|") {
				multilineKey = "message";
			} else {
				rule.message = value.replace(/^["']|["']$/g, "");
			}
		} else if (key === "metadata") {
			_currentSection = "metadata";
			const newObj = {};
			rule.metadata = newObj;
			sectionStack.push({ name: "metadata", indent, obj: newObj });
		} else if (key === "rule") {
			_currentSection = "rule";
			const newObj: YamlRuleCondition = {};
			rule.rule = newObj;
			sectionStack.push({ name: "rule", indent, obj: newObj });
		} else if (sectionStack.length > 0) {
			const current = getCurrentObj();
			const currentSectionName = sectionStack[sectionStack.length - 1]?.name;

			if (key === "weight" && currentSectionName === "metadata") {
				if (!rule.metadata) rule.metadata = {};
				rule.metadata.weight = parseInt(value, 10) || 3;
			} else if (key === "category" && currentSectionName === "metadata") {
				if (!rule.metadata) rule.metadata = {};
				rule.metadata.category = value.replace(/^["']|["']$/g, "");
			} else if (key === "pattern") {
				if (value === "|") {
					multilineKey = "pattern";
				} else {
					// Strip all surrounding quotes (handle nested quotes from YAML)
					let stripped = value;
					while (
						stripped.startsWith('"') &&
						stripped.endsWith('"') &&
						stripped.length > 1
					) {
						stripped = stripped.slice(1, -1);
					}
					while (
						stripped.startsWith("'") &&
						stripped.endsWith("'") &&
						stripped.length > 1
					) {
						stripped = stripped.slice(1, -1);
					}
					current.pattern = stripped;
				}
			} else if (key === "kind") {
				current.kind = value;
			} else if (key === "regex") {
				// Strip all surrounding quotes
				let stripped = value;
				while (
					stripped.startsWith('"') &&
					stripped.endsWith('"') &&
					stripped.length > 1
				) {
					stripped = stripped.slice(1, -1);
				}
				while (
					stripped.startsWith("'") &&
					stripped.endsWith("'") &&
					stripped.length > 1
				) {
					stripped = stripped.slice(1, -1);
				}
				current.regex = stripped;
			} else if (key === "has" || key === "not") {
				const newObj: YamlRuleCondition = {};
				current[key] = newObj;
				sectionStack.push({ name: key, indent, obj: newObj });
			} else if (key === "any" || key === "all") {
				if (!current[key]) current[key] = [];
				// Check if next lines with more indent are list items
				let j = i + 1;
				while (j < lines.length) {
					const nextLine = lines[j];
					const nextTrimmed = nextLine.trim();
					if (!nextTrimmed || nextTrimmed.startsWith("#")) {
						j++;
						continue;
					}
					const nextIndent = getIndent(nextLine);
					if (nextIndent <= indent) break;

					if (nextTrimmed.startsWith("- ")) {
						// New list item
						const itemObj: YamlRuleCondition = {};
						current[key].push(itemObj);
						sectionStack.push({ name: key, indent: nextIndent, obj: itemObj });
						// Parse the item content after "- "
						const itemContent = nextTrimmed.substring(2);
						if (itemContent.includes(":")) {
							const [itemKey, itemVal] = itemContent.split(":", 2);
							if (itemKey.trim() === "pattern") {
								itemObj.pattern = itemVal.trim().replace(/^["']|["']$/g, "");
							} else if (itemKey.trim() === "kind") {
								itemObj.kind = itemVal.trim();
							}
						} else if (itemContent) {
							// Assume it's a pattern
							itemObj.pattern = itemContent.replace(/^["']|["']$/g, "");
						}
					}
					j++;
				}
			}
		}
	}

	// Flush remaining multiline buffer
	if (multilineKey && multilineBuffer.length > 0) {
		const value = multilineBuffer.join("\n");
		const current = getCurrentObj();
		if (multilineKey === "pattern" && current) {
			current.pattern = value;
		} else if (multilineKey === "message") {
			rule.message = value;
		}
	}

	return rule.id ? rule : null;
}

/**
 * Check if a rule uses structured conditions (has/any/all/not/regex)
 */
function isStructuredRule(rule: YamlRule): boolean {
	if (!rule.rule) return false;
	return !!(
		rule.rule.has ||
		rule.rule.any ||
		rule.rule.all ||
		rule.rule.not ||
		rule.rule.regex
	);
}

/**
 * Execute a structured rule using manual AST traversal
 */
function executeStructuredRule(
	rootNode: any,
	condition: YamlRuleCondition,
	matches: any[] = [],
	depth = 0,
): any[] {
	// Prevent infinite recursion from nested rules
	if (depth > _MAX_RULE_DEPTH) {
		return matches;
	}

	// Start with finding nodes by kind or pattern
	let candidates: any[] = [];

	if (condition.pattern) {
		// Use pattern matching via findAll
		try {
			candidates = rootNode.findAll(condition.pattern);
		} catch {
			return matches;
		}
	} else if (condition.kind) {
		// Manual traversal for kind matching with depth limit
		candidates = findByKind(rootNode, condition.kind, 0);
	} else {
		// No kind or pattern, search all nodes with depth limit
		candidates = getAllNodes(rootNode, 0);
	}

	// Filter candidates by conditions
	for (const candidate of candidates) {
		let matchesCondition = true;

		// Check 'has' condition
		if (condition.has && matchesCondition) {
			const subMatches = executeStructuredRule(
				candidate,
				condition.has,
				[],
				depth + 1,
			);
			if (subMatches.length === 0) matchesCondition = false;
		}

		// Check 'not' condition
		if (condition.not && matchesCondition) {
			const subMatches = executeStructuredRule(
				candidate,
				condition.not,
				[],
				depth + 1,
			);
			if (subMatches.length > 0) matchesCondition = false;
		}

		// Check 'any' condition (at least one must match)
		if (condition.any && matchesCondition) {
			let anyMatches = false;
			for (const subCondition of condition.any) {
				const subMatches = executeStructuredRule(
					candidate,
					subCondition,
					[],
					depth + 1,
				);
				if (subMatches.length > 0) {
					anyMatches = true;
					break;
				}
			}
			if (!anyMatches) matchesCondition = false;
		}

		// Check 'all' condition (all must match)
		if (condition.all && matchesCondition) {
			for (const subCondition of condition.all) {
				const subMatches = executeStructuredRule(
					candidate,
					subCondition,
					[],
					depth + 1,
				);
				if (subMatches.length === 0) {
					matchesCondition = false;
					break;
				}
			}
		}

		// Check 'regex' condition with error handling
		if (condition.regex && matchesCondition) {
			try {
				const text = candidate.text();
				const regex = new RegExp(condition.regex);
				if (!regex.test(text)) matchesCondition = false;
			} catch {
				// Invalid regex, skip this condition
				matchesCondition = false;
			}
		}

		if (matchesCondition) {
			matches.push(candidate);
		}
	}

	return matches;
}

/**
 * Find all nodes of a specific kind with depth limit
 */
function findByKind(node: any, kind: string, currentDepth: number): any[] {
	if (currentDepth > _MAX_AST_DEPTH) {
		return [];
	}
	const results: any[] = [];
	if (node.kind() === kind) {
		results.push(node);
	}
	for (const child of node.children()) {
		results.push(...findByKind(child, kind, currentDepth + 1));
	}
	return results;
}

/**
 * Get all nodes with depth limit to prevent stack overflow
 */
function getAllNodes(node: any, currentDepth: number): any[] {
	if (currentDepth > _MAX_AST_DEPTH) {
		return [];
	}
	const results = [node];
	for (const child of node.children()) {
		results.push(...getAllNodes(child, currentDepth + 1));
	}
	return results;
}

const astGrepNapiRunner: RunnerDefinition = {
	id: "ast-grep-napi",
	appliesTo: ["jsts"], // TypeScript/JavaScript only
	priority: 15, // Run early (after type checkers, before other linters)
	enabledByDefault: true,
	skipTestFiles: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const _startTime = Date.now();

		if (!canHandle(ctx.filePath)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const sgModule = await loadSg();
		if (!sgModule) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		if (!fs.existsSync(ctx.filePath)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const lang = getLang(ctx.filePath, sgModule);
		if (!lang) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const content = fs.readFileSync(ctx.filePath, "utf-8");

		let root: import("@ast-grep/napi").SgRoot;
		try {
			root = sgModule.parse(lang, content);
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics: Diagnostic[] = [];
		const rootNode = root.root();

		// CONSOLIDATED: Use ast-grep-rules (unified with CLI tools)
		// Includes both security/architecture rules + slop patterns
		const ruleDirs = [
			path.join(process.cwd(), "rules/ast-grep-rules/rules"),
			path.join(process.cwd(), "rules/ast-grep-rules"), // For slop-patterns.yml
		];

		for (const ruleDir of ruleDirs) {
			const rules = loadYamlRules(ruleDir);

			for (const rule of rules) {
				// Skip rules for different languages (case-insensitive)
				const lang = rule.language?.toLowerCase();
				if (lang && lang !== "typescript" && lang !== "javascript") {
					continue;
				}

				try {
					let matches: any[] = [];

					if (isStructuredRule(rule) && rule.rule) {
						// Use structured rule execution
						matches = executeStructuredRule(rootNode, rule.rule, []);
					} else if (rule.rule?.pattern || rule.rule?.kind) {
						// Use simple pattern matching
						const pattern = rule.rule.pattern || rule.rule.kind;
						if (pattern) {
							try {
								matches = rootNode.findAll(pattern);
							} catch {
								// Pattern failed, try manual traversal for kind
								if (rule.rule.kind) {
									function findByKind(
										node: any,
										kind: string,
										depth = 0,
									): any[] {
										if (depth > _MAX_AST_DEPTH) return [];
										const results: any[] = [];
										if (node.kind() === kind) results.push(node);
										for (const child of node.children()) {
											results.push(...findByKind(child, kind, depth + 1));
										}
										return results;
									}
									matches = findByKind(rootNode, rule.rule.kind);
								}
							}
						}
					}

					// Limit matches per rule to prevent excessive false positives
					const limitedMatches = matches.slice(0, MAX_MATCHES_PER_RULE);

					for (const match of limitedMatches) {
						// Skip if we've hit the total diagnostic limit
						if (diagnostics.length >= MAX_TOTAL_DIAGNOSTICS) {
							break;
						}

						const range = match.range();
						const weight = rule.metadata?.weight || 3;
						const severity = weight >= 4 ? "error" : "warning";

						diagnostics.push({
							id: `ast-grep-napi-${range.start.line}-${rule.id}`,
							message: `[${rule.metadata?.category || "slop"}] ${rule.message || rule.id}`,
							filePath: ctx.filePath,
							line: range.start.line + 1,
							column: range.start.column + 1,
							severity,
							semantic: severity === "error" ? "blocking" : "warning",
							tool: "ast-grep-napi",
							rule: rule.id,
							fixable: false,
						});
					}

					// Stop processing more rules if we've hit the limit
					if (diagnostics.length >= MAX_TOTAL_DIAGNOSTICS) {
						break;
					}
				} catch {
					// Rule failed, skip
				}
			}
		}

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return {
			status: "failed",
			diagnostics,
			semantic: "warning",
		};
	},
};

// Log removed - runner disabled due to stability issues

export default astGrepNapiRunner;
