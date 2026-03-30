/**
 * LSP Client for pi-lens
 * 
 * Handles JSON-RPC communication with language servers:
 * - Initialize/shutdown lifecycle
 * - Document synchronization (didOpen, didChange)
 * - Diagnostics with debouncing
 * - Request/response handling
 */

import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { MessageConnection } from "vscode-jsonrpc";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import type { LSPProcess } from "./launch.js";
import { DiagnosticFound } from "../bus/events.js";

// --- Types ---

export interface LSPDiagnostic {
	severity: 1 | 2 | 3 | 4; // Error, Warning, Info, Hint
	message: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	code?: string | number;
	source?: string;
}

export interface LSPClientInfo {
	serverId: string;
	root: string;
	connection: MessageConnection;
	notify: {
		open(filePath: string, content: string, languageId: string): Promise<void>;
		change(filePath: string, content: string): Promise<void>;
	};
	getDiagnostics(filePath: string): LSPDiagnostic[];
	waitForDiagnostics(filePath: string, timeoutMs?: number): Promise<void>;
	shutdown(): Promise<void>;
}

// --- Constants ---

const DIAGNOSTICS_DEBOUNCE_MS = 150;
const INITIALIZE_TIMEOUT_MS = 45_000;

// --- Client Factory ---

export async function createLSPClient(options: {
	serverId: string;
	process: LSPProcess;
	root: string;
	initialization?: Record<string, unknown>;
}): Promise<LSPClientInfo> {
	const { serverId, process, root, initialization } = options;

	// Create JSON-RPC connection
	const connection = createMessageConnection(
		new StreamMessageReader(process.stdout),
		new StreamMessageWriter(process.stdin)
	);

	// Track diagnostics per file
	const diagnostics = new Map<string, LSPDiagnostic[]>();
	const pendingDiagnostics = new Map<string, ReturnType<typeof setTimeout>>();

	// Handle incoming diagnostics with debouncing
	connection.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics?: LSPDiagnostic[] }) => {
		const filePath = normalizeFilePath(params.uri);
		const newDiags: LSPDiagnostic[] = params.diagnostics || [];

		// Debounce: clear existing timer and set new one
		const existingTimer = pendingDiagnostics.get(filePath);
		if (existingTimer) clearTimeout(existingTimer);

		const timer = setTimeout(() => {
			diagnostics.set(filePath, newDiags);
			pendingDiagnostics.delete(filePath);

			// Publish to bus
			DiagnosticFound.publish({
				runnerId: serverId,
				filePath,
				diagnostics: newDiags.map((d) => ({
					id: `${serverId}:${d.code ?? "unknown"}:${d.range.start.line}`,
					message: d.message,
					filePath,
					line: d.range.start.line + 1,
					column: d.range.start.character + 1,
					severity: severityFromNumber(d.severity),
					semantic: d.severity === 1 ? "blocking" : d.severity === 2 ? "warning" : "silent",
					tool: serverId,
				})),
				durationMs: 0,
			});
		}, DIAGNOSTICS_DEBOUNCE_MS);

		pendingDiagnostics.set(filePath, timer);
	});

	// Handle server requests
	connection.onRequest("workspace/workspaceFolders", () => [
		{
			name: "workspace",
			uri: pathToFileURL(root).href,
		},
	]);

	connection.onRequest("client/registerCapability", async () => {});
	connection.onRequest("client/unregisterCapability", async () => {});
	connection.onRequest("workspace/configuration", async () => [initialization ?? {}]);

	// Start listening
	connection.listen();

	// Send initialize request
	await withTimeout(
		connection.sendRequest("initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(root).href,
			workspaceFolders: [
				{
					name: "workspace",
					uri: pathToFileURL(root).href,
				},
			],
			capabilities: {
				textDocument: {
					synchronization: {
						dynamicRegistration: false,
						willSave: false,
						willSaveWaitUntil: false,
						didSave: false,
					},
					publishDiagnostics: {
						dynamicRegistration: false,
						versionSupport: true,
						tagSupport: { valueSet: [1, 2] },
						relatedInformation: true,
					},
				},
				workspace: {
					workspaceFolders: {
						supported: true,
						changeNotifications: true,
					},
					configuration: true,
				},
			},
			initializationOptions: initialization,
		}),
		INITIALIZE_TIMEOUT_MS
	);

	// Send initialized notification
	await connection.sendNotification("initialized", {});

	// Track open documents with version numbers
	const documentVersions = new Map<string, number>();

	return {
		serverId,
		root,
		connection,

		notify: {
			async open(filePath, content, languageId) {
				const uri = pathToFileURL(filePath).href;
				documentVersions.set(filePath, 0);
				diagnostics.delete(filePath); // Clear stale diagnostics

				await connection.sendNotification("textDocument/didOpen", {
					textDocument: {
						uri,
						languageId,
						version: 0,
						text: content,
					},
				});
			},

			async change(filePath, content) {
				const uri = pathToFileURL(filePath).href;
				const version = (documentVersions.get(filePath) ?? 0) + 1;
				documentVersions.set(filePath, version);

				await connection.sendNotification("textDocument/didChange", {
					textDocument: { uri, version },
					contentChanges: [{ text: content }],
				});
			},
		},

		getDiagnostics(filePath) {
			return diagnostics.get(filePath) ?? [];
		},

		async waitForDiagnostics(filePath, timeoutMs = 3000) {
			if (diagnostics.has(filePath)) return;

			return new Promise((resolve) => {
				const checkInterval = setInterval(() => {
					if (diagnostics.has(filePath)) {
						clearInterval(checkInterval);
						clearTimeout(timeout);
						resolve();
					}
				}, 50);

				const timeout = setTimeout(() => {
					clearInterval(checkInterval);
					resolve();
				}, timeoutMs);
			});
		},

		async shutdown() {
			// Clear pending timers
			for (const timer of pendingDiagnostics.values()) {
				clearTimeout(timer);
			}
			pendingDiagnostics.clear();

			// Graceful shutdown
			try {
				await connection.sendRequest("shutdown");
				await connection.sendNotification("exit");
			} catch { /* ignore */ }

			connection.dispose();
			process.process.kill();
		},
	};
}

// --- Utilities ---

function normalizeFilePath(uri: string): string {
	try {
		return fileURLToPath(uri);
	} catch {
		return uri;
	}
}

function severityFromNumber(sev: number): "error" | "warning" | "info" | "hint" {
	switch (sev) {
		case 1: return "error";
		case 2: return "warning";
		case 3: return "info";
		case 4: return "hint";
		default: return "error";
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
		),
	]);
}
