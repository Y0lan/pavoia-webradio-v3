interface MobileHeaderProps {
  onOpenDrawer: () => void;
}

/**
 * Sticky strip on mobile-width screens. Wordmark + hamburger.
 * Hidden on md+ where the desktop sidebar takes over.
 */
export function MobileHeader({ onOpenDrawer }: MobileHeaderProps) {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-[var(--color-card-border)] bg-[var(--color-bg)]/95 px-4 py-3 backdrop-blur md:hidden">
      <h1
        className="font-display text-2xl font-normal tracking-[0.08em] text-[var(--color-text)]"
        style={{ textShadow: "0 0 16px rgba(232,80,32,0.15)" }}
      >
        PÂVOIA
      </h1>
      <button
        type="button"
        onClick={onOpenDrawer}
        aria-label="Open stages menu"
        className="flex size-10 items-center justify-center rounded-sm border border-[var(--color-card-border-strong)] text-[var(--color-text-soft)] transition-colors hover:bg-[var(--color-bg-soft)]"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="currentColor"
          aria-hidden="true"
        >
          <rect x="3" y="6" width="18" height="2" rx="1" />
          <rect x="3" y="11" width="18" height="2" rx="1" />
          <rect x="3" y="16" width="18" height="2" rx="1" />
        </svg>
      </button>
    </header>
  );
}
