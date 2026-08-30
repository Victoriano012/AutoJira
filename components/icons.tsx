/** Feather-style stroke icons for the toolbar's action buttons, sized to
 * match HomeIcon/ArrowLeftIcon/GearIcon. */

function Svg({ size = 20, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function PlusIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Svg>
  );
}

/** Feather "share-2": a small connected graph — reads as auto-layout. */
export function LayoutIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </Svg>
  );
}

export function PlayIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <polygon points="5 3 19 12 5 21 5 3" />
    </Svg>
  );
}

export function StopIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </Svg>
  );
}
