interface MobileHeaderProps {
  onOpenDrawer: () => void;
}

/**
 * Slim header strip shown on screens narrower than `md`. Two
 * elements: the brand mark + a hamburger button that opens the
 * drawer (which contains the same StagesList the desktop sidebar
 * shows). Hidden on md+ where the sidebar is always visible.
 */
export function MobileHeader({ onOpenDrawer }: MobileHeaderProps) {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-800 bg-[#0a0410]/95 px-4 py-3 backdrop-blur md:hidden">
      <h1 className="bg-gradient-to-r from-fuchsia-400 to-amber-300 bg-clip-text text-lg font-bold tracking-tight text-transparent">
        Pavoia
      </h1>
      <button
        type="button"
        onClick={onOpenDrawer}
        aria-label="Open stages menu"
        className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-700 text-slate-300 transition-colors hover:bg-slate-800/60"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
          <rect x="3" y="6" width="18" height="2" rx="1" />
          <rect x="3" y="11" width="18" height="2" rx="1" />
          <rect x="3" y="16" width="18" height="2" rx="1" />
        </svg>
      </button>
    </header>
  );
}
