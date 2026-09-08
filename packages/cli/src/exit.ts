import type { EngineDiagnostic } from "@afterpack/integration-utils";

export const EXIT = {
  ok: 0,
  failure: 1,
  partial: 2,
  sizeCap: 3,
  proRequired: 4,
  reflection: 5,
  usage: 64,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const SIZE_CAP_CODE = "DIAG_SIZE_CAP_REACHED";

export const EXIT_CODE_HELP = `Exit codes:
  0   success — every collected file was obfuscated and written
  1   total failure — nothing usable was produced (also: a Pro build whose
      cloud call failed, which never degrades to Free)
  2   partial — some files shipped unobfuscated; only reachable with
      \`--allowUnobfuscated\`
  3   size cap — \`inflation.max\` could not reach the complexity target
      (${SIZE_CAP_CODE})
  4   RESERVED — a Pro feature without a key, or a lapsed entitlement
  5   RESERVED — runtime reflection detected without \`reflection.allow\`
  64  misuse — an unknown flag or command, or a malformed value`;

export function failureExitCode(diagnostics: readonly EngineDiagnostic[]): ExitCode {
  const sizeCap = diagnostics.some((d) => d.code === SIZE_CAP_CODE && d.severity !== "info");
  return sizeCap ? EXIT.sizeCap : EXIT.failure;
}
