import { describe, it, expect } from "vitest";
import { ComplexityClient } from "./complexity-client.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("ComplexityClient", () => {
  const client = new ComplexityClient();
  let tmpDir: string;

  // Create temp dir for test files
  function createTempFile(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  // Setup before each test
  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-test-"));
  }

  // Cleanup after each test
  function cleanup() {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  }

  describe("isSupportedFile", () => {
    it("should support TypeScript files", () => {
      expect(client.isSupportedFile("test.ts")).toBe(true);
      expect(client.isSupportedFile("test.tsx")).toBe(true);
    });

    it("should support JavaScript files", () => {
      expect(client.isSupportedFile("test.js")).toBe(true);
      expect(client.isSupportedFile("test.jsx")).toBe(true);
      expect(client.isSupportedFile("test.mjs")).toBe(true);
      expect(client.isSupportedFile("test.cjs")).toBe(true);
    });

    it("should not support non-TS/JS files", () => {
      expect(client.isSupportedFile("test.py")).toBe(false);
      expect(client.isSupportedFile("test.json")).toBe(false);
      expect(client.isSupportedFile("test.md")).toBe(false);
    });
  });

  describe("analyzeFile", () => {
    it("should return null for non-existent files", () => {
      const result = client.analyzeFile("/nonexistent/file.ts");
      expect(result).toBeNull();
    });

    it("should analyze a simple function", () => {
      setup();
      try {
        const content = `
function greet(name: string): string {
  return "Hello, " + name;
}
`;
        const filePath = createTempFile("simple.ts", content);
        const result = client.analyzeFile(filePath);

        expect(result).not.toBeNull();
        expect(result!.functionCount).toBe(1);
        expect(result!.cyclomaticComplexity).toBe(1);
        expect(result!.cognitiveComplexity).toBe(0);
        expect(result!.maxNestingDepth).toBeGreaterThanOrEqual(1);
      } finally {
        cleanup();
      }
    });

    it("should detect if statements in cyclomatic complexity", () => {
      setup();
      try {
        const content = `
function check(x: number): string {
  if (x > 0) {
    return "positive";
  } else if (x < 0) {
    return "negative";
  } else {
    return "zero";
  }
}
`;
        const filePath = createTempFile("if-test.ts", content);
        const result = client.analyzeFile(filePath);

        expect(result).not.toBeNull();
        // 1 base + 1 if + 1 else-if = 3
        expect(result!.cyclomaticComplexity).toBeGreaterThanOrEqual(3);
      } finally {
        cleanup();
      }
    });

    it("should calculate maintainability index", () => {
      setup();
      try {
        const content = `
function simple(): number {
  return 42;
}
`;
        const filePath = createTempFile("mi-test.ts", content);
        const result = client.analyzeFile(filePath);

        expect(result).not.toBeNull();
        expect(result!.maintainabilityIndex).toBeGreaterThan(0);
        expect(result!.maintainabilityIndex).toBeLessThanOrEqual(100);
      } finally {
        cleanup();
      }
    });

    it("should detect deep nesting", () => {
      setup();
      try {
        const content = `
function deepNest(arr: number[][][][]): number {
  for (let i = 0; i < arr.length; i++) {
    for (let j = 0; j < arr[i].length; j++) {
      for (let k = 0; k < arr[i][j].length; k++) {
        for (let l = 0; l < arr[i][j][k].length; l++) {
          if (arr[i][j][k][l] > 0) {
            return arr[i][j][k][l];
          }
        }
      }
    }
  }
  return 0;
}
`;
        const filePath = createTempFile("nesting-test.ts", content);
        const result = client.analyzeFile(filePath);

        expect(result).not.toBeNull();
        expect(result!.maxNestingDepth).toBeGreaterThanOrEqual(5);
      } finally {
        cleanup();
      }
    });

    it("should count cognitive complexity with nesting penalty", () => {
      setup();
      try {
        const content = `
function nested(x: number, y: number): number {
  if (x > 0) {
    if (y > 0) {
      if (x > y) {
        return 1;
      }
    }
  }
  return 0;
}
`;
        const filePath = createTempFile("cognitive-test.ts", content);
        const result = client.analyzeFile(filePath);

        expect(result).not.toBeNull();
        // Cognitive: 1 (if) + 2 (nested if) + 3 (deeply nested if) = 6
        expect(result!.cognitiveComplexity).toBeGreaterThanOrEqual(6);
      } finally {
        cleanup();
      }
    });

    it("should calculate halstead volume", () => {
      setup();
      try {
        const content = `
function add(a: number, b: number): number {
  return a + b;
}
`;
        const filePath = createTempFile("halstead-test.ts", content);
        const result = client.analyzeFile(filePath);

        expect(result).not.toBeNull();
        expect(result!.halsteadVolume).toBeGreaterThan(0);
      } finally {
        cleanup();
      }
    });

    it("should measure function length", () => {
      setup();
      try {
        const shortContent = `function short() { return 1; }`;
        const longContent = `
function long(): number {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  const f = 6;
  const g = 7;
  const h = 8;
  const i = 9;
  const j = 10;
  return a + b + c + d + e + f + g + h + i + j;
}
`;
        const shortPath = createTempFile("short.ts", shortContent);
        const longPath = createTempFile("long.ts", longContent);

        const shortResult = client.analyzeFile(shortPath);
        const longResult = client.analyzeFile(longPath);

        expect(shortResult!.maxFunctionLength).toBeLessThan(longResult!.maxFunctionLength);
      } finally {
        cleanup();
      }
    });
  });

  describe("formatMetrics", () => {
    it("should format metrics for display", () => {
      const metrics = {
        filePath: "test.ts",
        maxNestingDepth: 4,
        avgFunctionLength: 15,
        maxFunctionLength: 30,
        functionCount: 3,
        cyclomaticComplexity: 4,
        maxCyclomaticComplexity: 8,
        cognitiveComplexity: 12,
        halsteadVolume: 200,
        maintainabilityIndex: 75,
        linesOfCode: 100,
        commentLines: 10,
        codeEntropy: 0.5,
      };

      const formatted = client.formatMetrics(metrics);
      expect(formatted).toContain("test.ts");
      expect(formatted).toContain("75/100");
    });

    it("should warn about low maintainability", () => {
      const metrics = {
        filePath: "bad.ts",
        maxNestingDepth: 8,
        avgFunctionLength: 60,
        maxFunctionLength: 100,
        functionCount: 5,
        cyclomaticComplexity: 15,
        maxCyclomaticComplexity: 25,
        cognitiveComplexity: 50,
        halsteadVolume: 800,
        maintainabilityIndex: 25,
        linesOfCode: 500,
        commentLines: 10,
        codeEntropy: 0.5,
      };

      const formatted = client.formatMetrics(metrics);
      expect(formatted).toContain("✗");  // Low MI indicator
    });
  });
});
