import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Clock, Download } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Meter } from "../../components/ui/meter";
import { api, apiPost } from "../../lib/api";
import type { Dashboard, VerifyReport } from "../../lib/types";
import { formatBytes } from "../../lib/utils";
import { FirstRunCard } from "../first-run/FirstRunCard";

function BudgetBar({ used, max, unit }: { used: number; max: number; unit: string }) {
  const pct = max > 0 ? Math.round((used / max) * 100) : 0;
  return (
    <Meter
      label={unit}
      valueText={`${used.toLocaleString()} / ${max.toLocaleString()} (${pct}%)`}
      percent={max > 0 ? (used / max) * 100 : 0}
    />
  );
}

function StatCard({
  title,
  value,
  hint,
  icon: Icon,
}: {
  title: string;
  value: string;
  hint?: string;
  icon: typeof Clock;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-muted-foreground">
          <span className="icon-tile">
            <Icon className="h-3.5 w-3.5" />
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold">{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const [verifying, setVerifying] = useState(false);
  const [reports, setReports] = useState<VerifyReport[] | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<Dashboard>("/api/dashboard"),
    refetchInterval: 15_000,
  });

  const digestQuery = useQuery({
    queryKey: ["digest"],
    queryFn: () => api<{ headline: string }>("/api/digest"),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) {
    return <p className="text-sm text-muted-foreground">Loading dashboard…</p>;
  }

  const { library, acquisition, jobs, recentEvents } = data;
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1);

  return (
    <div className="flex flex-col gap-6">
      {library.bands === 0 ? <FirstRunCard /> : null}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={verifying}
            onClick={async () => {
              setVerifying(true);
              try {
                const res = await apiPost<{ reports: VerifyReport[] }>("/api/verify");
                setReports(res.reports);
              } finally {
                setVerifying(false);
              }
            }}
          >
            {verifying ? "Verifying…" : "Run verify"}
          </Button>
          <Link to="/queue">
            <Button variant="secondary" size="sm">
              Open queue
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="Bands"
          value={String(library.bands)}
          hint={`${library.plannedTracks} planned · ${library.ownedTracks} owned`}
          icon={Clock}
        />
        <StatCard
          title="Library size"
          value={formatBytes(library.bytesUsed)}
          hint={`of ${library.maxTotalGb} GB budget`}
          icon={CheckCircle2}
        />
        <StatCard
          title="Acquired this month"
          value={String(acquisition.acquiredThisMonth)}
          hint={`budget ${acquisition.monthlyBudgetTracks} tracks`}
          icon={Download}
        />
        <StatCard
          title="Jobs"
          value={`${jobs.pending + jobs.running} active`}
          hint={`${jobs.failed} failed · ${jobs.done} done`}
          icon={jobs.failed > 0 ? AlertTriangle : CheckCircle2}
        />
      </div>

      <Card
        className="border-primary/40"
        style={{
          backgroundImage: "linear-gradient(120deg, var(--color-accent) 0%, var(--color-card) 55%)",
        }}
      >
        <CardHeader>
          <CardTitle>Digest</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-base leading-6">{digestQuery.data?.headline ?? "Loading digest…"}</p>
          <div className="flex gap-2">
            <Link to="/queue">
              <Button size="sm">Review candidates</Button>
            </Link>
            <Link to="/trends">
              <Button variant="outline" size="sm">
                Open trends
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Budgets</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <BudgetBar used={library.ownedTracks} max={library.maxTotalTracks} unit="tracks" />
            <BudgetBar used={Number(gb(library.bytesUsed))} max={library.maxTotalGb} unit="GB" />
            <BudgetBar
              used={acquisition.acquiredThisMonth}
              max={acquisition.monthlyBudgetTracks}
              unit="monthly acquisitions"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {recentEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {recentEvents.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">
                      <Badge variant="outline" className="mr-2">
                        {e.kind}
                      </Badge>
                      {String(e.payload.title ?? e.payload.name ?? e.payload.band ?? "")}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {new Date(e.createdAt).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {reports ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Verify result — {reports.every((r) => r.ok) ? "all clean" : "issues found"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
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
    </div>
  );
}
