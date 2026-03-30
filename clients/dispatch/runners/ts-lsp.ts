/**
 * TypeScript LSP runner for dispatch system
 *
 * Uses the new LSP client architecture (Phase 3) when --lens-lsp is enabled.
 * Falls back to built-in TypeScriptClient for backward compatibility.
 *
 * @deprecated The built-in TypeScriptClient is deprecated. Use --lens-lsp for full LSP support.
 */

import { TypeScriptClient } from "../../typescript-client.js";
import { getLSPService } from "../../lsp/index.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { readFileContent } from "./utils.js";

const tsLspRunner: RunnerDefinition = {
	id: "ts-lsp",
	appliesTo: ["jsts"],
	priority: 5,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Only check TypeScript files
		if (!ctx.filePath.match(/\.tsx?$/)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Phase 3: Use LSP client if --lens-lsp flag is enabled
		if (ctx.pi.getFlag("lens-lsp")) {
			return runWithLSPClient(ctx);
		}

		// DEPRECATED: Fall back to built-in TypeScriptClient
		// This path is deprecated and will be removed in a future release
		return runWithBuiltinClient(ctx);
	},
};

/**
 * Run with new LSP client (Phase 3)
 */
async function runWithLSPClient(ctx: DispatchContext): Promise<RunnerResult> {
	const lspService = getLSPService();

	// Check if we have LSP available for this file
	const hasLSP = await lspService.hasLSP(ctx.filePath);
	if (!hasLSP) {
		return { status: "skipped", diagnostics: [], semantic: "none" };
	}

	// Read file content
	const content = readFileContent(ctx.filePath);
	if (!content) {
		return { status: "skipped", diagnostics: [], semantic: "none" };
	}

	// Open file in LSP and get diagnostics
	await lspService.openFile(ctx.filePath, content);
	const lspDiags = await lspService.getDiagnostics(ctx.filePath);

	if (lspDiags.length === 0) {
		return { status: "succeeded", diagnostics: [], semantic: "none" };
	}

	// Convert LSP diagnostics to our format
	const diagnostics: Diagnostic[] = lspDiags.map((d) => ({
		id: `ts-lsp:${d.code ?? "unknown"}:${d.range.start.line}`,
		message: d.message,
		filePath: ctx.filePath,
		line: d.range.start.line + 1,
		column: d.range.start.character + 1,
		severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
		semantic: d.severity === 1 ? "blocking" : "warning",
		tool: "ts-lsp",
		code: String(d.code ?? ""),
	}));

	return {
		status: "failed",
		diagnostics,
		semantic: "blocking",
	};
}

/**
 * Run with deprecated built-in TypeScriptClient
 * @deprecated Use runWithLSPClient instead
 */
async function runWithBuiltinClient(ctx: DispatchContext): Promise<RunnerResult> {
	const tsClient = new TypeScriptClient();

	const content = readFileContent(ctx.filePath);
	if (!content) {
		return { status: "skipped", diagnostics: [], semantic: "none" };
	}
	tsClient.updateFile(ctx.filePath, content);

	const diags = tsClient.getDiagnostics(ctx.filePath);

	if (diags.length === 0) {
		return { status: "succeeded", diagnostics: [], semantic: "none" };
	}

	// Get code fixes for all errors
	const allFixes = tsClient.getAllCodeFixes(ctx.filePath);

	// Convert to diagnostics
	const diagnostics: Diagnostic[] = [];

	// The built-in client returns ts.Diagnostic with different shape
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	for (const d of diags as any[]) {
		const severity =
			d.category === 1 ? "error" : d.category === 2 ? "warning" : "info";
		const semantic = d.category === 1 ? "blocking" : "warning";

		// Find fixes for this line
		const lineFixes = allFixes.get(d.start.line);
		const fixDescription = lineFixes?.[0]?.description;

		diagnostics.push({
			id: `ts:${d.code}:${d.start.line}`,
			message: fixDescription
				? `${d.message} [💡 ${fixDescription}]`
				: d.message,
			filePath: ctx.filePath,
			line: d.start.line + 1,
			column: d.start.character + 1,
			severity,
			semantic,
			tool: "ts-lsp",
			fixable: !!lineFixes && lineFixes.length > 0,
			fixSuggestion: fixDescription,
		});
	}

	return {
		status: "failed",
		diagnostics,
		semantic: "blocking",
	};
}

export default tsLspRunner;
