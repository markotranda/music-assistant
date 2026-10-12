import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { ApiRequestError, apiPut } from "../../lib/api";
import type { Settings } from "../../lib/types";

/** Client-side mirror of the core quota formula (incl. banker's rounding). */
function roundHalfToEven(n: number): number {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function previewQuota(
  formula: Settings["formula"],
  score: 1 | 2 | 3,
  catalog: number,
): number {
  let v = roundHalfToEven(formula.multipliers[score] * Math.sqrt(catalog));
  if (v < formula.floors[score]) v = formula.floors[score];
  if (v > formula.caps[score]) v = formula.caps[score];
  return v;
}

const TIERS: (1 | 2 | 3)[] = [1, 2, 3];

export function FormulaForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const [formula, setFormula] = useState(settings.formula);
  const [catalog, setCatalog] = useState(139);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => apiPut("/api/settings/formula", formula),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
  });

  const setTier = (group: "multipliers" | "floors" | "caps", tier: 1 | 2 | 3, value: string) => {
    setSaved(false);
    setFormula((f) => ({
      ...f,
      [group]: { ...f[group], [tier]: Number(value) },
    }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quota formula</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-4 gap-3">
          <Label className="text-muted-foreground">Score</Label>
          <Label className="text-muted-foreground">Multiplier (√catalog)</Label>
          <Label className="text-muted-foreground">Floor</Label>
          <Label className="text-muted-foreground">Cap</Label>
          {TIERS.map((t) => (
            <div key={t} className="contents">
              <Label className="self-center">{t}</Label>
              <Input
                type="number"
                step="0.01"
                aria-label={`multiplier ${t}`}
                value={formula.multipliers[t]}
                onChange={(e) => setTier("multipliers", t, e.target.value)}
              />
              <Input
                type="number"
                aria-label={`floor ${t}`}
                value={formula.floors[t]}
                onChange={(e) => setTier("floors", t, e.target.value)}
              />
              <Input
                type="number"
                aria-label={`cap ${t}`}
                value={formula.caps[t]}
                onChange={(e) => setTier("caps", t, e.target.value)}
              />
            </div>
          ))}
        </div>

        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="deep-share">Deep-cut share (0–1)</Label>
            <Input
              id="deep-share"
              type="number"
              step="0.05"
              value={formula.deepShare}
              onChange={(e) => {
                setSaved(false);
                setFormula((f) => ({ ...f, deepShare: Number(e.target.value) }));
              }}
              className="w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="preview-catalog">Preview catalog size</Label>
            <Input
              id="preview-catalog"
              type="number"
              value={catalog}
              onChange={(e) => setCatalog(Number(e.target.value))}
              className="w-32"
            />
          </div>
          <p className="pb-2 text-sm text-muted-foreground">
            preview quota:{" "}
            {TIERS.map((t) => `${t}→${previewQuota(formula, t, catalog)}`).join("  ")}
          </p>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save formula"}
          </Button>
          {saved ? <span className="text-sm text-success">Saved.</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
