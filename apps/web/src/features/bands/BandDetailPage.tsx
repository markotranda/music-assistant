import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Pin, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge, statusVariant } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { ApiRequestError, api, apiDelete, apiPost } from "../../lib/api";
import type { Artist, PlanRow, SyncResult, VerifyReport } from "../../lib/types";

type ArtistDetail = { artist: Artist; plan: PlanRow[] };

function SyncPreview({
  preview,
  onApplied,
  artistId,
}: {
  preview: SyncResult;
  onApplied: () => void;
  artistId: number;
}) {
  const [applying, setApplying] = useState(false);
  const nothingToDo =
    preview.acquire.length === 0 && preview.retire.length === 0 && preview.renames.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Re-plan preview {nothingToDo ? "(nothing to change)" : ""}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {preview.acquire.length > 0 ? (
          <div>
            <p className="font-medium">Acquire ({preview.acquire.length})</p>
            <ul className="pl-4 text-muted-foreground">
              {preview.acquire.map((d) => (
                <li key={d.norm}>
                  {d.rank ? `${String(d.rank).padStart(2, "0")} - ` : ""}
                  {d.title}
                  {d.pinned ? " [pinned]" : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview.retire.length > 0 ? (
          <div>
            <p className="font-medium">Retire to _retired/ ({preview.retire.length})</p>
            <ul className="pl-4 text-muted-foreground">
              {preview.retire.map((r) => (
                <li key={r.fileName}>{r.fileName}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview.renames.length > 0 ? (
          <div>
            <p className="font-medium">Rename ({preview.renames.length})</p>
            <ul className="pl-4 text-muted-foreground">
              {preview.renames.map((r) => (
                <li key={r.from}>
                  {r.from} → {r.to}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button
            disabled={nothingToDo || applying}
            onClick={async () => {
              setApplying(true);
              try {
                await apiPost<SyncResult>(`/api/artists/${artistId}/sync`, {
                  apply: true,
                });
                onApplied();
              } finally {
                setApplying(false);
              }
            }}
          >
            {applying ? "Applying…" : "Apply changes"}
          </Button>
          <Button variant="ghost" onClick={onApplied}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function BandDetailPage() {
  const { artistId } = useParams({ from: "/bands/$artistId" });
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<SyncResult | null>(null);
  const [pinTitle, setPinTitle] = useState("");
  const [pinAlbum, setPinAlbum] = useState("");
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const id = Number(artistId);
  const detail = useQuery({
    queryKey: ["artist", id],
    queryFn: () => api<ArtistDetail>(`/api/artists/${id}`),
    refetchInterval: 30_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["artist", id] });
    void queryClient.invalidateQueries({ queryKey: ["artists"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    setPreview(null);
  };

  const handleError = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : String(err));

  const runSync = useMutation({
    mutationFn: (apply: boolean) => apiPost<SyncResult>(`/api/artists/${id}/sync`, { apply }),
    onSuccess: (result) => {
      if (result.applied) refresh();
      else setPreview(result);
    },
    onError: handleError,
  });

  const pinTrack = useMutation({
    mutationFn: () => apiPost(`/api/artists/${id}/tracks`, { title: pinTitle }),
    onSuccess: () => {
      setPinTitle("");
      setNotice("Track pinned — it survives every re-plan.");
      refresh();
    },
    onError: handleError,
  });

  const pinAlbumMutation = useMutation({
    mutationFn: () =>
      apiPost<{ pinned: { title: string }[]; skipped: string[] }>(`/api/artists/${id}/albums`, {
        album: pinAlbum,
      }),
    onSuccess: (result) => {
      setPinAlbum("");
      setNotice(
        `Pinned ${result.pinned.length} track(s)${result.skipped.length ? `, skipped ${result.skipped.length} already planned` : ""}.`,
      );
      refresh();
    },
    onError: handleError,
  });

  const removeTrack = useMutation({
    mutationFn: (norm: string) => apiDelete(`/api/artists/${id}/tracks/${norm}`),
    onSuccess: refresh,
    onError: handleError,
  });

  if (detail.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading band…</p>;
  }
  if (detail.error || !detail.data) {
    return (
      <p className="text-sm text-destructive">
        {detail.error instanceof ApiRequestError ? detail.error.message : "Band not found"}
      </p>
    );
  }

  const { artist, plan } = detail.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link to="/bands" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-xl font-semibold">{artist.name}</h1>
        <Badge variant="outline">score {artist.score}</Badge>
        {artist.quota ? <Badge variant="outline">quota {artist.quota}</Badge> : null}
        <span className="text-sm text-muted-foreground">catalog {artist.catalogSize ?? "?"}</span>
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={runSync.isPending}
            onClick={() => runSync.mutate(false)}
          >
            {runSync.isPending ? "Planning…" : "Preview re-plan"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              try {
                const res = await apiPost<{ reports: VerifyReport[] }>("/api/verify", {
                  artistId: id,
                });
                setReport(res.reports[0] ?? null);
              } catch (err) {
                handleError(err);
              }
            }}
          >
            Verify
          </Button>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="text-sm text-success">{notice}</p> : null}
      {preview ? <SyncPreview preview={preview} artistId={id} onApplied={refresh} /> : null}
      {report ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Verify — {report.ok ? "clean" : `${report.issues.length} issue(s)`}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm text-muted-foreground">
            {report.issues.map((i) => (
              <p key={`${i.type}:${i.fileName ?? i.norm ?? i.expected ?? ""}:${i.detail ?? ""}`}>
                <Badge
                  variant={
                    i.type === "corrupt" || i.type === "replaced" ? "destructive" : "warning"
                  }
                  className="mr-2"
                >
                  {i.type}
                </Badge>
                {i.fileName ?? i.norm} {i.expected ? `→ ${i.expected}` : ""}
                {i.detail ? ` (${i.detail})` : ""}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Pin a track</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input
              placeholder="Track title"
              value={pinTitle}
              onChange={(e) => setPinTitle(e.target.value)}
            />
            <Button
              disabled={!pinTitle.trim() || pinTrack.isPending}
              onClick={() => pinTrack.mutate()}
            >
              <Pin className="h-4 w-4" /> Pin
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Pin a whole album</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input
              placeholder="Album title (MusicBrainz)"
              value={pinAlbum}
              onChange={(e) => setPinAlbum(e.target.value)}
            />
            <Button
              disabled={!pinAlbum.trim() || pinAlbumMutation.isPending}
              onClick={() => pinAlbumMutation.mutate()}
            >
              <Pin className="h-4 w-4" /> Pin album
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Plan ({plan.length} track{plan.length === 1 ? "" : "s"})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>#</TH>
                <TH>Title</TH>
                <TH>Status</TH>
                <TH>Flags</TH>
                <TH aria-label="actions" />
              </TR>
            </THead>
            <TBody>
              {plan.map((row) => (
                <TR key={row.id}>
                  <TD className="w-10 text-muted-foreground">
                    {String(row.rank).padStart(2, "0")}
                  </TD>
                  <TD>{row.title}</TD>
                  <TD>
                    <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                  </TD>
                  <TD>
                    {row.pinned ? <Badge variant="outline">pinned</Badge> : null}
                    {row.source !== "lastfm_rank" ? (
                      <Badge variant="outline" className="ml-1">
                        {row.source}
                      </Badge>
                    ) : null}
                  </TD>
                  <TD className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      title={`Remove ${row.title} (file is retired, not deleted)`}
                      onClick={() => {
                        if (window.confirm(`Remove '${row.title}' from the plan?`)) {
                          removeTrack.mutate(row.norm);
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
