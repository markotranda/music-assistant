import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Calculator, Scissors, Settings2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select } from "../../components/ui/select";
import { ApiRequestError, api, apiPost } from "../../lib/api";
import type { Artist, PolicyState, PruneReportView, SimulationView } from "../../lib/types";

/**
 * Policy page (PLAN.md §4.2/§4.5): budget meters with the gate verdicts, the
 * prune report (retire is reversible), and the simulator — "what would change
 * if I set score 3 on X / lower the budget?".
 */

function Meter({
  label,
  value,
  max,
  unit,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-28 text-muted-foreground">{label}</span>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
        <span
          className={`block h-full rounded-full ${pct >= 100 ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-28 text-right text-xs text-muted-foreground">
        {unit === "GB" ? `${(value / 1024 ** 3).toFixed(1)}` : value.toLocaleString()}/
        {unit === "GB" ? max : max.toLocaleString()} {unit}
      </span>
    </div>
  );
}

export function PolicyPage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scoreArtist, setScoreArtist] = useState("");
  const [scoreValue, setScoreValue] = useState("3");
  const [maxTracks, setMaxTracks] = useState("");

  const state = useQuery({
    queryKey: ["policy"],
    queryFn: () => api<PolicyState>("/api/policy"),
  });
  const report = useQuery({
    queryKey: ["prune-report"],
    queryFn: () => api<PruneReportView>("/api/policy/prune-report"),
  });
  const artists = useQuery({
    queryKey: ["artists"],
    queryFn: () => api<{ artists: Artist[] }>("/api/artists"),
  });

  const onError = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : String(err));

  const applyPrune = useMutation({
    mutationFn: () => apiPost<{ retired: { fileName: string }[] }>("/api/policy/prune/apply"),
    onSuccess: (res) => {
      setNotice(`${res.retired.length} track(s) retired to _retired/ (recoverable).`);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["prune-report"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError,
  });

  const [simulation, setSimulation] = useState<SimulationView | null>(null);
  const runSim = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = {};
      if (maxTracks.trim()) patch.maxTotalTracks = Number(maxTracks);
      return apiPost<SimulationView>("/api/policy/simulate", {
        scoreChanges: scoreArtist ? { [scoreArtist]: Number(scoreValue) } : undefined,
        policyPatch: Object.keys(patch).length > 0 ? patch : undefined,
      });
    },
    onSuccess: (sim) => {
      setSimulation(sim);
      setError(null);
    },
    onError,
  });

  const policy = state.data?.policy;
  const budget = state.data?.budget;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Policy</h1>
        <Link to="/settings">
          <Button variant="outline" size="sm">
            <Settings2 className="h-3.5 w-3.5" /> Edit policy settings
          </Button>
        </Link>
      </div>

      {notice ? <p className="text-sm text-success">{notice}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>
            Budgets{" "}
            {policy ? (
              <span className="font-normal text-muted-foreground">
                {policy.approvalMode} mode · taste-fit ≥ {policy.tasteFitThreshold}
              </span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {!budget || !policy ? (
            <p className="text-sm text-muted-foreground">Loading policy…</p>
          ) : (
            <>
              <Meter
                label="Library"
                value={budget.ownedTracks}
                max={policy.maxTotalTracks}
                unit="tracks"
              />
              <Meter label="Size" value={budget.bytesUsed} max={policy.maxTotalGb} unit="GB" />
              <Meter
                label="This month"
                value={budget.acquiredThisMonth}
                max={budget.monthlyBudgetTracks}
                unit="tracks"
              />
              <p className="text-xs text-muted-foreground">
                Monthly target is soft (overflow allowed) —
                {budget.overBudget ? " currently exceeded." : " within target."} Hard stops are the
                library ceilings above.
              </p>
              <ul className="flex flex-col gap-1">
                {budget.gates.map((g) => (
                  <li key={g.name} className="text-sm">
                    <Badge variant={g.pass ? "success" : "destructive"} className="mr-2">
                      {g.pass ? "pass" : "block"}
                    </Badge>
                    {g.detail}
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Genre balance{" "}
            <span className="font-normal text-muted-foreground">
              (soft cap {policy ? `${Math.round(policy.genreSoftCapShare * 100)}%` : "—"} — over
              budget costs −15 taste-fit)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {Object.keys(state.data?.genreShares ?? {}).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No genre signal yet — tags are cached when the taste profile recomputes.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {Object.entries(state.data?.genreShares ?? {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([tag, share]) => (
                  <li key={tag} className="flex items-center gap-2 text-sm">
                    <span className="w-32 truncate">{tag}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                      <span
                        className={`block h-full rounded-full ${
                          share > (policy?.genreSoftCapShare ?? 0.5) ? "bg-warning" : "bg-primary"
                        }`}
                        style={{ width: `${Math.min(100, Math.round(share * 100))}%` }}
                      />
                    </span>
                    <span className="w-12 text-right text-xs text-muted-foreground">
                      {Math.round(share * 100)}%
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>
            Prune report{" "}
            <span className="font-normal text-muted-foreground">{report.data?.summary ?? ""}</span>
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            disabled={applyPrune.isPending || (report.data?.proposals.length ?? 0) === 0}
            onClick={() => applyPrune.mutate()}
            title="Retire proposed tracks to _retired/<Band>/ — recoverable"
          >
            <Scissors className="h-3.5 w-3.5" /> Apply
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {report.data?.autoPruneEnabled ? (
            <p className="text-sm text-warning">
              Auto-prune is ON — the weekly scan retires proposals automatically (recoverable from
              _retired).
            </p>
          ) : null}
          {(report.data?.proposals.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing to prune — every owned track has been played within the decay window.
            </p>
          ) : (
            report.data?.proposals.map((p) => (
              <div key={p.norm} className="flex items-center gap-2 text-sm">
                <Badge variant="outline">prio {p.priority}</Badge>
                <span className="font-medium">
                  {p.artistName} — {p.title}
                </span>
                <span className="text-muted-foreground">{p.reason}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Simulator{" "}
            <span className="font-normal text-muted-foreground">
              — what would change? (projection only)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="sim-band">Band</Label>
              <Select
                id="sim-band"
                aria-label="Simulated band"
                value={scoreArtist}
                onChange={(e) => setScoreArtist(e.target.value)}
                className="w-44"
              >
                <option value="">— none —</option>
                {(artists.data?.artists ?? []).map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name} (score {a.score})
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="sim-score">New score</Label>
              <Select
                id="sim-score"
                aria-label="Simulated score"
                value={scoreValue}
                onChange={(e) => setScoreValue(e.target.value)}
                className="w-28"
              >
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="sim-max-tracks">Max tracks</Label>
              <Input
                id="sim-max-tracks"
                aria-label="Simulated max tracks"
                placeholder="unchanged"
                value={maxTracks}
                onChange={(e) => setMaxTracks(e.target.value)}
                className="w-28"
              />
            </div>
            <Button size="sm" disabled={runSim.isPending} onClick={() => runSim.mutate()}>
              <Calculator className="h-3.5 w-3.5" /> Simulate
            </Button>
          </div>

          {simulation ? (
            <div className="flex flex-col gap-1 text-sm">
              {simulation.changes.map((c) => (
                <p key={c.artist}>
                  <span className="font-medium">{c.artist}</span>: score {c.scoreBefore}→
                  {c.scoreAfter} ⇒ quota {c.quotaBefore}→{c.quotaAfter} (
                  {c.deltaTracks >= 0 ? "+" : ""}
                  {c.deltaTracks})
                </p>
              ))}
              <p className="text-muted-foreground">{simulation.summary}</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Pick a band and a score to project its quota change — nothing is applied.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
