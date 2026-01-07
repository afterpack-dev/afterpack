import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * End-to-end tests for the AfterPack CLI.
 *
 * Note: These tests require @afterpack/core to be installed.
 * They will be skipped if the native addon is not available.
 */

const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

function runCLI(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      exitCode: error.status || 1,
    };
  }
}

describe("AfterPack CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "afterpack-e2e-"));
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  describe("--version", () => {
    it("should display version", () => {
      const { stdout, exitCode } = runCLI("--version");
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/AfterPack v\d+\.\d+\.\d+/);
    });

    it("should work with -v flag", () => {
      const { stdout, exitCode } = runCLI("-v");
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/v\d+\.\d+\.\d+/);
    });
  });

  describe("--help", () => {
    it("should display help", () => {
      const { stdout, exitCode } = runCLI("--help");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("npx afterpack");
      expect(stdout).toContain("afterpack.dev");
    });

    it("should work with -h flag", () => {
      const { stdout, exitCode } = runCLI("-h");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage:");
    });

    it("should show help when no arguments", () => {
      const { stdout, exitCode } = runCLI("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage:");
    });
  });

  describe("file processing", () => {
    it("should process a JavaScript file", () => {
      const testFile = join(tmpDir, "test.js");
      writeFileSync(testFile, 'console.log("hello");');

      const { stdout, exitCode } = runCLI(testFile);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Processing:");
      expect(stdout).toContain("Done!");

      const content = readFileSync(testFile, "utf8");
      expect(content).toContain('console.log("hello");');
      expect(content).toContain("// Processed by AfterPack");
    });

    it("should process .mjs files", () => {
      const testFile = join(tmpDir, "test.mjs");
      writeFileSync(testFile, 'export const x = 1;');

      const { exitCode } = runCLI(testFile);
      expect(exitCode).toBe(0);

      const content = readFileSync(testFile, "utf8");
      expect(content).toContain("// Processed by AfterPack");
    });

    it("should process .cjs files", () => {
      const testFile = join(tmpDir, "test.cjs");
      writeFileSync(testFile, 'module.exports = {};');

      const { exitCode } = runCLI(testFile);
      expect(exitCode).toBe(0);

      const content = readFileSync(testFile, "utf8");
      expect(content).toContain("// Processed by AfterPack");
    });

    it("should process multiple files", () => {
      const file1 = join(tmpDir, "a.js");
      const file2 = join(tmpDir, "b.js");
      writeFileSync(file1, "const a = 1;");
      writeFileSync(file2, "const b = 2;");

      const { stdout, exitCode } = runCLI(`${file1} ${file2}`);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("All files processed successfully");

      expect(readFileSync(file1, "utf8")).toContain("// Processed by AfterPack");
      expect(readFileSync(file2, "utf8")).toContain("// Processed by AfterPack");
    });
  });

  describe("error handling", () => {
    it("should error on non-existent file", () => {
      const { stderr, exitCode } = runCLI(join(tmpDir, "nonexistent.js"));
      expect(exitCode).toBe(1);
      expect(stderr).toContain("File not found");
    });

    it("should error on non-JavaScript file", () => {
      const testFile = join(tmpDir, "test.txt");
      writeFileSync(testFile, "not javascript");

      const { stderr, exitCode } = runCLI(testFile);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Expected JavaScript file");
    });

    it("should error on directory", () => {
      const { stderr, exitCode } = runCLI(tmpDir);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("directory");
    });
  });
});
