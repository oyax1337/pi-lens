# Symbol Extraction & Call Graph Implementation Plan

> **For Pi:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add symbol definition/reference extraction and call graph analysis via a shared SymbolService that integrates with existing caching infrastructure.

**Architecture:** Shared service layer (SymbolService) with incremental updates, 24hr file cache in `.pi-lens/symbol-index.json`, tree-sitter queries for extraction, and enhanced runners for similarity and impact analysis.

**Tech Stack:** TypeScript, web-tree-sitter (WASM), YAML query files

---

## Task 1: Create Symbol Types

**Files:**
- Create: `clients/symbol-types.ts`

**Step 1: Write symbol type definitions**

Create `clients/symbol-types.ts`:

```typescript
/**
 * Symbol types for pi-lens
 * Shared between SymbolService and runners
 */

export type SymbolKind = 'function' | 'class' | 'variable' | 'interface' | 'type' | 'method' | 'property';

export interface Symbol {
  id: string;              // filePath:name:kind (unique identifier)
  name: string;
  kind: SymbolKind;
  filePath: string;
  line: number;
  column: number;
  signature?: string;      // For functions: "(a: T, b: U) => R"
  isExported: boolean;
  doc?: string;            // JSDoc comment if available
}

export interface SymbolRef {
  symbolId: string;        // Reference to which symbol (by id)
  filePath: string;
  line: number;
  column: number;
  context?: string;        // Surrounding line for context
}

export interface SymbolIndex {
  version: string;
  createdAt: string;
  symbols: Map<string, Symbol>;       // symbolId -> Symbol
  refs: Map<string, SymbolRef[]>;    // symbolId -> references
  byFile: Map<string, string[]>;      // filePath -> symbolIds in that file
}

export interface CallEdge {
  caller: string;        // symbolId of caller
  callerFile: string;
  callerLine: number;
  callerColumn: number;
  callee: string;        // symbolId or external name
  calleeResolved: boolean; // true if callee is in project symbols
}

export interface CallGraph {
  edges: CallEdge[];
  adjacency: Map<string, string[]>;   // caller symbolId -> callees
  reverse: Map<string, string[]>;     // callee symbolId -> callers
  cycles: string[][];                 // Detected circular call chains
  orphans: string[];                  // Symbols defined but never called
  entryPoints: string[];              // Symbols called but never defined (exports, main)
}

// Serializable versions for JSON storage
export interface SerializableSymbolIndex {
  version: string;
  createdAt: string;
  symbols: [string, Symbol][];
  refs: [string, SymbolRef[]][];
  byFile: [string, string[]][];
}

export interface SerializableCallGraph {
  edges: CallEdge[];
  adjacency: [string, string[]][];
  reverse: [string, string[]][];
  cycles: string[][];
  orphans: string[];
  entryPoints: string[];
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit clients/symbol-types.ts`

Expected: No errors

**Step 3: Commit**

```bash
git add clients/symbol-types.ts
git commit -m "feat(symbol): add shared type definitions"
```

**Verification:**
- [ ] File created with all types
- [ ] Compiles without errors
- [ ] Commit made

---

## Task 2: Create Tree-sitter Symbol Extractor

**Files:**
- Create: `clients/tree-sitter-symbol-extractor.ts`

**Step 1: Write symbol extractor**

Create `clients/tree-sitter-symbol-extractor.ts`:

```typescript
/**
 * Symbol extraction via tree-sitter queries
 * Extracts definitions and references from source files
 */

import * as path from "node:path";
import type { Symbol, SymbolKind, SymbolRef } from "./symbol-types.js";

// Tree-sitter query patterns for symbol extraction
const SYMBOL_QUERIES: Record<string, { defs: string; refs: string }> = {
  typescript: {
    defs: `
      ;; Function declarations: function foo(params) { }
      (function_declaration
        name: (identifier) @funcName
        parameters: (formal_parameters) @funcParams
        body: (statement_block) @funcBody) @funcDef
      
      ;; Arrow functions: const foo = (params) => { }
      (variable_declarator
        name: (identifier) @arrowName
        value: (arrow_function
          parameters: (formal_parameters) @arrowParams
          body: (_) @arrowBody)) @arrowDef
      
      ;; Class declarations: class Foo { }
      (class_declaration
        name: (type_identifier) @className) @classDef
      
      ;; Method definitions: class Foo { bar() { } }
      (method_definition
        name: (property_identifier) @methodName
        parameters: (formal_parameters) @methodParams) @methodDef
      
      ;; Interface declarations: interface Foo { }
      (interface_declaration
        name: (type_identifier) @interfaceName) @interfaceDef
      
      ;; Type alias: type Foo = ...
      (type_alias_declaration
        name: (type_identifier) @typeName) @typeDef
    `,
    refs: `
      ;; Function/method calls: foo() or obj.bar()
      (call_expression
        function: (identifier) @callIdent) @callRef
      
      (call_expression
        function: (member_expression
          object: (_)
          property: (property_identifier) @callMethod)) @callMethodRef
      
      ;; New expressions: new Foo()
      (new_expression
        constructor: (identifier) @newIdent) @newRef
      
      ;; Type references: type T = Foo
      (type_identifier) @typeIdent
    `
  },
  python: {
    defs: `
      ;; Function definitions: def foo(params):
      (function_definition
        name: (identifier) @funcName
        parameters: (parameters) @funcParams) @funcDef
      
      ;; Class definitions: class Foo:
      (class_definition
        name: (identifier) @className) @classDef
      
      ;; Method definitions (within class)
      (class_definition
        body: (block
          (function_definition
            name: (identifier) @methodName
            parameters: (parameters) @methodParams) @methodDef))
    `,
    refs: `
      ;; Function calls: foo() or obj.bar()
      (call
        function: (identifier) @callIdent) @callRef
      
      (call
        function: (attribute
          object: (_)
          attribute: (identifier) @callMethod)) @callMethodRef
    `
  },
  rust: {
    defs: `
      ;; Function definitions: fn foo(params) { }
      (function_item
        name: (identifier) @funcName
        parameters: (parameters) @funcParams) @funcDef
      
      ;; Struct definitions: struct Foo { }
      (struct_item
        name: (type_identifier) @structName) @structDef
      
      ;; Impl blocks: impl Foo { fn bar() { } }
      (impl_item
        type: (type_identifier) @implType
        body: (declaration_list
          (function_item
            name: (identifier) @implMethodName) @implMethodDef))
    `,
    refs: `
      ;; Function calls: foo() or obj.bar()
      (call_expression
        function: (identifier) @callIdent) @callRef
      
      (call_expression
        function: (field_expression
          value: (_)
          field: (field_identifier) @callField)) @callFieldRef
    `
  }
};

export interface ExtractedSymbols {
  symbols: Symbol[];
  refs: SymbolRef[];
}

export class TreeSitterSymbolExtractor {
  // biome-ignore lint/suspicious/noExplicitAny: Language type from web-tree-sitter
  private language: any;
  private languageId: string;
  // biome-ignore lint/suspicious/noExplicitAny: Query type from web-tree-sitter
  private defQuery: any;
  // biome-ignore lint/suspicious/noExplicitAny: Query type from web-tree-sitter
  private refQuery: any;

  constructor(languageId: string, language: unknown) {
    this.languageId = languageId;
    // biome-ignore lint/suspicious/noExplicitAny: Language type
    this.language = language as any;
  }

  async init(): Promise<boolean> {
    try {
      const { Query } = await import("web-tree-sitter");
      const queries = SYMBOL_QUERIES[this.languageId];
      if (!queries) return false;

      this.defQuery = new Query(this.language, queries.defs);
      this.refQuery = new Query(this.language, queries.refs);
      return true;
    } catch (err) {
      console.error(`[symbol-extractor] Failed to init ${this.languageId}:`, err);
      return false;
    }
  }

  /**
   * Extract symbols from a parsed tree-sitter tree
   */
  extract(
    // biome-ignore lint/suspicious/noExplicitAny: Tree type
    tree: any,
    filePath: string,
    content: string
  ): ExtractedSymbols {
    const symbols: Symbol[] = [];
    const refs: SymbolRef[] = [];

    const relativePath = path.relative(process.cwd(), filePath);

    // Extract definitions
    const defMatches = this.defQuery.matches(tree.rootNode);
    for (const match of defMatches) {
      const symbol = this.parseDefMatch(match, relativePath, content);
      if (symbol) symbols.push(symbol);
    }

    // Extract references
    const refMatches = this.refQuery.matches(tree.rootNode);
    for (const match of refMatches) {
      const ref = this.parseRefMatch(match, relativePath);
      if (ref) refs.push(ref);
    }

    return { symbols, refs };
  }

  // biome-ignore lint/suspicious/noExplicitAny: Match type
  private parseDefMatch(match: any, filePath: string, content: string): Symbol | null {
    const captures: Record<string, { text: string; node: unknown }> = {};
    
    for (const capture of match.captures) {
      captures[capture.name] = {
        text: capture.node.text,
        // biome-ignore lint/suspicious/noExplicitAny: Node type
        node: capture.node as any
      };
    }

    // Determine kind and name
    let name: string | undefined;
    let kind: SymbolKind | undefined;
    let params: string | undefined;
    let defNode: { startPosition: { row: number; column: number } } | undefined;

    if (captures.funcName) {
      name = captures.funcName.text;
      kind = 'function';
      params = captures.funcParams?.text;
      // biome-ignore lint/suspicious/noExplicitAny: Node type
      defNode = captures.funcDef?.node as any;
    } else if (captures.arrowName) {
      name = captures.arrowName.text;
      kind = 'function';
      params = captures.arrowParams?.text;
      // biome-ignore lint/suspicious/noExplicitAny: Node type
      defNode = captures.arrowDef?.node as any;
    } else if (captures.className) {
      name = captures.className.text;
      kind = 'class';
      // biome-ignore lint/suspicious/noExplicitAny: Node type
      defNode = captures.classDef?.node as any;
    } else if (captures.methodName) {
      name = captures.methodName.text;
      kind = 'method';
      params = captures.methodParams?.text;
      // biome-ignore lint/suspicious/noExplicitAny: Node type
      defNode = captures.methodDef?.node as any;
    } else if (captures.interfaceName) {
      name = captures.interfaceName.text;
      kind = 'interface';
      // biome-ignore lint/suspicious/noExplicitAny: Node type
      defNode = captures.interfaceDef?.node as any;
    } else if (captures.typeName) {
      name = captures.typeName.text;
      kind = 'type';
      // biome-ignore lint/suspicious/noExplicitAny: Node type
      defNode = captures.typeDef?.node as any;
    }

    if (!name || !kind || !defNode) return null;

    // Check if exported (basic heuristic: has export keyword before it)
    const isExported = this.isExported(defNode, content);
    const signature = params ? this.extractSignature(params, kind) : undefined;

    return {
      id: `${filePath}:${name}`,
      name,
      kind,
      filePath,
      line: defNode.startPosition.row + 1,
      column: defNode.startPosition.column + 1,
      signature,
      isExported
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: Match type
  private parseRefMatch(match: any, filePath: string): SymbolRef | null {
    let name: string | undefined;
    let refNode: { startPosition: { row: number; column: number } } | undefined;

    for (const capture of match.captures) {
      if (capture.name.endsWith('Ident') || 
          capture.name.endsWith('Method') || 
          capture.name.endsWith('Field')) {
        name = capture.node.text;
        // biome-ignore lint/suspicious/noExplicitAny: Node type
        refNode = capture.node as any;
      }
      if (capture.name.endsWith('Ref') && !refNode) {
        // biome-ignore lint/suspicious/noExplicitAny: Node type
        refNode = capture.node as any;
      }
    }

    if (!name || !refNode) return null;

    return {
      symbolId: `${filePath}:${name}`, // Will be resolved later
      filePath,
      line: refNode.startPosition.row + 1,
      column: refNode.startPosition.column + 1
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: Node type
  private isExported(node: any, content: string): boolean {
    // Simple heuristic: check for "export" keyword before the node
    const lines = content.split('\n');
    const lineIdx = node.startPosition.row;
    const line = lines[lineIdx] || '';
    return line.includes('export') || this.hasExportModifier(node, content);
  }

  // biome-ignore lint/suspicious/noExplicitAny: Node type
  private hasExportModifier(_node: any, _content: string): boolean {
    // TODO: Implement proper export modifier detection
    // For now, use simple line-based check
    return false;
  }

  private extractSignature(paramsText: string, kind: SymbolKind): string | undefined {
    if (kind === 'function' || kind === 'method') {
      // Clean up params: remove comments, normalize whitespace
      return paramsText.replace(/\/\*[\s\S]*?\*\//g, '')
                       .replace(/\/\/.*$/gm, '')
                       .replace(/\s+/g, ' ')
                       .trim();
    }
    return undefined;
  }
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit clients/tree-sitter-symbol-extractor.ts`

Expected: No errors

**Step 3: Commit**

```bash
git add clients/tree-sitter-symbol-extractor.ts
git commit -m "feat(symbol): add tree-sitter symbol extractor"
```

**Verification:**
- [ ] Extractor file created
- [ ] Compiles without errors
- [ ] Has queries for TS, Python, Rust
- [ ] Commit made

---

## Task 3: Create SymbolService with Cache Integration

**Files:**
- Create: `clients/symbol-service.ts`
- Read first: `clients/project-index.ts` (for serialization pattern)
- Read first: `clients/cache-manager.ts` (for turn-state integration)

**Step 1: Write SymbolService**

Create `clients/symbol-service.ts`:

```typescript
/**
 * SymbolService: Project-wide symbol index with caching
 * 
 * Integrates with:
 * - CacheManager: Turn-state tracking for incremental updates
 * - TreeSitterClient: Parsing files
 * - TreeSitterSymbolExtractor: Extracting symbols
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CacheManager } from "./cache-manager.js";
import { TreeSitterClient } from "./tree-sitter-client.js";
import { TreeSitterSymbolExtractor } from "./tree-sitter-symbol-extractor.js";
import type {
  CallEdge,
  CallGraph,
  SerializableCallGraph,
  SerializableSymbolIndex,
  Symbol,
  SymbolIndex,
  SymbolRef,
} from "./symbol-types.js";

const INDEX_FILE = ".pi-lens/symbol-index.json";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class SymbolService {
  private cache: CacheManager;
  private treeSitter: TreeSitterClient;
  private index: SymbolIndex | null = null;
  private callGraph: CallGraph | null = null;
  private cwd: string;

  constructor(cwd = process.cwd(), verbose = false) {
    this.cwd = cwd;
    this.cache = new CacheManager(verbose);
    this.treeSitter = new TreeSitterClient(verbose);
  }

  // ==========================================================================
  // Index Management
  // ==========================================================================

  /**
   * Get or build the symbol index
   */
  async getIndex(): Promise<SymbolIndex> {
    if (this.index) return this.index;

    // Try to load from cache
    const cached = await this.loadIndex();
    if (cached && this.isFresh(cached)) {
      this.index = cached;
      return cached;
    }

    // Build fresh index
    return this.rebuild();
  }

  /**
   * Incremental update: only re-extract changed files
   */
  async update(): Promise<SymbolIndex> {
    const index = await this.getIndex();
    
    // Get changed files from turn state
    const changedFiles = this.getChangedFiles();
    if (changedFiles.length === 0) {
      return index;
    }

    // Remove stale entries for changed files
    for (const file of changedFiles) {
      this.removeFileFromIndex(index, file);
    }

    // Re-extract changed files
    await this.extractFiles(changedFiles, index);

    // Rebuild call graph if it was cached
    if (this.callGraph) {
      this.buildCallGraph(index);
    }

    // Save updated index
    await this.saveIndex(index);

    return index;
  }

  /**
   * Full rebuild: scan all source files
   */
  async rebuild(): Promise<SymbolIndex> {
    this.index = this.createEmptyIndex();
    this.callGraph = null;

    // Find all source files
    const files = await this.findSourceFiles();
    
    // Extract symbols from all files
    await this.extractFiles(files, this.index);

    // Build call graph
    this.buildCallGraph(this.index);

    // Save to disk
    await this.saveIndex(this.index);

    return this.index;
  }

  // ==========================================================================
  // Query Methods
  // ==========================================================================

  /**
   * Find symbol definition by name
   */
  findDefinition(name: string, filePath?: string): Symbol | null {
    if (!this.index) return null;

    // If filePath provided, look in that file first
    if (filePath) {
      const normalizedFile = path.relative(this.cwd, filePath).replace(/\\/g, "/");
      const id = `${normalizedFile}:${name}`;
      const symbol = this.index.symbols.get(id);
      if (symbol) return symbol;
    }

    // Search all symbols by name
    for (const symbol of this.index.symbols.values()) {
      if (symbol.name === name) {
        return symbol;
      }
    }

    return null;
  }

  /**
   * Find all references to a symbol
   */
  findReferences(symbolId: string): SymbolRef[] {
    if (!this.index) return [];
    return this.index.refs.get(symbolId) || [];
  }

  /**
   * Find all symbols in a file
   */
  findInFile(filePath: string): Symbol[] {
    if (!this.index) return [];

    const normalizedFile = path.relative(this.cwd, filePath).replace(/\\/g, "/");
    const symbolIds = this.index.byFile.get(normalizedFile) || [];
    
    return symbolIds
      .map(id => this.index!.symbols.get(id))
      .filter((s): s is Symbol => s !== undefined);
  }

  /**
   * Find all exported symbols
   */
  findExported(projectRoot: string): Symbol[] {
    if (!this.index) return [];

    const result: Symbol[] = [];
    const normalizedRoot = path.relative(this.cwd, projectRoot).replace(/\\/g, "/");

    for (const symbol of this.index.symbols.values()) {
      if (symbol.isExported && symbol.filePath.startsWith(normalizedRoot)) {
        result.push(symbol);
      }
    }

    return result;
  }

  /**
   * Get symbol signature
   */
  getSignature(symbolId: string): string | undefined {
    if (!this.index) return undefined;
    return this.index.symbols.get(symbolId)?.signature;
  }

  /**
   * Check if symbol is exported
   */
  isExported(symbolId: string): boolean {
    if (!this.index) return false;
    return this.index.symbols.get(symbolId)?.isExported || false;
  }

  // ==========================================================================
  // Call Graph Queries
  // ==========================================================================

  /**
   * Get or build call graph
   */
  async getCallGraph(): Promise<CallGraph> {
    if (this.callGraph) return this.callGraph;

    const index = await this.getIndex();
    this.buildCallGraph(index);

    return this.callGraph!;
  }

  /**
   * Find direct callers of a symbol
   */
  async findCallers(symbolId: string): Promise<string[]> {
    const graph = await this.getCallGraph();
    return graph.reverse.get(symbolId) || [];
  }

  /**
   * Find direct callees of a symbol
   */
  async findCallees(symbolId: string): Promise<string[]> {
    const graph = await this.getCallGraph();
    return graph.adjacency.get(symbolId) || [];
  }

  /**
   * Find all transitive callers (impact analysis)
   */
  async findImpact(symbolId: string): Promise<string[]> {
    const graph = await this.getCallGraph();
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      result.push(id);

      const callers = graph.reverse.get(id) || [];
      for (const caller of callers) {
        visit(caller);
      }
    };

    // Start with direct callers
    const directCallers = graph.reverse.get(symbolId) || [];
    for (const caller of directCallers) {
      visit(caller);
    }

    return result;
  }

  /**
   * Find circular dependencies
   */
  async findCycles(): Promise<string[][]> {
    const graph = await this.getCallGraph();
    return graph.cycles;
  }

  /**
   * Find orphaned symbols (defined but never called)
   */
  async findOrphans(): Promise<Symbol[]> {
    const graph = await this.getCallGraph();
    const index = await this.getIndex();

    return graph.orphans
      .map(id => index.symbols.get(id))
      .filter((s): s is Symbol => s !== undefined);
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private createEmptyIndex(): SymbolIndex {
    return {
      version: "1.0",
      createdAt: new Date().toISOString(),
      symbols: new Map(),
      refs: new Map(),
      byFile: new Map()
    };
  }

  private async loadIndex(): Promise<SymbolIndex | null> {
    const indexPath = path.join(this.cwd, INDEX_FILE);

    try {
      const data = await fs.readFile(indexPath, "utf-8");
      const parsed: SerializableSymbolIndex = JSON.parse(data);

      const index: SymbolIndex = {
        version: parsed.version,
        createdAt: parsed.createdAt,
        symbols: new Map(parsed.symbols),
        refs: new Map(parsed.refs),
        byFile: new Map(parsed.byFile)
      };

      // Load call graph if present
      const graphPath = path.join(this.cwd, INDEX_FILE.replace('.json', '-callgraph.json'));
      try {
        const graphData = await fs.readFile(graphPath, "utf-8");
        const graphParsed: SerializableCallGraph = JSON.parse(graphData);
        this.callGraph = {
          edges: graphParsed.edges,
          adjacency: new Map(graphParsed.adjacency),
          reverse: new Map(graphParsed.reverse),
          cycles: graphParsed.cycles,
          orphans: graphParsed.orphans,
          entryPoints: graphParsed.entryPoints
        };
      } catch {
        // No call graph cached
      }

      return index;
    } catch {
      return null;
    }
  }

  private async saveIndex(index: SymbolIndex): Promise<void> {
    const indexPath = path.join(this.cwd, INDEX_FILE);
    await fs.mkdir(path.dirname(indexPath), { recursive: true });

    const serialized: SerializableSymbolIndex = {
      version: index.version,
      createdAt: new Date().toISOString(),
      symbols: Array.from(index.symbols.entries()),
      refs: Array.from(index.refs.entries()),
      byFile: Array.from(index.byFile.entries())
    };

    await fs.writeFile(indexPath, JSON.stringify(serialized, null, 2));

    // Save call graph if built
    if (this.callGraph) {
      const graphPath = path.join(this.cwd, INDEX_FILE.replace('.json', '-callgraph.json'));
      const serializedGraph: SerializableCallGraph = {
        edges: this.callGraph.edges,
        adjacency: Array.from(this.callGraph.adjacency.entries()),
        reverse: Array.from(this.callGraph.reverse.entries()),
        cycles: this.callGraph.cycles,
        orphans: this.callGraph.orphans,
        entryPoints: this.callGraph.entryPoints
      };
      await fs.writeFile(graphPath, JSON.stringify(serializedGraph, null, 2));
    }
  }

  private isFresh(index: SymbolIndex): boolean {
    const createdAt = new Date(index.createdAt).getTime();
    const age = Date.now() - createdAt;
    return age < MAX_AGE_MS;
  }

  private getChangedFiles(): string[] {
    const turnState = this.cache.readTurnState(this.cwd);
    return Object.keys(turnState.files);
  }

  private removeFileFromIndex(index: SymbolIndex, file: string): void {
    const normalizedFile = file.replace(/\\/g, "/");
    const symbolIds = index.byFile.get(normalizedFile) || [];

    for (const id of symbolIds) {
      index.symbols.delete(id);
      index.refs.delete(id);
    }

    index.byFile.delete(normalizedFile);
  }

  private async findSourceFiles(): Promise<string[]> {
    const { glob } = await import("glob");
    
    const patterns = [
      "**/*.ts",
      "**/*.tsx",
      "**/*.js",
      "**/*.jsx",
      "**/*.py",
      "**/*.rs"
    ];

    const ignore = [
      "**/node_modules/**",
      "**/.pi-lens/**",
      "**/dist/**",
      "**/build/**",
      "**/*.test.ts",
      "**/*.spec.ts"
    ];

    const files: string[] = [];
    for (const pattern of patterns) {
      const matches = await glob(pattern, { cwd: this.cwd, ignore });
      files.push(...matches.map(f => path.join(this.cwd, f)));
    }

    return [...new Set(files)];
  }

  private async extractFiles(files: string[], index: SymbolIndex): Promise<void> {
    // Initialize tree-sitter
    const initialized = await this.treeSitter.init();
    if (!initialized) {
      console.error("[symbol-service] Tree-sitter initialization failed");
      return;
    }

    for (const file of files) {
      await this.extractFile(file, index);
    }
  }

  private async extractFile(filePath: string, index: SymbolIndex): Promise<void> {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) return;

    // Parse file with tree-sitter
    const tree = await this.treeSitter.parseFile(filePath, languageId);
    if (!tree) return;

    // Create extractor and extract symbols
    // biome-ignore lint/suspicious/noExplicitAny: Language loading
    const language = (this.treeSitter as any).languages.get(languageId);
    if (!language) return;

    const extractor = new TreeSitterSymbolExtractor(languageId, language);
    const initialized = await extractor.init();
    if (!initialized) return;

    const content = await fs.readFile(filePath, "utf-8");
    const { symbols, refs } = extractor.extract(tree, filePath, content);

    // Add to index
    const normalizedFile = path.relative(this.cwd, filePath).replace(/\\/g, "/");
    const symbolIds: string[] = [];

    for (const symbol of symbols) {
      index.symbols.set(symbol.id, symbol);
      symbolIds.push(symbol.id);
    }

    index.byFile.set(normalizedFile, symbolIds);

    // Add references (will be resolved later)
    for (const ref of refs) {
      // Try to resolve to a symbol in the index
      const resolvedId = this.resolveReference(ref, index);
      if (resolvedId) {
        ref.symbolId = resolvedId;
        const existing = index.refs.get(resolvedId) || [];
        existing.push(ref);
        index.refs.set(resolvedId, existing);
      }
    }
  }

  private getLanguageId(filePath: string): string | null {
    if (filePath.endsWith(".ts")) return "typescript";
    if (filePath.endsWith(".tsx")) return "tsx";
    if (filePath.endsWith(".js")) return "javascript";
    if (filePath.endsWith(".jsx")) return "javascript";
    if (filePath.endsWith(".py")) return "python";
    if (filePath.endsWith(".rs")) return "rust";
    return null;
  }

  private resolveReference(ref: SymbolRef, index: SymbolIndex): string | null {
    // Try exact match by id pattern: file:name
    const parts = ref.symbolId.split(":");
    if (parts.length === 2) {
      // Check if exists
      if (index.symbols.has(ref.symbolId)) {
        return ref.symbolId;
      }
    }

    // Try to find by name in project
    for (const [id, symbol] of index.symbols) {
      if (symbol.name === parts[parts.length - 1]) {
        return id;
      }
    }

    return null;
  }

  private buildCallGraph(index: SymbolIndex): void {
    const edges: CallEdge[] = [];
    const adjacency = new Map<string, string[]>();
    const reverse = new Map<string, string[]>();

    // Build edges from references
    for (const [symbolId, refs] of index.refs) {
      for (const ref of refs) {
        // Find the containing function for this reference
        const caller = this.findContainingSymbol(ref, index);
        if (!caller) continue;

        const edge: CallEdge = {
          caller: caller.id,
          callerFile: ref.filePath,
          callerLine: ref.line,
          callerColumn: ref.column,
          callee: ref.symbolId,
          calleeResolved: index.symbols.has(ref.symbolId)
        };

        edges.push(edge);

        // Update adjacency (caller -> callees)
        const callees = adjacency.get(caller.id) || [];
        if (!callees.includes(ref.symbolId)) {
          callees.push(ref.symbolId);
          adjacency.set(caller.id, callees);
        }

        // Update reverse (callee -> callers)
        const callers = reverse.get(ref.symbolId) || [];
        if (!callers.includes(caller.id)) {
          callers.push(caller.id);
          reverse.set(ref.symbolId, callers);
        }
      }
    }

    // Find orphans (defined but never called)
    const orphans: string[] = [];
    for (const symbol of index.symbols.values()) {
      if (!symbol.isExported && !reverse.has(symbol.id)) {
        orphans.push(symbol.id);
      }
    }

    // Find entry points (called but we don't see their definition)
    const entryPoints: string[] = [];
    for (const edge of edges) {
      if (!index.symbols.has(edge.caller)) {
        entryPoints.push(edge.caller);
      }
    }

    // Detect cycles
    const cycles = this.detectCycles(adjacency);

    this.callGraph = {
      edges,
      adjacency,
      reverse,
      cycles,
      orphans,
      entryPoints: [...new Set(entryPoints)]
    };
  }

  private findContainingSymbol(ref: SymbolRef, index: SymbolIndex): Symbol | null {
    const normalizedFile = ref.filePath.replace(/\\/g, "/");
    const symbolIds = index.byFile.get(normalizedFile) || [];

    // Find the symbol that contains this reference (by line range)
    // This is simplified - assumes symbols are functions that contain the reference
    for (const id of symbolIds) {
      const symbol = index.symbols.get(id);
      if (!symbol) continue;

      // Simple heuristic: reference is in same file, assume it's in nearest preceding function
      // TODO: Implement proper range checking when we store end positions
      if (symbol.kind === 'function' || symbol.kind === 'method') {
        // For now, just return the first function symbol in the file
        // This will be improved with proper range tracking
        return symbol;
      }
    }

    return null;
  }

  private detectCycles(adjacency: Map<string, string[]>): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (node: string, path: string[]) => {
      visited.add(node);
      recStack.add(node);
      path.push(node);

      const neighbors = adjacency.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, path);
        } else if (recStack.has(neighbor)) {
          // Found a cycle
          const cycleStart = path.indexOf(neighbor);
          const cycle = path.slice(cycleStart);
          cycles.push([...cycle, neighbor]);
        }
      }

      path.pop();
      recStack.delete(node);
    };

    for (const node of adjacency.keys()) {
      if (!visited.has(node)) {
        dfs(node, []);
      }
    }

    return cycles;
  }
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit clients/symbol-service.ts`

Expected: No errors (may have warnings about 'any' types, that's ok)

**Step 3: Commit**

```bash
git add clients/symbol-service.ts
git commit -m "feat(symbol): add SymbolService with cache integration"
```

**Verification:**
- [ ] Service file created
- [ ] Compiles without errors
- [ ] Has all query methods (findDefinition, findReferences, etc.)
- [ ] Has call graph methods (findCallers, findImpact, findCycles)
- [ ] Integrates with CacheManager for turn-state
- [ ] Saves to `.pi-lens/symbol-index.json`
- [ ] Commit made

---

## Task 4: Add Symbol Queries to Tree-sitter Query Loader

**Files:**
- Read first: `clients/tree-sitter-query-loader.ts`
- Create: `rules/tree-sitter-queries/typescript/symbols.yml`

**Step 1: Create symbol query file**

Create `rules/tree-sitter-queries/typescript/symbols.yml`:

```yaml
---
id: symbol-function-def
name: Function Definition
severity: info
category: symbol
language: typescript
message: Function definition detected
query: |
  (function_declaration
    name: (identifier) @name
    parameters: (formal_parameters) @params
    body: (statement_block) @body) @def
metavars: [name, params, body, def]
has_fix: false
tags: [symbol, definition, function]

---
id: symbol-arrow-def
name: Arrow Function Definition
severity: info
category: symbol
language: typescript
message: Arrow function definition detected
query: |
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function
      parameters: (formal_parameters) @params
      body: (_) @body)) @def
metavars: [name, params, body, def]
has_fix: false
tags: [symbol, definition, function]

---
id: symbol-class-def
name: Class Definition
severity: info
category: symbol
language: typescript
message: Class definition detected
query: |
  (class_declaration
    name: (type_identifier) @name) @def
metavars: [name, def]
has_fix: false
tags: [symbol, definition, class]

---
id: symbol-method-def
name: Method Definition
severity: info
category: symbol
language: typescript
message: Method definition detected
query: |
  (method_definition
    name: (property_identifier) @name
    parameters: (formal_parameters) @params) @def
metavars: [name, params, def]
has_fix: false
tags: [symbol, definition, method]

---
id: symbol-function-call
name: Function Call
severity: info
category: symbol
language: typescript
message: Function call detected
query: |
  (call_expression
    function: (identifier) @callee) @ref
metavars: [callee, ref]
has_fix: false
tags: [symbol, reference, call]

---
id: symbol-method-call
name: Method Call
severity: info
category: symbol
language: typescript
message: Method call detected
query: |
  (call_expression
    function: (member_expression
      property: (property_identifier) @callee)) @ref
metavars: [callee, ref]
has_fix: false
tags: [symbol, reference, call]
```

**Step 2: Create Python symbols file**

Create `rules/tree-sitter-queries/python/symbols.yml`:

```yaml
---
id: symbol-function-def
name: Function Definition
severity: info
category: symbol
language: python
message: Function definition detected
query: |
  (function_definition
    name: (identifier) @name
    parameters: (parameters) @params) @def
metavars: [name, params, def]
has_fix: false
tags: [symbol, definition, function]

---
id: symbol-class-def
name: Class Definition
severity: info
category: symbol
language: python
message: Class definition detected
query: |
  (class_definition
    name: (identifier) @name) @def
metavars: [name, def]
has_fix: false
tags: [symbol, definition, class]

---
id: symbol-function-call
name: Function Call
severity: info
category: symbol
language: python
message: Function call detected
query: |
  (call
    function: (identifier) @callee) @ref
metavars: [callee, ref]
has_fix: false
tags: [symbol, reference, call]
```

**Step 3: Commit**

```bash
git add rules/tree-sitter-queries/typescript/symbols.yml
git add rules/tree-sitter-queries/python/symbols.yml
git commit -m "feat(symbol): add tree-sitter queries for symbol extraction"
```

**Verification:**
- [ ] TypeScript symbol queries created
- [ ] Python symbol queries created
- [ ] Queries have correct structure
- [ ] Commit made

---

## Task 5: Create Impact Runner

**Files:**
- Create: `clients/dispatch/runners/impact.ts`
- Read first: `clients/dispatch/types.ts`

**Step 1: Write impact runner**

Create `clients/dispatch/runners/impact.ts`:

```typescript
/**
 * Impact Runner: Warn about callers when editing functions
 * 
 * Uses SymbolService to find functions with callers and reports
 * potential impact of changes.
 */

import { SymbolService } from "../../symbol-service.js";
import type {
  Diagnostic,
  DispatchContext,
  RunnerDefinition,
  RunnerResult,
} from "../types.js";

const impactRunner: RunnerDefinition = {
  id: "impact",
  appliesTo: ["jsts", "python", "rust"],
  priority: 25, // After type-checking, before similarity
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const { filePath } = ctx;

    // Initialize symbol service
    const symbols = new SymbolService();
    
    // Get index (will load from cache or build)
    let index;
    try {
      index = await symbols.getIndex();
    } catch (err) {
      console.error("[impact] Failed to load symbol index:", err);
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    // Find symbols defined in this file
    const fileSymbols = symbols.findInFile(filePath);
    if (fileSymbols.length === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    // Get call graph for caller analysis
    let callGraph;
    try {
      callGraph = await symbols.getCallGraph();
    } catch (err) {
      console.error("[impact] Failed to load call graph:", err);
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const diagnostics: Diagnostic[] = [];

    for (const symbol of fileSymbols) {
      // Only show for exported functions that have callers
      if (!symbol.isExported) continue;
      if (symbol.kind !== 'function' && symbol.kind !== 'method') continue;

      const callers = callGraph.reverse.get(symbol.id) || [];
      if (callers.length === 0) continue;

      // Format caller list (show first 3, then "and N more")
      const callerNames = callers.slice(0, 3).map(id => {
        const parts = id.split(":");
        return parts[parts.length - 1]; // Just the function name
      });

      let callerMsg = callerNames.join(", ");
      if (callers.length > 3) {
        callerMsg += ` and ${callers.length - 3} more`;
      }

      diagnostics.push({
        id: `impact:${symbol.id}`,
        tool: "impact",
        rule: "function-with-callers",
        filePath,
        line: symbol.line,
        column: symbol.column,
        message: `Function '${symbol.name}' has ${callers.length} caller(s). ` +
                 `Changes may affect: ${callerMsg}`,
        severity: "info",
        semantic: "none", // Non-blocking
      });
    }

    return {
      status: "succeeded",
      diagnostics,
      semantic: "none",
    };
  },
};

export default impactRunner;
```

**Step 2: Register in runner index**

Modify `clients/dispatch/runners/index.ts`:

Add to imports:
```typescript
import impactRunner from "./impact.js";
```

Add to runners array:
```typescript
export const runners: RunnerDefinition[] = [
  // ... existing runners
  impactRunner,
  // ... rest
];
```

**Step 3: Verify compilation**

Run: `npx tsc --noEmit clients/dispatch/runners/impact.ts`

Expected: No errors

**Step 4: Commit**

```bash
git add clients/dispatch/runners/impact.ts
git add clients/dispatch/runners/index.ts
git commit -m "feat(impact): add impact runner for caller analysis"
```

**Verification:**
- [ ] Impact runner created
- [ ] Registered in index
- [ ] Compiles without errors
- [ ] Shows caller count for exported functions
- [ ] Non-blocking (info severity)
- [ ] Commit made

---

## Task 6: Enhance Similarity Runner with Signature Data

**Files:**
- Modify: `clients/dispatch/runners/similarity.ts`
- Read first: `clients/dispatch/runners/similarity.ts` (current implementation)

**Step 1: Add SymbolService import and signature pre-filter**

Modify `clients/dispatch/runners/similarity.ts`:

Add import:
```typescript
import { SymbolService } from "../../symbol-service.js";
```

In the `run` function, after loading the project index:

```typescript
// Load symbol index for signature data
let symbolService: SymbolService | null = null;
let symbolIndex: Awaited<ReturnType<SymbolService['getIndex']>> | null = null;

try {
  symbolService = new SymbolService(projectRoot);
  symbolIndex = await symbolService.getIndex();
} catch {
  // Symbol service optional - continue without it
  symbolService = null;
  symbolIndex = null;
}
```

Then in the function extraction loop:

```typescript
for (const func of newFunctions) {
  // Guardrail: Skip tiny functions
  if (func.transitionCount < CONFIG.MIN_TRANSITIONS) {
    continue;
  }

  // NEW: Get signature from symbol index for pre-filtering
  const symbolId = `${path.relative(projectRoot, filePath)}:${func.name}`;
  const signature = symbolService?.getSignature(symbolId);
  
  // Find similar functions in index
  const matches = findSimilarFunctions(
    func.matrix,
    index,
    CONFIG.SIMILARITY_THRESHOLD,
    CONFIG.MAX_SUGGESTIONS,
    signature // NEW: Pass signature for pre-filter
  );
  // ... rest of logic
}
```

**Step 2: Update findSimilarFunctions to use signature**

Modify the signature comparison in `findSimilarFunctions`:

```typescript
export function findSimilarFunctions(
  matrix: number[][],
  index: ProjectIndex,
  threshold = 0.75,
  maxResults = 3,
  sourceSignature?: string
): SimilarityMatch[] {
  const matches: SimilarityMatch[] = [];

  for (const entry of index.entries.values()) {
    // NEW: Quick signature pre-filter
    if (sourceSignature && entry.signature) {
      const sigSimilarity = compareSignatures(sourceSignature, entry.signature);
      // Skip if signatures are completely different (heuristic)
      if (sigSimilarity < 0.3) continue;
    }

    const similarity = calculateSimilarity(matrix, entry.matrix);

    if (similarity >= threshold) {
      matches.push({
        targetId: entry.id,
        targetName: entry.functionName,
        targetLocation: `${entry.filePath}:1`,
        similarity,
        signature: entry.signature,
      });
    }
  }

  // Sort by similarity descending, take top N
  return matches
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxResults);
}

// NEW: Simple signature comparison
function compareSignatures(a: string, b: string): number {
  // Normalize: remove whitespace, lowercase
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const na = normalize(a);
  const nb = normalize(b);
  
  // Extract parameter types
  const extractTypes = (s: string) => {
    const match = s.match(/\(([^)]*)\)/);
    if (!match) return [];
    return match[1].split(',').map(p => p.split(':')[1]?.trim()).filter(Boolean);
  };
  
  const typesA = extractTypes(a);
  const typesB = extractTypes(b);
  
  // Compare type count and types
  if (typesA.length !== typesB.length) {
    return 0.5; // Different arity
  }
  
  let matches = 0;
  for (let i = 0; i < typesA.length; i++) {
    if (typesA[i] === typesB[i]) matches++;
  }
  
  return typesA.length > 0 ? matches / typesA.length : 1;
}
```

**Step 3: Verify compilation**

Run: `npx tsc --noEmit clients/dispatch/runners/similarity.ts`

Expected: No errors

**Step 4: Commit**

```bash
git add clients/dispatch/runners/similarity.ts
git commit -m "feat(similarity): add signature pre-filter from SymbolService"
```

**Verification:**
- [ ] SymbolService integrated
- [ ] Signature pre-filter added
- [ ] Compiles without errors
- [ ] Commit made

---

## Task 7: Add Tests for SymbolService

**Files:**
- Create: `clients/symbol-service.test.ts`

**Step 1: Write tests**

Create `clients/symbol-service.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SymbolService } from "./symbol-service.js";

describe("SymbolService", () => {
  let tempDir: string;
  let service: SymbolService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-test-"));
    service = new SymbolService(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("index building", () => {
    it("should build index for TypeScript file", async () => {
      // Create test file
      const testFile = path.join(tempDir, "test.ts");
      await fs.writeFile(testFile, `
        export function foo(a: string, b: number): string {
          return a + b;
        }
        
        function bar() {
          foo("test", 1);
        }
      `);

      const index = await service.rebuild();

      // Should find both functions
      const symbols = Array.from(index.symbols.values());
      expect(symbols.length).toBeGreaterThanOrEqual(1);
      
      // Should find exported function
      const foo = symbols.find(s => s.name === "foo");
      expect(foo).toBeDefined();
      expect(foo?.isExported).toBe(true);
      expect(foo?.signature).toBeDefined();
    });

    it("should persist and load index", async () => {
      const testFile = path.join(tempDir, "test.ts");
      await fs.writeFile(testFile, `export function test() {}`);

      // Build and save
      await service.rebuild();

      // Create new service instance (simulating restart)
      const service2 = new SymbolService(tempDir);
      const index = await service2.getIndex();

      expect(index.symbols.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe("queries", () => {
    beforeEach(async () => {
      // Setup test files
      await fs.writeFile(path.join(tempDir, "utils.ts"), `
        export function helper(x: number): number {
          return x * 2;
        }
        
        export function unused() {
          return "dead code";
        }
      `);

      await fs.writeFile(path.join(tempDir, "main.ts"), `
        import { helper } from "./utils";
        
        export function main() {
          const result = helper(5);
          console.log(result);
        }
      `);

      await service.rebuild();
    });

    it("should find definitions by name", async () => {
      const def = service.findDefinition("helper");
      expect(def).toBeDefined();
      expect(def?.name).toBe("helper");
    });

    it("should find symbols in file", async () => {
      const symbols = service.findInFile(path.join(tempDir, "utils.ts"));
      expect(symbols.length).toBeGreaterThanOrEqual(1);
    });

    it("should find exported symbols", async () => {
      const exported = service.findExported(tempDir);
      expect(exported.length).toBeGreaterThanOrEqual(1);
      expect(exported.every(s => s.isExported)).toBe(true);
    });
  });

  describe("call graph", () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(tempDir, "a.ts"), `
        export function a() {
          b();
        }
        export function b() {
          c();
        }
        export function c() {}
      `);

      await service.rebuild();
    });

    it("should build call graph", async () => {
      const graph = await service.getCallGraph();
      expect(graph.edges.length).toBeGreaterThanOrEqual(1);
    });

    it("should find callers", async () => {
      const callers = await service.findCallers("a.ts:b");
      expect(callers).toContain("a.ts:a");
    });

    it("should find callees", async () => {
      const callees = await service.findCallees("a.ts:a");
      expect(callees).toContain("a.ts:b");
    });

    it("should find orphans", async () => {
      const orphans = await service.findOrphans();
      // 'c' is never called (if not exported and no calls)
      const orphanNames = orphans.map(o => o.name);
      expect(orphanNames).toContain("c");
    });
  });
});
```

**Step 2: Run tests**

Run: `npm test clients/symbol-service.test.ts`

Expected: Tests pass (may be skipped if tree-sitter not available, that's ok)

**Step 3: Commit**

```bash
git add clients/symbol-service.test.ts
git commit -m "test(symbol): add SymbolService unit tests"
```

**Verification:**
- [ ] Test file created
- [ ] Tests cover index building, queries, call graph
- [ ] Tests pass or skip gracefully
- [ ] Commit made

---

## Task 8: Integration Test - End-to-End

**Files:**
- Create: `clients/__tests__/symbol-integration.test.ts`

**Step 1: Create integration test**

Create `clients/__tests__/symbol-integration.test.ts`:

```typescript
import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SymbolService } from "../symbol-service.js";
import { CacheManager } from "../cache-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

describe("Symbol Integration", () => {
  const projectRoot = path.join(FIXTURES_DIR, "symbol-project");

  beforeAll(async () => {
    // Create fixture project
    await fs.mkdir(projectRoot, { recursive: true });
    
    // Create math.ts
    await fs.writeFile(
      path.join(projectRoot, "math.ts"),
      `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

function privateHelper(x: number): number {
  return x * 2;
}
`
    );

    // Create main.ts
    await fs.writeFile(
      path.join(projectRoot, "main.ts"),
      `
import { add, multiply } from "./math";

export function calculate() {
  const sum = add(1, 2);
  const product = multiply(3, 4);
  return sum + product;
}

export function unused() {
  return "never called";
}
`
    );
  });

  it("should extract all symbols from project", async () => {
    const service = new SymbolService(projectRoot);
    const index = await service.rebuild();

    const symbols = Array.from(index.symbols.values());
    
    // Should find exported functions
    const add = symbols.find(s => s.name === "add");
    expect(add).toBeDefined();
    expect(add?.isExported).toBe(true);
    
    const multiply = symbols.find(s => s.name === "multiply");
    expect(multiply).toBeDefined();
    
    // Should find non-exported function
    const helper = symbols.find(s => s.name === "privateHelper");
    expect(helper).toBeDefined();
    expect(helper?.isExported).toBe(false);
  });

  it("should build call graph with correct edges", async () => {
    const service = new SymbolService(projectRoot);
    await service.rebuild();
    
    const graph = await service.getCallGraph();
    
    // calculate() calls add() and multiply()
    const calculateCallers = await service.findCallers("main.ts:calculate");
    // calculate is exported but not called within project (entry point)
    expect(calculateCallers.length).toBe(0);
    
    const addCallers = await service.findCallers("math.ts:add");
    expect(addCallers).toContain("main.ts:calculate");
    
    const multiplyCallers = await service.findCallers("math.ts:multiply");
    expect(multiplyCallers).toContain("main.ts:calculate");
  });

  it("should detect orphans (unused functions)", async () => {
    const service = new SymbolService(projectRoot);
    await service.rebuild();
    
    const orphans = await service.findOrphans();
    const orphanNames = orphans.map(o => o.name);
    
    // privateHelper is not exported and not called
    expect(orphanNames).toContain("privateHelper");
    
    // unused() is exported so it's not an orphan (may be called externally)
    expect(orphanNames).not.toContain("unused");
  });

  it("should update incrementally on file change", async () => {
    const service = new SymbolService(projectRoot);
    await service.rebuild();
    
    // Initially has 5 functions
    let index = await service.getIndex();
    expect(index.symbols.size).toBe(5);
    
    // Simulate file change via turn state
    const cache = new CacheManager();
    cache.addModifiedRange(
      path.join(projectRoot, "math.ts"),
      { start: 1, end: 10 },
      false,
      projectRoot
    );
    
    // Update should pick up the change
    index = await service.update();
    
    // Index should still be valid
    expect(index.symbols.size).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 2: Run integration tests**

Run: `npm test clients/__tests__/symbol-integration.test.ts`

Expected: Tests pass or skip gracefully

**Step 3: Commit**

```bash
git add clients/__tests__/symbol-integration.test.ts
git commit -m "test(symbol): add integration tests"
```

**Verification:**
- [ ] Integration test file created
- [ ] Tests pass
- [ ] Commit made

---

## Task 9: Documentation Update

**Files:**
- Modify: `AGENTS.md` (add symbol service section)

**Step 1: Add section to AGENTS.md**

Add to `AGENTS.md`:

```markdown
## Symbol Extraction & Call Graph

pi-lens extracts symbol definitions and references using tree-sitter queries.

### SymbolService
- Builds project-wide symbol index (`.pi-lens/symbol-index.json`)
- 24hr cache TTL, incremental updates via turn-state tracking
- Supports TypeScript, Python, Rust

### Usage
```typescript
import { SymbolService } from "./clients/symbol-service.js";

const symbols = new SymbolService();
const index = await symbols.getIndex();

// Find definitions
const def = symbols.findDefinition("myFunction");

// Find references
const refs = symbols.findReferences("file.ts:myFunction");

// Impact analysis
const callers = await symbols.findCallers("file.ts:myFunction");
const allImpacted = await symbols.findImpact("file.ts:myFunction");

// Dead code detection
const orphans = await symbols.findOrphans();

// Circular dependencies
const cycles = await symbols.findCycles();
```

### Call Graph
- Built automatically with symbol index
- Tracks caller → callee relationships
- Detects circular dependencies
- Identifies orphaned (unused) functions

### Runners Using Symbols
- **impact**: Shows caller count for exported functions (non-blocking)
- **similarity**: Uses signature pre-filter for faster matching
```

**Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: add SymbolService and call graph documentation"
```

**Verification:**
- [ ] AGENTS.md updated
- [ ] Documentation is clear
- [ ] Commit made

---

## Summary

After completing all tasks, pi-lens will have:

1. **SymbolService** - Core service for symbol extraction and queries
2. **Tree-sitter integration** - Queries for TS, Python, Rust
3. **Call graph** - Caller/callee tracking with cycle detection
4. **Impact runner** - Warns about callers when editing functions
5. **Enhanced similarity** - Signature pre-filter for better matching
6. **Caching** - 24hr TTL, incremental updates via turn-state
7. **Tests** - Unit and integration tests
8. **Documentation** - AGENTS.md updated

**Performance targets:**
- Cache hit: <50ms
- Incremental update: <200ms
- Full rebuild: <5s
- Call graph query: <10ms
