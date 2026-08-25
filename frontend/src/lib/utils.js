import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, letting a caller's utility win over a component default.
 *
 * `twMerge` is what makes that work: plain `clsx` would emit both `p-3` and
 * `p-6` and leave the winner to CSS source order, which is not something a
 * component author can control from a prop.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
