/**
 * Rule Cache for pi-lens
 *
 * Provides disk-based caching for parsed tree-sitter rules with
 * automatic invalidation based on rule file modification times.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const CACHE_DIR = path.join(process.cwd(), ".pi-lens", "cache");
const CACHE_VERSION = "v1";

export interface QueryCacheEntry {
	version: string;
	timestamp: number;
	ruleHash: string;
	queries: Array<{
		id: string;
		name: string;
		severity: string;
		language: string;
		message: string;
		query: string;
		metavars: string[];
		post_filter?: string;
		// biome-ignore lint/suspicious/noExplicitAny: Flexible filter params
		post_filter_params?: Record<string, any>;
	}>;
}

export class RuleCache {
	private cacheFile: string;

	constructor(language: string) {
		this.cacheFile = path.join(
			CACHE_DIR,
			`${language}-rules-${CACHE_VERSION}.json`,
		);
	}

	private ensureCacheDir(): void {
		if (!fs.existsSync(CACHE_DIR)) {
			fs.mkdirSync(CACHE_DIR, { recursive: true });
		}
	}

	private computeRuleHash(ruleFiles: string[]): string {
		const hash = crypto.createHash("sha256");
		for (const file of ruleFiles.sort()) {
			if (fs.existsSync(file)) {
				const stat = fs.statSync(file);
				hash.update(`${file}:${stat.mtimeMs}:${stat.size}`);
			}
		}
		return hash.digest("hex").slice(0, 16);
	}

	get(ruleFiles: string[]): QueryCacheEntry | null {
		try {
			this.ensureCacheDir();
			if (!fs.existsSync(this.cacheFile)) return null;

			const cached = JSON.parse(
				fs.readFileSync(this.cacheFile, "utf-8"),
			) as QueryCacheEntry;
			const currentHash = this.computeRuleHash(ruleFiles);

			if (cached.version !== CACHE_VERSION || cached.ruleHash !== currentHash) {
				return null; // Cache invalid
			}

			return cached;
		} catch {
			return null;
		}
	}

	set(ruleFiles: string[], queries: QueryCacheEntry["queries"]): void {
		try {
			this.ensureCacheDir();
			const entry: QueryCacheEntry = {
				version: CACHE_VERSION,
				timestamp: Date.now(),
				ruleHash: this.computeRuleHash(ruleFiles),
				queries,
			};
			fs.writeFileSync(this.cacheFile, JSON.stringify(entry, null, 2));
		} catch {
			// Cache write failure is non-fatal
		}
	}

	clear(): void {
		try {
			if (fs.existsSync(this.cacheFile)) {
				fs.unlinkSync(this.cacheFile);
			}
		} catch {
			// Ignore
		}
	}
}
