import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { Badge, statusVariant } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { ApiRequestError, api, apiPost } from "../../lib/api";
import type { Job, VerifyReport } from "../../lib/types";
import { CandidatesPanel } from "./CandidatesPanel";

/** Compact one-line job description — payloads can be huge (e.g. migrate CSVs). */
function jobTitle(job: Job): string {
  const p = job.payload;
  switch (job.type) {
    case "download":
      return String(p.title ?? p.norm ?? "download");
    case "verify":
      return p.name ? `verify ${String(p.name)}` : "verify all bands";
    case "scrobble_sync":
      return "sync scrobbles";
    case "release_radar":
      return "scan releases";
    case "discovery":
      return "discover related artists";
    case "prune_scan":
      return "decay / prune scan";
    case "rotation_scan":
      return "rank rotation";
    case "migrate":
      return "import legacy state (bands.csv + plan.csv)";
    case "plan_all":
      return "plan all bands";
    default: {
      const json = JSON.stringify(p);
      if (json === "{}") return job.type;
      return json.length > 60 ? `${job.type} ${json.slice(0, 60)}…` : `${job.type} ${json}`;
    }
  }
}

export function QueuePage() {
  const queryClient = useQueryClient();
  const [reports, setReports] = useState<VerifyReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<{ jobs: Job[] }>("/api/jobs?limit=100"),
    // Poll while work is in flight, idle otherwise.
    refetchInterval: (query) => {
      const list = query.state.data?.jobs ?? [];
      return list.some((j) => j.status === "pending" || j.status === "running") ? 3_000 : 15_000;
    },
  });

  const retry = useMutation({
    mutationFn: (jobId: number) => apiPost(`/api/jobs/${jobId}/retry`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
  });

  const verify = useMutation({
    mutationFn: () => apiPost<{ reports: VerifyReport[] }>("/api/verify"),
    onSuccess: (res) => {
      setReports(res.reports);
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
  });

  const list = jobs.data?.jobs ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Queue</h1>
        <Button
          variant="outline"
          size="sm"
          disabled={verify.isPending}
          onClick={() => verify.mutate()}
        >
          {verify.isPending ? "Verifying…" : "Deep verify all bands"}
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>
            Jobs{" "}
            <span className="font-normal text-muted-foreground">
              (auto-refreshes while downloading)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No jobs yet — they appear when tracks are queued for acquisition.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>#</TH>
                  <TH>Track</TH>
                  <TH>Type</TH>
                  <TH>Status</TH>
                  <TH>Attempts</TH>
                  <TH>Error</TH>
                  <TH aria-label="actions" />
                </TR>
              </THead>
              <TBody>
                {list.map((job) => (
                  <TR key={job.id}>
                    <TD className="w-10 text-muted-foreground">{job.id}</TD>
                    <TD className="whitespace-nowrap">{jobTitle(job)}</TD>
                    <TD>{job.type}</TD>
                    <TD>
                      <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
                    </TD>
                    <TD>{job.attempts}</TD>
                    <TD className="max-w-md truncate text-xs text-muted-foreground">
                      {job.error ?? ""}
                    </TD>
                    <TD className="text-right">
                      {job.status === "failed" ? (
                        <Button variant="ghost" size="sm" onClick={() => retry.mutate(job.id)}>
                          <RotateCcw className="h-3.5 w-3.5" /> Retry
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {reports ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Verify — {reports.every((r) => r.ok) ? "all clean" : "issues found"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {reports.map((r) => (
              <div key={r.artistId}>
                <p className="font-medium">
                  {r.band}{" "}
                  <span className="text-muted-foreground">
                    ({r.planCount} planned, {r.onDiskCount} on disk)
                  </span>
                </p>
                {r.issues.map((i) => (
                  <p
                    key={`${i.type}:${i.fileName ?? i.norm ?? i.expected ?? ""}:${i.detail ?? ""}`}
                    className="pl-3 text-muted-foreground"
                  >
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
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <CandidatesPanel />
    </div>
  );
}
