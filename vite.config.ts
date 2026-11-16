/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Commit being built, shown in Settings to tell which version is live. */
function buildCommit(): string {
  // Cloudflare's builds set WORKERS_CI_COMMIT_SHA, but it isn't always a hash (a manual deploy gave "main").
  const fromCi = process.env.WORKERS_CI_COMMIT_SHA ?? '';
  if (/^[0-9a-f]{7,40}$/i.test(fromCi)) return fromCi.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return fromCi || 'dev';
  }
}

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: { chunkSizeWarningLimit: 900 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
