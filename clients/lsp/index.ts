/**
 * LSP Service Layer for pi-lens
 *
 * Manages multiple LSP clients per workspace with:
 * - Auto-spawning based on file type
 * - Effect-TS service composition
 * - Bus event integration
 * - Resource cleanup
 */

import type { LSPClientInfo } from "./client.js";
import { createLSPClient } from "./client.js";
import { getServersForFileWithConfig } from "./config.js";
import { getLanguageId } from "./language.js";
import type { LSPServerInfo } from "./server.js";

// --- Types ---

export interface LSPState {
	clients: Map<string, LSPClientInfo>; // key: "serverId:root"
	servers: Map<string, LSPServerInfo>;
	broken: Set<string>; // servers that failed to initialize
	inFlight: Map<string, Promise<SpawnedServer | undefined>>; // prevent duplicate spawns
}

export interface SpawnedServer {
	client: LSPClientInfo;
	info: LSPServerInfo;
}

// --- Service ---

export class LSPService {
	private state: LSPState;

	constructor() {
		this.state = {
			clients: new Map(),
			servers: new Map(),
			broken: new Set(),
			inFlight: new Map(),
		};
	}

	/**
	 * Get or create LSP client for a file
	 * Prevents duplicate client creation via in-flight promise tracking
	 */
	async getClientForFile(filePath: string): Promise<SpawnedServer | undefined> {
		const servers = getServersForFileWithConfig(filePath);
		if (servers.length === 0) return undefined;

		// Try each matching server
		for (const server of servers) {
			const root = await server.root(filePath);
			if (!root) continue;

			// Normalize root path for consistent cache key on Windows
			const normalizedRoot =
				process.platform === "win32" ? root.toLowerCase() : root;
			const key = `${server.id}:${normalizedRoot}`;

			// Check cache first (fast path)
			const existing = this.state.clients.get(key);
			if (existing) {
				if (!existing.isAlive()) {
					try {
						await existing.shutdown();
					} catch {
						/* ignore dead client shutdown errors */
					}
					this.state.clients.delete(key);
					this.state.broken.delete(key);
				} else {
				return { client: existing, info: server };
				}
			}

			// Check if broken
			if (this.state.broken.has(key)) {
				continue;
			}

			// Check if there's already an in-flight spawn for this key
			const inFlight = this.state.inFlight.get(key);
			if (inFlight) {
				// Wait for the existing spawn to complete
				const result = await inFlight;
				if (result) return result;
				continue; // This server failed, try next
			}

			// Create the spawn promise and store it
			const spawnPromise = this.spawnClient(server, root, key);
			this.state.inFlight.set(key, spawnPromise);

			try {
				const result = await spawnPromise;
				if (result) return result;
			} finally {
				// Clean up in-flight tracking
				this.state.inFlight.delete(key);
			}
		}

		return undefined;
	}

	/**
	 * Internal: spawn a client for a server/root combination
	 */
	private async spawnClient(
		server: LSPServerInfo,
		root: string,
		key: string,
	): Promise<SpawnedServer | undefined> {
		try {
			const spawned = await server.spawn(root);
			if (!spawned) {
				this.state.broken.add(key);
				return undefined;
			}

			const client = await createLSPClient({
				serverId: server.id,
				process: spawned.process,
				root,
				initialization: spawned.initialization,
			});

			this.state.clients.set(key, client);
			return { client, info: server };
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (errorMsg.includes("Timeout")) {
				console.error(
					`[lsp] ${server.id} timed out during initialization (${errorMsg}). The server may be downloading or the project is large. Skipping.`,
				);
			} else if (errorMsg.includes("stream was destroyed")) {
				console.error(
					`[lsp] ${server.id} stream was destroyed. The server binary may be missing or crashed immediately. Try reinstalling: npm install -g ${server.id}-language-server`,
				);
			} else if (errorMsg.includes("exited immediately")) {
				console.error(
					`[lsp] ${server.id} ${errorMsg}. Try reinstalling: npm install -g ${server.id}-language-server`,
				);
			} else {
				console.error(`[lsp] Failed to spawn ${server.id}:`, err);
			}
			this.state.broken.add(key);
			return undefined;
		}
	}

	/**
	 * Open a file in LSP (sends textDocument/didOpen)
	 */
	async openFile(filePath: string, content: string): Promise<void> {
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return;

		const languageId = getLanguageId(filePath) ?? "plaintext";
		await spawned.client.notify.open(filePath, content, languageId);
	}

	/**
	 * Update file content (sends textDocument/didChange)
	 */
	async updateFile(filePath: string, content: string): Promise<void> {
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return;

		await spawned.client.notify.change(filePath, content);
	}

	/**
	 * Get diagnostics for a file
	 */
	async getDiagnostics(
		filePath: string,
	): Promise<import("./client.js").LSPDiagnostic[]> {
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return [];

		await spawned.client.waitForDiagnostics(filePath, 3000);
		return spawned.client.getDiagnostics(filePath);
	}

	/**
	 * Navigation: go to definition
	 */
	async definition(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return [];
		return spawned.client.definition(filePath, line, character);
	}

	/**
	 * Navigation: find all references
	 */
	async references(
		filePath: string,
		line: number,
		character: number,
		includeDeclaration = true,
	) {
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return [];
		return spawned.client.references(
			filePath,
			line,
			character,
			includeDeclaration,
		);
	}

	/**
	 * Navigation: hover info
	 */
	async hover(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return null;
		return spawned.client.hover(filePath, line, character);
	}

	/**
	 * Navigation: symbols in document
	 */
	async documentSymbol(filePath: string) {
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return [];
		return spawned.client.documentSymbol(filePath);
	}

	/**
	 * Navigation: workspace-wide symbol search
	 */
	async workspaceSymbol(query: string) {
		// Use the first active client for workspace-level queries
		const clients = Array.from(this.state.clients.values());
		if (clients.length === 0) return [];
		return clients[0].workspaceSymbol(query);
	}

	/**
	 * Navigation: go to implementation
	 */
	async implementation(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return [];
		return spawned.client.implementation(filePath, line, character);
	}

	/**
	 * Navigation: prepare call hierarchy at position
	 */
	async prepareCallHierarchy(
		filePath: string,
		line: number,
		character: number,
	) {
		const spawned = await this.getClientForFile(filePath);
		if (!spawned) return [];
		return spawned.client.prepareCallHierarchy(filePath, line, character);
	}

	/**
	 * Navigation: find incoming calls (callers)
	 */
	async incomingCalls(item: import("./client.js").LSPCallHierarchyItem) {
		const spawned = await this.getClientForFile(
			item.uri.replace("file://", ""),
		);
		if (!spawned) return [];
		return spawned.client.incomingCalls(item);
	}

	/**
	 * Navigation: find outgoing calls (callees)
	 */
	async outgoingCalls(item: import("./client.js").LSPCallHierarchyItem) {
		const spawned = await this.getClientForFile(
			item.uri.replace("file://", ""),
		);
		if (!spawned) return [];
		return spawned.client.outgoingCalls(item);
	}

	/**
	 * Get all diagnostics across all tracked files (for cascade checking)
	 */
	async getAllDiagnostics(): Promise<
		Map<string, import("./client.js").LSPDiagnostic[]>
	> {
		const all = new Map<string, import("./client.js").LSPDiagnostic[]>();
		for (const [_key, client] of this.state.clients) {
			const clientDiags = client.getAllDiagnostics();
			for (const [filePath, diags] of clientDiags) {
				const existing = all.get(filePath) ?? [];
				all.set(filePath, [...existing, ...diags]);
			}
		}
		return all;
	}

	/**
	 * Check if LSP is available for a file
	 */
	async hasLSP(filePath: string): Promise<boolean> {
		const servers = getServersForFileWithConfig(filePath);
		if (servers.length === 0) return false;

		// Check if any server can provide a root
		for (const server of servers) {
			const root = await server.root(filePath);
			if (root) return true;
		}

		return false;
	}

	/**
	 * Shutdown all LSP clients
	 */
	async shutdown(): Promise<void> {
		// Cancel any in-flight spawns
		this.state.inFlight.clear();

		for (const [key, client] of this.state.clients) {
			try {
				await client.shutdown();
			} catch (err) {
				console.error(`[lsp] Error shutting down ${key}:`, err);
			}
		}
		this.state.clients.clear();
		this.state.broken.clear();
	}

	/**
	 * Get status of all active clients
	 */
	getStatus(): Array<{ serverId: string; root: string; connected: boolean }> {
		return Array.from(this.state.clients.entries()).map(([key, _client]) => {
			const [serverId, root] = key.split(":");
			return { serverId, root, connected: true };
		});
	}
}

// --- Singleton Instance ---

let globalLSPService: LSPService | null = null;

export function getLSPService(): LSPService {
	if (!globalLSPService) {
		globalLSPService = new LSPService();
	}
	return globalLSPService;
}

export function resetLSPService(): void {
	if (globalLSPService) {
		globalLSPService.shutdown().catch(() => {});
	}
	globalLSPService = null;
}
