/**
 * Sparks brand mark — a single-cycle waveform pulse (flat → trough → crest → flat).
 * Monochrome and stroke-based, so it inherits `color` (uses currentColor by
 * default) and scales crisply anywhere: sidebar header, auth shell, tab icon.
 */
export function Logo({
  size = 24,
  color = "currentColor",
  strokeWidth = 5,
  title = "Sparks",
}: {
  size?: number;
  color?: string;
  strokeWidth?: number;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path
        d="M2 24 H13 C16.2 24 16.6 39 20.5 39 C24.4 39 24 9 28 9 C32 9 31.8 24 35 24 H46"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
