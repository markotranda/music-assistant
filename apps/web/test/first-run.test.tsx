// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDashboard, mockApi, renderApp } from "./harness";

afterEach(() => vi.unstubAllGlobals());

const report = {
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  bands: {
    imported: 141,
    skipped: [],
    quotaDiffs: [{ band: "Accept", legacyQuota: 15, computedQuota: 14 }],
  },
  plan: { imported: 1673, alreadyImported: 0, owned: 1672, planned: 1, pinned: 2 },
  files: {
    matched: 1672,
    unmatched: ["Terror/99 - Off Plan.mp3"],
    unknownBandDirs: [],
  },
  problems: ["quota mismatch for 'Accept': legacy 15, computed 14"],
  summary: "imported 141 band(s) and 1673 plan row(s) (1672 owned, 1 planned, 2 pinned)",
};

describe("first-run wizard", () => {
  it("imports legacy state and renders the migration report", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({
        body: { ...emptyDashboard, library: { ...emptyDashboard.library, bands: 0 } },
      }),
      "GET /api/digest": () => ({ body: { headline: "fresh start" } }),
      "GET /api/migrate/report": () => ({
        body: { report: calls.some((c) => c.key === "POST /api/migrate") ? report : null },
      }),
      "POST /api/migrate": () => ({ body: { jobId: 7 } }),
      "POST /api/plan": () => ({ body: { jobId: 8 } }),
    });

    renderApp("/");

    await screen.findByText("First run — bring your legacy state");

    const bandsInput = screen.getByLabelText("bands.csv");
    const planInput = screen.getByLabelText(/plan\.csv/);
    fireEvent.change(bandsInput, {
      target: { files: [new File(["Band,Score\nX,1"], "bands.csv", { type: "text/csv" })] },
    });
    fireEvent.change(planInput, {
      target: { files: [new File(["Band,Rank\nX,1"], "plan.csv", { type: "text/csv" })] },
    });
    fireEvent.click(screen.getByText("Import legacy state"));

    await waitFor(() => {
      expect(calls.some((c) => c.key === "POST /api/migrate")).toBe(true);
    });
    await screen.findByText(/imported 141 band\(s\) and 1673 plan row\(s\)/);
    await screen.findByText(/quota mismatch: Accept legacy 15 vs computed 14/);
    await screen.findByText(/unmatched file \(left in place\): Terror\/99 - Off Plan\.mp3/);

    // The report lands — the natural next step is one click away.
    fireEvent.click(await screen.findByText("Plan everything now"));
    await waitFor(() => {
      expect(calls.some((c) => c.key === "POST /api/plan")).toBe(true);
    });
    await screen.findByText(/Bulk plan queued \(job 8\)/);
  });
});
