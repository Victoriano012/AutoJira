/** AutoProject mark: the smallest possible DAG — two ticket cards converging on
 * one, joined by the orthogonal edge the graph editor draws. Convergence, not
 * divergence: a ticket waiting on its dependencies is the shape every board in
 * this app has. Colours are the app's own status palette, so the mark reads as
 * a live graph: emerald = done, amber = waiting on a human, zinc = still to do,
 * with the edge the same zinc as the card it feeds.
 *
 * Every colour is fixed — nothing here takes currentColor, so `className` is
 * for layout only and the mark looks the same on any chrome. Cards are filled
 * rather than stroked and every coordinate is a multiple of 1.5, so the shapes
 * survive a 16px browser tab without straddling pixels. The edge is drawn
 * heavier than the cards' own weight would suggest (2.4, not 1.8): in zinc it
 * no longer contrasts with the cards, so it needs the extra mass to still read
 * as a connector at 16px rather than dropping out.
 *
 * Keep this and app/icon.svg in sync — same geometry, same colours. */
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
        d="M9 6H12M9 18H12M12 6V18M12 12H15"
        stroke="#71717a"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <rect x="1.5" y="3" width="7.5" height="6" rx="1.2" fill="#10b981" />
      <rect x="1.5" y="15" width="7.5" height="6" rx="1.2" fill="#f59e0b" />
      <rect x="15" y="9" width="7.5" height="6" rx="1.2" fill="#71717a" />
    </svg>
  );
}
