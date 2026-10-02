import type { NextConfig } from "next";
import path from "path";
import { loadEnvConfig } from "@next/env";

// Next's CLI sets NODE_ENV ('development' for `next dev`, 'production' for
// `next build`/`next start`) before it loads this file, so it's already
// reliable here — reused below for the CSP's own dev/prod branching.
const isDev = process.env.NODE_ENV !== 'production';

// The canonical .env.local/.env.test.local live at the repo root, not in
// apps/web. @next/env is the same loader the Next CLI uses internally for
// its own .env* handling (dev, build, and start all import this config
// module before reading process.env), so this is the one place that needs
// to point it somewhere other than the default (this file's own directory).
// The `dev` argument controls whether .env.development(.local) or
// .env.production(.local) is also considered, matching what the Next CLI
// itself would pass for this phase.
loadEnvConfig(path.resolve(__dirname, "../.."), isDev);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';

// Next's dev server (Fast Refresh, on-demand entries) eval's module code and
// breaks without 'unsafe-eval'. Production doesn't need it — the built
// output never calls eval — so it's dropped there. 'unsafe-inline' stays in
// both: the app has no nonce plumbing (no per-request header/middleware
// injection), so removing it would break every inline script Next itself
// emits (e.g. the hydration bootstrap) without a nonce to replace it.
const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  ...(isDev ? ["'unsafe-eval'"] : []),
  'https://challenges.cloudflare.com',
].join(' ');

const nextConfig: NextConfig = {
  // @adaptive/shared ships its TypeScript source directly (no build step,
  // internal workspace package only) — Next only runs its own TS/JS
  // transform over app code and node_modules by default, so a workspace
  // package needs to opt in explicitly to get compiled instead of loaded raw.
  transpilePackages: ['@adaptive/shared'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              `script-src ${scriptSrc}`,
              "style-src 'self' 'unsafe-inline'",
              `connect-src 'self' ${supabaseUrl}`,
              "img-src 'self' data: blob:",
              "font-src 'self'",
              "frame-src https://challenges.cloudflare.com",
              "worker-src 'self' blob:",
              "object-src 'none'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
