import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["mongoose", "nodemailer", "mongodb-memory-server"],
  experimental: { serverActions: { bodySizeLimit: "12mb" } },
};

export default nextConfig;
