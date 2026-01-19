import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";

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
    it("should show waitlist message when no arguments", () => {
      const { stdout, exitCode } = runCLI("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("AfterPack v");
      expect(stdout).toContain("Coming soon: High-performance JavaScript protection");
      expect(stdout).toContain("https://www.afterpack.dev");
    });

    it("should show waitlist message for any unknown command", () => {
      const { stdout, exitCode } = runCLI("unknown");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Join the waitlist for early access");
    });

    it("should show waitlist message for file arguments", () => {
      const { stdout, exitCode } = runCLI("somefile.js");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("https://www.afterpack.dev");
    });
  });

  describe("audit command", () => {
    it("should show coming soon message", () => {
      const { stdout, exitCode } = runCLI("audit");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("AfterPack v");
      expect(stdout).toContain("Audit command coming soon");
      expect(stdout).toContain("analyze your site");
      expect(stdout).toContain("https://www.afterpack.dev");
    });

    it("should show same message with URL argument", () => {
      const { stdout, exitCode } = runCLI("audit https://example.com");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Audit command coming soon");
      expect(stdout).toContain("https://www.afterpack.dev");
    });
  });
});
