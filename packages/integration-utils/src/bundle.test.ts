import { describe, expect, it } from "vitest";
import { type OutputBundleLike, stripBundleCssSourceMaps } from "./bundle.js";

describe("stripBundleCssSourceMaps", () => {
  it("deletes every CSS map and the trailer that points at it, and nothing else", () => {
    const bundle: OutputBundleLike = {
      "assets/index.css": {
        type: "asset",
        fileName: "assets/index.css",
        source: "a{color:red}\n/*# sourceMappingURL=index.css.map */\n",
      },
      "assets/index.css.map": { type: "asset", fileName: "assets/index.css.map", source: "{}" },
      "assets/theme.css": {
        type: "asset",
        fileName: "assets/theme.css",
        source: new TextEncoder().encode("b{}\n/*# sourceMappingURL=theme.css.map*/"),
      },
      "assets/theme.css.map": { type: "asset", fileName: "assets/theme.css.map", source: "{}" },
      "assets/index.js": { type: "chunk", fileName: "assets/index.js", code: "x()" },
      "assets/index.js.map": { type: "asset", fileName: "assets/index.js.map", source: "{}" },
      "assets/plain.css": { type: "asset", fileName: "assets/plain.css", source: "c{}\n" },
    };

    stripBundleCssSourceMaps(bundle);

    expect(Object.keys(bundle).sort()).toEqual([
      "assets/index.css",
      "assets/index.js",
      "assets/index.js.map",
      "assets/plain.css",
      "assets/theme.css",
    ]);
    expect(bundle["assets/index.css"].source).toBe("a{color:red}\n");
    expect(bundle["assets/theme.css"].source).toBe("b{}\n");
    expect(bundle["assets/plain.css"].source).toBe("c{}\n");
    expect(bundle["assets/index.js"].code).toBe("x()");
  });
});
