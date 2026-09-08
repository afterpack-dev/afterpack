import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { Ledger } from "./ledger.js";

const RENDERER = join(__dirname, "../renderer/index.html");
const PRELOAD = join(__dirname, "../preload/index.mjs");

ipcMain.handle("ledger:total", (_event, entries: [string, number][]) => {
  const ledger = new Ledger("main");
  for (const [label, amount] of entries) ledger.add(label, amount);
  return ledger.summary();
});

ipcMain.handle("app:info", () => ({ channel: "fixture", version: "1.4.2" }));

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    show: false,
    webPreferences: { preload: PRELOAD, sandbox: false, contextIsolation: true },
  });
  win.loadFile(RENDERER);
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
