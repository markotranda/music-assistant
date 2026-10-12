import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Minimal UI state only — server state lives in TanStack Query (PLAN.md). */

type UiState = {
  token: string | null;
  setToken: (token: string | null) => void;
};

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      token: null,
      setToken: (token) => set({ token }),
    }),
    { name: "ma-ui" },
  ),
);
