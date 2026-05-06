import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { Layout } from "./pages/Layout.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { StageDetailPage } from "./pages/StageDetailPage.tsx";

const rootRoute = createRootRoute({
  component: Layout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const stageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stage/$stageId",
  component: StageDetailPage,
});

const routeTree = rootRoute.addChildren([indexRoute, stageRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
