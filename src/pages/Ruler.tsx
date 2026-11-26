import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PageProps } from '../App';
import { href } from '../router';

/**
 * A ruler for the top of the screen (temporary): lines every 5 points from the very top, on the app's
 * dark background with a white bar down the middle — so a screenshot of the home-screen app shows how
 * far down iOS shades the page. Three ways to show it, to find out what the shading depends on:
 * a fixed layer over everything (no shading seen), ordinary page content ("in the page"), and the
 * same with a thin fixed strip along the top edge.
 */
export function RulerPage({ route }: PageProps) {
  const mode = route.query.get('mode') ?? 'fixed';
  const probe = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState('');
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle('ruler-flow', mode !== 'fixed');
    el.classList.toggle('ruler-edge', mode === 'edge');
    const safe = probe.current?.getBoundingClientRect().height ?? 0;
    const room = getComputedStyle(el).getPropertyValue('--safe-top').trim();
    const standalone = window.matchMedia('(display-mode: standalone)').matches;
    setInfo(`${mode} · safe area top ${Math.round(safe)} · room ${room} · ${innerWidth}×${innerHeight} · ${standalone ? 'home-screen app' : 'browser'}`);
    return () => {
      el.classList.remove('ruler-flow', 'ruler-edge');
    };
  }, [mode]);
  const lines = Array.from({ length: 41 }, (_, i) => i * 5);
  const body = (
    <div className={mode === 'fixed' ? 'ruler' : 'ruler ruler-inflow'} role="img" aria-label="Ruler for the top of the screen">
      <div ref={probe} style={{ position: 'absolute', top: 0, width: 1, height: 'env(safe-area-inset-top)' }} />
      <div className="ruler-bar" />
      {lines.map((y) => (
        <div key={y} className={`ruler-line ${y % 10 ? 'minor' : ''}`} style={{ top: y }}>
          {y % 10 === 0 && (
            <>
              <span>{y}</span>
              <span className="mid">{y}</span>
              <span>{y}</span>
            </>
          )}
        </div>
      ))}
      <div className="ruler-info">
        <p>
          <b>Take a screenshot</b> of each of these and send them — the numbers say how far down the shading reaches (look at the white bar):
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {[
            ['fixed', '1. Over everything'],
            ['flow', '2. In the page'],
            ['edge', '3. In the page + top strip'],
          ].map(([m, label]) => (
            <a key={m} className={`btn ${m === mode ? 'primary' : ''}`} href={href('ruler', { mode: m })}>
              {label}
            </a>
          ))}
        </div>
        <p className="small">{info}</p>
        <a className="btn" href={href('settings')}>
          Close
        </a>
      </div>
    </div>
  );
  return mode === 'fixed' ? createPortal(body, document.body) : body;
}
