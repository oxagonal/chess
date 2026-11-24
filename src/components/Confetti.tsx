/**
 * A burst of confetti over the page — for finishing something big (a chapter prepared down to your
 * coverage goal). A canvas laid over everything for a few seconds, taps go through it. With reduced
 * motion asked for, nothing moves (the message that goes with it says it all).
 */
const COLORS = ['#74b95a', '#e8b04a', '#4a90d9', '#e05d5d', '#b07ad9', '#f2f2f2'];

export function confetti(durationMs = 2600) {
  if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: `${w}px`, height: `${h}px`, pointerEvents: 'none', zIndex: '1000' });
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas.remove();
  ctx.scale(dpr, dpr);
  // Two bursts from the bottom corners, up and inwards, then falling with a flutter.
  const pieces = Array.from({ length: 160 }, (_, i) => {
    const left = i % 2 === 0;
    const angle = (left ? -60 : -120) * (Math.PI / 180) + (Math.random() - 0.5) * 0.9;
    const speed = 9 + Math.random() * 9;
    return {
      x: left ? w * 0.08 : w * 0.92,
      y: h * 0.95,
      vx: Math.cos(angle) * speed * (w / 900 + 0.4),
      vy: Math.sin(angle) * speed * (h / 800 + 0.4),
      size: 5 + Math.random() * 6,
      spin: Math.random() * Math.PI,
      vspin: (Math.random() - 0.5) * 0.3,
      color: COLORS[i % COLORS.length],
    };
  });
  const start = performance.now();
  const frame = (t: number) => {
    const age = t - start;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = Math.max(0, Math.min(1, (durationMs - age) / 600));
    for (const p of pieces) {
      p.vy += 0.32; // gravity
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx + Math.sin((age + p.size * 90) / 180) * 0.6;
      p.y += p.vy;
      p.spin += p.vspin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, (p.size / 2) * Math.abs(Math.cos(p.spin * 2)) + 1);
      ctx.restore();
    }
    if (age < durationMs) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
