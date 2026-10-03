import type { NextConfig } from "next";
import path from "path";
import { loadEnvConfig } from "@next/env";

// Next's CLI sets NODE_ENV ('development' for `next dev`, 'production' for
// `next build`/`next start`) before it loads this file, so it's already
// reliable here — reused below for the CSP's own dev/prod branching.
const isDev = process.env.NODE_ENV !== 'production';

// The canonical .env.local/.env.test.local live at the repo root, not in
// apps/web. Next has already called @next/env's loadEnvConfig for apps/web
// (which has no env files) before it imports this module, and @next/env
// caches that first result per process, so a plain second call for the root
// returns the cached, empty result. `forceReload` (the fourth argument) makes
// it read the root files; Next then copies whatever this adds to process.env
// into its baseline, so the values survive dev-server env reloads. Shell and
// Vercel variables still win: dotenv never overrides a key already set. Next
// watches only apps/web for env-file edits, so a change to the root file
// needs a dev-server restart. The `dev` argument selects
// .env.development(.local) versus .env.production(.local), as the Next CLI
// itself would for this phase.
loadEnvConfig(path.resolve(__dirname, "../.."), isDev, console, true);

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
  // Next 16 otherwise writes AGENTS.md and CLAUDE.md into apps/web on every dev start; the repo
  // keeps its own agent instructions at the root.
  agentRules: false,
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
