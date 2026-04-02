export type PaginationControlsProps = {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
};

/**
 * Pagination bar shown below inventory table/cards.
 * Extracted from InventoryPage lines ~2961-2999.
 */
export function PaginationControls({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
}: PaginationControlsProps) {
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * pageSize;

  return (
    <div className="inventory-pagination">
      <span className="inventory-pagination-info">
        {pageStart + 1}–{Math.min(pageStart + pageSize, totalItems)} of {totalItems}
      </span>
      <div className="inventory-pagination-controls">
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={() => onPageChange(Math.max(1, safePage - 1))}
          disabled={safePage === 1}
        >
          ← Prev
        </button>
        {totalPages <= 10 ? (
          <span className="inventory-pagination-pages">
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
              <button
                key={page}
                type="button"
                className={`inventory-pagination-page${safePage === page ? " active" : ""}`}
                onClick={() => onPageChange(page)}
              >
                {page}
              </button>
            ))}
          </span>
        ) : (
          <span className="inventory-pagination-current">Page {safePage} of {totalPages}</span>
        )}
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
          disabled={safePage === totalPages}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
