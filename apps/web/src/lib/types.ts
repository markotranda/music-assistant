/** Wire types mirroring the server's Zod schemas (see /doc). */

export type Artist = {
  id: number;
  mbid: string;
  name: string;
  disambig: string | null;
  score: number;
  catalogSize: number | null;
  quota: number | null;
  pinnedMbid: string | null;
  ignored: boolean;
  createdAt: string;
};

export type ArtistListItem = Artist & { planCount: number; onDiskCount: number };

export type PlanRow = {
  id: number;
  rank: number;
  title: string;
  norm: string;
  pinned: boolean;
  status: string;
  source: string;
};

export type Desired = { rank: number; title: string; norm: string; pinned: boolean };

export type SyncResult = {
  applied: boolean;
  desired: Desired[];
  acquire: Desired[];
  retire: { fileName: string }[];
  renames: { from: string; to: string }[];
};

export type Job = {
  id: number;
  type: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  runAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  payload: Record<string, unknown>;
};

export type VerifyIssue = {
  type: "missing" | "surplus" | "renamed" | "replaced" | "corrupt";
  norm?: string;
  fileName?: string;
  expected?: string;
  detail?: string;
};

export type VerifyReport = {
  artistId: number;
  band: string;
  planCount: number;
  onDiskCount: number;
  ok: boolean;
  issues: VerifyIssue[];
};

export type Dashboard = {
  library: {
    bands: number;
    plannedTracks: number;
    ownedTracks: number;
    bytesUsed: number;
    maxTotalTracks: number;
    maxTotalGb: number;
  };
  acquisition: { acquiredThisMonth: number; monthlyBudgetTracks: number };
  jobs: { pending: number; running: number; done: number; failed: number };
  recentEvents: { id: number; kind: string; payload: Record<string, unknown>; createdAt: string }[];
};

export type Settings = {
  formula: {
    multipliers: Record<string, number>;
    floors: Record<string, number>;
    caps: Record<string, number>;
    deepShare: number;
  };
  policy: {
    approvalMode: "manual" | "hybrid" | "auto";
    tasteFitThreshold: number;
    monthlyAcquisitionBudgetTracks: number;
    maxTotalTracks: number;
    maxTotalGb: number;
    decayMonths: number;
    rotationEnabled: boolean;
    pruneReportEnabled: boolean;
  };
  integrations: {
    lastfmApiKeyMasked: string | null;
    musicbrainzUserAgent: string;
    deezerEnabled: boolean;
  };
  acquisition: {
    audioFormat: string;
    audioQuality: string;
    minDurationS: number;
    maxDurationS: number;
    playerClients: (string | null)[];
  };
  auth: { tokenMasked: string | null };
  overrides: { pinnedMbids: Record<string, string>; searchNameFixes: Record<string, string> };
};

export type ResolveResult = {
  mbid: string;
  name: string;
  country: string | null;
  disambiguation: string | null;
  pinned: boolean;
  alternatives: {
    mbid: string;
    name: string;
    country: string | null;
    disambiguation: string | null;
  }[];
};
