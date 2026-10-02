/**
 * True on any production-mode server: a Vercel production or preview deployment, or a self-hosted
 * `next start`. Controls that must hold wherever the real database may be reached check this.
 */
export function isProductionMode(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
}

/**
 * True only for the live production site. On Vercel, `VERCEL_ENV` decides (a preview is not
 * production even though its `NODE_ENV` is); off Vercel, `NODE_ENV` decides.
 */
export function isLiveProduction(): boolean {
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === 'production';
  return process.env.NODE_ENV === 'production';
}
