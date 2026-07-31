// Animated SVG loading states. Every animation here is CSS transform or
// opacity ONLY — those run on the compositor thread, so they keep moving
// even while the main thread is pinned flat by wasm init or a model cache
// write. A JS-driven percent number freezes exactly when reassurance
// matters most; these don't.
//
// prefers-reduced-motion collapses everything to a calm static glyph.

export function MoonLoader({ size = 56 }: { size?: number }) {
  return (
    <span className="ldr-moon" aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 56 56" width={size} height={size}>
        {/* crescent: full disc minus an offset shadow disc */}
        <defs>
          <mask id="ldr-crescent">
            <rect width="56" height="56" fill="white" />
            <circle cx="35" cy="22" r="16" fill="black" />
          </mask>
        </defs>
        <circle cx="28" cy="28" r="16" fill="#e8d5a3" mask="url(#ldr-crescent)" />
        {/* the orbiting spark — parent group rotates, spark counter-twinkles */}
        <g className="ldr-orbit">
          <circle cx="28" cy="4.5" r="2.2" fill="#f0e3bd" className="ldr-spark" />
        </g>
      </svg>
      <style>{`
        .ldr-moon { display: inline-block; position: relative; }
        .ldr-orbit {
          transform-origin: 28px 28px;
          animation: ldrOrbit 3.2s linear infinite;
        }
        .ldr-spark { animation: ldrSpark 1.6s ease-in-out infinite; }
        @keyframes ldrOrbit { to { transform: rotate(360deg) } }
        @keyframes ldrSpark { 0%,100% { opacity: .4 } 50% { opacity: 1 } }
        @media (prefers-reduced-motion: reduce) {
          .ldr-orbit { animation: none }
          .ldr-spark { animation: none; opacity: .8 }
        }
      `}</style>
    </span>
  );
}

/** Progress bar whose fill carries a light-sweep and a glowing comet head.
    The width is JS-driven (fine while the network streams); the sweep and
    the comet's breathing are compositor-driven, so a stall — cache write,
    wasm compile — still shimmers instead of flatlining. */
export function ShimmerBar({ pct }: { pct: number }) {
  return (
    <span className="ldr-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <span className="ldr-bar-fill" style={{ width: `${Math.max(3, Math.min(100, pct))}%` }}>
        <span className="ldr-bar-sweep" />
        <span className="ldr-bar-comet" />
      </span>
      <style>{`
        .ldr-bar {
          display: block; height: 6px; border-radius: 9999px;
          background: #2a2418; overflow: hidden; position: relative;
        }
        .ldr-bar-fill {
          display: block; height: 100%; border-radius: 9999px;
          background: #6b5d3f; position: relative; overflow: hidden;
          /* No width transition: width animates on the MAIN thread, which
             wasm init freezes — the bar visibly stuck mid-tween in testing.
             Snap the width; the sweep and comet (compositor) carry the
             sense of motion. */
        }
        .ldr-bar-sweep {
          position: absolute; inset: 0;
          background: linear-gradient(100deg, transparent 20%, rgba(240,227,189,.45) 50%, transparent 80%);
          transform: translateX(-100%);
          animation: ldrSweep 1.8s ease-in-out infinite;
        }
        .ldr-bar-comet {
          position: absolute; right: 0; top: 50%; width: 10px; height: 10px;
          border-radius: 9999px; background: #f0e3bd;
          box-shadow: 0 0 8px 2px rgba(240,227,189,.55);
          transform: translate(4px, -50%);
          animation: ldrComet 1.6s ease-in-out infinite;
        }
        @keyframes ldrSweep { to { transform: translateX(100%) } }
        @keyframes ldrComet {
          0%,100% { transform: translate(4px,-50%) scale(.7); opacity: .6 }
          50% { transform: translate(4px,-50%) scale(1); opacity: 1 }
        }
        @media (prefers-reduced-motion: reduce) {
          .ldr-bar-sweep, .ldr-bar-comet { animation: none }
          .ldr-bar-sweep { transform: none; opacity: 0 }
        }
      `}</style>
    </span>
  );
}

/** Three drifting stars for "it's thinking" — the gap between a sent
    message and the first token, where a static glyph reads as a hang. */
export function TwinkleRow({ size = 14 }: { size?: number }) {
  return (
    <span className="ldr-twinkle" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <svg key={i} viewBox="0 0 10 10" width={size} height={size} style={{ animationDelay: `${i * 0.35}s` }} className="ldr-star">
          <path d="M5 0 L6.1 3.9 L10 5 L6.1 6.1 L5 10 L3.9 6.1 L0 5 L3.9 3.9 Z" fill="#e8d5a3" />
        </svg>
      ))}
      <style>{`
        .ldr-twinkle { display: inline-flex; gap: 6px; align-items: center; }
        .ldr-star {
          animation: ldrTwinkle 1.4s ease-in-out infinite;
          transform-origin: center;
        }
        @keyframes ldrTwinkle {
          0%,100% { opacity: .25; transform: scale(.75) rotate(0deg) }
          50% { opacity: 1; transform: scale(1) rotate(45deg) }
        }
        @media (prefers-reduced-motion: reduce) {
          .ldr-star { animation: none; opacity: .6 }
        }
      `}</style>
    </span>
  );
}
