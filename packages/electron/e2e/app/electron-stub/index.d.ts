export interface IpcMainEvent {
  sender: unknown;
}
export declare const app: {
  whenReady(): Promise<void>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  quit(): void;
  getAppPath(): string;
};
export declare class BrowserWindow {
  static getAllWindows(): BrowserWindow[];
  constructor(options?: Record<string, unknown>);
  webContents: { openDevTools(): void; send(channel: string, ...args: unknown[]): void };
  loadFile(path: string): void;
  loadURL(url: string): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  show(): void;
}
export declare const ipcMain: {
  handle(channel: string, handler: (event: IpcMainEvent, ...args: never[]) => unknown): void;
  on(channel: string, handler: (event: IpcMainEvent, ...args: never[]) => unknown): void;
};
export declare const ipcRenderer: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, handler: (...args: unknown[]) => void): void;
  send(channel: string, ...args: unknown[]): void;
};
export declare const contextBridge: {
  exposeInMainWorld(key: string, api: unknown): void;
};
