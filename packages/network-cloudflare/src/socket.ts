import type {
  NetworkProtection,
  NetworkProtectionOptions,
  SocketData,
  SocketState,
} from "@afterpack/network-core";
import { createNetworkProtection } from "./resolve.js";

export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const REFUSAL_CLOSE_CODE = 1008;
export const PENDING_SEND_LIMIT = 256;
export const PENDING_BYTES_LIMIT = 1 << 20;

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

interface Pending {
  messages: SocketData[];
  bytes: number;
}

export interface SocketProtection {
  readonly protection: NetworkProtection;
  accept(socket: ProtectedSocket, attachment?: unknown): void;
  restore(socket: ProtectedSocket): void;
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
  const pending = new WeakMap<ProtectedSocket, Pending>();
  const timers = new WeakMap<ProtectedSocket, ReturnType<typeof setTimeout>>();
  const refused = new WeakSet<ProtectedSocket>();

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
    refused.add(socket);
    try {
      socket.close(REFUSAL_CLOSE_CODE);
    } catch {}
  };

  const arm = (socket: ProtectedSocket, deadline: number) => {
    const timer = timers.get(socket);
    if (timer !== undefined) clearTimeout(timer);
    timers.set(
      socket,
      setTimeout(
        () => {
          timers.delete(socket);
          if (read(socket)?.np1.state === null) refuse(socket);
        },
        Math.max(0, deadline - Date.now()),
      ),
    );
  };

  const accept = (socket: ProtectedSocket, attachment?: unknown) => {
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    write(socket, { np1: { state: null, deadline }, app: attachment ?? null });
    arm(socket, deadline);
  };

  const restore = (socket: ProtectedSocket) => {
    if (refused.has(socket) || timers.has(socket)) return;
    const current = read(socket);
    if (current === undefined || current.np1.state !== null) return;
    if (Date.now() >= current.np1.deadline) refuse(socket);
    else arm(socket, current.np1.deadline);
  };

  const receive = (
    socket: ProtectedSocket,
    message: string | ArrayBuffer | ArrayBufferView,
  ): string | ArrayBuffer | null => {
    if (refused.has(socket)) return null;
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
      const queued = pending.get(socket)?.messages ?? [];
      forget(socket);
      for (const data of queued) socket.send(protection.sealSocket(opened.state, data));
    }
    const data = opened.message;
    if (data === null || typeof data === "string") return data;
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  };

  const send = (socket: ProtectedSocket, message: SocketData) => {
    if (refused.has(socket)) return;
    const current = read(socket);
    if (current === undefined) return;
    const state = current.np1.state;
    if (state !== null) {
      socket.send(protection.sealSocket(state, message));
      return;
    }
    const item = typeof message === "string" ? message : copy(message);
    const queue = pending.get(socket) ?? { messages: [], bytes: 0 };
    queue.messages.push(item);
    queue.bytes += typeof item === "string" ? item.length * 3 : item.byteLength;
    if (queue.messages.length > PENDING_SEND_LIMIT || queue.bytes > PENDING_BYTES_LIMIT) {
      refuse(socket);
      return;
    }
    pending.set(socket, queue);
  };

  const attachment = (socket: ProtectedSocket): unknown => read(socket)?.app ?? null;

  const setAttachment = (socket: ProtectedSocket, value: unknown) => {
    const current = read(socket);
    if (current === undefined) throw new Error("accept the socket before setting its attachment");
    write(socket, { np1: current.np1, app: value });
  };

  return { protection, accept, restore, receive, send, attachment, setAttachment };
}

function copy(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}
