/**
 * Stacks read bottom-to-top in the data model (index 0 sits on trunk), but
 * read top-down on screen, matching `gh stack view`. Only the display is
 * reversed; every message back to the host uses model order.
 */
export function toDisplayOrder(names: string[]): string[] {
  return [...names].reverse();
}

export function toModelOrder(names: string[]): string[] {
  return [...names].reverse();
}

/** `1` -> `1st`. Stacks are short, so the teens rule never bites in practice. */
export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/**
 * How long ago the last fetch was, as coarsely as still says something.
 *
 * The point is not the exact number but whether the ahead/behind counts below
 * are worth believing — "3d ago" and "3d 4h ago" carry the same warning.
 */
export function since(when: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - when) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
