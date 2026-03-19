/** Map container width to column count matching the Tailwind breakpoints. */
export function getColumnCount(width: number): number {
  if (width >= 1024) return 8;
  if (width >= 768) return 6;
  if (width >= 640) return 4;
  return 3;
}
