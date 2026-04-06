/**
 * Unified LSP Runner for pi-lens
 *
 * Handles type checking for ALL LSP-supported languages:
 * - TypeScript/JavaScript (typescript-language-server)
 * - Python (pyright/pylsp)
 * - Go (gopls)
 * - Rust (rust-analyzer)
 * - Ruby, PHP, C#, Java, Kotlin, Swift, Dart, etc.
 *
 * Replaces language-specific runners (ts-lsp, pyright) with a single
 * unified runner that delegates to the LSP service.
 */

import { getLSPService } from "../../lsp/index.js";
import { RUNTIME_CONFIG } from "../../runtime-config.js";
import { resolveRunnerPath } from "../runner-context.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { readFileContent } from "./utils.js";

const LSP_MAX_FILE_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const LSP_MAX_FILE_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;

const lspRunner: RunnerDefinition = {
	id: "lsp",
	appliesTo: ["jsts", "python", "go", "rust"], // Core LSP languages
	priority: 4, // Run before everything (even ts-lsp was priority 5)
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const diagnosticPath = resolveRunnerPath(ctx.cwd, ctx.filePath);
		// Only run if --lens-lsp flag is enabled
		if (!ctx.pi.getFlag("lens-lsp")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const lspService = getLSPService();

		// Check if we have LSP available for this file
		const hasLSP = await lspService.hasLSP(ctx.filePath);
		if (!hasLSP) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Prefer already-synced diagnostics from pipeline to avoid duplicate didOpen
		// traffic on each write. If nothing is available yet, we fall back to a
		// single open+diagnostics cycle.
		let lspDiags: import("../../lsp/client.js").LSPDiagnostic[] = [];
		let serverFailed = false;
		let failureReason = "";

		try {
			lspDiags = await lspService.getDiagnostics(ctx.filePath);
		} catch {
			// fall through to open+diagnostics path below
		}

		if (lspDiags.length === 0) {
			const content = readFileContent(ctx.filePath);
			if (!content) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}

			const sizeBytes = Buffer.byteLength(content, "utf-8");
			const lineCount = content.split("\n").length;
			if (sizeBytes > LSP_MAX_FILE_BYTES || lineCount > LSP_MAX_FILE_LINES) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}

			// Try to open file in LSP and get diagnostics
			// If the server fails to spawn or crashes, this will be caught
			try {
				await lspService.openFile(ctx.filePath, content);
				// getDiagnostics() internally calls waitForDiagnostics() with bus
				// subscription + 150ms debounce + 3s timeout
				lspDiags = await lspService.getDiagnostics(ctx.filePath);
			} catch (err) {
				serverFailed = true;
				failureReason = err instanceof Error ? err.message : String(err);
				// Check if this is a server spawn/connection error
				if (
					failureReason.includes("spawn") ||
					failureReason.includes("exited") ||
					failureReason.includes("connection") ||
					failureReason.includes("JSON RPC")
				) {
					// Mark this server as broken so we don't keep trying
					console.error(
						`[lsp-runner] LSP server failed for ${diagnosticPath}: ${failureReason}`,
					);
				}
			}
		}

		if (serverFailed) {
			return {
				status: "failed",
				diagnostics: [
					{
						id: `lsp:server-error:0`,
						message: `LSP server failed: ${failureReason}`,
						filePath: diagnosticPath,
						line: 1,
						column: 1,
						severity: "error",
						semantic: "warning", // Don't block - fallback to other runners
						tool: "lsp",
					},
				],
				semantic: "warning",
			};
		}

		if (lspDiags.length === 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Convert LSP diagnostics to our format
		// Defensive: filter out malformed diagnostics that may lack range
		const diagnostics: Diagnostic[] = lspDiags
			.filter((d) => d.range?.start?.line !== undefined)
			.map((d) => ({
				id: `lsp:${d.code ?? "unknown"}:${d.range.start.line}`,
				message: d.message,
				filePath: diagnosticPath,
				line: d.range.start.line + 1,
				column: d.range.start.character + 1,
				severity:
					d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
				semantic: d.severity === 1 ? "blocking" : "warning",
				tool: "lsp",
				code: String(d.code ?? ""),
			}));

		const hasErrors = diagnostics.some((d) => d.semantic === "blocking");

		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors
				? "blocking"
				: diagnostics.length > 0
					? "warning"
					: "none",
		};
	},
};

export default lspRunner;
