import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Agent SDK spawns a bundled CLI subprocess; keep it unbundled so its
  // runtime files are traced into the serverless function as-is.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
