import {
  type DetectedOutput,
  detectBuildOutput,
  detectFramework,
  detectIntegration,
  type Framework,
} from "./detect.js";

export type BareRunPlan =
  | { kind: "integrationInstalled"; framework: Framework }
  | { kind: "frameworkDetected"; framework: Framework; buildOutput: DetectedOutput | null }
  | { kind: "buildOutput"; detected: DetectedOutput }
  | { kind: "nothing" };

export function planBareRun(cwd: string): BareRunPlan {
  const framework = detectFramework(cwd);
  if (framework) {
    if (detectIntegration(cwd, framework)) return { kind: "integrationInstalled", framework };
    return { kind: "frameworkDetected", framework, buildOutput: detectBuildOutput(cwd) };
  }
  const detected = detectBuildOutput(cwd);
  return detected ? { kind: "buildOutput", detected } : { kind: "nothing" };
}

export function commandLine(cmd: string): string {
  return `   $ ${cmd}`;
}

const COMMAND_COLUMN = 20;

export function commandRow(cmd: string, description: string): string {
  return `   $ ${cmd.padEnd(COMMAND_COLUMN)}${description}`;
}
