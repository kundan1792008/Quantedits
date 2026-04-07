import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "replicate.delivery",
      },
      {
        protocol: "https",
        hostname: "s3.amazonaws.com",
      },
      {
        protocol: "https",
        // Matches any S3 regional endpoint, e.g. my-bucket.s3.us-east-1.amazonaws.com
        hostname: "**.s3.**.amazonaws.com",
      },
      {
        protocol: "https",
        // Cloudflare R2 public bucket URL
        hostname: "**.r2.cloudflarestorage.com",
      },
    ],
  },
};

export default nextConfig;
