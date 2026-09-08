import { describe, expect, it } from "vitest";
import {
  captureDirectiveRegions,
  parseDirectivePayload,
  renameGlobalsRefusalMessage,
  scanDirectives,
} from "./directives.js";

describe("parseDirectivePayload", () => {
  it("maps the named presets to their region deltas + tier", () => {
    expect(parseDirectivePayload("skip")).toMatchObject({
      keyword: "skip",
      tier: "free",
      delta: { target: 0, floor: false },
    });
    expect(parseDirectivePayload("preset=hard")).toMatchObject({
      tier: "amplifying",
      delta: { target: 25, floor: true },
    });
    expect(parseDirectivePayload("preset=extreme")).toMatchObject({
      tier: "amplifying",
      delta: { target: 80, floor: true },
    });
  });

  it("parses K=V attributes and classifies decrease-only as free", () => {
    expect(parseDirectivePayload("strings.encode=off")).toMatchObject({
      tier: "free",
      delta: { floor: false },
    });
    expect(parseDirectivePayload("strings.encode=on")).toMatchObject({
      tier: "amplifying",
      delta: { floor: true },
    });
    expect(parseDirectivePayload("complexity=0")).toMatchObject({
      tier: "free",
      delta: { target: 0 },
    });
    expect(parseDirectivePayload("complexity=25")).toMatchObject({
      tier: "amplifying",
      delta: { target: 25 },
    });
    expect(parseDirectivePayload("complexity=8 strings.encode=on")).toMatchObject({
      tier: "amplifying",
      delta: { target: 8, floor: true },
    });
  });

  it("surfaces an error for unknown keys, bad values, and an empty directive", () => {
    expect(parseDirectivePayload("nonsense").error).toBeDefined();
    expect(parseDirectivePayload("complexity=-1").error).toBeDefined();
    expect(parseDirectivePayload("strings.encode=maybe").error).toBeDefined();
    expect(parseDirectivePayload("").error).toBeDefined();
  });
});

describe("scanDirectives — line-scoped", () => {
  it("captures an INLINE strings.encode=off region covering the rest of its line", () => {
    const src = 'const one = "A";\nconst two = /* @afterpack strings.encode=off */ "KEEP";\n';
    const { regions, directives } = scanDirectives(src);
    expect(regions).toHaveLength(1);
    expect(regions[0].floor).toBe(false);
    expect(directives[0].form).toBe("line");
    const kept = src.indexOf('"KEEP"');
    expect(regions[0].start).toBeLessThanOrEqual(kept);
    expect(regions[0].end).toBeGreaterThanOrEqual(src.indexOf(";", kept));
    expect(regions[0].start).toBeGreaterThan(src.indexOf('"A"'));
  });

  it("scopes a marker alone on its line to the NEXT line", () => {
    const src = "a();\n/* @afterpack skip */\nconst secret = 1;\nb();\n";
    const { regions } = scanDirectives(src);
    expect(regions).toHaveLength(1);
    const line = src.indexOf("const secret");
    expect(regions[0].start).toBeLessThanOrEqual(line);
    expect(regions[0].end).toBeGreaterThanOrEqual(src.indexOf(";", line));
    expect(regions[0].end).toBeLessThan(src.indexOf("b()"));
  });
});

describe("scanDirectives — block-scoped", () => {
  it("captures a `preset=extreme`/`end` block spanning between the markers, innermost wins", () => {
    const src =
      "keep();\n/* @afterpack preset=extreme */\nhot();\n/* @afterpack skip */ cold();\n/* @afterpack end */\ntail();\n";
    const { regions, directives } = scanDirectives(src);
    const block = directives.find((d) => d.form === "block");
    expect(block?.keyword).toBe("preset");
    expect(block?.region.target).toBe(80);
    const inner = directives.find((d) => d.keyword === "skip");
    const outer = block as NonNullable<typeof block>;
    expect(
      (inner as NonNullable<typeof inner>).region.end -
        (inner as NonNullable<typeof inner>).region.start,
    ).toBeLessThan(outer.region.end - outer.region.start);
    expect(regions.length).toBe(2);
  });

  it("flags a dangling `end` and never emits a region for it", () => {
    const { regions, diagnostics } = scanDirectives("a();\n/* @afterpack end */\n");
    expect(regions).toHaveLength(0);
    expect(diagnostics[0].code).toBe("DIAG_DIRECTIVE_DANGLING_END");
  });
});

describe("scanDirectives — directive label (Protection Map `directives_detected`)", () => {
  it("stamps each region with its directive keyword as an informational label", () => {
    const src =
      "keep();\n/* @afterpack preset=extreme */\nhot();\n/* @afterpack skip */ cold();\n/* @afterpack end */\nconst k = /* @afterpack strings.encode=off */ 1;\n";
    const { directives } = scanDirectives(src);
    const byKeyword = Object.fromEntries(directives.map((d) => [d.keyword, d]));
    expect(byKeyword.preset.region.label).toBe("preset");
    expect(byKeyword.skip.region.label).toBe("skip");
    expect(byKeyword["strings.encode"].region.label).toBe("strings.encode");
  });
});

describe("scanDirectives — robustness", () => {
  it("returns nothing for source with no directives", () => {
    expect(scanDirectives("const x = 1;\nconsole.log(x);\n").regions).toEqual([]);
  });

  it("never fires on `@afterpack` text inside a string or template literal", () => {
    const src =
      'const a = "/* @afterpack skip */";\nconst b = `/* @afterpack preset=extreme */`;\n';
    expect(scanDirectives(src).regions).toEqual([]);
  });

  it("records an UNKNOWN directive as a diagnostic, not a region", () => {
    const { regions, diagnostics } = scanDirectives("/* @afterpack complexty=9 */ x();\n");
    expect(regions).toEqual([]);
    expect(diagnostics[0].code).toBe("DIAG_DIRECTIVE_UNKNOWN");
  });

  it("emits UTF-8 byte offsets, not UTF-16 char indices", () => {
    const src = 'const é = /* @afterpack strings.encode=off */ "KEEP";\n';
    const region = scanDirectives(src).regions[0];
    const markerEndChar = src.indexOf("*/") + 2;
    expect(region.start).toBe(markerEndChar + 1);
  });
});

describe("scanDirectives — documented forms this scanner cannot place", () => {
  it("reports a `// @afterpack` LINE comment instead of ignoring it", () => {
    const { regions, diagnostics } = scanDirectives("// @afterpack skip\nconst s = 1;\n");
    expect(regions).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("DIAG_DIRECTIVE_UNSUPPORTED_FORM");
    expect(diagnostics[0].message).toContain("/* @afterpack");
  });

  it("reports the `:begin`/`:end` span grammar in either comment style", () => {
    const line = scanDirectives("// @afterpack:begin preset=hard\nx();\n// @afterpack:end\n");
    const block = scanDirectives("/* @afterpack:begin preset=hard */\nx();\n");
    for (const d of [...line.diagnostics, ...block.diagnostics]) {
      expect(d.code).toBe("DIAG_DIRECTIVE_UNSUPPORTED_FORM");
      expect(d.message).toContain("span form");
    }
    expect(line.regions).toEqual([]);
    expect(block.regions).toEqual([]);
  });

  it("never fires the line-comment report on an ordinary comment", () => {
    expect(scanDirectives("// just a note\nconst x = 1;\n").diagnostics).toEqual([]);
  });
});

describe("scanDirectives — recognised keys with no per-region engine channel", () => {
  it.each([
    "async.preserve",
    "generators.preserve",
    "identifiers.rename",
  ])("reports `%s` as NOT_IMPLEMENTED and emits no region", (key) => {
    const { regions, diagnostics } = scanDirectives(`const s = /* @afterpack ${key} */ 1;\n`);
    expect(regions).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("DIAG_DIRECTIVE_NOT_IMPLEMENTED");
    expect(diagnostics[0].message).toContain(key);
  });

  it("keeps the applied part of a mixed directive and reports only the rest", () => {
    const src = "const s = /* @afterpack complexity=40 async.preserve */ 1;\n";
    const { regions, diagnostics } = scanDirectives(src);
    expect(regions).toHaveLength(1);
    expect(regions[0].target).toBe(40);
    expect(diagnostics.map((d) => d.code)).toEqual(["DIAG_DIRECTIVE_NOT_IMPLEMENTED"]);
  });
});

describe("parseDirectivePayload — the documented dotted vocabulary", () => {
  it("maps `preset=<name>` onto the region wire's target + floor", () => {
    expect(parseDirectivePayload("preset=extreme")).toMatchObject({
      keyword: "preset",
      tier: "amplifying",
      delta: { target: 80, floor: true },
    });
    expect(parseDirectivePayload("preset=minify").delta).toEqual({ target: 0, floor: false });
    expect(parseDirectivePayload("preset=nope").error).toBeDefined();
  });

  it("accepts the spec's bool sugar — a bare bool key means `=on`", () => {
    expect(parseDirectivePayload("skip")).toMatchObject({ delta: { target: 0, floor: false } });
    expect(parseDirectivePayload("skip=on").delta).toEqual({ target: 0, floor: false });
    expect(parseDirectivePayload("skip=off").noop).toBe(true);
  });

  it("refuses an unknown or kebab-cased key instead of ignoring it", () => {
    const unknown = parseDirectivePayload("destroy");
    expect(unknown.noop).toBe(true);
    expect(unknown.error).toContain("unknown directive key `destroy`");
    expect(parseDirectivePayload("control-flow.enabled=false").error).toContain(
      "kebab-case is not a directive key",
    );
  });

  it("lowers `controlFlow.enabled=false` to a deny mask, and stays FREE", () => {
    expect(parseDirectivePayload("controlFlow.enabled=false")).toMatchObject({
      tier: "free",
      delta: { deny: ["controlFlowFlatten"] },
    });
    expect(parseDirectivePayload("controlFlow.enabled=true").noop).toBe(true);
  });

  it("carries inflation.max and the transform masks", () => {
    expect(parseDirectivePayload("inflation.max=5").delta).toEqual({ max: 5 });
    expect(parseDirectivePayload("transforms.deny=integerBytecode").delta).toEqual({
      deny: ["integerBytecode"],
    });
    expect(parseDirectivePayload("transforms.only=stringencoding").delta).toEqual({
      only: ["stringEncoding"],
    });
  });

  it("rejects the pre-dotted spellings and kebab-case with a named error", () => {
    expect(parseDirectivePayload("target=25").error).toContain("target");
    expect(parseDirectivePayload("floor=off").error).toBeDefined();
    expect(parseDirectivePayload("deny=integerBytecode").error).toBeDefined();
    expect(parseDirectivePayload("complexity-target=25").error).toContain("kebab-case");
  });

  it("requires a value on a non-bool key", () => {
    expect(parseDirectivePayload("complexity").error).toContain("=<value>");
  });
});

describe("captureDirectiveRegions — the channel bridge", () => {
  it("SINGLE-file merges captured regions after hand-authored ones", () => {
    const source = 'const two = /* @afterpack strings.encode=off */ "KEEP";\n';
    const handAuthored = [{ start: 0, end: 4, target: 0 }];
    const out = captureDirectiveRegions([{ source }], handAuthored);
    expect(out.applied).toBe(1);
    expect(out.regions?.[0]).toEqual(handAuthored[0]);
    expect(out.regions?.[1].floor).toBe(false);
  });

  it("SINGLE-file with no directives forwards hand-authored regions verbatim (byte-identical)", () => {
    expect(captureDirectiveRegions([{ source: "const x = 1;\n" }]).regions).toBeUndefined();
    const hand = [{ start: 0, end: 4 }];
    expect(captureDirectiveRegions([{ source: "const x = 1;\n" }], hand).regions).toBe(hand);
  });

  it("MULTI-file defers captured directives (per-file channel is a later phase)", () => {
    const out = captureDirectiveRegions([
      { source: "const a = /* @afterpack skip */ 1;\n" },
      { source: "const b = 2;\n" },
    ]);
    expect(out.applied).toBe(0);
    expect(out.deferredFiles).toBe(1);
    expect(out.regions).toBeUndefined();
  });

  it("passes hand-authored regions through untouched when disabled", () => {
    const hand = [{ start: 1, end: 2 }];
    const out = captureDirectiveRegions([{ source: "/* @afterpack skip */ x();\n" }], hand, false);
    expect(out.regions).toBe(hand);
    expect(out.applied).toBe(0);
  });
});

describe("parseDirectivePayload — multi-key composition", () => {
  it("ACCUMULATES deny lists across keys instead of letting the last one win", () => {
    const parsed = parseDirectivePayload("controlFlow.enabled=off transforms.deny=integerBytecode");
    expect(parsed.delta.deny).toEqual(["controlFlowFlatten", "integerBytecode"]);
  });

  it("de-duplicates a kind named twice", () => {
    const parsed = parseDirectivePayload(
      "controlFlow.enabled=off transforms.deny=controlFlowFlatten",
    );
    expect(parsed.delta.deny).toEqual(["controlFlowFlatten"]);
  });
});

describe("parseDirectivePayload — `end`", () => {
  it("rejects extra keys on `end` rather than dropping them", () => {
    expect(parseDirectivePayload("end skip").error).toContain("takes no keys");
    expect(parseDirectivePayload("end").error).toBeUndefined();
  });
});

describe("identifiers.globals.rename — the file-wide escape hatch", () => {
  it("parses the bool sugar onto the file-level flag, never a region delta", () => {
    expect(parseDirectivePayload("identifiers.globals.rename")).toMatchObject({
      keyword: "identifiers.globals.rename",
      renameGlobals: true,
      noop: true,
      delta: {},
    });
    expect(parseDirectivePayload("identifiers.globals.rename=on").renameGlobals).toBe(true);
    expect(parseDirectivePayload("identifiers.globals.rename=true").renameGlobals).toBe(true);
  });

  it("treats `=off` as the default (no file flag, a `omit` note, no region)", () => {
    const parsed = parseDirectivePayload("identifiers.globals.rename=off");
    expect(parsed.renameGlobals).toBe(false);
    expect(parsed.delta).toEqual({});
    expect(parsed.notes[0]).toContain("default");
  });

  it("rejects a non-bool value with a named error", () => {
    expect(parseDirectivePayload("identifiers.globals.rename=sometimes").error).toContain(
      "identifiers.globals.rename",
    );
  });

  it("applies file-wide from an INLINE (per-region) directive, degrading with a diagnostic", () => {
    const src = "var api = /* @afterpack identifiers.globals.rename */ makeApi();\n";
    const { regions, renameGlobals, diagnostics } = scanDirectives(src);
    expect(renameGlobals).toBe(true);
    expect(regions).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("DIAG_DIRECTIVE_REGION_TO_FILE");
    expect(diagnostics[0].message).toContain("cannot be scoped to a region");
  });

  it("applies file-wide from a BLOCK (per-region) directive, degrading with a diagnostic", () => {
    const src =
      "/* @afterpack identifiers.globals.rename */\nfunction f(){ return 1; }\n/* @afterpack end */\n";
    const { regions, renameGlobals, diagnostics } = scanDirectives(src);
    expect(renameGlobals).toBe(true);
    expect(regions).toEqual([]);
    expect(diagnostics.map((d) => d.code)).toContain("DIAG_DIRECTIVE_REGION_TO_FILE");
  });

  it("keeps a region-scoped sibling key while sending renameGlobals file-wide", () => {
    const src = "const s = /* @afterpack complexity=40 identifiers.globals.rename */ 1;\n";
    const { regions, renameGlobals, diagnostics } = scanDirectives(src);
    expect(renameGlobals).toBe(true);
    expect(regions).toHaveLength(1);
    expect(regions[0].target).toBe(40);
    expect(diagnostics.map((d) => d.code)).toEqual(["DIAG_DIRECTIVE_REGION_TO_FILE"]);
  });

  it("is false and diagnostic-free when no directive asks for it", () => {
    const { renameGlobals, diagnostics } = scanDirectives("const x = 1;\nconsole.log(x);\n");
    expect(renameGlobals).toBe(false);
    expect(diagnostics).toEqual([]);
  });

  it("surfaces the file flag through captureDirectiveRegions for a ONE-file batch", () => {
    const one = captureDirectiveRegions([
      { source: "/* @afterpack identifiers.globals.rename */\nvar x = 1;\n" },
    ]);
    expect(one.renameGlobals).toBe(true);
    expect(one.renameGlobalsRefused).toEqual([]);
    const none = captureDirectiveRegions([{ source: "var a = 1;\n" }]);
    expect(none.renameGlobals).toBe(false);
  });

  it("REFUSES the flag in a multi-file batch and names the files that asked", () => {
    const many = captureDirectiveRegions([
      { source: "var a = 1;\n", filePath: "/dist/a.js" },
      {
        source: "/* @afterpack identifiers.globals.rename */ var b = 2;\n",
        filePath: "/dist/b.js",
      },
      {
        source: "/* @afterpack identifiers.globals.rename */ var c = 3;\n",
        filePath: "/dist/c.js",
      },
    ]);
    expect(many.renameGlobals).toBe(false);
    expect(many.renameGlobalsRefused).toEqual(["/dist/b.js", "/dist/c.js"]);
  });

  it("falls back to a positional label when the caller supplied no filePath", () => {
    const many = captureDirectiveRegions([
      { source: "var a = 1;\n" },
      { source: "/* @afterpack identifiers.globals.rename */ var b = 2;\n" },
    ]);
    expect(many.renameGlobals).toBe(false);
    expect(many.renameGlobalsRefused).toEqual(["file #2"]);
  });

  it("never refuses when directive capture is disabled (nothing was scanned)", () => {
    const off = captureDirectiveRegions(
      [
        { source: "/* @afterpack identifiers.globals.rename */ var a = 1;\n", filePath: "/a.js" },
        { source: "var b = 2;\n", filePath: "/b.js" },
      ],
      undefined,
      false,
    );
    expect(off.renameGlobals).toBe(false);
    expect(off.renameGlobalsRefused).toEqual([]);
  });
});

describe("renameGlobalsRefusalMessage", () => {
  it("names the asking files, the build-wide reason, and the single-file workaround", () => {
    const message = renameGlobalsRefusalMessage(["/dist/b.js"], 12);
    expect(message).toContain("REFUSED `identifiers.globals.rename` from /dist/b.js");
    expect(message).toContain("BUILD-WIDE");
    expect(message).toContain("all 12 file(s)");
    expect(message).toContain("Nothing was renamed");
    expect(message).toContain("Obfuscate that file on its own");
  });

  it("caps the listed files at three and counts the rest", () => {
    const message = renameGlobalsRefusalMessage(["a", "b", "c", "d", "e"], 9);
    expect(message).toContain("from a, b, c and 2 more");
  });
});
