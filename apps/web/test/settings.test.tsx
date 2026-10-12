// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clickTab, defaultSettings, emptyDashboard, mockApi, renderApp } from "./harness";

afterEach(() => vi.unstubAllGlobals());

describe("settings page", () => {
  it("saves the formula with partial tier updates (other fields untouched)", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/settings": () => ({ body: { settings: defaultSettings } }),
      "PUT /api/settings/formula": () => ({ body: { settings: defaultSettings } }),
    });

    renderApp("/settings");
    await screen.findByText("Quota formula");

    fireEvent.change(screen.getByLabelText("multiplier 2"), {
      target: { value: "1.5" },
    });
    fireEvent.click(screen.getByText("Save formula"));

    await waitFor(() => {
      const put = calls.find((c) => c.key === "PUT /api/settings/formula");
      expect(put).toBeDefined();
      expect(put?.body).toMatchObject({
        multipliers: { 1: 0.65, 2: 1.5, 3: 2 },
        floors: { 1: 3, 2: 5, 3: 8 },
        caps: { 1: 7, 2: 20, 3: 30 },
        deepShare: 0.35,
      });
    });
    await screen.findByText("Saved.");
  });

  it("shows the live quota preview (score 2, catalog 139 -> 14)", async () => {
    mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/settings": () => ({ body: { settings: defaultSettings } }),
    });

    renderApp("/settings");
    // 0.65*sqrt(139)=7.66->8 capped to 7; 1.15*sqrt(139)=13.56->14; 2*sqrt(139)=23.58->24.
    // (RTL collapses whitespace: single spaces between entries.)
    await screen.findByText(/preview quota: 1→7 2→14 3→24/);
  });

  it("never sends the masked Last.fm key back unless a new one is typed", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/settings": () => ({ body: { settings: defaultSettings } }),
      "PUT /api/settings/integrations": () => ({ body: { settings: defaultSettings } }),
    });

    renderApp("/settings");
    await clickTab("Integrations");

    // The masked hint is shown, never the clear key.
    expect(screen.queryByDisplayValue("test-key")).toBeNull();
    await screen.findByPlaceholderText(/stored: test…key/);

    // Save without typing a key: the secret must NOT be in the body.
    fireEvent.click(screen.getByText("Save integrations"));
    await waitFor(() => {
      const put = calls.find((c) => c.key === "PUT /api/settings/integrations");
      expect(put).toBeDefined();
      expect(put?.body).not.toHaveProperty("lastfmApiKey");
    });

    // Type a new key: now it is sent.
    fireEvent.change(screen.getByLabelText("Last.fm API key"), {
      target: { value: "brand-new-key" },
    });
    fireEvent.click(screen.getByText("Save integrations"));
    await waitFor(() => {
      const puts = calls.filter((c) => c.key === "PUT /api/settings/integrations");
      expect(puts[puts.length - 1]?.body).toMatchObject({ lastfmApiKey: "brand-new-key" });
    });
  });

  it("saves overrides parsed from name = value lines", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/settings": () => ({ body: { settings: defaultSettings } }),
      "PUT /api/settings/overrides": () => ({ body: { settings: defaultSettings } }),
    });

    renderApp("/settings");
    await clickTab("Overrides");

    fireEvent.change(await screen.findByLabelText("Pinned MBIDs (merged acts)"), {
      target: { value: "Terror = 697eba1a\n\nNot a line\nMotorhead = Motorhead-fixed" },
    });
    fireEvent.click(screen.getByText("Save overrides"));

    await waitFor(() => {
      const put = calls.find((c) => c.key === "PUT /api/settings/overrides");
      expect(put).toBeDefined();
      expect(put?.body).toEqual({
        pinnedMbids: {
          Terror: "697eba1a",
          Motorhead: "Motorhead-fixed",
        },
        searchNameFixes: {},
      });
    });
  });

  it("generates and disables the API token", async () => {
    const calls = mockApi({
      "GET /api/dashboard": () => ({ body: emptyDashboard }),
      "GET /api/settings": () => ({
        body: {
          settings: { ...defaultSettings, auth: { tokenMasked: "abcd…123" } },
        },
      }),
      "PUT /api/settings/auth": () => ({
        body: {
          settings: { ...defaultSettings, auth: { tokenMasked: "new …456" } },
        },
      }),
    });

    renderApp("/settings");
    await clickTab("Security");
    await screen.findByText(/token active/);

    fireEvent.click(screen.getByText("Generate"));
    await waitFor(() => {
      const put = calls.find((c) => c.key === "PUT /api/settings/auth");
      expect(put).toBeDefined();
      const body = (put ?? { body: {} }).body as { token: string };
      expect(body.token.length).toBe(48);
    });
    await screen.findByText("Copy this token now — it is shown once:");

    fireEvent.click(screen.getByText("Disable"));
    await waitFor(() => {
      const puts = calls.filter((c) => c.key === "PUT /api/settings/auth");
      expect(puts[puts.length - 1]?.body).toEqual({ token: "" });
    });
  });
});
