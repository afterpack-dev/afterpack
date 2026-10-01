import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect } from "@playwright/test";
import ts from "typescript";
import { stripHashes } from "./normalize.js";
import type { Fixture } from "./registry.js";

export const SIGNATURE_THRESHOLDS = {
  minComputedMemberShare: 0.75,
  minFileComputedMemberShare: 0.6,
  minMemberAccessesForFileCheck: 20,
  minComputedMembersPerKB: 12,
  minShortIdentifierShare: 0.8,
  maxMeanIdentifierLength: 2.6,
  maxWordyLiteralSurvival: 0.15,
  minWordyLiteralsForSurvivalCheck: 20,
};

const RECEIPT = ".afterpack-protection.json";
const JS_FILE = /\.(?:js|mjs|cjs)$/;
const WORDY = /[A-Za-z]{3,}\s+[A-Za-z]{3,}/;
const DIRECTIVE = /^use [a-z]+$/;

export interface FileSignature {
  path: string;
  memberAccesses: number;
  computedMemberShare: number;
}

export interface Signature {
  files: FileSignature[];
  bytes: number;
  identifiers: number;
  meanIdentifierLength: number;
  shortIdentifierShare: number;
  computedMemberShare: number;
  computedMembersPerKB: number;
  wordyLiterals: Set<string>;
  text: string;
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  );
}

export function measureSignature(paths: string[]): Signature {
  let identifiers = 0;
  let identifierChars = 0;
  let shortIdentifiers = 0;
  let computed = 0;
  let dotted = 0;
  let bytes = 0;
  const wordyLiterals = new Set<string>();
  const files: FileSignature[] = [];
  const texts: string[] = [];
  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    texts.push(text);
    bytes += Buffer.byteLength(text);
    let fileComputed = 0;
    let fileDotted = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        if (!isPropertyName(node)) {
          identifiers += 1;
          identifierChars += node.text.length;
          if (node.text.length <= 2) shortIdentifiers += 1;
        }
      } else if (ts.isElementAccessExpression(node)) {
        fileComputed += 1;
      } else if (ts.isPropertyAccessExpression(node)) {
        fileDotted += 1;
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (WORDY.test(node.text) && !DIRECTIVE.test(node.text)) wordyLiterals.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
    computed += fileComputed;
    dotted += fileDotted;
    const memberAccesses = fileComputed + fileDotted;
    files.push({
      path,
      memberAccesses,
      computedMemberShare: memberAccesses === 0 ? 0 : fileComputed / memberAccesses,
    });
  }
  return {
    files,
    bytes,
    identifiers,
    meanIdentifierLength: identifiers === 0 ? 0 : identifierChars / identifiers,
    shortIdentifierShare: identifiers === 0 ? 0 : shortIdentifiers / identifiers,
    computedMemberShare: computed + dotted === 0 ? 0 : computed / (computed + dotted),
    computedMembersPerKB: bytes === 0 ? 0 : computed / (bytes / 1024),
    wordyLiterals,
    text: texts.join("\n"),
  };
}

function jsUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (sub: string): void => {
    for (const entry of readdirSync(sub, { withFileTypes: true })) {
      const full = join(sub, entry.name);
      const isDirectory = entry.isDirectory() || (!entry.isFile() && statSync(full).isDirectory());
      if (isDirectory) walk(full);
      else if (JS_FILE.test(entry.name)) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

export interface ProtectedFile {
  root: string;
  path: string;
}

export function protectedFilesOf(app: Fixture): ProtectedFile[] {
  return app.receipts.flatMap((root) => {
    const receiptPath = join(root, RECEIPT);
    expect(existsSync(receiptPath), `${app.name}: no protection receipt at ${receiptPath}`).toBe(
      true,
    );
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      files: { path: string; transformed?: boolean }[];
    };
    return receipt.files
      .filter((entry) => entry.transformed !== false && JS_FILE.test(entry.path))
      .map((entry) => ({ root, path: entry.path }));
  });
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function signatureFailures(signature: Signature, root: string): string[] {
  const t = SIGNATURE_THRESHOLDS;
  const failures: string[] = [];
  if (signature.computedMemberShare < t.minComputedMemberShare) {
    failures.push(
      `computed member accesses are ${percent(signature.computedMemberShare)} of all, below ${percent(t.minComputedMemberShare)}`,
    );
  }
  if (signature.computedMembersPerKB < t.minComputedMembersPerKB) {
    failures.push(
      `${signature.computedMembersPerKB.toFixed(1)} computed member accesses per KB, below ${t.minComputedMembersPerKB}`,
    );
  }
  if (signature.shortIdentifierShare < t.minShortIdentifierShare) {
    failures.push(
      `identifiers of two characters or fewer are ${percent(signature.shortIdentifierShare)}, below ${percent(t.minShortIdentifierShare)}`,
    );
  }
  if (signature.meanIdentifierLength > t.maxMeanIdentifierLength) {
    failures.push(
      `mean identifier length ${signature.meanIdentifierLength.toFixed(2)}, above ${t.maxMeanIdentifierLength}`,
    );
  }
  for (const file of signature.files) {
    if (
      file.memberAccesses >= t.minMemberAccessesForFileCheck &&
      file.computedMemberShare < t.minFileComputedMemberShare
    ) {
      failures.push(
        `${relative(root, file.path)} reads like plain code: ${percent(file.computedMemberShare)} computed member accesses`,
      );
    }
  }
  return failures;
}

export function unprotectedBaselineSignature(app: Fixture): Signature {
  if (!app.baseline) throw new Error(`${app.name} has no baseline build`);
  return measureSignature(app.baseline.receipts.flatMap(jsUnder));
}

export function expectObfuscationSignatures(app: Fixture): Signature {
  const files = protectedFilesOf(app);
  expect(
    files.length,
    `${app.name}: the protection receipts name no JavaScript file`,
  ).toBeGreaterThan(0);
  const signature = measureSignature(files.map((file) => join(file.root, file.path)));
  expect(
    signatureFailures(signature, app.dir),
    `${app.name}: ${files.length} protected file(s), ${(signature.bytes / 1024).toFixed(0)} KB, lack the obfuscation signatures`,
  ).toEqual([]);
  return signature;
}

export function expectLiteralsHidden(app: Fixture, signature: Signature): void {
  const baseline = app.baseline;
  if (!baseline) throw new Error(`${app.name} has no baseline build to compare literals against`);
  const counterparts = new Set<string>();
  for (const file of protectedFilesOf(app)) {
    const root = baseline.receipts[app.receipts.indexOf(file.root)];
    const exact = join(root, file.path);
    const matches = existsSync(exact)
      ? [exact]
      : jsUnder(root).filter(
          (path) =>
            stripHashes(relative(root, path).split(sep).join("/")) === stripHashes(file.path),
        );
    expect(
      matches.length,
      `${app.name}: the baseline build has no counterpart of ${file.path}`,
    ).toBeGreaterThan(0);
    for (const match of matches) counterparts.add(match);
  }
  const literals = [...measureSignature([...counterparts]).wordyLiterals];
  expect(
    literals.length,
    `${app.name}: the baseline build carries too few wordy literals to measure`,
  ).toBeGreaterThanOrEqual(SIGNATURE_THRESHOLDS.minWordyLiteralsForSurvivalCheck);
  const survivors = literals.filter((literal) => signature.text.includes(literal));
  expect(
    survivors.length / literals.length,
    `${app.name}: ${survivors.length} of ${literals.length} wordy literals survived verbatim: ` +
      survivors
        .slice(0, 10)
        .map((literal) => JSON.stringify(literal.slice(0, 60)))
        .join(", "),
  ).toBeLessThanOrEqual(SIGNATURE_THRESHOLDS.maxWordyLiteralSurvival);
}
