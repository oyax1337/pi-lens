/**
 * Tree-sitter Structural Analysis Runner
 *
 * Executes all loaded tree-sitter query files from rules/tree-sitter-queries/
 * for fast AST-based pattern matching.
 * Updated: ast-grep-napi test
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeMapKey } from "../../path-utils.js";
import { TreeSitterClient } from "../../tree-sitter-client.js";
import {
	queryLoader,
	type TreeSitterQuery,
} from "../../tree-sitter-query-loader.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

// Module-level singleton: web-tree-sitter WASM must only be initialized once per process.
// Creating a new TreeSitterClient() on every write resets TRANSFER_BUFFER (a module-level
// WASM pointer) — concurrent writes race on _ts_init() and corrupt shared WASM state → crash.
let _sharedClient: TreeSitterClient | null = null;
function getSharedClient(): TreeSitterClient {
	if (!_sharedClient) {
		_sharedClient = new TreeSitterClient();
	}
	return _sharedClient;
}

/**
 * Check if a code block is effectively empty (ignoring comments and whitespace)
 */
function isEmptyBlock(blockContent: string): boolean {
	// Remove comments, whitespace, and check if anything remains
	const cleaned = blockContent
		.replace(/\/\/.*$/gm, "") // Remove single-line comments
		.replace(/\/\*[\s\S]*?\*\//g, "") // Remove multi-line comments
		.replace(/\s+/g, "") // Remove all whitespace
		.trim();
	return cleaned.length === 0 || cleaned === "{}";
}

/**
 * Extract parameter count from match text
 */
function countParameters(matchText: string): number {
	// Count commas in parameter list, or check for non-empty params
	// Simple heuristic: count commas + 1, or 0 if empty
	const paramsMatch = matchText.match(/\((.*)\)/);
	if (!paramsMatch) return 0;
	const params = paramsMatch[1].trim();
	if (!params) return 0;
	return params.split(",").length;
}

/**
 * Apply post-filter to determine if a match should be reported
 */
function applyPostFilter(
	query: TreeSitterQuery,
	captures: Record<string, string>,
): boolean {
	if (!query.post_filter) return true; // No filter = always include

	switch (query.post_filter) {
		case "empty_body": {
			// Check if the BODY capture is effectively empty
			const body = captures.BODY || captures.body || "";
			return isEmptyBlock(body);
		}

		case "count_params": {
			// Check if parameter count meets minimum
			const minParams = query.post_filter_params?.min_params || 6;
			// Get PARAMS capture which contains the parameter list like "(a, b, c)"
			const params = captures.PARAMS || captures.params || captures.PARAM || "";
			const paramCount = countParameters(params);
			return paramCount >= minParams;
		}

		case "not_dbg_method":
			// Exclude debug methods (for console-statement)
			return !/\b(dbg|debug|logDebug)\b/i.test(captures.METHOD || "");

		default:
			// Unknown filter - include by default (safer than excluding)
			return true;
	}
}

/**
 * Check if variable name matches secret patterns
 * This handles the #match? predicate from tree-sitter queries
 */
function matchesSecretPattern(varName: string): boolean {
	const secretPatterns = [
		/api[_-]?key/i,
		/api[_-]?secret/i,
		/password/i,
		/secret/i,
		/token/i,
		/auth/i,
		/private[_-]?key/i,
		/access[_-]?token/i,
		/credentials/i,
		/aws[_-]?secret/i,
		/github[_-]?token/i,
	];
	return secretPatterns.some((pattern) => pattern.test(varName));
}

const treeSitterRunner: RunnerDefinition = {
	id: "tree-sitter",
	appliesTo: ["jsts", "python"],
	priority: 14, // Between oxlint (12) and ast-grep-napi (15)
	enabledByDefault: true,
	skipTestFiles: false, // Run on test files too (structural issues matter there)

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Use singleton client — WASM must never be re-initialized after first call
		const client = getSharedClient();
		if (!client.isAvailable()) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const initialized = await client.init();
		if (!initialized) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Determine language from file extension
		const filePath = ctx.filePath;
		const isPython = filePath.endsWith(".py");
		const isTypeScript = filePath.endsWith(".ts");
		const isTSX = filePath.endsWith(".tsx");
		const isJavaScript = filePath.endsWith(".js") || filePath.endsWith(".jsx");

		let languageId: string;
		if (isPython) {
			languageId = "python";
		} else if (isTSX) {
			languageId = "tsx";
		} else if (isTypeScript) {
			languageId = "typescript";
		} else if (isJavaScript) {
			languageId = "javascript";
		} else {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Load queries if not already loaded
		if (!queryLoader.getAllQueries().length) {
			await queryLoader.loadQueries();
		}

		// Get all loaded queries for this language
		const allQueries = queryLoader.getAllQueries();
		const languageQueries = allQueries.filter(
			(q) =>
				q.language === languageId ||
				(isJavaScript && q.language === "typescript"),
		);

		if (languageQueries.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const diagnostics: Diagnostic[] = [];

		// Run each query against the file
		for (const query of languageQueries) {
			try {
				// Extract directory from file path (use path.dirname for cross-platform)
				const rootDir = path.dirname(filePath);

				const matches = await client.structuralSearch(
					query.id, // Use query ID as pattern (findMatchingQuery will resolve it)
					languageId,
					rootDir,
					{
						maxResults: 10,
						fileFilter: (f) => normalizeMapKey(f) === normalizeMapKey(filePath),
					},
				);

				for (const match of matches) {
					// Apply post-filter if defined (pass captures for proper filtering)
					if (!applyPostFilter(query, match.captures)) {
						continue; // Skip this match - filter didn't pass
					}

					// For hardcoded-secrets, also check variable name pattern
					if (query.id === "hardcoded-secrets") {
						// Extract variable name from captures
						const varName = match.captures?.VARNAME || "";
						if (!varName || !matchesSecretPattern(varName)) {
							continue; // Skip - no variable name or doesn't match secret patterns
						}
					}

					// Get line/column from match (already 0-indexed from tree-sitter)
					const line = match.line;
					const column = match.column;

					// Map severity to semantic
					const semantic =
						query.severity === "error"
							? "blocking"
							: query.severity === "warning"
								? "warning"
								: "none";

					diagnostics.push({
						id: `tree-sitter:${query.id}:${line}`,
						message: query.message,
						filePath,
						line: line + 1, // 1-indexed
						column: column + 1, // 1-indexed
						severity: query.severity,
						semantic,
						tool: "tree-sitter",
						rule: query.id,
					});
				}
			} catch (err) {
				// Individual query failure shouldn't stop other queries
				console.error(`[tree-sitter] Query ${query.id} failed:`, err);
			}
		}

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Check if any blocking issues
		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");

		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic: hasBlocking ? "blocking" : "warning",
		};
	},
};

export default treeSitterRunner;
// test ast-grep-napi re-enable
