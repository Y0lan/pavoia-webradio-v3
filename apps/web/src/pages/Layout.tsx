import { Outlet, useMatches } from "@tanstack/react-router";

import { Sidebar } from "../components/Sidebar.tsx";

/**
 * Outer page chrome: sidebar + main outlet. Identifies the active
 * stage by matching the stage-detail route in the route tree.
 *
 * Mobile becomes a stack (sidebar on top, content below) until
 * Slice E replaces it with a proper drawer.
 */
export function Layout() {
  const matches = useMatches();
  const stageMatch = matches.find((m) => m.routeId === "/stage/$stageId");
  const activeStageId =
    stageMatch && "stageId" in stageMatch.params
      ? (stageMatch.params.stageId as string)
      : null;

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Sidebar activeStageId={activeStageId} />
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
