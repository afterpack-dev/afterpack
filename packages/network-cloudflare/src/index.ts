export {
  type Counters,
  createNetworkProtection,
  generateKeyPair,
  type NetworkProtection,
  type NetworkProtectionOptions,
  REFUSAL_STATUS,
  type RefusalReason,
  type RequestInfo,
  type Routes,
  type SocketState,
} from "@afterpack/network-core";
export {
  type FetchHandler,
  type HonoLikeApp,
  type HonoLikeContext,
  type HonoLikeMiddleware,
  networkProtection,
  withNetworkProtection,
} from "./fetch.js";
export type { ProtectionSource } from "./resolve.js";
export {
  createSocketProtection,
  HANDSHAKE_TIMEOUT_MS,
  type ProtectedSocket,
  REFUSAL_CLOSE_CODE,
  type SocketProtection,
  type SocketProtectionSource,
} from "./socket.js";
