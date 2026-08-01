import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The collector holds a long-lived WebSocket to the Protect console.
  serverExternalPackages: ["ws", "@clickhouse/client"],
  // Without this, Next infers a workspace root above the project and file
  // tracing walks (and trips over) unrelated sibling repos.
  outputFileTracingRoot: path.resolve(__dirname),
};

export default nextConfig;
