import TcpSocket from "react-native-tcp-socket";
import { Directory, File, Paths } from "expo-file-system";
import { getOrCreateDeviceIdentity } from "./identity";
import { Buffer } from "buffer";

let server: TcpSocket.Server | null = null;
let isShuttingDown = false;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let serverDesiredOn = false; // tracks user intent: should the server be running?
const PORT = 8377;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to destroy any server WE still hold a reference to.
 * After a hot-reload, `server` is null so this is a no-op — the ghost
 * native server keeps running, which is fine (it still serves correctly).
 */
function destroyServer(): Promise<void> {
  return new Promise((resolve) => {
    isShuttingDown = true;
    if (!server) {
      resolve();
      return;
    }
    const s = server;
    server = null;
    try {
      s.close(() => resolve());
    } catch {
      resolve();
    }
    setTimeout(resolve, 1000);
  });
}

/**
 * Build the request handler and bind to PORT.
 * Rejects with EADDRINUSE if the port is taken.
 */
function createAndListen(
  deviceId: string,
  sandboxDir: Directory,
): Promise<TcpSocket.Server> {
  return new Promise((resolve, reject) => {
    const s = TcpSocket.createServer((socket) => {
      let buffer = "";
      let dead = false;

      const markDead = () => { dead = true; };
      socket.on("close", markDead);
      socket.on("error", markDead);

      /**
       * Safe write: silently no-ops if the socket or server is gone.
       * The try/catch protects against synchronous JS errors;
       * the `dead` flag prevents us from reaching the native bridge
       * for sockets that are already destroyed on the Java side.
       */
      const safeWrite = (data: string | Buffer): Promise<void> =>
        new Promise((resolve) => {
          if (dead || isShuttingDown) { resolve(); return; }
          try {
            if (typeof data === "string") {
              socket.write(data, "utf8" as any, resolve as any);
            } else {
              socket.write(data as any, resolve as any);
            }
          } catch {
            dead = true;
            resolve();
          }
        });

      const safeEnd = () => {
        if (dead || isShuttingDown) return;
        dead = true;
        try { socket.end(); } catch { /* already gone */ }
      };

      socket.on("data", async (rawData) => {
        if (dead || isShuttingDown) return;

        buffer += rawData.toString();
        if (!buffer.includes("\r\n\r\n")) return;

        const request = buffer;
        buffer = "";

        const firstLine = request.split("\r\n")[0] ?? "";
        const parts = firstLine.split(" ");
        if (parts.length < 2) { safeEnd(); return; }
        const method = parts[0];
        const url = parts[1];

        try {
          if (method === "GET" && url === "/health") {
            const body = JSON.stringify({
              status: "ok",
              app: "lanclave",
              device_id: deviceId,
              name: "Mobile Device",
            });
            await safeWrite(
              `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
            );
            safeEnd();
          } else if (method === "GET" && url === "/api/sandbox/files") {
            const items = sandboxDir.list();
            const files: { name: string; size: number; is_directory: boolean }[] = [];
            for (const item of items) {
              if (item.name.startsWith(".")) continue;
              const isDir = item instanceof Directory;
              files.push({
                name: item.name,
                size: isDir ? 0 : (item as File).size,
                is_directory: isDir,
              });
            }
            const body = JSON.stringify(files);
            await safeWrite(
              `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
            );
            safeEnd();
          } else if (method === "GET" && url.startsWith("/files/")) {
            const pathParam = decodeURIComponent(url.replace("/files/", ""));
            if (pathParam.includes("..") || pathParam.includes("/") || !pathParam) {
              await safeWrite("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
              safeEnd();
              return;
            }
            const file = new File(sandboxDir, pathParam);
            if (!file.exists) {
              await safeWrite("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
              safeEnd();
              return;
            }
            const binaryData = await file.bytes();
            if (dead || isShuttingDown) return;
            await safeWrite(
              `HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${binaryData.byteLength}\r\nConnection: close\r\n\r\n`,
            );
            await safeWrite(Buffer.from(binaryData));
            safeEnd();
          } else {
            await safeWrite("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
            safeEnd();
          }
        } catch (e) {
          console.warn("[server] Handler error:", e);
          safeEnd();
        }
      });
    });

    // Listen for server-level errors (e.g. native crash / unexpected close)
    s.on("error", (err: NodeJS.ErrnoException) => {
      // If the server dies while we want it running, mark it null so
      // the watchdog picks it up and restarts
      if (server === s) {
        console.warn("[server] Server error while running:", err.message);
        server = null;
      }
      reject(err);
    });

    s.listen({ port: PORT, host: "0.0.0.0" }, () => {
      console.log(`[server] Listening on port ${PORT}`);
      resolve(s);
    });
  });
}

// ---------------------------------------------------------------------------
// Watchdog — periodically checks if the server is still alive and restarts it
// ---------------------------------------------------------------------------

function startWatchdog(): void {
  stopWatchdog();
  watchdogTimer = setInterval(async () => {
    if (!serverDesiredOn) return; // user turned it off, don't restart

    // If server reference is lost (native crash, hot reload, etc.) try to restart
    if (!server) {
      console.log("[watchdog] Server is gone, attempting restart…");
      try {
        const identity = await getOrCreateDeviceIdentity();
        const sandboxDir = Paths.document;
        server = await createAndListen(identity.deviceId, sandboxDir);
        isShuttingDown = false;
        console.log("[watchdog] Server restarted successfully.");
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EADDRINUSE") {
          // Ghost server is still alive — that's fine, it's serving requests
          isShuttingDown = false;
        } else {
          console.warn("[watchdog] Restart failed:", err);
        }
      }
    }
  }, 10_000); // check every 10 seconds
}

function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the HTTP server. **Never throws** — if the port is already in use
 * (e.g. a ghost server from a hot-reload), we treat it as "server is running"
 * and return successfully, because the old native server is still serving
 * requests just fine.
 *
 * Also starts a watchdog that auto-restarts the server if it dies.
 */
export async function startServer(): Promise<void> {
  serverDesiredOn = true;
  await destroyServer();

  const identity = await getOrCreateDeviceIdentity();
  const sandboxDir = Paths.document;

  try {
    server = await createAndListen(identity.deviceId, sandboxDir);
    isShuttingDown = false;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EADDRINUSE") {
      console.warn(
        `[server] Port ${PORT} already in use (ghost server from hot-reload). ` +
        `Treating as running.`,
      );
      server = null;
      isShuttingDown = false;
    } else {
      console.error("[server] Failed to start:", err);
    }
  }

  // Start the watchdog to auto-recover from crashes
  startWatchdog();
}

export function stopServer(): void {
  serverDesiredOn = false;
  stopWatchdog();
  destroyServer();
}

/**
 * Returns true if the user intended the server to be on.
 * This stays true even if the native server crashed momentarily —
 * the watchdog will bring it back.
 */
export function isServerRunning(): boolean {
  return serverDesiredOn;
}
