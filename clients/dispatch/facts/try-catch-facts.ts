import * as ts from "typescript";
import type { FactProvider } from "../fact-provider-types.js";

export interface TryCatchSummary {
  line: number;
  column: number;
  catchParam: string | null;
  bodyText: string;
  isEmpty: boolean;
  hasRethrow: boolean;
  hasLogging: boolean;
}

function isOnlyWhitespaceOrComments(text: string): boolean {
  // Remove block comments
  let stripped = text.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove line comments
  stripped = stripped.replace(/\/\/[^\n]*/g, "");
  return stripped.trim().length === 0;
}

export const tryCatchFactProvider: FactProvider = {
  id: "tryCatchFacts",
  provides: ["file.tryCatchSummaries"],
  requires: ["file.content"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath);
  },
  run(ctx, store) {
    const content = store.getFileFact<string>(ctx.filePath, "file.content");
    if (!content) {
      store.setFileFact(ctx.filePath, "file.tryCatchSummaries", []);
      return;
    }

    const sourceFile = ts.createSourceFile(
      ctx.filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const summaries: TryCatchSummary[] = [];

    function visit(node: ts.Node): void {
      if (ts.isCatchClause(node)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const line = pos.line + 1;
        const column = pos.character + 1;

        let catchParam: string | null = null;
        if (node.variableDeclaration) {
          const name = node.variableDeclaration.name;
          if (ts.isIdentifier(name)) {
            catchParam = name.text;
          }
        }

        const bodyText = node.block.getText(sourceFile)
          .replace(/^\{/, "")
          .replace(/\}$/, "")
          .trim();

        const isEmpty = isOnlyWhitespaceOrComments(bodyText);
        const hasRethrow = /\bthrow\b/.test(bodyText);
        const hasLogging =
          /\bconsole\.(log|warn|error)\b/.test(bodyText) ||
          /\blogger\./.test(bodyText);

        summaries.push({ line, column, catchParam, bodyText, isEmpty, hasRethrow, hasLogging });
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    store.setFileFact(ctx.filePath, "file.tryCatchSummaries", summaries);
  },
};
