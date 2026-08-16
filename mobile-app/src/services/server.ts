import TcpSocket from "react-native-tcp-socket";
import { Directory, File, Paths } from "expo-file-system";
import { getOrCreateDeviceIdentity } from "./identity";
import { Buffer } from "buffer";
import { getSettings } from "./settings";

let server: TcpSocket.Server | null = null;
let isShuttingDown = false;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let serverDesiredOn = false; // tracks user intent: should the server be running?
const PORT = 8377;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

function createAndListen(
  deviceId: string,
  displayName: string,
  sandboxDir: Directory,
): Promise<TcpSocket.Server> {
  return new Promise((resolve, reject) => {
    const s = TcpSocket.createServer((socket) => {
      let buffer = "";
      let dead = false;

      const markDead = () => { dead = true; };
      socket.on("close", markDead);
      socket.on("error", markDead);

      const safeWrite = async (data: string | Buffer, skipDelay: boolean = false, encoding: any = "utf8"): Promise<void> => {
        if (dead || isShuttingDown) return;

        try {
          if (typeof data === "string") {
            socket.write(data, encoding);
          } else {
            socket.write(data);
          }
        } catch {
          dead = true;
          return;
        }
        
        if (!skipDelay) {
          // Yield to the event loop and allow GC/socket flush.
          // In React Native, setImmediate is faster than setTimeout(..., 2).
          await new Promise(resolve => setImmediate(resolve));
        }
      };

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
              device_name: displayName,
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
            const items = sandboxDir.list();
            const child = items.find(i => i.name === pathParam);
            
            if (!child || child instanceof Directory) {
              await safeWrite("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
              safeEnd();
              return;
            }
            const file = child as File;
            const fileSize = file.size ?? 0;
            
            await safeWrite(
              `HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${fileSize}\r\nConnection: close\r\n\r\n`,
            );

            const chunkSize = 1024 * 1024; // 1 MB chunks
            let offset = 0;
            console.log(`[server] Starting download for ${pathParam} (${fileSize} bytes)`);
            let lastLogTime = Date.now();
            let chunkCount = 0;
            
            try {
              while (offset < fileSize) {
                if (dead || isShuttingDown) {
                  console.log(`[server] Transfer cancelled or server shutting down. dead=${dead}, isShuttingDown=${isShuttingDown}`);
                  break;
                }
                
                const length = Math.min(chunkSize, fileSize - offset);
                // Read chunk as base64 to avoid react-native string encoding issues with binary data
                const b64Chunk = await require("expo-file-system/legacy").readAsStringAsync(file.uri, {
                  encoding: "base64",
                  position: offset,
                  length: length,
                });
                
                chunkCount++;
                // Skip the delay except for every 4th chunk (every 4 MB)
                const skipDelay = chunkCount % 4 !== 0;
                await safeWrite(b64Chunk, skipDelay, "base64");
                offset += length;
                
                const now = Date.now();
                if (now - lastLogTime > 1000) {
                    console.log(`[server] Sent ${offset}/${fileSize} bytes for ${pathParam}`);
                    lastLogTime = now;
                }
              }
              console.log(`[server] Transfer complete for ${pathParam}, total sent: ${offset}`);
            } catch (err) {
              console.error(`[server] Error during transfer of ${pathParam}:`, err);
            }
            
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

    s.on("error", (err: NodeJS.ErrnoException) => {
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

function startWatchdog(): void {
  stopWatchdog();
  watchdogTimer = setInterval(async () => {
    if (!serverDesiredOn) return; 

    if (!server) {
      console.log("[watchdog] Server is gone, attempting restart…");
      try {
        const identity = await getOrCreateDeviceIdentity();
        const settings = await getSettings();
        const sandboxDir = new Directory(settings.sandboxPath);
        server = await createAndListen(identity.deviceId, settings.displayName, sandboxDir);
        isShuttingDown = false;
        console.log("[watchdog] Server restarted successfully.");
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EADDRINUSE") {
          isShuttingDown = false;
        } else {
          console.warn("[watchdog] Restart failed:", err);
        }
      }
    }
  }, 10_000);
}

function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

export async function startServer(): Promise<void> {
  serverDesiredOn = true;
  await destroyServer();

  const identity = await getOrCreateDeviceIdentity();
  const settings = await getSettings();
  const sandboxDir = new Directory(settings.sandboxPath);

  try {
    server = await createAndListen(identity.deviceId, settings.displayName, sandboxDir);
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

  startWatchdog();
}

export function stopServer(): void {
  serverDesiredOn = false;
  stopWatchdog();
  destroyServer();
}

export function isServerRunning(): boolean {
  return serverDesiredOn;
}
