// Displacement map behind every `.glass-refract` ring: soft fractal noise pushes
// the backdrop pixels sideways, which reads as refraction through an uneven glass
// edge (the part of Apple's Liquid Glass a plain blur can't fake).
// Mounted once by PlatformShell — invisible, no layout, no paint.
export default function GlassFilterDefs() {
  return (
    <svg className="glass-defs" aria-hidden="true" focusable="false">
      <filter id="liquid-glass" x="-30%" y="-30%" width="160%" height="160%"
              colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.006 0.010" numOctaves="2"
                      seed="11" result="noise" />
        <feGaussianBlur in="noise" stdDeviation="3" result="soft" />
        <feDisplacementMap in="SourceGraphic" in2="soft" scale="10"
                           xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
