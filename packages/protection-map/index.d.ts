/** What AfterPack applied to a build, file by file. It contains your original source, so keep it private. */
export interface ProtectionMap {
  schemaVersion: number;
  spanUnits?: "utf16";
  generatedAt: string | null;
  engine: {
    version: string;
    backend: string;
    seed: number;
    preset: "minify" | "light" | "medium" | "hard" | "extreme" | null;
    complexity: number;
    [key: string]: unknown;
  };
  files: ProtectionMapFile[];
}

/** One file of a {@link ProtectionMap}. */
export interface ProtectionMapFile {
  file: {
    path: string | null;
    originalSource: string;
    inputSize: number;
    outputSize: number;
    [key: string]: unknown;
  };
  regions: Record<string, unknown>[];
  spotlights: Record<string, unknown>[];
  aggregate: Record<string, unknown>;
}

export interface RenderProtectionMapOptions {
  /** An HTML template to render into. Defaults to the one bundled with this package. */
  template?: string;
  /** Keep the per-region transform history. Defaults to `true`. */
  includeLineage?: boolean;
}

export interface RenderedProtectionMap {
  /** The self-contained HTML report. */
  html: string;
  /** The number of files in the report. */
  files: number;
  /** The number of regions whose transform history was shortened. */
  cappedRegions: number;
  /** The number of transform history steps removed. */
  totalLineageStepsRemoved: number;
}

/** Render Protection Map data into one self-contained HTML file. */
export declare function renderProtectionMapHtml(
  data: ProtectionMap | { files: ProtectionMapFile[] },
  options?: RenderProtectionMapOptions,
): RenderedProtectionMap;
