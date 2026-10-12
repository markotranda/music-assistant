import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radar, RefreshCw, Sparkles, Upload } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { ApiRequestError, api, apiPost } from "../../lib/api";
import type { Artist, ScrobbleStats, TasteProfile } from "../../lib/types";

function WeightList({
  title,
  weights,
  display,
}: {
  title: string;
  weights: Record<string, number>;
  /** Maps normalized keys back to display names (bands are stored lowercased). */
  display?: (key: string) => string;
}) {
  const top = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>
      {top.length === 0 ? (
        <p className="text-sm text-muted-foreground">no signal yet</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {top.map(([name, weight]) => (
            <li key={name} className="flex items-center gap-2 text-sm">
              <span className="w-32 truncate">{display ? display(name) : name}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${Math.round(weight * 100)}%` }}
                />
              </span>
              <span className="w-9 text-right text-xs text-muted-foreground">
                {Math.round(weight * 100)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TrendsPage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const taste = useQuery({
    queryKey: ["taste"],
    queryFn: () => api<{ profile: TasteProfile }>("/api/taste"),
  });
  const scrobbles = useQuery({
    queryKey: ["scrobbles"],
    queryFn: () => api<ScrobbleStats>("/api/scrobbles"),
    refetchInterval: 60_000,
  });
  const artists = useQuery({
    queryKey: ["artists"],
    queryFn: () => api<{ artists: Artist[] }>("/api/artists"),
  });

  // Affinity keys are normalized lowercase — map back to real band names.
  const displayName = new Map(
    (artists.data?.artists ?? []).map((a) => [a.name.toLowerCase(), a.name]),
  );
  const properName = (key: string) => displayName.get(key) ?? key;

  const onError = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : String(err));

  const onEnqueued = (label: string) => () => {
    setNotice(`${label} job enqueued — progress shows in the Queue.`);
    setError(null);
  };

  const recompute = useMutation({
    mutationFn: () => apiPost<{ profile: TasteProfile }>("/api/taste/recompute"),
    onSuccess: () => {
      setNotice("Taste profile recomputed.");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["taste"] });
    },
    onError,
  });

  const syncScrobbles = useMutation({
    mutationFn: () => apiPost("/api/scrobbles/sync"),
    onSuccess: onEnqueued("Scrobble sync"),
    onError,
  });
  const discover = useMutation({
    mutationFn: () => apiPost("/api/trends/discover"),
    onSuccess: onEnqueued("Discovery"),
    onError,
  });
  const radar = useMutation({
    mutationFn: () => apiPost("/api/trends/release-radar"),
    onSuccess: onEnqueued("Release radar"),
    onError,
  });

  const profile = taste.data?.profile;
  const stats = scrobbles.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Trends</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={syncScrobbles.isPending}
            onClick={() => syncScrobbles.mutate()}
            title="Import your Last.fm scrobble history (full history on first run)"
          >
            <Upload className="h-3.5 w-3.5" /> Sync scrobbles
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={discover.isPending}
            onClick={() => discover.mutate()}
          >
            <Sparkles className="h-3.5 w-3.5" /> Run discovery
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={radar.isPending}
            onClick={() => radar.mutate()}
          >
            <Radar className="h-3.5 w-3.5" /> Scan releases
          </Button>
        </div>
      </div>

      {notice ? <p className="text-sm text-success">{notice}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>
            Taste profile{" "}
            {profile?.updatedAt ? (
              <Badge variant="outline">
                updated {new Date(profile.updatedAt).toLocaleString()}
              </Badge>
            ) : null}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            disabled={recompute.isPending}
            onClick={() => recompute.mutate()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {recompute.isPending ? "Recomputing…" : "Recompute"}
          </Button>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <WeightList
            title="Bands (affinity)"
            weights={profile?.bandAffinity ?? {}}
            display={(k) => properName(k)}
          />
          <WeightList title="Genres" weights={profile?.genreWeights ?? {}} />
          <WeightList title="Eras" weights={profile?.eraWeights ?? {}} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Listening history{" "}
            {stats ? (
              <span className="font-normal text-muted-foreground">
                {stats.total.toLocaleString()} scrobbles
                {stats.lastPlayedAt
                  ? ` · last played ${new Date(stats.lastPlayedAt).toLocaleDateString()}`
                  : ""}
              </span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!stats || stats.topArtists.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No scrobbles imported yet — use “Sync scrobbles” to import your Last.fm history (full
              history on first run).
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-1 md:grid-cols-2">
              {stats.topArtists.map((a) => (
                <li key={a.artistName} className="flex items-center justify-between text-sm">
                  <span className="truncate">{a.artistName}</span>
                  <Badge variant="outline">{a.plays.toLocaleString()} plays</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
