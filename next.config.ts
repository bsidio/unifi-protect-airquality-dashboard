import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone emits a self-contained server bundle, which keeps the runtime
  // image small and avoids shipping node_modules into the container.
  output: "standalone",
  // The collector holds a long-lived WebSocket to the Protect console.
  serverExternalPackages: ["ws", "@clickhouse/client"],
  // Without this, Next infers a workspace root above the project and file
  // tracing walks (and trips over) unrelated sibling repos.
  outputFileTracingRoot: path.resolve(__dirname),
};

export default nextConfig;
