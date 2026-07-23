import { memo, useCallback } from "react"
import { IconChevronDown } from "@tabler/icons-react"
import { Button } from "@/ui-lib/base-components/button/button"

type ExpandArrowProps = {
    isExpanded: boolean
    rowId: string
    toggleExpanded: (id: string) => void
}

/**
 * Expand arrow — memo-wrapped so it only re-renders when props change.
 * Accepts `rowId` + `toggleExpanded` instead of an inline `onClick` closure
 * so that the parent doesn't create a new function reference on every render.
 */
const ExpandArrow = memo(function ExpandArrow({ isExpanded, rowId, toggleExpanded }: ExpandArrowProps) {
    const handleClick = useCallback(
        (e: React.MouseEvent) => { e.stopPropagation(); toggleExpanded(rowId) },
        [rowId, toggleExpanded],
    )

    return (
        <Button
            variant="icon"
            className="dt-expand-arrow"
            aria-label={isExpanded ? "Collapse row" : "Expand row"}
            icon={<IconChevronDown className={isExpanded ? 'dt-expand-arrow--open' : ''} size={20} />}
            onClick={handleClick}
        />
    )
})

export default ExpandArrow
