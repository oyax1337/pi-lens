import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function usage() {
	console.error(
		"Usage: node scripts/run-harness.mjs <case-dir> [--model provider/model] [--pi-bin /path/to/pi]",
	);
}

function timestampDirName() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function copyDir(source, target) {
	fs.cpSync(source, target, { recursive: true });
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stringifySnippet(value) {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function parseArgs(argv) {
	const args = [...argv];
	const result = { caseDir: undefined, model: undefined, piBin: undefined };
	while (args.length > 0) {
		const arg = args.shift();
		if (!arg) continue;
		if (arg === "--model") {
			result.model = args.shift();
			continue;
		}
		if (arg === "--pi-bin") {
			result.piBin = args.shift();
			continue;
		}
		if (!result.caseDir) {
			result.caseDir = arg;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return result;
}

const {
	caseDir,
	model: modelOverride,
	piBin: piBinOverride,
} = parseArgs(process.argv.slice(2));
if (!caseDir) {
	usage();
	process.exit(1);
}

const resolvedCaseDir = path.resolve(repoRoot, caseDir);
const caseFile = path.join(resolvedCaseDir, "case.json");
const promptFile = path.join(resolvedCaseDir, "prompt.txt");
const workspaceSource = path.join(resolvedCaseDir, "workspace");

if (!fs.existsSync(caseFile)) throw new Error(`Missing case file: ${caseFile}`);
if (!fs.existsSync(promptFile))
	throw new Error(`Missing prompt file: ${promptFile}`);
if (!fs.existsSync(workspaceSource)) {
	throw new Error(`Missing workspace directory: ${workspaceSource}`);
}

const manifest = readJson(caseFile);
const prompt = fs.readFileSync(promptFile, "utf8").trim();
const model =
	modelOverride || manifest.model || process.env.PI_LENS_HARNESS_MODEL;
if (!model) {
	throw new Error(
		"No model configured. Set it in case.json, pass --model, or export PI_LENS_HARNESS_MODEL.",
	);
}

const runRoot = path.join(
	repoRoot,
	".harness",
	"runs",
	timestampDirName(),
	manifest.name,
);
const workspaceDir = path.join(runRoot, "workspace");
const harnessPromptFile = path.join(workspaceDir, "HARNESS_PROMPT.txt");
ensureDir(runRoot);
copyDir(workspaceSource, workspaceDir);
fs.writeFileSync(path.join(runRoot, "prompt.txt"), `${prompt}\n`, "utf8");
fs.writeFileSync(harnessPromptFile, `${prompt}\n`, "utf8");
fs.writeFileSync(
	path.join(runRoot, "manifest.json"),
	JSON.stringify(manifest, null, 2),
);

const piArgs = [
	"--print",
	"--mode",
	"json",
	"--no-session",
	"--thinking",
	"low",
	"--no-extensions",
	"--extension",
	path.join(repoRoot, "index.ts"),
	"--model",
	model,
	"@HARNESS_PROMPT.txt",
	"Follow the instructions in HARNESS_PROMPT.txt exactly. Do not modify package.json, tsconfig.json, or HARNESS_PROMPT.txt. Do not add dependencies or use npm install. Prefer read, write, and edit over bash unless bash is strictly necessary.",
];

function runPi(args, cwd, piBinOverride) {
	const env = {
		...process.env,
		PI_LENS_STARTUP_MODE: process.env.PI_LENS_STARTUP_MODE || "quick",
	};
	const appData = process.env.APPDATA || process.env.Roaming || "";
	const configuredPiBin = piBinOverride || process.env.PI_HARNESS_PI_BIN;
	const attempts = [];
	if (configuredPiBin) attempts.push([configuredPiBin, args]);
	if (process.platform === "win32") {
		attempts.push(
			[path.join(appData, "npm", "pi.cmd"), args],
			[
				path.join(appData, "npm", "npx.cmd"),
				["@mariozechner/pi-coding-agent", ...args],
			],
			["pi.cmd", args],
			["pi", args],
			["npx.cmd", ["@mariozechner/pi-coding-agent", ...args]],
		);
	} else {
		attempts.push(
			["pi", args],
			["npx", ["@mariozechner/pi-coding-agent", ...args]],
		);
	}

	for (const [command, commandArgs] of attempts) {
		const result = spawnSync(command, commandArgs, {
			cwd,
			encoding: "utf8",
			maxBuffer: 20 * 1024 * 1024,
			env,
			shell:
				process.platform === "win32" && /\.(cmd|bat)$/i.test(String(command)),
		});
		if (result.error) continue;
		return { command, args: commandArgs, result };
	}

	return {
		command: "pi",
		args,
		result: {
			stdout: "",
			stderr: "",
			status: null,
			signal: null,
			error: new Error("Unable to locate pi or npx on PATH."),
		},
	};
}

const startedAt = Date.now();
const execution = runPi(piArgs, workspaceDir, piBinOverride);
const child = execution.result;
const durationMs = Date.now() - startedAt;

const stdout = child.stdout || "";
const stderr = child.stderr || "";
fs.writeFileSync(path.join(runRoot, "stdout.jsonl"), stdout, "utf8");
fs.writeFileSync(path.join(runRoot, "stderr.txt"), stderr, "utf8");

const events = [];
for (const line of stdout.split(/\r?\n/)) {
	if (!line.trim()) continue;
	try {
		events.push(JSON.parse(line));
	} catch {
		// Keep raw output on disk; summary stays best-effort.
	}
}

const toolCalls = [];
const toolResults = [];
let assistantText = "";
for (const event of events) {
	if (event?.type === "tool_execution_start") {
		toolCalls.push({ toolName: event.toolName, args: event.args });
	}
	if (event?.type === "tool_execution_end") {
		toolResults.push({
			toolName: event.toolName,
			isError: Boolean(event.isError),
			resultSnippet: stringifySnippet(event.result).slice(0, 1000),
		});
	}
	if (
		event?.type === "message_update" &&
		event?.assistantMessageEvent?.type === "text_delta" &&
		typeof event.assistantMessageEvent.delta === "string"
	) {
		assistantText += event.assistantMessageEvent.delta;
	}
}

const expectedFiles = Array.isArray(manifest.expectedFiles)
	? manifest.expectedFiles.map((relativePath) => ({
			path: relativePath,
			exists: fs.existsSync(path.join(workspaceDir, relativePath)),
		}))
	: [];

const expectedToolCalls = Array.isArray(manifest.expectedToolCalls)
	? manifest.expectedToolCalls.map((toolName) => ({
			toolName,
			called: toolCalls.some((call) => call.toolName === toolName),
		}))
	: [];

const summary = {
	name: manifest.name,
	description: manifest.description || "",
	model,
	cwd: workspaceDir,
	command: execution.command,
	commandArgs: execution.args,
	durationMs,
	exitCode: child.status,
	signal: child.signal,
	error: child.error ? String(child.error) : null,
	success:
		child.status === 0 &&
		expectedFiles.every((entry) => entry.exists) &&
		expectedToolCalls.every((entry) => entry.called),
	expectedFiles,
	expectedToolCalls,
	toolCallCount: toolCalls.length,
	toolsUsed: [...new Set(toolCalls.map((call) => call.toolName))],
	toolCalls,
	toolResults,
	assistantText: assistantText.trim(),
	stderrSnippet: stderr.slice(0, 4000),
};

fs.writeFileSync(
	path.join(runRoot, "summary.json"),
	JSON.stringify(summary, null, 2),
	"utf8",
);

console.log(JSON.stringify(summary, null, 2));
if (!summary.success) process.exitCode = 1;
