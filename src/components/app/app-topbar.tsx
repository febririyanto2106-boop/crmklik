import { Search, PanelLeftClose, PanelLeftOpen, BookOpen } from "lucide-react";
import { Breadcrumbs } from "@/shared/components/breadcrumbs";
import { useLayout } from "@/shared/contexts/layout-context";
import { MobileNav } from "./mobile-nav";
import { NotificationCenter } from "./notification-center";
import { UserMenu } from "./user-menu";
import { ThemeSwitcher } from "./theme-switcher";
import { QuickActions } from "./quick-actions";
import { docsUrl } from "@/lib/docs/links";
import { SHOW_RESOURCE_LINKS } from "@/lib/docs/visibility";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
  tabs?: ReactNode;
  showBreadcrumbs?: boolean;
  showPageHeader?: boolean;
  showSidebarToggle?: boolean;
};

/**
 * Sticky application header. Composes: mobile nav trigger, breadcrumbs +
 * title, global search (⌘K), quick actions, notifications, theme switcher,
 * and user menu. Backwards-compatible with { title, subtitle, actions }.
 */
export function AppTopbar({
  title,
  subtitle,
  actions,
  tabs,
  showBreadcrumbs = true,
  showPageHeader = true,
  showSidebarToggle = true,
}: Props) {
  const { setCommandOpen, sidebarCollapsed, toggleSidebar, navMode, setTopbarActionsNode } =
    useLayout();
  const headerRef = useRef<HTMLElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [actionsEmpty, setActionsEmpty] = useState(true);

  /*
   * Pages portal their toolbar into this slot, and some of them portal
   * something that is itself desktop-only ("hidden md:block"). `empty:hidden`
   * cannot see that — the node has children, they just do not render — so on a
   * phone that left an 17px strip of border and padding with nothing in it.
   * Measuring the slot instead catches both cases: no children, or children
   * that lay out to nothing.
   */
  const setActionsNode = useCallback(
    (node: HTMLDivElement | null) => {
      actionsRef.current = node;
      setTopbarActionsNode(node);
    },
    [setTopbarActionsNode],
  );

  useEffect(() => {
    const el = actionsRef.current;
    if (!el) return;
    const read = () => setActionsEmpty(el.getBoundingClientRect().height === 0);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Publish the actual sticky topbar height (h-header row + title/actions row)
  // as `--topbar-height` on <html>. Sticky sub-headers below the topbar use
  // `top-[var(--topbar-height,var(--header-height))]` so they always align flush under the
  // topbar regardless of breakpoint or wrap.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const write = () => {
      document.documentElement.style.setProperty(
        "--topbar-height",
        `${Math.round(el.getBoundingClientRect().height)}px`,
      );
    };
    write();
    const ro = new ResizeObserver(write);
    ro.observe(el);
    window.addEventListener("resize", write);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", write);
    };
  }, []);

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur-xl supports-[backdrop-filter]:bg-surface/70"
    >
      {/* Row 1 — controls */}
      <div className="flex h-header items-center gap-2 px-3 lg:px-6">
        <MobileNav />

        {/*
         * Mobile only: the page title rides in the controls row instead of
         * getting a band of its own. Row 2 is the single biggest consumer of
         * vertical space on a phone, and this row always has slack in the
         * middle (the full search field is md+ only), so the title costs
         * nothing here.
         */}
        {showPageHeader && (
          <h1 className="md:hidden min-w-0 flex-1 truncate font-display text-base font-semibold">
            {title}
          </h1>
        )}

        {navMode === "full" && showSidebarToggle && (
          <button
            onClick={toggleSidebar}
            className="grid h-9 w-9 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        )}

        <button
          onClick={() => setCommandOpen(true)}
          className="hidden md:flex flex-1 max-w-xl items-center gap-2 rounded-control border border-border bg-muted/40 px-3 h-9 text-sm text-muted-foreground transition-all hover:bg-muted hover:border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Open command palette"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left truncate">Search contacts, messages, actions</span>
          <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            ⌘K
          </kbd>
        </button>

        {/* Mobile-only search icon */}
        <button
          onClick={() => setCommandOpen(true)}
          className="md:hidden grid h-9 w-9 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </button>

        <div className="ml-auto flex items-center gap-1">
          {SHOW_RESOURCE_LINKS && (
            <a
              href={docsUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden md:inline-flex items-center gap-1.5 rounded-control px-2.5 h-9 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Open documentation"
              title="Documentation"
            >
              <BookOpen className="h-4 w-4" />
              <span className="hidden lg:inline">Docs</span>
            </a>
          )}
          <QuickActions />
          <ThemeSwitcher />
          <NotificationCenter />
          <div className="mx-1 h-6 w-px bg-border" aria-hidden />
          <UserMenu />
        </div>
      </div>

      {/* Row 2 — page title + breadcrumbs + actions, 8/4 grid on large screens */}
      {showPageHeader && (
        <div className="grid grid-cols-1 gap-2 max-md:border-t-0 max-md:p-0 border-t border-border/50 px-4 py-3 lg:grid-cols-12 lg:items-center lg:px-6">
          {/*
           * Below md the title moved up into row 1 and this block disappears
           * entirely, so the whole band collapses unless the page supplies
           * actions — in which case the actions carry their own padding and
           * divider (see below).
           */}
          <div className="hidden md:block min-w-0 lg:col-span-8">
            {showBreadcrumbs && <Breadcrumbs />}
            <div className="mt-1 flex min-w-0 items-baseline gap-3">
              <h1 className="font-display text-lg font-semibold lg:text-xl">{title}</h1>
              {subtitle && (
                <p className="hidden min-w-0 flex-1 truncate text-sm text-muted-foreground sm:block">
                  {subtitle}
                </p>
              )}
            </div>
          </div>
          <div
            className={`max-md:px-4 lg:col-span-4 ${
              /*
               * The band's own padding and divider are opt-in rather than
               * opt-out: conflicting classes (py-0 vs py-2) would be decided by
               * Tailwind's stylesheet order, not by this condition. Collapsing
               * it instead of hiding it keeps the slot measurable — hiding
               * would zero the height we read and latch it shut forever.
               */
              actionsEmpty ? "" : "max-md:border-t max-md:border-border/50 max-md:py-2"
            }`}
          >
            <div
              ref={setActionsNode}
              className="flex flex-wrap items-center gap-2 lg:justify-end empty:hidden"
            >
              {actions}
            </div>
          </div>
        </div>
      )}

      {/* Row 3 — optional in-page tab navigation (e.g. CRM's Contacts/Leads/Messaging switch) */}
      {tabs && <div className="border-t border-border/50 px-4 lg:px-6">{tabs}</div>}
    </header>
  );
}
