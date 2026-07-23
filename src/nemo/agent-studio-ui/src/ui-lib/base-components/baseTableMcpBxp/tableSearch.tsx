import { useRef, useEffect } from "react"
import { IconSearch, IconX } from "@tabler/icons-react"
import { cn } from "@/ui-lib/lib/utils"

interface TableSearchProps {
    value: string
    onChange: (value: string) => void
    placeholder?: string
    disabled?: boolean
    isOpen: boolean
    onToggle: () => void
    /** When true, icon stays blue even when closed (search filters rows). When false, icon is gray. */
    isEnabled?: boolean
}

export function TableSearch({
    value,
    onChange,
    placeholder = "Search...",
    disabled = false,
    isOpen,
    onToggle,
    isEnabled = false,
}: TableSearchProps) {
    const inputRef = useRef<HTMLInputElement>(null)

    // Auto-focus the input when search opens (slight delay for transition)
    useEffect(() => {
        if (isOpen && inputRef.current) {
            const timer = setTimeout(() => inputRef.current?.focus(), 100)
            return () => clearTimeout(timer)
        }
    }, [isOpen])

    const handleToggle = () => {
        onToggle()
    }

    const handleClear = () => {
        onChange("")
        inputRef.current?.focus()
    }

    const hasValue = value.length > 0

    return (
        <div className={cn("dt-search", isOpen && "dt-search--open", disabled && "dt-search--disabled")}>
            {/* Magnifying glass icon — always visible */}
            <button
                type="button"
                className={cn(
                    "dt-search__icon",
                    (isOpen || isEnabled) && "dt-search__icon--active",
                    !isEnabled && "dt-search__icon--not-enabled",
                )}
                onClick={handleToggle}
                aria-label={isOpen ? "Close search" : "Open search"}
                disabled={disabled || !isEnabled}
            >
                <IconSearch size={20} />
            </button>

            {/* Input — always in DOM, animated via CSS */}
            <input
                ref={inputRef}
                type="text"
                className="dt-search__input"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                tabIndex={isOpen ? 0 : -1}
            />

            {/* Clear button — always in DOM, visible only when open AND has value */}
            <button
                type="button"
                className={cn("dt-search__clear", isOpen && hasValue && "dt-search__clear--visible")}
                onClick={handleClear}
                aria-label="Clear search"
                tabIndex={isOpen && hasValue ? 0 : -1}
            >
                <IconX size={20} />
            </button>

            {/* Underline — always in DOM, animated via CSS */}
            <div className="dt-search__underline" />
        </div>
    )
}
