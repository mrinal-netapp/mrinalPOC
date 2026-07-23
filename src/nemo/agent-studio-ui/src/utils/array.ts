/**
 * Array utilities for drag-and-drop reordering
 */

/**
 * Move an item in an array from one index to another
 * @param arr - The source array
 * @param from - The source index
 * @param to - The target index
 * @returns A new array with the item moved
 */
export function arrayMove<T>(arr: T[], from: number, to: number): T[] {
    const next = arr.slice()
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    return next
}
