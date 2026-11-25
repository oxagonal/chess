/**
 * The Cloudflare Worker in front of the static site: /api/stop (the phone stop check,
 * src/worker/stop.ts); everything else is the app's files.
 */
import { handleStop } from '../src/worker/stop';

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/stop') return handleStop(url);
    return env.ASSETS.fetch(request);
  },
};
