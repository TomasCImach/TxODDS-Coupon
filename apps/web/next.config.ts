import type { NextConfig } from "next";
import path from "node:path";
import { resolvePasskeyDeploymentConfig } from "./src/lib/deployment-config";

const browserApiOrigin = (() => {
  try {
    return new URL(
      process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000",
    ).origin;
  } catch {
    return "http://localhost:4000";
  }
})();

resolvePasskeyDeploymentConfig({
  deploymentTier: process.env.NEXT_PUBLIC_DEPLOYMENT_TIER,
  appId: process.env.NEXT_PUBLIC_PASSKEY_APP_ID,
});

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${browserApiOrigin} https://api.devnet.solana.com wss://api.devnet.solana.com https://wallet.passkeys.foundation https://*.passkeys.foundation`,
  "frame-src https://wallet.passkeys.foundation https://*.passkeys.foundation",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join("; ");

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@goaldrop/protocol", "@goaldrop/ui"],
  experimental: { optimizePackageImports: ["@solana/web3.js"] },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
        ],
      },
    ];
  },
};

export default config;
