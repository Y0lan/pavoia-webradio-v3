import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useArtist, type PublicArtistSimilar } from "../api/plex.ts";

/* ============================================================================
 * Context — Layout owns the open state, components anywhere in the tree
 * call openArtist(ratingKey) / closeArtist(). Recursive: clicking a
 * similar artist inside the drawer just opens that artist.
 * ========================================================================== */

interface ArtistDrawerContextValue {
  ratingKey: number | null;
  openArtist: (ratingKey: number) => void;
  closeArtist: () => void;
}

const Ctx = createContext<ArtistDrawerContextValue | null>(null);

export function ArtistDrawerProvider({ children }: { children: ReactNode }) {
  const [ratingKey, setRatingKey] = useState<number | null>(null);
  return (
    <Ctx.Provider
      value={{
        ratingKey,
        openArtist: setRatingKey,
        closeArtist: () => setRatingKey(null),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useArtistDrawer(): ArtistDrawerContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error("useArtistDrawer must be used inside <ArtistDrawerProvider>");
  }
  return v;
}

/* ============================================================================
 * Drawer UI
 * ========================================================================== */

/**
 * Right-side slide-in artist drawer. Shows bio, country, genres, and
 * up to N similar artists (clickable, navigates the drawer). Pulls
 * data from /api/plex/artist via TanStack Query.
 */
export function ArtistDrawer() {
  const { ratingKey, openArtist, closeArtist } = useArtistDrawer();
  const open = ratingKey !== null;
  const { data, isLoading, isError, error } = useArtist(ratingKey);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeArtist();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      const el = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (el && document.body.contains(el)) {
        try {
          el.focus();
        } catch {
          // ignore — element disabled
        }
      }
    };
  }, [open, closeArtist]);

  return (
    <div
      className={`fixed inset-0 z-40 ${
        open ? "pointer-events-auto" : "pointer-events-none"
      }`}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close artist drawer"
        onClick={closeArtist}
        tabIndex={open ? 0 : -1}
        className={`absolute inset-0 bg-black/80 backdrop-blur-sm transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Panel — slides in from the right */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={open}
        aria-label="Artist details"
        tabIndex={-1}
        {...(open ? {} : { inert: true })}
        className={`absolute inset-y-0 right-0 flex w-full max-w-md transform flex-col overflow-y-auto border-l border-[var(--color-card-border-strong)] bg-[var(--color-bg)] shadow-2xl outline-none transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {/* Header — close button + label */}
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--color-card-border)] bg-[var(--color-bg)]/95 px-5 py-4 backdrop-blur">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">
            // artist · plex
          </span>
          <button
            type="button"
            onClick={closeArtist}
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-sm border border-[var(--color-card-border-strong)] text-[var(--color-text-soft)] transition-colors hover:bg-[var(--color-bg-soft)] hover:text-[var(--color-text)]"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
              aria-hidden="true"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        </header>

        <div className="px-5 py-6">
          {isLoading ? (
            <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
              // loading artist…
            </p>
          ) : isError || !data ? (
            <div className="rounded-sm border border-[rgba(255,170,0,0.3)] bg-[var(--color-bg-soft)] px-4 py-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-amber)]">
                // artist lookup failed
              </p>
              <p className="mt-2 font-sans text-xs text-[var(--color-text-soft)]">
                {error instanceof Error
                  ? error.message
                  : "Plex didn't return artist details."}
              </p>
            </div>
          ) : (
            <>
              {/* Hero — thumb + title */}
              <div className="flex items-end gap-4">
                {data.thumb ? (
                  <img
                    src={data.thumb}
                    alt=""
                    className="size-24 shrink-0 rounded-sm object-cover ring-1 ring-[var(--color-card-border-strong)]"
                  />
                ) : (
                  <div className="size-24 shrink-0 rounded-sm bg-[var(--color-bg-soft)] ring-1 ring-[var(--color-card-border)]" />
                )}
                <div className="min-w-0 flex-1">
                  <h2 className="line-clamp-2 font-serif text-2xl italic leading-tight text-[var(--color-text)]">
                    {data.title}
                  </h2>
                  {data.country.length > 0 || data.genre.length > 0 ? (
                    <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-faint)]">
                      {[...data.country, ...data.genre].join(" · ")}
                    </p>
                  ) : null}
                </div>
              </div>

              {/* Bio */}
              {data.summary ? (
                <div className="mt-6 border-l-2 border-[var(--color-accent)] pl-4 font-serif text-sm italic leading-relaxed text-[var(--color-text-soft)]">
                  {data.summary}
                </div>
              ) : (
                <p className="mt-6 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
                  // no bio in plex
                </p>
              )}

              {/* Similar artists */}
              {data.similar.length > 0 ? (
                <div className="mt-8">
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">
                    // similar artists
                  </p>
                  <ul className="mt-3 space-y-1">
                    {data.similar.slice(0, 12).map((s) => (
                      <li key={s.ratingKey}>
                        <SimilarArtistRow
                          item={s}
                          onClick={() => {
                            const n = Number(s.ratingKey);
                            if (Number.isInteger(n) && n > 0) openArtist(n);
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SimilarArtistRow({
  item,
  onClick,
}: {
  item: PublicArtistSimilar;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left transition-colors hover:bg-[var(--color-bg-soft)]"
    >
      {item.thumb ? (
        <img
          src={item.thumb}
          alt=""
          className="size-9 shrink-0 rounded-sm object-cover ring-1 ring-[var(--color-card-border)]"
          loading="lazy"
        />
      ) : (
        <div className="size-9 shrink-0 rounded-sm bg-[var(--color-bg-soft)] ring-1 ring-[var(--color-card-border)]" />
      )}
      <span className="truncate font-sans text-sm text-[var(--color-text)]">
        {item.title}
      </span>
      <span
        className="ml-auto font-mono text-[10px] text-[var(--color-text-faint)]"
        aria-hidden="true"
      >
        →
      </span>
    </button>
  );
}
