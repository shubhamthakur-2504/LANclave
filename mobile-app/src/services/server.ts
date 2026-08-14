import TcpSocket from "react-native-tcp-socket";
import { Directory, File, Paths } from "expo-file-system";
import { getOrCreateDeviceIdentity } from "./identity";
import { Buffer } from "buffer";

let server: TcpSocket.Server | null = null;
const PORT = 8377;

export async function startServer(): Promise<void> {
  if (server) return;

  const identity = await getOrCreateDeviceIdentity();
  const deviceId = identity.deviceId;
  
  // Use Paths.document as the sandbox directory
  const sandboxDir = Paths.document;

  server = TcpSocket.createServer((socket) => {
    let buffer = "";
    
    socket.on("data", async (data) => {
      buffer += data.toString();
      // Wait for the full HTTP header block
      if (!buffer.includes("\r\n\r\n")) {
        return;
      }

      const request = buffer;
      const firstLine = request.split("\r\n")[0];
      if (!firstLine) return;
      
      const parts = firstLine.split(" ");
      if (parts.length < 2) return;
      const method = parts[0];
      const url = parts[1];

      // Clear buffer to prevent duplicate processing if more data arrives (shouldn't for GET)
      buffer = "";

      try {
        if (method === "GET" && url === "/health") {
          const body = JSON.stringify({
            status: "ok",
            app: "lanclave",
            device_id: deviceId,
            name: "Mobile Device"
          });
          const response = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
          socket.write(response);
          socket.end();
        } 
        else if (method === "GET" && url === "/api/sandbox/files") {
          const items = sandboxDir.list();
          const files = [];
          
          for (const item of items) {
            // Filter hidden files
            if (item.name.startsWith(".")) continue;

            const isDir = item instanceof Directory;
            if (isDir) {
              files.push({
                name: item.name,
                size: 0,
                is_directory: true,
              });
            } else {
              const file = item as File;
              files.push({
                name: file.name,
                size: file.size,
                is_directory: false,
              });
            }
          }
          
          const body = JSON.stringify(files);
          const response = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
          socket.write(response);
          socket.end();
        }
        else if (method === "GET" && url.startsWith("/files/")) {
          const pathParam = decodeURIComponent(url.replace("/files/", ""));
          
          // Prevent directory traversal
          if (pathParam.includes("..") || pathParam.includes("/") || !pathParam) {
             const resp = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
             socket.write(resp);
             socket.end();
             return;
          }
          
          const file = new File(sandboxDir, pathParam);
          
          if (!file.exists) {
            const resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
            socket.write(resp);
            socket.end();
            return;
          }
          
          // In Expo 57, text() reads as string, but for binary we might need to read as base64 
          // or use readAsBytes(). For now we read as base64 to Buffer.
          // Note: text() is a synchronous string read, text() doesn't have options.
          // We can use base64() method if it exists, or text().
          // Let's use `file.text()` or assume `react-native-tcp-socket` can send the file path directly.
          // Actually, expo-file-system File has text(), bytes() methods in SDK 57.
          const binaryData = await file.bytes();
          
          const header = `HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${binaryData.byteLength}\r\nConnection: close\r\n\r\n`;
          socket.write(header);
          socket.write(Buffer.from(binaryData));
          socket.end();
        } 
        else {
          const resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
          socket.write(resp);
          socket.end();
        }
      } catch (e) {
        console.error("HTTP error:", e);
        const resp = "HTTP/1.1 500 Internal Error\r\nConnection: close\r\n\r\n";
        socket.write(resp);
        socket.end();
      }
    });

    socket.on("error", (err) => {
      console.warn("Socket error:", err);
    });
  });

  server.on("error", (err) => {
    console.error("Server error:", err);
  });

  server.listen({ port: PORT, host: "0.0.0.0" }, () => {
    console.log(`Mobile HTTP Server listening on port ${PORT}`);
  });
}

export function stopServer(): void {
  if (server) {
    server.close();
    server = null;
    console.log("Mobile HTTP Server stopped.");
  }
}

export function isServerRunning(): boolean {
  return server !== null;
}
