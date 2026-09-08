export declare const LINEAGE_EMBED_CAP: number;
export declare const PLACEHOLDER: string;

export declare function defaultTemplatePath(): string;

export declare function readDefaultTemplate(): string;

export declare function normalizeToFiles(raw: unknown): { files: unknown[] };

export declare function capLineage(data: { files?: unknown[] }): {
  cappedRegions: number;
  totalLineageStepsRemoved: number;
};

export declare function embedIntoTemplate(template: string, data: unknown): string;

export declare function encodeCompact(
  data: { files?: unknown[]; engine?: unknown; generatedAt?: unknown; spanUnits?: unknown },
  options?: { includeLineage?: boolean },
): Record<string, unknown>;

export declare function decodeCompact(compact: unknown): {
  schemaVersion?: number;
  spanUnits?: string;
  engine?: unknown;
  generatedAt?: unknown;
  files: unknown[];
};

export declare function renderProtectionMapHtml(
  raw: unknown,
  options?: { template?: string; includeLineage?: boolean },
): {
  html: string;
  files: number;
  cappedRegions: number;
  totalLineageStepsRemoved: number;
};
