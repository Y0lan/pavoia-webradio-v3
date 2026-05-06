import { Outlet, useRouterState } from "@tanstack/react-router";

import { Sidebar } from "../components/Sidebar.tsx";

/**
 * Outer page chrome: sidebar + main outlet. Identifies the active
 * stage from the routed location (typed via TanStack Router's
 * generated tree) instead of a raw routeId string match.
 *
 * Mobile becomes a stack (sidebar on top, content below) until
 * Slice E replaces it with a proper drawer.
 */
export function Layout() {
  const activeStageId = useRouterState({
    select: (state) => {
      // The stage-detail route declares params { stageId: string };
      // TanStack hands us the merged params for the current match.
      const params = state.matches[state.matches.length - 1]?.params as
        | { stageId?: string }
        | undefined;
      return params?.stageId ?? null;
    },
  });

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Sidebar activeStageId={activeStageId} />
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
