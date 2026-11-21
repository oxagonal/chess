import { useEffect, useState } from 'react';

export interface Route {
  path: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [p, q] = raw.split('?');
  return { path: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q ?? '') };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function href(path: string, query?: Record<string, string | undefined>): string {
  const q = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][]).toString() : '';
  return `#/${path.replace(/^\//, '')}${q ? `?${q}` : ''}`;
}

export function navigate(path: string, query?: Record<string, string | undefined>) {
  window.location.hash = href(path, query);
}

/**
 * The Repertoire tab on a scope — every chapter of a color ('white' / 'black'), a repertoire
 * (`set:<id>`) or one chapter (its id) — or, without one, on the scope you last looked at.
 */
export const scopeHref = (scope?: string) => href('repertoire', scope ? { scope } : undefined);
export const openScope = (scope?: string) => navigate('repertoire', scope ? { scope } : undefined);
