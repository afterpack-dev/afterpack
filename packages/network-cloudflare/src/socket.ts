import {
  createNetworkProtection,
  type NetworkProtection,
  type NetworkProtectionOptions,
  type SocketData,
  type SocketState,
} from "@afterpack/network-core";

export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const REFUSAL_CLOSE_CODE = 1008;

export interface ProtectedSocket {
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
}

export type SocketProtectionSource =
  | NetworkProtection
  | (Pick<NetworkProtectionOptions, "privateKeys"> & Partial<NetworkProtectionOptions>);

interface Session {
  state: SocketState | null;
  deadline: number;
}

interface Attachment {
  np1: Session;
  app: unknown;
}

export interface SocketProtection {
  readonly protection: NetworkProtection;
  accept(socket: ProtectedSocket, attachment?: unknown): void;
  receive(
    socket: ProtectedSocket,
    message: string | ArrayBuffer | ArrayBufferView,
  ): string | ArrayBuffer | null;
  send(socket: ProtectedSocket, message: SocketData): void;
  attachment(socket: ProtectedSocket): unknown;
  setAttachment(socket: ProtectedSocket, value: unknown): void;
}

function isAttachment(value: unknown): value is Attachment {
  return typeof value === "object" && value !== null && "np1" in value && "app" in value;
}

function toProtection(source: SocketProtectionSource): NetworkProtection {
  if (typeof (source as NetworkProtection).openSocket === "function")
    return source as NetworkProtection;
  const options = source as NetworkProtectionOptions;
  return createNetworkProtection({ ...options, routes: options.routes ?? { include: ["/**"] } });
}

export function createSocketProtection(source: SocketProtectionSource): SocketProtection {
  const protection = toProtection(source);
  const local = new WeakMap<ProtectedSocket, Attachment>();
  const pending = new Map<ProtectedSocket, SocketData[]>();
  const timers = new Map<ProtectedSocket, ReturnType<typeof setTimeout>>();

  const read = (socket: ProtectedSocket): Attachment | undefined => {
    if (typeof socket.deserializeAttachment === "function") {
      const value = socket.deserializeAttachment();
      return isAttachment(value) ? value : undefined;
    }
    return local.get(socket);
  };

  const write = (socket: ProtectedSocket, value: Attachment) => {
    if (typeof socket.serializeAttachment === "function") socket.serializeAttachment(value);
    else local.set(socket, value);
  };

  const forget = (socket: ProtectedSocket) => {
    pending.delete(socket);
    const timer = timers.get(socket);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(socket);
  };

  const refuse = (socket: ProtectedSocket) => {
    forget(socket);
    try {
      socket.close(REFUSAL_CLOSE_CODE);
    } catch {}
  };

  const accept = (socket: ProtectedSocket, attachment?: unknown) => {
    write(socket, {
      np1: { state: null, deadline: Date.now() + HANDSHAKE_TIMEOUT_MS },
      app: attachment ?? null,
    });
    timers.set(
      socket,
      setTimeout(() => {
        timers.delete(socket);
        if (read(socket)?.np1.state === null) refuse(socket);
      }, HANDSHAKE_TIMEOUT_MS),
    );
  };

  const receive = (
    socket: ProtectedSocket,
    message: string | ArrayBuffer | ArrayBufferView,
  ): string | ArrayBuffer | null => {
    const current = read(socket);
    if (current === undefined) {
      refuse(socket);
      return null;
    }
    const { state, deadline } = current.np1;
    if (state === null && Date.now() > deadline) {
      refuse(socket);
      return null;
    }
    const opened = protection.openSocket(state, message);
    if (!opened.ok) {
      refuse(socket);
      return null;
    }
    if (state === null) {
      write(socket, { np1: { state: opened.state, deadline }, app: current.app });
      const queued = pending.get(socket) ?? [];
      forget(socket);
      for (const data of queued) socket.send(protection.sealSocket(opened.state, data));
    }
    const data = opened.message;
    if (data === null || typeof data === "string") return data;
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  };

  const send = (socket: ProtectedSocket, message: SocketData) => {
    const state = read(socket)?.np1.state ?? null;
    if (state === null) {
      const queue = pending.get(socket) ?? [];
      queue.push(typeof message === "string" ? message : copy(message));
      pending.set(socket, queue);
      return;
    }
    socket.send(protection.sealSocket(state, message));
  };

  const attachment = (socket: ProtectedSocket): unknown => read(socket)?.app ?? null;

  const setAttachment = (socket: ProtectedSocket, value: unknown) => {
    const current = read(socket);
    if (current === undefined) throw new Error("accept the socket before setting its attachment");
    write(socket, { np1: current.np1, app: value });
  };

  return { protection, accept, receive, send, attachment, setAttachment };
}

function copy(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}
