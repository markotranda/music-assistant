import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Select } from "../../components/ui/select";
import { ApiRequestError, api, apiPost } from "../../lib/api";
import type { Candidate } from "../../lib/types";

/**
 * Candidate review (PLAN.md §4.5): taste-fit score, why-suggested breakdown,
 * approve (score picked here) / reject / never-suggest. Candidates enter the
 * queue, never the library directly.
 */

function fitVariant(score: number | null): "success" | "warning" | "outline" {
  if (score === null) return "outline";
  if (score >= 70) return "success";
  if (score >= 40) return "warning";
  return "outline";
}

function CandidateRow({ candidate }: { candidate: Candidate }) {
  const queryClient = useQueryClient();
  const [score, setScore] = useState("1");
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["candidates"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["digest"] });
    void queryClient.invalidateQueries({ queryKey: ["artists"] });
  };

  const approve = useMutation({
    mutationFn: () => apiPost(`/api/candidates/${candidate.id}/approve`, { score: Number(score) }),
    onSuccess: invalidate,
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
  });
  const reject = useMutation({
    mutationFn: () => apiPost(`/api/candidates/${candidate.id}/reject`),
    onSuccess: invalidate,
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
  });
  const ignore = useMutation({
    mutationFn: () =>
      apiPost("/api/candidates/ignore-artist", {
        name: candidate.payload.name ?? candidate.payload.artistName ?? "",
      }),
    onSuccess: invalidate,
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
  });

  const what =
    candidate.payload.name ?? candidate.payload.title ?? JSON.stringify(candidate.payload);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Badge variant={fitVariant(candidate.tasteFit)}>fit {candidate.tasteFit ?? "?"}</Badge>
        <Badge variant="outline">{candidate.type.replace("_", " ")}</Badge>
        <span className="font-medium">{what}</span>
        {candidate.payload.releaseDate ? (
          <span className="text-xs text-muted-foreground">{candidate.payload.releaseDate}</span>
        ) : null}
      </div>

      {candidate.reason ? (
        <p className="text-sm text-muted-foreground">{candidate.reason}</p>
      ) : null}

      {candidate.payload.why && candidate.payload.why.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {candidate.payload.why.map((part) => (
            <span
              key={part.label}
              className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              title={`${part.points} of ${part.max} points`}
            >
              {part.label} · {part.points}/{part.max}
            </span>
          ))}
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex items-center gap-2">
        {candidate.type === "related" ? (
          <Select
            aria-label={`score for ${what}`}
            value={score}
            onChange={(e) => setScore(e.target.value)}
            className="w-28"
          >
            <option value="1">1 — casual</option>
            <option value="2">2 — fan</option>
            <option value="3">3 — favorite</option>
          </Select>
        ) : null}
        <Button
          size="sm"
          disabled={approve.isPending}
          onClick={() => approve.mutate()}
          title={
            candidate.type === "related"
              ? "Track this band and plan its quota"
              : "Pin the album's tracks into the plan"
          }
        >
          <Check className="h-3.5 w-3.5" />
          {candidate.type === "related" ? "Track band" : "Pin album"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={reject.isPending}
          onClick={() => reject.mutate()}
        >
          <X className="h-3.5 w-3.5" /> Reject
        </Button>
        {candidate.type === "related" && candidate.payload.name ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={ignore.isPending}
            title="Never suggest this artist again"
            onClick={() => ignore.mutate()}
          >
            <Ban className="h-3.5 w-3.5" /> Never suggest
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function CandidatesPanel() {
  const candidates = useQuery({
    queryKey: ["candidates"],
    queryFn: () => api<{ candidates: Candidate[] }>("/api/candidates?status=pending"),
    refetchInterval: 30_000,
  });

  const list = candidates.data?.candidates ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Candidates{" "}
          <span className="font-normal text-muted-foreground">
            ({list.length} pending — approve to acquire)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {candidates.error ? (
          <p className="text-sm text-destructive">
            {candidates.error instanceof ApiRequestError
              ? candidates.error.message
              : String(candidates.error)}
          </p>
        ) : candidates.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading candidates…</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No candidates yet — run discovery or the release radar from the Trends page.
          </p>
        ) : (
          list.map((c) => <CandidateRow key={c.id} candidate={c} />)
        )}
      </CardContent>
    </Card>
  );
}
