import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { href } from '../router';

/**
 * A ruler for the top of the screen (temporary): lines every 5 points from the very top, on the app's
 * dark background with a white bar down the middle — so a screenshot of the home-screen app shows
 * exactly how far down iOS shades the page, and the room under the status bar can be set to that.
 */
export function RulerPage() {
  const probe = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState('');
  useEffect(() => {
    const safe = probe.current?.getBoundingClientRect().height ?? 0;
    const room = getComputedStyle(document.documentElement).getPropertyValue('--safe-top').trim();
    const standalone = window.matchMedia('(display-mode: standalone)').matches;
    setInfo(`safe area top ${Math.round(safe)} · room ${room} · ${innerWidth}×${innerHeight} · ${standalone ? 'home-screen app' : 'browser'}`);
  }, []);
  const lines = Array.from({ length: 41 }, (_, i) => i * 5);
  return createPortal(
    <div className="ruler" role="img" aria-label="Ruler for the top of the screen">
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
          <b>Take a screenshot of this page</b> and send it: the numbers say how far down the shading reaches (look at the white bar).
        </p>
        <p className="small">{info}</p>
        <a className="btn" href={href('settings')}>
          Close
        </a>
      </div>
    </div>,
    document.body,
  );
}
