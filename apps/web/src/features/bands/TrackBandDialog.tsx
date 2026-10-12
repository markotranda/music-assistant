import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select } from "../../components/ui/select";
import { ApiRequestError, apiPost } from "../../lib/api";
import type { ResolveResult } from "../../lib/types";

/**
 * Track-band flow: resolve first (no side effects), disambiguate if MusicBrainz
 * returns several candidates, then track. Mirrors the legacy add-band wizard.
 */
export function TrackBandDialog({ onTracked }: { onTracked: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [score, setScore] = useState("2");
  const [resolved, setResolved] = useState<ResolveResult | null>(null);
  const [chosenMbid, setChosenMbid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = useMutation({
    mutationFn: (bandName: string) =>
      apiPost<ResolveResult>("/api/artists/resolve", { name: bandName }),
    onSuccess: (data) => {
      setResolved(data);
      setChosenMbid(data.mbid);
      setError(null);
    },
    onError: (err) => {
      setResolved(null);
      setError(err instanceof ApiRequestError ? err.message : String(err));
    },
  });

  const track = useMutation({
    mutationFn: () =>
      apiPost("/api/artists", {
        name,
        mbid: chosenMbid ?? undefined,
        score: Number(score),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["artists"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setOpen(false);
      setName("");
      setResolved(null);
      setChosenMbid(null);
      onTracked();
    },
    onError: (err) => {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button>Track band</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Track a band</DialogTitle>
          <DialogDescription>
            Resolve on MusicBrainz first — nothing is saved until you confirm.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) resolve.mutate(name.trim());
          }}
        >
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="band-name">Band name</Label>
              <Input
                id="band-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Terror"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="band-score">Score</Label>
              <Select
                id="band-score"
                value={score}
                onChange={(e) => setScore(e.target.value)}
                className="w-24"
              >
                <option value="1">1 — casual</option>
                <option value="2">2 — fan</option>
                <option value="3">3 — favorite</option>
              </Select>
            </div>
            <Button type="submit" disabled={resolve.isPending}>
              {resolve.isPending ? "Resolving…" : "Resolve"}
            </Button>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          {resolved ? (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <p className="text-sm font-medium">Choose the right artist:</p>
              {[resolved, ...resolved.alternatives].map((alt, idx) => {
                const id = `cand-${idx}`;
                return (
                  <label
                    key={alt.mbid}
                    htmlFor={id}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      id={id}
                      type="radio"
                      name="candidate"
                      checked={chosenMbid === alt.mbid}
                      onChange={() => setChosenMbid(alt.mbid)}
                    />
                    <span>{alt.name}</span>
                    {alt.country ? (
                      <span className="text-xs text-muted-foreground">[{alt.country}]</span>
                    ) : null}
                    {alt.disambiguation ? (
                      <span className="text-xs text-muted-foreground">— {alt.disambiguation}</span>
                    ) : null}
                    {idx === 0 ? (
                      <span className="text-xs text-muted-foreground">(best match)</span>
                    ) : null}
                  </label>
                );
              })}
              <Button
                className="mt-1 self-start"
                disabled={track.isPending || !chosenMbid}
                onClick={() => track.mutate()}
              >
                {track.isPending ? "Tracking…" : `Track with score ${score}`}
              </Button>
            </div>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
