/**
 * A stand-in for the `electron` module, so this fixture can EXECUTE its
 * obfuscated main and preload bundles under plain `node` (and its renderer
 * bundle in headless Chromium) on a CI runner with no display server. Every
 * call is recorded on `globalThis.__ELECTRON_STUB__`, and `ipcRenderer.invoke`
 * really dispatches to the handler `ipcMain.handle` registered -- so the
 * harness crosses the same main <-> preload boundary the real runtime does.
 */
const stub = (globalThis.__ELECTRON_STUB__ ??= {
  windows: [],
  handlers: new Map(),
  exposed: {},
  events: [],
  quit: 0,
});

export class BrowserWindow {
  static getAllWindows() {
    return stub.windows;
  }
  constructor(options) {
    this.options = options;
    this.loaded = null;
    this.webContents = { openDevTools() {}, send() {} };
    stub.windows.push(this);
  }
  loadFile(path) {
    this.loaded = { kind: "file", path };
  }
  loadURL(url) {
    this.loaded = { kind: "url", url };
  }
  on() {}
  show() {}
}

export const app = {
  whenReady: () => Promise.resolve(),
  on: (event, handler) => stub.events.push({ event, handler }),
  quit: () => {
    stub.quit += 1;
  },
  getAppPath: () => process.cwd(),
};

export const ipcMain = {
  handle: (channel, handler) => stub.handlers.set(channel, handler),
  on: (channel, handler) => stub.handlers.set(channel, handler),
};

export const ipcRenderer = {
  invoke: async (channel, ...args) => {
    const handler = stub.handlers.get(channel);
    if (!handler) throw new Error(`no ipcMain handler registered for ${channel}`);
    return handler({ sender: null }, ...args);
  },
  on: () => {},
  send: () => {},
};

export const contextBridge = {
  exposeInMainWorld: (key, api) => {
    stub.exposed[key] = api;
  },
};

export const shell = { openExternal: async () => {} };

export default { app, BrowserWindow, ipcMain, ipcRenderer, contextBridge, shell };
