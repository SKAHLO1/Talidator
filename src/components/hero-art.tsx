// Isometric "validated stack" illustration for the dashboard hero.

const STROKE = "#5fe0cf";

function Slab({ cx, cy, hw, t, opacity = 1 }: { cx: number; cy: number; hw: number; t: number; opacity?: number }) {
  const hh = hw / 2;
  return (
    <g opacity={opacity}>
      <path d={`M${cx - hw},${cy} L${cx},${cy + hh} L${cx},${cy + hh + t} L${cx - hw},${cy + t} Z`} fill="rgba(42,157,143,0.28)" stroke={STROKE} strokeWidth="1" />
      <path d={`M${cx},${cy + hh} L${cx + hw},${cy} L${cx + hw},${cy + t} L${cx},${cy + hh + t} Z`} fill="rgba(42,157,143,0.16)" stroke={STROKE} strokeWidth="1" />
      <path d={`M${cx},${cy - hh} L${cx + hw},${cy} L${cx},${cy + hh} L${cx - hw},${cy} Z`} fill="rgba(95,224,207,0.10)" stroke={STROKE} strokeWidth="1.2" />
      <path d={`M${cx},${cy - hh + 10} L${cx + hw - 20},${cy} L${cx},${cy + hh - 10} L${cx - hw + 20},${cy} Z`} fill="none" stroke={STROKE} strokeOpacity=".35" strokeWidth=".8" />
    </g>
  );
}

function Cube({ cx, cy, s }: { cx: number; cy: number; s: number }) {
  const h = s / 2;
  return (
    <g>
      <path d={`M${cx - s},${cy} L${cx},${cy + h} L${cx},${cy + h + s} L${cx - s},${cy + s} Z`} fill="rgba(42,157,143,0.45)" stroke={STROKE} strokeWidth="1" />
      <path d={`M${cx},${cy + h} L${cx + s},${cy} L${cx + s},${cy + s} L${cx},${cy + h + s} Z`} fill="rgba(42,157,143,0.25)" stroke={STROKE} strokeWidth="1" />
      <path d={`M${cx},${cy - h} L${cx + s},${cy} L${cx},${cy + h} L${cx - s},${cy} Z`} fill="rgba(95,224,207,0.35)" stroke={STROKE} strokeWidth="1" />
    </g>
  );
}

export function HeroArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 420 270" className={className} aria-hidden>
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <radialGradient id="halo" cx="50%" cy="55%" r="50%">
          <stop offset="0" stopColor="#2a9d8f" stopOpacity=".35" />
          <stop offset="1" stopColor="#2a9d8f" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="shield" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3fbfae" stopOpacity=".55" />
          <stop offset="1" stopColor="#1f7f74" stopOpacity=".35" />
        </linearGradient>
      </defs>

      <ellipse cx="215" cy="160" rx="190" ry="110" fill="url(#halo)" />

      {/* circuit connections */}
      <g stroke={STROKE} strokeOpacity=".55" strokeWidth="1" fill="none" filter="url(#glow)">
        <path d="M80 150 L140 150 L160 140" />
        <path d="M335 105 L300 105 L280 120" />
        <path d="M275 215 L255 200" />
        <path d="M110 190 L150 205" />
      </g>

      <g filter="url(#glow)">
        <Slab cx={215} cy={200} hw={78} t={14} />
        <Slab cx={215} cy={168} hw={78} t={14} />
        <Slab cx={215} cy={136} hw={78} t={14} />
      </g>

      <g className="animate-float" filter="url(#glow)">
        <path d="M222 28 L256 42 V70 C256 94 240 108 222 115 L222 28Z" fill="rgba(31,127,116,0.5)" stroke={STROKE} strokeWidth="1" />
        <path d="M215 24 L249 38 V66 C249 90 233 104 215 111 C197 104 181 90 181 66 V38 Z" fill="url(#shield)" stroke={STROKE} strokeWidth="1.5" />
        <path d="M200 67 l10 10 l20 -22" fill="none" stroke="#9ff5ea" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      <g filter="url(#glow)">
        <Cube cx={70} cy={140} s={18} />
        <Cube cx={345} cy={92} s={17} />
        <Cube cx={285} cy={210} s={15} />
        <Cube cx={100} cy={188} s={9} />
      </g>
    </svg>
  );
}
