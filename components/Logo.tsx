/** AutoJira mark: the smallest possible DAG — one ticket card fanning out into
 * two along an orthogonal edge, the way the graph editor routes them. Cards are
 * filled, not stroked, so they survive a 16px browser tab; every coordinate is
 * a multiple of 1.5 so the shapes land on whole pixels at both 16px and 32px.
 * Cards and edges take currentColor; the violet card (the one that's next) is
 * the only hard-coded colour, so the mark still reads in one flat tone.
 * Keep this and app/icon.svg in sync — same geometry, explicit colours there. */
export default function Logo({
  size = 20,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden
    >
      <path
        d="M9 12H12M12 6V18M12 6H15M12 18H15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <rect x="1.5" y="9" width="7.5" height="6" rx="1.2" fill="currentColor" />
      <rect x="15" y="15" width="7.5" height="6" rx="1.2" fill="currentColor" />
      <rect x="15" y="3" width="7.5" height="6" rx="1.2" fill="#8b5cf6" />
    </svg>
  );
}
