import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Upload } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { ApiRequestError, api, apiPost } from "../../lib/api";
import type { MigrateReportView } from "../../lib/types";

/**
 * First-run wizard (PLAN.md §6 Phase 7): shown while the library is empty —
 * import the legacy bands.csv/plan.csv state (collection is scanned from the
 * server's configured directory) or start fresh.
 */
export function FirstRunCard() {
  const queryClient = useQueryClient();
  const [bandsFile, setBandsFile] = useState<File | null>(null);
  const [planFile, setPlanFile] = useState<File | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  const report = useQuery({
    queryKey: ["migrate-report"],
    queryFn: () => api<{ report: MigrateReportView | null }>("/api/migrate/report"),
    refetchInterval: queued ? 2000 : false,
  });

  const start = useMutation({
    mutationFn: async () => {
      if (!bandsFile) throw new Error("choose a bands.csv to import");
      return apiPost<{ jobId: number | null }>("/api/migrate", {
        bandsCsv: await bandsFile.text(),
        planCsv: planFile ? await planFile.text() : undefined,
      });
    },
    onSuccess: (res) => {
      setQueued(true);
      setError(null);
      setNotice(
        res.jobId === null
          ? "An identical migration is already queued — the report appears below when done."
          : `Migration queued (job ${res.jobId}) — the report appears below when done.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["migrate-report"] });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
  });

  const result = report.data?.report;

  return (
    <Card>
      <CardHeader>
        <CardTitle>First run — bring your legacy state</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Import the old tool's <code>bands.csv</code> (bands + scores) and optionally{" "}
          <code>plan.csv</code> — with just the bands, plans are created fresh by the syncs. When a
          plan is imported, the collection is scanned from the server's configured directory; files
          are only read, and everything unmappable is reported, never guessed.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="first-run-bands">bands.csv</Label>
            <Input
              id="first-run-bands"
              type="file"
              accept=".csv"
              onChange={(e) => setBandsFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="first-run-plan">plan.csv (optional — omit to plan fresh)</Label>
            <Input
              id="first-run-plan"
              type="file"
              accept=".csv"
              onChange={(e) => setPlanFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <Button size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
            <Upload className="h-3.5 w-3.5" /> Import legacy state
          </Button>
          <Link to="/bands">
            <Button variant="outline" size="sm">
              Start fresh instead
            </Button>
          </Link>
          <Link to="/settings">
            <Button variant="ghost" size="sm">
              Configure integrations
            </Button>
          </Link>
        </div>

        {notice ? <p className="text-sm text-success">{notice}</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {result ? (
          <div className="flex flex-col gap-1 rounded-md border p-3 text-sm">
            <p className="font-medium">{result.summary}</p>
            <p className="text-muted-foreground">
              plan: {result.plan.owned} owned · {result.plan.planned} planned · {result.plan.pinned}{" "}
              pinned
            </p>
            {result.bands.quotaDiffs.map((d) => (
              <p key={d.band} className="text-warning">
                quota mismatch: {d.band} legacy {d.legacyQuota} vs computed {d.computedQuota}
              </p>
            ))}
            {result.files.unmatched.map((f) => (
              <p key={f} className="text-muted-foreground">
                unmatched file (left in place): {f}
              </p>
            ))}
            {result.problems.slice(0, 10).map((p) => (
              <p key={p} className="text-muted-foreground">
                note: {p}
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
