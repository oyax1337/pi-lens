import * as nodeFs from "node:fs";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { logReadGuardEvent } from "./read-guard-logger.js";

export function countFileLines(filePath: string): number {
	try {
		const content = nodeFs.readFileSync(filePath, "utf-8");
		if (content.length === 0) return 1;
		return content.split(/\r?\n/).length;
	} catch {
		return 1;
	}
}

export function getTouchedLinesForGuard(
	event: unknown,
	filePath?: string,
	sessionId?: string,
): [number, number] | undefined {
	if (isToolCallEventType("edit", event as any)) {
		const editInput = (event as { input?: unknown }).input as {
			oldRange?: { start: { line: number }; end: { line: number } };
			edits?: Array<{
				range?: { start?: { line: number }; end?: { line: number } };
			}>;
		};
		if (editInput.oldRange) {
			const touchedLines: [number, number] = [
				editInput.oldRange.start.line,
				editInput.oldRange.end.line,
			];
			if (filePath) {
				logReadGuardEvent({
					event: "touched_lines_detected",
					sessionId,
					filePath,
					metadata: {
						tool: "edit",
						source: "oldRange",
						touchedLines,
					},
				});
			}
			return touchedLines;
		}
		if (editInput.edits?.length) {
			const rangedEdits = editInput.edits
				.map((edit) => {
					const start = edit.range?.start?.line;
					const end = edit.range?.end?.line ?? start;
					if (typeof start !== "number" || typeof end !== "number") {
						return null;
					}
					return [start, end] as [number, number];
				})
				.filter((range): range is [number, number] => range !== null);
			if (rangedEdits.length === 0) {
				if (filePath) {
					logReadGuardEvent({
						event: "touched_lines_missing",
						sessionId,
						filePath,
						metadata: {
							tool: "edit",
							source: "edits_without_ranges",
							editCount: editInput.edits.length,
						},
					});
				}
				return undefined;
			}
			const starts = rangedEdits.map(([start]) => start);
			const ends = rangedEdits.map(([, end]) => end);
			const touchedLines: [number, number] = [
				Math.min(...starts),
				Math.max(...ends),
			];
			if (filePath) {
				logReadGuardEvent({
					event: "touched_lines_detected",
					sessionId,
					filePath,
					metadata: {
						tool: "edit",
						source: "edits_ranges",
						touchedLines,
						rangedEditCount: rangedEdits.length,
						totalEditCount: editInput.edits.length,
					},
				});
			}
			return touchedLines;
		}
		if (filePath) {
			logReadGuardEvent({
				event: "touched_lines_missing",
				sessionId,
				filePath,
				metadata: {
					tool: "edit",
					source: "no_oldRange_or_edits",
				},
			});
		}
		return undefined;
	}

	if (isToolCallEventType("write", event as any)) {
		const lineCount = filePath ? countFileLines(filePath) : 1;
		const touchedLines: [number, number] = [1, lineCount];
		if (filePath) {
			logReadGuardEvent({
				event: "touched_lines_detected",
				sessionId,
				filePath,
				metadata: {
					tool: "write",
					source: "full_file_write",
					touchedLines,
					lineCount,
				},
			});
		}
		return touchedLines;
	}

	return undefined;
}
