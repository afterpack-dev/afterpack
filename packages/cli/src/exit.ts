import type { EngineDiagnostic } from "@afterpack/integration-utils";

export const EXIT = {
  ok: 0,
  failure: 1,
  partial: 2,
  sizeCap: 3,
  proRequired: 4,
  reflection: 5,
  updateRequired: 6,
  usage: 64,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const SIZE_CAP_CODE = "DIAG_SIZE_CAP_REACHED";
export const PRO_REQUIRED_CODE = "DIAG_PRO_DIRECTIVE_REQUIRES_KEY";
export const REFLECTION_CODE = "DIAG_REFLECTION_NOT_ACKNOWLEDGED";

export const EXIT_CODE_HELP = `Exit codes:
  0   success — every collected file was obfuscated and written
  1   total failure — nothing usable was produced (also: a Pro build whose
      cloud call failed; it never falls back to a local build)
  2   partial — reserved for a quota-exhausted build; no build returns it today
  3   size cap — \`inflation.max\` could not reach the complexity target
      (${SIZE_CAP_CODE})
  4   Pro required — a region directive that raises protection needs a Pro key
      (${PRO_REQUIRED_CODE})
  5   reflection — a runtime-reflection pattern was not acknowledged
      (${REFLECTION_CODE})
  6   update required — the AfterPack cloud API, or this afterpack, needs a
      newer @afterpack/core; nothing was written
  64  misuse — an unknown flag or command, or a malformed value`;

export function failureExitCode(diagnostics: readonly EngineDiagnostic[]): ExitCode {
  const has = (code: string) => diagnostics.some((d) => d.code === code && d.severity !== "info");
  if (has(PRO_REQUIRED_CODE)) return EXIT.proRequired;
  if (has(REFLECTION_CODE)) return EXIT.reflection;
  if (has(SIZE_CAP_CODE)) return EXIT.sizeCap;
  return EXIT.failure;
}
