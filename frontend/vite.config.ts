import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const publicTunnelHost = process.env.ENTROPY_PUBLIC_TUNNEL_HOST?.trim().toLowerCase();

const limitPublicTunnelApi: Plugin = {
  name: "entropy-miniapp-tunnel-api-limit",
  configureServer(server) {
    if (!publicTunnelHost) return;

    server.middlewares.use((request, response, next) => {
      const requestHost = (request.headers.host || "").replace(/:\d+$/, "").toLowerCase();
      if (requestHost !== publicTunnelHost || !request.url?.startsWith("/api/")) {
        next();
        return;
      }

      let pathname: string;
      try {
        pathname = new URL(request.url, "http://localhost").pathname;
      } catch {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Invalid request path." }));
        return;
      }

      const allowed =
        (request.method === "GET" && pathname === "/api/miniapp/catalog") ||
        (request.method === "POST" && pathname === "/api/miniapp/orders") ||
        (request.method === "POST" && pathname === "/api/observability/events");
      if (allowed) {
        next();
        return;
      }

      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "This API route is not available through the Mini App tunnel." }));
    });
  },
};

export default defineConfig({
  plugins: [react(), limitPublicTunnelApi],
  publicDir: resolve(__dirname, "public"),
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    allowedHosts: publicTunnelHost ? [publicTunnelHost] : [],
    proxy: { "/api": "http://127.0.0.1:8765" },
  },
});
