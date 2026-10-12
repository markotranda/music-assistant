// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDashboard, mockApi, renderApp } from "./harness";

afterEach(() => vi.unstubAllGlobals());

const artists = {
  artists: [
    {
      id: 1,
      mbid: "697eba1a-bf52-46b1-a19f-4d7190b63e5c",
      name: "Terror",
      disambig: null,
      score: 1,
      catalogSize: 135,
      quota: 7,
      pinnedMbid: null,
      ignored: false,
      createdAt: new Date().toISOString(),
      planCount: 7,
      onDiskCount: 5,
    },
    {
      id: 2,
      mbid: "other-mbid",
      name: "Death",
      disambig: "death metal",
      score: 3,
      catalogSize: 100,
      quota: 20,
      pinnedMbid: null,
      ignored: false,
      createdAt: new Date().toISOString(),
      planCount: 20,
      onDiskCount: 20,
    },
  ],
};

describe("bands page", () => {
  it("lists bands, flags missing files, and changes a score", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/artists": () => ({ body: artists }),
      "PATCH /api/artists/1": () => ({
        body: {
          artist: { ...artists.artists[0], score: 3 },
          sync: { applied: true, desired: [], acquire: [], retire: [], renames: [] },
        },
      }),
    });

    renderApp("/bands");

    await screen.findByText("Terror");
    await screen.findByText("2 missing");
    await screen.findByText("death metal");

    fireEvent.change(screen.getByLabelText("score for Terror"), {
      target: { value: "3" },
    });

    await waitFor(() => {
      const patch = calls.find((c) => c.key === "PATCH /api/artists/1");
      expect(patch).toBeDefined();
      expect(patch?.body).toEqual({ score: 3 });
    });
  });

  it("tracks a band through resolve + disambiguation, sending the chosen MBID", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/artists": () => ({ body: { artists: [] } }),
      "POST /api/artists/resolve": () => ({
        body: {
          mbid: "best-mbid",
          name: "Terror",
          country: "US",
          disambiguation: "hardcore",
          pinned: false,
          alternatives: [
            { mbid: "alt-mbid", name: "Terror", country: "SE", disambiguation: "black metal" },
          ],
        },
      }),
      "POST /api/artists": () => ({
        body: {
          artist: artists.artists[0],
          catalog: { albums: 10, catalog: 135, method: "mb(avg 13.5 x 10, n=10)" },
          sync: { applied: true, desired: [], acquire: [], retire: [], renames: [] },
        },
      }),
    });

    renderApp("/bands");
    await screen.findByText(/No bands tracked yet/);

    fireEvent.click(screen.getByText("Track band"));
    fireEvent.change(await screen.findByLabelText("Band name"), {
      target: { value: "Terror" },
    });
    fireEvent.click(screen.getByText("Resolve"));

    await screen.findByText("Choose the right artist:");
    await screen.findByText("[SE]");

    // Pick the alternative instead of the best match.
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[1]);
    fireEvent.click(screen.getByText("Track with score 2"));

    await waitFor(() => {
      const track = calls.find((c) => c.key === "POST /api/artists");
      expect(track).toBeDefined();
      expect(track?.body).toEqual({ name: "Terror", mbid: "alt-mbid", score: 2 });
    });
  });

  it("surfaces resolve failures instead of failing silently", async () => {
    mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/artists": () => ({ body: { artists: [] } }),
      "POST /api/artists/resolve": () => ({
        status: 404,
        body: { error: "could not resolve 'Nonsense' on MusicBrainz" },
      }),
    });

    renderApp("/bands");
    fireEvent.click(await screen.findByText("Track band"));
    fireEvent.change(await screen.findByLabelText("Band name"), {
      target: { value: "Nonsense" },
    });
    fireEvent.click(screen.getByText("Resolve"));

    await screen.findByText("could not resolve 'Nonsense' on MusicBrainz");
  });
});
