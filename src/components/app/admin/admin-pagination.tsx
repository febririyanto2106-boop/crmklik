/**
 * Pager for the super-admin list pages.
 *
 * Both lists already load their rows in one query and filter them in memory,
 * so this pages the *filtered* array rather than refetching — the page a row
 * lands on always matches what the filters above the table say.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const ADMIN_PAGE_SIZES = [25, 50, 100] as const;

/** Clamps a page number to a list that may have shrunk under it. */
export function clampPage(page: number, total: number, perPage: number): number {
  const pages = Math.max(1, Math.ceil(total / perPage));
  return Math.min(Math.max(1, page), pages);
}

/** The slice of `items` belonging to `page`. */
export function pageSlice<T>(items: T[], page: number, perPage: number): T[] {
  const safe = clampPage(page, items.length, perPage);
  const start = (safe - 1) * perPage;
  return items.slice(start, start + perPage);
}

export function AdminPagination({
  page,
  perPage,
  total,
  onPageChange,
  onPerPageChange,
  label = "items",
}: {
  page: number;
  perPage: number;
  total: number;
  onPageChange: (page: number) => void;
  onPerPageChange: (perPage: number) => void;
  label?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = clampPage(page, total, perPage);
  // An empty list should read "0 of 0", not "1–0 of 0".
  const first = total === 0 ? 0 : (current - 1) * perPage + 1;
  const last = Math.min(current * perPage, total);

  return (
    <div className="flex flex-wrap items-center gap-3 border-t px-3 py-2 text-sm text-muted-foreground">
      <span>
        {first}–{last} of {total} {label}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <Select
          value={String(perPage)}
          onValueChange={(v) => {
            onPerPageChange(Number(v));
            // Row 300 is not on page 1 of a bigger page size, so start over.
            onPageChange(1);
          }}
        >
          <SelectTrigger className="h-8 w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ADMIN_PAGE_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} / page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={current <= 1}
          onClick={() => onPageChange(current - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="tabular-nums">
          Page {current} of {pages}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={current >= pages}
          onClick={() => onPageChange(current + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
