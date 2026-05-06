import { useEffect, useState } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";

import { BusMysteryCard } from "../components/BusMysteryCard.tsx";
import { InfoDialog } from "../components/InfoDialog.tsx";
import { MobileDrawer } from "../components/MobileDrawer.tsx";
import { MobileHeader } from "../components/MobileHeader.tsx";
import { Sidebar } from "../components/Sidebar.tsx";

/**
 * Outer page chrome: mobile header + drawer (or desktop sidebar) +
 * main outlet + dialogs. Identifies the active stage from the
 * routed location (typed via TanStack Router) instead of a raw
 * routeId string match.
 *
 * State machine for ephemeral overlays:
 *   - drawerOpen: mobile slide-in menu
 *   - infoOpen:   about/credits dialog (triggered from sidebar
 *                 footer "i" button)
 *   - busOpen:    Bus stage easter egg (triggered when listener
 *                 clicks the disabled Bus row)
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

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [busOpen, setBusOpen] = useState(false);

  // Auto-close the drawer when the route changes (i.e. the user
  // tapped a stage). Without this the drawer stays open over the
  // newly-routed content, which is jarring.
  useEffect(() => {
    setDrawerOpen(false);
  }, [activeStageId]);

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <MobileHeader onOpenDrawer={() => setDrawerOpen(true)} />

      {/* Desktop sidebar — visible at md+. */}
      <div className="hidden md:flex md:flex-col">
        <Sidebar
          activeStageId={activeStageId}
          onOpenInfo={() => setInfoOpen(true)}
          onOpenBus={() => setBusOpen(true)}
        />
      </div>

      {/* Mobile drawer — same Sidebar content, slide-in panel. */}
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <Sidebar
          activeStageId={activeStageId}
          onOpenInfo={() => setInfoOpen(true)}
          onOpenBus={() => setBusOpen(true)}
        />
      </MobileDrawer>

      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>

      <InfoDialog open={infoOpen} onClose={() => setInfoOpen(false)} />
      <BusMysteryCard open={busOpen} onClose={() => setBusOpen(false)} />
    </div>
  );
}
