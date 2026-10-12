import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Select } from "../../components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { ApiRequestError, api, apiDelete, apiPatch } from "../../lib/api";
import type { ArtistListItem } from "../../lib/types";
import { TrackBandDialog } from "./TrackBandDialog";

function ScoreSelect({ artist }: { artist: ArtistListItem }) {
  const queryClient = useQueryClient();
  const setScore = useMutation({
    mutationFn: (score: number) => apiPatch(`/api/artists/${artist.id}`, { score }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["artists"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  return (
    <Select
      aria-label={`score for ${artist.name}`}
      value={String(artist.score)}
      disabled={setScore.isPending}
      onChange={(e) => setScore.mutate(Number(e.target.value))}
      className="w-36"
    >
      <option value="1">1 — casual</option>
      <option value="2">2 — fan</option>
      <option value="3">3 — favorite</option>
    </Select>
  );
}

function UntrackButton({ artist }: { artist: ArtistListItem }) {
  const queryClient = useQueryClient();
  const untrack = useMutation({
    mutationFn: () => apiDelete(`/api/artists/${artist.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["artists"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  return (
    <Button
      variant="ghost"
      size="icon"
      title={`Untrack ${artist.name} (files are retired, not deleted)`}
      className="text-muted-foreground hover:text-destructive"
      onClick={() => {
        if (
          window.confirm(
            `Untrack ${artist.name}? Owned files move to _retired/ and can be restored.`,
          )
        ) {
          untrack.mutate();
        }
      }}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

export function BandsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["artists"],
    queryFn: () => api<{ artists: ArtistListItem[] }>("/api/artists"),
    refetchInterval: 30_000,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Bands</h1>
        <TrackBandDialog onTracked={() => undefined} />
      </div>

      {error ? (
        <p className="text-sm text-destructive">
          {error instanceof ApiRequestError ? error.message : String(error)}
        </p>
      ) : null}

      <Card>
        {isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading bands…</p>
        ) : (data?.artists.length ?? 0) === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No bands tracked yet — use “Track band” to add your first one.
          </p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Band</TH>
                <TH>Score</TH>
                <TH>Quota</TH>
                <TH>Planned</TH>
                <TH>On disk</TH>
                <TH aria-label="actions" />
              </TR>
            </THead>
            <TBody>
              {data?.artists.map((a) => (
                <TR key={a.id}>
                  <TD>
                    <Link
                      to="/bands/$artistId"
                      params={{ artistId: String(a.id) }}
                      className="font-medium hover:underline"
                    >
                      {a.name}
                    </Link>
                    {a.disambig ? (
                      <span className="ml-2 text-xs text-muted-foreground">{a.disambig}</span>
                    ) : null}
                  </TD>
                  <TD>
                    <ScoreSelect artist={a} />
                  </TD>
                  <TD>{a.quota ?? "—"}</TD>
                  <TD>{a.planCount}</TD>
                  <TD>
                    {a.onDiskCount}
                    {a.onDiskCount < a.planCount ? (
                      <Badge variant="warning" className="ml-2">
                        {a.planCount - a.onDiskCount} missing
                      </Badge>
                    ) : null}
                  </TD>
                  <TD className="text-right">
                    <UntrackButton artist={a} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
