// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDashboard, mockApi, renderApp } from "./harness";

const lockedDashboard = {
  ...emptyDashboard,
  library: {
    bands: 3,
    plannedTracks: 42,
    ownedTracks: 40,
    bytesUsed: 1024 ** 3 * 2,
    maxTotalTracks: 5000,
    maxTotalGb: 50,
  },
  recentEvents: [
    {
      id: 1,
      kind: "track_acquired",
      payload: { title: "Overcome", band: "Terror" },
      createdAt: new Date().toISOString(),
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("auth gate", () => {
  it("locks the UI when the API requires a token, and unlocks with the right one", async () => {
    const calls = mockApi({
      "GET /api/dashboard": ({ headers }) =>
        headers.authorization === "Bearer s3cret-token"
          ? { body: lockedDashboard }
          : { status: 401, body: { error: "missing or invalid API token" } },
    });

    renderApp("/");

    // Locked: the gate is up instead of the dashboard.
    await screen.findByText("This instance requires an API token.");

    fireEvent.change(screen.getByPlaceholderText("API token"), {
      target: { value: "s3cret-token" },
    });
    fireEvent.click(screen.getByText("Unlock"));

    // Unlocked: dashboard renders and calls carry the bearer.
    await screen.findByText("Dashboard");
    await screen.findByText("Overcome");
    await waitFor(() => {
      const authed = calls.filter((c) => c.headers.authorization === "Bearer s3cret-token");
      expect(authed.length).toBeGreaterThan(0);
    });
  });

  it("stays locked with a wrong token", async () => {
    mockApi({
      "GET /api/dashboard": () => ({
        status: 401,
        body: { error: "missing or invalid API token" },
      }),
    });

    renderApp("/");
    await screen.findByText("This instance requires an API token.");
    fireEvent.change(screen.getByPlaceholderText("API token"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByText("Unlock"));

    // The probe re-runs and 401s again — gate remains.
    await screen.findByText("This instance requires an API token.");
    expect(screen.queryByText("Dashboard")).toBeNull();
  });
});

describe("dashboard", () => {
  it("renders library vs budgets, job counts and recent activity", async () => {
    mockApi({ "GET /api/dashboard": () => ({ body: lockedDashboard }) });

    renderApp("/");

    await screen.findByText("Dashboard");
    await screen.findByText("Bands");
    await screen.findByText("42 planned · 40 owned");
    // Budget bar for tracks: label on the left, "40 / 5,000 (0%)" on the right
    // (locale-proof about the thousands separator).
    await screen.findByText(/40 \//);
    // Recent event renders its kind + payload title.
    await screen.findByText("track_acquired");
    await screen.findByText("Overcome");
  });

  it("queues bulk plan and retag jobs from the budget card", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({ body: lockedDashboard }),
      "GET /api/digest": () => ({ body: { headline: "fresh start" } }),
      "POST /api/plan": () => ({ body: { jobId: 3 } }),
      "POST /api/retag": () => ({ body: { jobId: 4 } }),
    });

    renderApp("/");
    fireEvent.click(await screen.findByText("Plan all bands"));
    await screen.findByText(/Bulk plan queued — follow it on the Queue page \(job 3\)/);

    fireEvent.click(screen.getByText("Retag files"));
    await screen.findByText(/Retag queued — follow it on the Queue page \(job 4\)/);

    expect(calls.some((c) => c.key === "POST /api/plan")).toBe(true);
    expect(calls.some((c) => c.key === "POST /api/retag")).toBe(true);
  });
});
