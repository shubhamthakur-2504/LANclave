/**
 * Requests to other LANclave devices.
 *
 * Every device speaks TLS with a certificate its own identity key vouches
 * for (see `Tls.kt`). `fetch` cannot check a certificate like that, so
 * nothing in the app calls it for a peer: requests go through the native
 * module, which can, and which signs them too.
 */

import ExpoNativeServerModule from "../../modules/expo-native-server/src/ExpoNativeServerModule";

export interface PeerRequestInit {
  method?: "GET" | "POST";
  /** Sent as JSON. */
  body?: unknown;
  /**
   * Reach a device that is not paired: discovery and pairing only. Without
   * it, a device outside the paired list is refused before anything is sent.
   */
  anyone?: boolean;
  /** Say who is asking, with the signed headers. On unless turned off. */
  signed?: boolean;
  timeoutMs?: number;
}

export interface PeerResponse {
  ok: boolean;
  status: number;
  text: string;
  /** The body as JSON, or null when it is not JSON. */
  json: <T = any>() => T | null;
}

/**
 * Why nothing came back. `name` is what callers switch on:
 * "TimeoutError", "TlsError" (it answered, but is not a device we accept:
 * an older LANclave, or not paired), or "NetworkError".
 */
export class PeerRequestError extends Error {
  constructor(name: "TimeoutError" | "TlsError" | "NetworkError", peerAddr: string) {
    super(
      name === "TimeoutError"
        ? `connection to ${peerAddr} timed out — peer may be unreachable`
        : name === "TlsError"
          ? `${peerAddr} is not a device this phone can talk to — it may need updating, or pairing again`
          : `could not reach ${peerAddr} — check both devices are on the same LAN`,
    );
    this.name = name;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000; // generous for a LAN

/** `fetch`, for another LANclave device. `peerAddr` is `ip:port`. */
export async function peerFetch(
  peerAddr: string,
  path: string,
  init: PeerRequestInit = {},
): Promise<PeerResponse> {
  const reply = await ExpoNativeServerModule.peerRequest(
    peerAddr,
    init.method ?? "GET",
    path,
    init.body === undefined ? null : JSON.stringify(init.body),
    init.anyone ?? false,
    init.signed ?? true,
    init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (reply.status === -2) throw new PeerRequestError("TimeoutError", peerAddr);
  if (reply.status === -3) throw new PeerRequestError("TlsError", peerAddr);
  if (reply.status < 0) throw new PeerRequestError("NetworkError", peerAddr);

  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    text: reply.body,
    json: () => {
      try {
        return JSON.parse(reply.body);
      } catch {
        return null;
      }
    },
  };
}
