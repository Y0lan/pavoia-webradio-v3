import { useEffect, useState } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";

import { usePlayback } from "../audio/PlaybackProvider.tsx";
import { ArtistDrawer } from "../components/ArtistDrawer.tsx";
import { BusMysteryCard } from "../components/BusMysteryCard.tsx";
import { InfoDialog } from "../components/InfoDialog.tsx";
import { MobileDrawer } from "../components/MobileDrawer.tsx";
import { MobileHeader } from "../components/MobileHeader.tsx";
import { PersistentPlayerBar } from "../components/PersistentPlayerBar.tsx";
import { Sidebar } from "../components/Sidebar.tsx";

/**
 * Outer chrome — sidebar + main outlet + persistent mini-player.
 *
 * Three pieces of overlay state live here:
 *   - drawerOpen : mobile slide-in nav
 *   - infoOpen   : about dialog (sidebar footer button)
 *   - busOpen    : the Bus stage easter egg
 *
 * The PersistentPlayerBar at the bottom shows whatever is currently
 * audible across the whole app — the v1 "exploring" pattern. When
 * the listener is on the same stage that's playing, the bar still
 * shows up (it's the cross-page identity of "what's on air right now").
 */
export function Layout() {
  const activeStageId = useRouterState({
    select: (state) => {
      const params = state.matches[state.matches.length - 1]?.params as
        | { stageId?: string }
        | undefined;
      return params?.stageId ?? null;
    },
  });
  const { playingStageId } = usePlayback();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [busOpen, setBusOpen] = useState(false);

  // Auto-close the drawer on route change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [activeStageId]);

  // Add bottom padding when the persistent bar is visible so content
  // doesn't slide under it. Use a tailwind class via state attr.
  const playerBarVisible = playingStageId !== null;

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden md:flex-row">
      <MobileHeader onOpenDrawer={() => setDrawerOpen(true)} />

      {/* Desktop sidebar — full-viewport height + sticky so the footer
          About button stays visible regardless of how tall the main
          column gets. */}
      <div className="hidden md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        <Sidebar
          activeStageId={activeStageId}
          onOpenInfo={() => setInfoOpen(true)}
          onOpenBus={() => setBusOpen(true)}
        />
      </div>

      {/* Mobile drawer wraps the same Sidebar */}
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <Sidebar
          activeStageId={activeStageId}
          onOpenInfo={() => setInfoOpen(true)}
          onOpenBus={() => setBusOpen(true)}
        />
      </MobileDrawer>

      <main
        className="relative min-w-0 flex-1 overflow-hidden"
        style={{
          // Reserve space for the fixed persistent player bar so the
          // page's own footer doesn't slide under it.
          paddingBottom: playerBarVisible ? "5.5rem" : undefined,
        }}
      >
        <div className="h-full overflow-hidden">
          <Outlet />
        </div>
      </main>

      <PersistentPlayerBar />
      <ArtistDrawer />
      <InfoDialog open={infoOpen} onClose={() => setInfoOpen(false)} />
      <BusMysteryCard open={busOpen} onClose={() => setBusOpen(false)} />
    </div>
  );
}
