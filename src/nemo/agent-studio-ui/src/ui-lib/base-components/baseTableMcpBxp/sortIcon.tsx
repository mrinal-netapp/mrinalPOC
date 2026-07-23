/**
 * Sort icon matching Figma "table header sort & filter" component.
 *
 * Three visual states:
 * - "none" (unsorted): two rounded chevron polygons (up ▲ + down ▼), fill #1C1C1C
 * - "asc" (ascending): single arrow-with-stem pointing UP, fill #1C1C1C
 * - "desc" (descending): single arrow-with-stem pointing DOWN, fill #1C1C1C
 *
 * On hover the "none" state chevrons become #6F6F6F (handled via CSS).
 */
interface SortIconProps {
    direction: "asc" | "desc" | false
    className?: string
}

/**
 * Unsorted — two rounded chevrons (from Figma "Sort / none").
 */
function SortNoneIcon() {
    return (
        <svg
            className="dt-sort-icon dt-sort-icon--none"
            width="12"
            height="14"
            viewBox="0 0 12 14"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            {/* Up chevron */}
            <path
                d="M5.59637 0.355412C5.79062 0.159126 6.10721 0.157482 6.30349 0.351741L10.1357 4.14462C10.4532 4.45885 10.2307 5 9.78402 5H2.19826C1.75406 5 1.53041 4.46402 1.84286 4.1483L5.59637 0.355412Z"
                className="dt-sort-chevron"
            />
            {/* Down chevron */}
            <path
                d="M6.35355 13.6464C6.15829 13.8417 5.84171 13.8417 5.64645 13.6464L1.85355 9.85355C1.53857 9.53857 1.76165 9 2.20711 9L9.79289 9C10.2383 9 10.4614 9.53857 10.1464 9.85355L6.35355 13.6464Z"
                className="dt-sort-chevron"
            />
        </svg>
    )
}

/**
 * Arrow-with-stem icon (from Figma "Sort / down (descending)").
 * When direction="asc" it is rotated 180° via CSS (matching Figma "Sort / up (ascending)").
 */
function SortArrowIcon({ direction }: { direction: "asc" | "desc" }) {
    return (
        <svg
            className={`dt-sort-icon dt-sort-icon--${direction}`}
            width="12"
            height="14"
            viewBox="0 0 12 14"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M6 0.140472C5.44772 0.140472 5 0.588188 5 1.14047V8.14047H2.06752C1.6436 8.14047 1.41202 8.6349 1.68341 8.96056L5.61589 13.6795C5.81579 13.9194 6.18421 13.9194 6.38411 13.6795L10.3166 8.96056C10.588 8.6349 10.3564 8.14047 9.93248 8.14047H7V1.14047C7 0.588188 6.55228 0.140472 6 0.140472Z"
                className="dt-sort-arrow"
            />
        </svg>
    )
}

export function SortIcon({ direction, className }: SortIconProps) {
    return (
        <span className={`dt-sort-icon-wrapper${className ? ` ${className}` : ""}`}>
            {direction ? <SortArrowIcon direction={direction} /> : <SortNoneIcon />}
        </span>
    )
}
