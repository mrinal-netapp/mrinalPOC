import { IconChevronsLeft, IconChevronLeft, IconChevronRight, IconChevronsRight } from "@tabler/icons-react"
import { Typography } from "../typography/typography"

export type BaseTablePaginationProps = {
    pageIndex: number
    pageCount: number
    pageSize: number
    totalRows: number
    canPreviousPage: boolean
    canNextPage: boolean
    onFirstPage: () => void
    onPreviousPage: () => void
    onNextPage: () => void
    onLastPage: () => void
}

export function BaseTablePagination(props: BaseTablePaginationProps) {
    const { pageIndex, pageSize, totalRows, canPreviousPage, canNextPage, onFirstPage, onPreviousPage, onNextPage, onLastPage } = props

    const rangeStart = totalRows === 0 ? 0 : pageIndex * pageSize + 1
    const rangeEnd = Math.min((pageIndex + 1) * pageSize, totalRows)

    return (
        <div className="dt-pagination">
            <div className="dt-pagination-info">
                <Typography Component="span" fontSize="fs14" boldness="semibold">
                    {rangeStart} - {rangeEnd} of {totalRows}
                </Typography>
            </div>
            <div className="dt-pagination-arrows">
                <div className="dt-pagination-arrow-group">
                    <button
                        className={`dt-pagination-arrow ${!canPreviousPage ? 'dt-pagination-arrow--disabled' : ''}`}
                        onClick={onFirstPage}
                        disabled={!canPreviousPage}
                        aria-label="Go to first page"
                    >
                        <IconChevronsLeft size={20} />
                    </button>
                    <button
                        className={`dt-pagination-arrow ${!canPreviousPage ? 'dt-pagination-arrow--disabled' : ''}`}
                        onClick={onPreviousPage}
                        disabled={!canPreviousPage}
                        aria-label="Go to previous page"
                    >
                        <IconChevronLeft size={20} />
                    </button>
                </div>
                <div className="dt-pagination-page">
                    <Typography Component="span" fontSize="fs14" boldness="semibold">
                        {pageIndex + 1}
                    </Typography>
                </div>
                <div className="dt-pagination-arrow-group">
                    <button
                        className={`dt-pagination-arrow ${!canNextPage ? 'dt-pagination-arrow--disabled' : ''}`}
                        onClick={onNextPage}
                        disabled={!canNextPage}
                        aria-label="Go to next page"
                    >
                        <IconChevronRight size={20} />
                    </button>
                    <button
                        className={`dt-pagination-arrow ${!canNextPage ? 'dt-pagination-arrow--disabled' : ''}`}
                        onClick={onLastPage}
                        disabled={!canNextPage}
                        aria-label="Go to last page"
                    >
                        <IconChevronsRight size={20} />
                    </button>
                </div>
            </div>
        </div>
    )
}
