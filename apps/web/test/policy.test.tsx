// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDashboard, mockApi, renderApp } from "./harness";

afterEach(() => vi.unstubAllGlobals());

const policyState = {
  policy: {
    approvalMode: "hybrid",
    tasteFitThreshold: 70,
    autoApproveFit: 85,
    bandHardMaxTracks: 40,
    genreSoftCapShare: 0.5,
    monthlyAcquisitionBudgetTracks: 40,
    maxTotalTracks: 5000,
    maxTotalGb: 50,
    decayMonths: 12,
    rotationEnabled: true,
    pruneReportEnabled: true,
    autoPruneEnabled: false,
  },
  budget: {
    ownedTracks: 120,
    maxTotalTracks: 5000,
    bytesUsed: 3 * 1024 ** 3,
    maxTotalGb: 50,
    acquiredThisMonth: 12,
    monthlyBudgetTracks: 40,
    allowed: true,
    overBudget: false,
    gates: [
      { name: "global_tracks", pass: true, detail: "120/5000 tracks" },
      { name: "global_size", pass: true, detail: "3.0/50 GB" },
    ],
  },
  genreShares: { hardcore: 0.8, metal: 0.2 },
};

const pruneReport = {
  generatedAt: new Date().toISOString(),
  decayMonths: 12,
  autoPruneEnabled: false,
  proposals: [
    {
      norm: "oldsong",
      title: "Old Song",
      artistName: "Terror",
      reason: "last played 18 months ago (2 plays)",
      priority: 70,
      sizeBytes: 1000,
    },
  ],
  reclaimableBytes: 1000,
  summary: "1 track idle over 12 months (0 MB reclaimable)",
};

describe("policy page", () => {
  it("renders budgets, gates, genre shares and the prune report; applies prune", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/policy": () => ({ body: policyState }),
      "GET /api/policy/prune-report": () => ({ body: pruneReport }),
      "GET /api/artists": () => ({ body: { artists: [] } }),
      "POST /api/policy/prune/apply": () => ({
        body: { retired: [{ artist: "Terror", fileName: "01 - Old Song.mp3" }], skipped: [] },
      }),
    });

    renderApp("/policy");

    await screen.findByRole("heading", { name: "Policy" });
    await screen.findByText("hybrid mode · taste-fit ≥ 70");
    await screen.findByText("120/5000 tracks"); // gate verdict
    await screen.findByText("hardcore"); // over soft cap -> warning bar
    await screen.findByText("last played 18 months ago (2 plays)");

    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => {
      expect(calls.some((c) => c.key === "POST /api/policy/prune/apply")).toBe(true);
    });
    await screen.findByText(/1 track\(s\) retired to _retired/);
  });

  it("runs the simulator and shows the projection", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/policy": () => ({ body: policyState }),
      "GET /api/policy/prune-report": () => ({ body: pruneReport }),
      "GET /api/artists": () => ({
        body: {
          artists: [
            {
              id: 1,
              name: "Terror",
              mbid: "m",
              score: 1,
              catalogSize: 139,
              quota: 7,
              planCount: 7,
              onDiskCount: 0,
            },
          ],
        },
      }),
      "POST /api/policy/simulate": () => ({
        body: {
          changes: [
            {
              artist: "Terror",
              scoreBefore: 1,
              scoreAfter: 3,
              quotaBefore: 7,
              quotaAfter: 24,
              deltaTracks: 17,
            },
          ],
          library: {
            tracksNow: 120,
            tracksProjected: 137,
            maxTotalTracks: 5000,
            acquiredThisMonth: 12,
            monthlyBudgetTracks: 40,
          },
          summary: "Terror: score 1→3 ⇒ quota 7→24 (+17) ⇒ library 120→137 of 5000 tracks",
        },
      }),
    });

    renderApp("/policy");
    await screen.findByText("Simulator");

    fireEvent.change(screen.getByLabelText("Simulated band"), {
      target: { value: "Terror" },
    });
    fireEvent.change(screen.getByLabelText("Simulated score"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByText("Simulate"));

    await waitFor(() => {
      expect(calls.some((c) => c.key === "POST /api/policy/simulate")).toBe(true);
    });
    // The summary line is unique; the change line repeats inside it.
    await screen.findByText(
      "Terror: score 1→3 ⇒ quota 7→24 (+17) ⇒ library 120→137 of 5000 tracks",
    );
    expect(screen.getAllByText(/⇒ quota 7→24/).length).toBeGreaterThan(0);
  });
});
