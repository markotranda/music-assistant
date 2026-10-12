import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type { Dashboard, Settings } from "../src/lib/types";
import { routeTree } from "../src/router";
import { useUiStore } from "../src/stores/ui";

/** Fetch mock: routes are `"METHOD /path"` -> handler. Returns a fetch-shaped object. */

export type MockResult = { status?: number; body: unknown };
export type MockHandler = (init: {
  headers: Record<string, string>;
  body?: unknown;
}) => MockResult | Promise<MockResult>;

export type ApiCall = {
  key: string;
  body: unknown;
  headers: Record<string, string>;
};

export function mockApi(routes: Record<string, MockHandler>): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: RequestInfo | URL, init: RequestInit = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(
        Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          String(v),
        ]),
      );
      const key = `${method} ${String(path)}`;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ key, body, headers });

      const handler = routes[key];
      if (!handler) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: `no mock for ${key}` }),
        };
      }
      const result = await handler({ headers, body });
      return {
        ok: (result.status ?? 200) < 400,
        status: result.status ?? 200,
        json: async () => result.body,
      };
    }),
  );
  return calls;
}

export const emptyDashboard: Dashboard = {
  library: {
    bands: 0,
    plannedTracks: 0,
    ownedTracks: 0,
    bytesUsed: 0,
    maxTotalTracks: 5000,
    maxTotalGb: 50,
  },
  acquisition: { acquiredThisMonth: 0, monthlyBudgetTracks: 40 },
  jobs: { pending: 0, running: 0, done: 0, failed: 0 },
  recentEvents: [],
};

export const defaultSettings: Settings = {
  formula: {
    multipliers: { 1: 0.65, 2: 1.15, 3: 2 },
    floors: { 1: 3, 2: 5, 3: 8 },
    caps: { 1: 7, 2: 20, 3: 30 },
    deepShare: 0.35,
  },
  policy: {
    approvalMode: "manual",
    tasteFitThreshold: 70,
    monthlyAcquisitionBudgetTracks: 40,
    maxTotalTracks: 5000,
    maxTotalGb: 50,
    decayMonths: 12,
    rotationEnabled: true,
    pruneReportEnabled: true,
  },
  integrations: {
    lastfmApiKeyMasked: "test…key",
    musicbrainzUserAgent: "MusicAssistant/0.1.0 ( test )",
    deezerEnabled: true,
  },
  acquisition: {
    audioFormat: "mp3",
    audioQuality: "2",
    minDurationS: 60,
    maxDurationS: 900,
    playerClients: [null, "web_safari", "android,web"],
  },
  auth: { tokenMasked: null },
  overrides: { pinnedMbids: {}, searchNameFixes: {} },
};

/** Radix tabs select on mousedown — plain click isn't enough in jsdom. */
export async function clickTab(name: string) {
  const tab = await screen.findByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
  return tab;
}

export function renderApp(initialPath = "/") {
  // RTL auto-cleanup needs vitest globals; do it explicitly instead.
  cleanup();
  useUiStore.setState({ token: null });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient };
}
