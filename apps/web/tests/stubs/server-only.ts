// Vitest runs outside Next's bundler, which is what normally turns
// `server-only` into a no-op on the server module graph and a build-time
// error only when a client component pulls it in. Without this alias every
// test that imports a server-only module would hit the package's
// unconditional throw. See vitest.config.mts.
export {};
