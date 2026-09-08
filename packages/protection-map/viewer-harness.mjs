import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const TEMPLATE =
  process.env.AFTERPACK_TEMPLATE || fileURLToPath(new URL("./template.html", import.meta.url));

const flushPendingMicrotasksForAsyncIife = () => new Promise((resolve) => setTimeout(resolve, 0));

function cssVars(html) {
  const style = html.slice(html.indexOf("<style"), html.indexOf("</style>"));
  const vars = Object.create(null);
  for (const m of style.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
    if (!(m[1] in vars)) vars[m[1]] = m[2].trim();
  }
  return vars;
}

function makeEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: new Proxy(
      {},
      {
        get: (t, k) => (k === "setProperty" ? () => {} : (t[k] ?? "")),
        set: (t, k, v) => {
          t[k] = v;
          return true;
        },
      },
    ),
    dataset: {},
    attrs: Object.create(null),
    children: [],
    innerHTML: "",
    textContent: "",
    value: "",
    disabled: false,
    checked: false,
    classList: {
      _s: new Set(),
      add(...c) {
        for (const x of c) this._s.add(x);
      },
      remove(...c) {
        for (const x of c) this._s.delete(x);
      },
      toggle(c, on) {
        on === undefined
          ? this._s.has(c)
            ? this._s.delete(c)
            : this._s.add(c)
          : on
            ? this._s.add(c)
            : this._s.delete(c);
      },
      contains(c) {
        return this._s.has(c);
      },
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    hasAttribute(k) {
      return k in this.attrs;
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      return c;
    },
    insertBefore(c) {
      this.children.push(c);
      return c;
    },
    remove() {},
    focus() {},
    blur() {},
    select() {},
    scrollIntoView() {},
    addEventListener() {},
    removeEventListener() {},
    closest() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return { width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800 };
    },
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 800,
    clientHeight: 800,
    offsetHeight: 800,
    offsetWidth: 1200,
  };
  return el;
}

export function makeStorage(seed) {
  const map = new Map(Object.entries(seed ?? {}));
  return {
    map,
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem(k, v) {
      map.set(String(k), String(v));
    },
    removeItem(k) {
      map.delete(String(k));
    },
    clear() {
      map.clear();
    },
  };
}

export function readPrefs(storage) {
  const raw = storage.getItem("afterpack-protmap-prefs");
  return raw ? JSON.parse(raw) : {};
}

export async function loadViewer(doc, { hash = "", storage = makeStorage() } = {}) {
  const html = readFileSync(TEMPLATE, "utf8");
  const vars = cssVars(html);

  const scripts = [
    ...html.matchAll(/<script(?![^>]*type="application\/octet-stream")[^>]*>([\s\S]*?)<\/script>/g),
  ].map((m) => m[1]);
  if (scripts.length !== 2) throw new Error(`expected 2 inline scripts, got ${scripts.length}`);
  const [codecScript, viewerScriptSource] = scripts;
  const EXPORTS = [
    "DATA",
    "FILES",
    "ancestorExpansion",
    "findFileIdxByPath",
    "readHashParams",
    "isWeakFile",
    "isMarkedFile",
    "activeFileFilter",
    "setFileFilter",
    "applyDeepLink",
    "applyTreeSearch",
    "renderTree",
    "directiveTint",
    "paintCode",
    "prepareFile",
    "makeSameUnits",
    "buildByteStarts",
    "makeByteToChar",
    "sourceOriginOf",
    "updateSourceOriginNote",
    "cardUnlit",
    "INSP_COPY",
    "tokenAt",
    "selectUnlit",
    "renderInspector",
    "inspectorSummary",
    "renderWeakSpots",
    "isSectionCollapsed",
    "setSectionCollapsed",
    "toggleInspectorSection",
    "toggleWeakSpotsSection",
    "syncRailFill",
    "prefs",
    "state",
  ];
  const tail = "  init();\n})();";
  if (!viewerScriptSource.includes(tail))
    throw new Error("IIFE tail not found -- harness needs updating");
  const viewer = viewerScriptSource.replace(
    tail,
    `  init();\n  globalThis.__VIEWER = { ${EXPORTS.map((n) => `${n}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(", ")} };\n})();`,
  );

  const els = new Map();
  const byId = (id) => {
    if (!els.has(id)) els.set(id, makeEl());
    return els.get(id);
  };
  const dataEl = byId("afterpack-data");
  dataEl.textContent = JSON.stringify(doc);

  const document = {
    getElementById: byId,
    createElement: (t) => makeEl(t),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: makeEl("body"),
    documentElement: makeEl("html"),
    execCommand: () => true,
  };
  const replaced = [];
  const sandbox = {
    document,
    history: {
      replaceState(_s, _t, url) {
        replaced.push(url);
      },
    },
    window: {
      innerWidth: 1400,
      innerHeight: 900,
      location: { hash, pathname: "/protection-map.html", search: "" },
      matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    },
    getComputedStyle: () => ({ getPropertyValue: (n) => vars[n] ?? "" }),
    localStorage: storage,
    requestAnimationFrame: (f) => setTimeout(f, 0),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    TextEncoder,
    TextDecoder,
    Blob,
    DecompressionStream,
    navigator: {},
    globalThis: undefined,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  sandbox.globalThis = sandbox;
  vm.runInContext(codecScript, sandbox, { filename: "template.html#codec" });
  vm.runInContext(viewer, sandbox, { filename: "template.html#viewer" });
  await flushPendingMicrotasksForAsyncIife();
  if (!sandbox.__VIEWER)
    throw new Error(
      `viewer did not run: code-body says ${JSON.stringify(byId("code-body").textContent)}`,
    );
  return { ...sandbox.__VIEWER, els, byId, replaced, storage };
}
