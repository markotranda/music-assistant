// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDashboard, mockApi, renderApp } from "./harness";

afterEach(() => vi.unstubAllGlobals());

const candidates = {
  candidates: [
    {
      id: 1,
      type: "related",
      status: "pending",
      tasteFit: 94,
      reason: "similar to Terror (90% match) · genre overlap (hardcore, punk)",
      payload: {
        name: "Comeback Kid",
        similarTo: { name: "Terror", match: 0.9 },
        tags: ["hardcore", "punk"],
        why: [
          { label: "similar to Terror (90% match)", points: 41, max: 45 },
          { label: "genre overlap (hardcore, punk)", points: 35, max: 35 },
        ],
      },
      createdAt: new Date().toISOString(),
    },
    {
      id: 2,
      type: "new_release",
      status: "pending",
      tasteFit: 80,
      reason: "Terror released New Record (2026-10-01)",
      payload: {
        artistName: "Terror",
        title: "New Record",
        releaseDate: "2026-10-01",
      },
      createdAt: new Date().toISOString(),
    },
  ],
};

describe("candidate review", () => {
  it("shows scores, reasons and why-chips; approves with the chosen score", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/jobs?limit=100": () => ({ body: { jobs: [] } }),
      "GET /api/candidates?status=pending": () => ({ body: candidates }),
      "POST /api/candidates/1/approve": () => ({
        body: {
          candidate: { ...candidates.candidates[0], status: "approved" },
          trackedArtistId: 5,
        },
      }),
    });

    renderApp("/queue");

    await screen.findByText("Comeback Kid");
    // Reason (full text) and the why-chips (points breakdown) both render.
    await screen.findByText("similar to Terror (90% match) · genre overlap (hardcore, punk)");
    await screen.findByText("similar to Terror (90% match) · 41/45");
    await screen.findByText("Terror released New Record (2026-10-01)");
    await screen.findByText("genre overlap (hardcore, punk) · 35/35");

    // Related artists get the score picker; releases don't.
    expect(screen.getByLabelText("score for Comeback Kid")).toBeTruthy();
    expect(screen.queryByLabelText(/score for New Record/)).toBeNull();

    fireEvent.change(screen.getByLabelText("score for Comeback Kid"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByText("Track band"));

    await waitFor(() => {
      const post = calls.find((c) => c.key === "POST /api/candidates/1/approve");
      expect(post).toBeDefined();
      expect(post?.body).toEqual({ score: 3 });
    });
  });

  it("rejects and blocklists from the queue", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/jobs?limit=100": () => ({ body: { jobs: [] } }),
      "GET /api/candidates?status=pending": () => ({ body: candidates }),
      "POST /api/candidates/1/reject": () => ({
        body: { candidate: { ...candidates.candidates[0], status: "rejected" } },
      }),
      "POST /api/candidates/ignore-artist": () => ({
        body: { ignored: ["Comeback Kid"], rejected: 0 },
      }),
    });

    renderApp("/queue");
    await screen.findByText("Comeback Kid");

    fireEvent.click(screen.getAllByText("Reject")[0]);
    await waitFor(() => {
      expect(calls.some((c) => c.key === "POST /api/candidates/1/reject")).toBe(true);
    });

    fireEvent.click(screen.getByText("Never suggest"));
    await waitFor(() => {
      const ignore = calls.find((c) => c.key === "POST /api/candidates/ignore-artist");
      expect(ignore?.body).toEqual({ name: "Comeback Kid" });
    });
  });
});

describe("trends page", () => {
  it("renders the taste profile, scrobble stats and enqueues jobs", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/taste": () => ({
        body: {
          profile: {
            bandAffinity: { terror: 1, death: 0.5 },
            genreWeights: { hardcore: 1, "death metal": 0.5 },
            eraWeights: { "2020s": 1 },
            updatedAt: "2026-10-12T10:00:00.000Z",
          },
        },
      }),
      "GET /api/scrobbles": () => ({
        body: {
          total: 4212,
          lastPlayedAt: "2026-10-11T10:00:00.000Z",
          topArtists: [
            { artistName: "Terror", plays: 300 },
            { artistName: "Death", plays: 120 },
          ],
        },
      }),
      "POST /api/trends/discover": () => ({ body: { enqueued: "discovery" } }),
    });

    renderApp("/trends");

    await screen.findByText("Taste profile");
    await screen.findByText("hardcore");
    await screen.findByText("death metal");
    // Locale-proof: separators vary ("4,212" vs "4.212").
    await screen.findByText(/4\D?212 scrobbles/);
    await screen.findByText("300 plays");

    fireEvent.click(screen.getByText("Run discovery"));
    await waitFor(() => {
      expect(calls.some((c) => c.key === "POST /api/trends/discover")).toBe(true);
    });
    await screen.findByText(/Discovery job enqueued/);
  });
});
