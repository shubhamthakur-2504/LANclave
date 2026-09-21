/**
 * Turn a backend error into a sentence a person can act on.
 *
 * The Rust side already has a real error taxonomy (`ClientError`), but it
 * crosses the Tauri boundary as a formatted string, and the UI was rendering
 * that string raw. These patterns map the `Display` output in
 * `src-tauri/src/client/mod.rs` back to something human, and every branch ends
 * with what the user can do about it.
 *
 * Keep the match strings in sync with that `Display` impl.
 */

export interface FriendlyError {
  message: string;
  /** Extra line shown under the message, when there is something useful. */
  hint?: string;
}

/** `peerName` is used where naming the peer makes the message concrete. */
export function humanizeError(err: unknown, peerName?: string): FriendlyError {
  const raw = typeof err === "string" ? err : String(err);
  const lower = raw.toLowerCase();
  const who = peerName ? `“${peerName}”` : "the other device";

  if (lower.includes("could not reach peer")) {
    return {
      message: `Couldn't reach ${who}.`,
      hint: "Check both devices are on the same Wi-Fi or hotspot, and that the other one has its server running.",
    };
  }

  // ServerRejected(u16) — the status code carries the real meaning.
  const rejected = raw.match(/peer rejected the request \(HTTP (\d{3})\)/i);
  if (rejected) {
    switch (rejected[1]) {
      case "401":
        return {
          message: `${peerName ?? "That device"} did not recognise this one.`,
          hint: "Pair the two devices again.",
        };
      case "404":
        return { message: "That file is no longer on the other device." };
      case "409":
        return {
          message: "A file with that name already exists on the other device.",
          hint: "Rename it, or remove the copy there first.",
        };
      case "413":
        return { message: "That file is too large for the other device to accept." };
      default:
        return {
          message: `${peerName ?? "The other device"} refused the request.`,
          hint: `It replied with HTTP ${rejected[1]}.`,
        };
    }
  }

  if (lower.includes("transfer error")) {
    return {
      message: "The transfer stopped partway.",
      hint: "This is usually the network dropping. Try again.",
    };
  }

  if (lower.includes("local i/o error")) {
    return {
      message: "Couldn't read or write the file on this device.",
      hint: "Check the sandbox folder still exists and has free space.",
    };
  }

  if (lower.includes("outside") && lower.includes("sandbox")) {
    return {
      message: "That file is outside your sandbox folder.",
      hint: "Only files inside the sandbox can be shared.",
    };
  }

  if (lower.includes("already running")) {
    return { message: "The server is already running." };
  }
  if (lower.includes("not running")) {
    return { message: "The server isn't running." };
  }
  if (lower.includes("bind")) {
    return {
      message: "Couldn't start the server.",
      hint: "Another program may already be using port 8377.",
    };
  }

  // Unrecognised: still show something, but never a bare exception dump.
  return {
    message: "Something went wrong.",
    hint: raw.length > 160 ? `${raw.slice(0, 160)}…` : raw,
  };
}
