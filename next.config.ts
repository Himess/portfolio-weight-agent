import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The agent core is plain TypeScript shared between the app, the replay
  // harness and the tests. Nothing here needs bundler special-casing.
  serverExternalPackages: ["@anthropic-ai/sdk"],
};

export default nextConfig;
