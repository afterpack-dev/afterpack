import { contextBridge, ipcRenderer } from "electron";

const api = {
  total: (entries: [string, number][]) => ipcRenderer.invoke("ledger:total", entries),
  info: () => ipcRenderer.invoke("app:info"),
  label: (n: number) => `entry-${n.toString(36)}`,
};

export type AfterpackBridge = typeof api;

contextBridge.exposeInMainWorld("afterpack", api);
