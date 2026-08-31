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

/** Feather "grid": 2×2 rounded squares — auto-layout. */
export function LayoutIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
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

/** Ring spinner marking work in progress; sized by the caller's class. */
export function Spinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`${className} block animate-spin rounded-full border border-blue-400 border-t-transparent`}
    />
  );
}

export function StopIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </Svg>
  );
}
