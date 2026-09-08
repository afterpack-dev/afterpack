import { execSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * End-to-end tests for the AfterPack CLI.
 *
 * Note: These tests require @afterpack/core to be installed.
 * They will be skipped if the native addon is not available.
 */

const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

function runCLI(args: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
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

  describe("default command", () => {
    it("should show help with available commands when no arguments", () => {
      const { stdout, exitCode } = runCLI("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("AfterPack v");
      expect(stdout).toContain("audit <url>");
      expect(stdout).toContain("https://www.afterpack.dev");
    });

    it("should show help for any unknown command", () => {
      const { stdout, exitCode } = runCLI("unknown");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("audit <url>");
    });

    it("should show help for file arguments", () => {
      const { stdout, exitCode } = runCLI("somefile.js");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("https://www.afterpack.dev");
    });
  });

  describe("audit command", () => {
    it("should show usage and exit 1 when no URL is provided", () => {
      const { stdout, exitCode } = runCLI("audit");
      expect(exitCode).toBe(1);
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("afterpack audit");
    });
  });

  describe("obfuscate command", () => {
    it("should show usage and exit 1 when no file is provided", () => {
      const { stdout, exitCode } = runCLI("obfuscate");
      expect(exitCode).toBe(1);
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("afterpack obfuscate");
    });

    it("should be listed in the help output", () => {
      const { stdout } = runCLI("");
      expect(stdout).toContain("obfuscate <file.js>");
    });
  });
});
