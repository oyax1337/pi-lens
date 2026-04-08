import type { FileKind } from "../file-kinds.js";
import type { RunnerGroup, ToolPlan } from "./types.js";

type CapabilityDimension =
	| "types"
	| "security"
	| "smells"
	| "format"
	| "lint"
	| "architecture"
	| "docs";

interface CapabilityMatrixEntry {
	name: string;
	capabilities: CapabilityDimension[];
	writeGroups: RunnerGroup[];
	fullOnlyGroups?: RunnerGroup[];
}

export const LANGUAGE_CAPABILITY_MATRIX: Record<FileKind, CapabilityMatrixEntry> = {
	jsts: {
		name: "JavaScript/TypeScript Linting",
		capabilities: ["types", "security", "smells", "format", "lint", "architecture"],
		writeGroups: [
			{ mode: "fallback", runnerIds: ["lsp", "ts-lsp"], filterKinds: ["jsts"] },
			{ mode: "all", runnerIds: ["biome-check-json"], filterKinds: ["jsts"] },
			{ mode: "all", runnerIds: ["tree-sitter"], filterKinds: ["jsts"] },
			{ mode: "all", runnerIds: ["ast-grep-napi"], filterKinds: ["jsts"] },
			{ mode: "fallback", runnerIds: ["type-safety"], filterKinds: ["jsts"] },
			{ mode: "fallback", runnerIds: ["similarity"], filterKinds: ["jsts"] },
			{ mode: "fallback", runnerIds: ["eslint"], filterKinds: ["jsts"] },
			{ mode: "fallback", runnerIds: ["architect"], filterKinds: ["jsts"] },
		],
		fullOnlyGroups: [
			{ mode: "fallback", runnerIds: ["biome-lint", "oxlint"], filterKinds: ["jsts"] },
		],
	},
	python: {
		name: "Python Linting",
		capabilities: ["types", "lint", "architecture", "smells"],
		writeGroups: [
			{ mode: "fallback", runnerIds: ["lsp", "pyright"], filterKinds: ["python"] },
			{ mode: "fallback", runnerIds: ["ruff-lint"], filterKinds: ["python"] },
			{ mode: "fallback", runnerIds: ["architect"], filterKinds: ["python"] },
		],
		fullOnlyGroups: [
			{ mode: "fallback", runnerIds: ["python-slop"], filterKinds: ["python"] },
		],
	},
	go: {
		name: "Go Linting",
		capabilities: ["types", "lint", "smells"],
		writeGroups: [
			{ mode: "all", runnerIds: ["lsp"], filterKinds: ["go"] },
			{ mode: "fallback", runnerIds: ["go-vet"], filterKinds: ["go"] },
			{ mode: "fallback", runnerIds: ["golangci-lint"], filterKinds: ["go"] },
			{ mode: "all", runnerIds: ["tree-sitter"], filterKinds: ["go"] },
		],
	},
	rust: {
		name: "Rust Linting",
		capabilities: ["types", "lint", "smells"],
		writeGroups: [
			{ mode: "all", runnerIds: ["lsp"], filterKinds: ["rust"] },
			{ mode: "fallback", runnerIds: ["rust-clippy"], filterKinds: ["rust"] },
			{ mode: "all", runnerIds: ["tree-sitter"], filterKinds: ["rust"] },
		],
	},
	ruby: {
		name: "Ruby Linting",
		capabilities: ["types", "lint", "smells"],
		writeGroups: [
			{ mode: "all", runnerIds: ["lsp"], filterKinds: ["ruby"] },
			{ mode: "fallback", runnerIds: ["rubocop"], filterKinds: ["ruby"] },
			{ mode: "all", runnerIds: ["tree-sitter"], filterKinds: ["ruby"] },
		],
	},
	cxx: {
		name: "C/C++ Linting",
		capabilities: ["types", "lint"],
		writeGroups: [{ mode: "fallback", runnerIds: ["lsp"], filterKinds: ["cxx"] }],
	},
	cmake: {
		name: "CMake Processing",
		capabilities: ["lint"],
		writeGroups: [{ mode: "fallback", runnerIds: ["lsp"], filterKinds: ["cmake"] }],
	},
	shell: {
		name: "Shell Script Linting",
		capabilities: ["lint", "security"],
		writeGroups: [{ mode: "fallback", runnerIds: ["shellcheck"] }],
	},
	json: {
		name: "JSON Processing",
		capabilities: ["format"],
		writeGroups: [{ mode: "fallback", runnerIds: ["lsp"], filterKinds: ["json"] }],
	},
	markdown: {
		name: "Markdown Processing",
		capabilities: ["docs"],
		writeGroups: [
			{ mode: "fallback", runnerIds: ["lsp"], filterKinds: ["markdown"] },
			{ mode: "fallback", runnerIds: ["spellcheck"] },
		],
	},
	css: {
		name: "CSS Processing",
		capabilities: ["format", "lint"],
		writeGroups: [{ mode: "fallback", runnerIds: ["lsp"], filterKinds: ["css"] }],
	},
	yaml: {
		name: "YAML Processing",
		capabilities: ["format", "lint"],
		writeGroups: [{ mode: "fallback", runnerIds: ["yamllint"], filterKinds: ["yaml"] }],
	},
	sql: {
		name: "SQL Processing",
		capabilities: ["format", "lint"],
		writeGroups: [{ mode: "fallback", runnerIds: ["sqlfluff"], filterKinds: ["sql"] }],
	},
};

function toWritePlan(entry: CapabilityMatrixEntry): ToolPlan {
	return {
		name: entry.name,
		groups: [...entry.writeGroups],
	};
}

function toFullPlan(kind: FileKind, entry: CapabilityMatrixEntry): ToolPlan {
	if (kind === "jsts") {
		return {
			name: "JavaScript/TypeScript Full Lint",
			groups: [
				{ mode: "fallback", runnerIds: ["lsp", "ts-lsp"], filterKinds: ["jsts"] },
				{ mode: "all", runnerIds: ["tree-sitter"], filterKinds: ["jsts"] },
				{ mode: "all", runnerIds: ["ast-grep-napi"], filterKinds: ["jsts"] },
				...(entry.fullOnlyGroups ?? []),
				{ mode: "fallback", runnerIds: ["type-safety"], filterKinds: ["jsts"] },
				{ mode: "fallback", runnerIds: ["similarity"], filterKinds: ["jsts"] },
				{ mode: "fallback", runnerIds: ["architect"], filterKinds: ["jsts"] },
				{ mode: "fallback", runnerIds: ["eslint"], filterKinds: ["jsts"] },
			],
		};
	}

	if (kind === "python") {
		return {
			name: "Python Full Lint",
			groups: [
				{ mode: "fallback", runnerIds: ["lsp", "pyright"], filterKinds: ["python"] },
				{ mode: "fallback", runnerIds: ["ruff-lint"], filterKinds: ["python"] },
				...(entry.fullOnlyGroups ?? []),
				{ mode: "fallback", runnerIds: ["architect"], filterKinds: ["python"] },
			],
		};
	}

	return {
		name: entry.name,
		groups: [...entry.writeGroups, ...(entry.fullOnlyGroups ?? [])],
	};
}

export const TOOL_PLANS: Record<string, ToolPlan> = Object.fromEntries(
	Object.entries(LANGUAGE_CAPABILITY_MATRIX).map(([kind, entry]) => [
		kind,
		toWritePlan(entry),
	]),
) as Record<string, ToolPlan>;

export function getToolPlan(kind: FileKind): ToolPlan | undefined {
	return TOOL_PLANS[kind];
}

export function getAllToolPlans(): Record<string, ToolPlan> {
	return TOOL_PLANS;
}

export const FULL_LINT_PLANS: Record<string, ToolPlan> = Object.fromEntries(
	Object.entries(LANGUAGE_CAPABILITY_MATRIX).map(([kind, entry]) => [
		kind,
		toFullPlan(kind as FileKind, entry),
	]),
) as Record<string, ToolPlan>;
