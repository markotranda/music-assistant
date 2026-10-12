import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./components/layout";
import { BandDetailPage } from "./features/bands/BandDetailPage";
import { BandsPage } from "./features/bands/BandsPage";
import { DashboardPage } from "./features/dashboard/DashboardPage";
import { PolicyPage } from "./features/policy/PolicyPage";
import { QueuePage } from "./features/queue/QueuePage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { TrendsPage } from "./features/trends/TrendsPage";

/** Code-based route tree — no file-based plugin magic. */

const rootRoute = createRootRoute({ component: Layout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DashboardPage,
});

const bandsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bands",
  component: BandsPage,
});

const bandDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bands/$artistId",
  component: BandDetailPage,
});

const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queue",
  component: QueuePage,
});

const trendsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trends",
  component: TrendsPage,
});

const policyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/policy",
  component: PolicyPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  bandsRoute,
  bandDetailRoute,
  queueRoute,
  trendsRoute,
  policyRoute,
  settingsRoute,
]);

export { routeTree };

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
