import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { ApiRequestError, apiPut } from "../../lib/api";
import type { Settings } from "../../lib/types";

export function PolicyForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const [policy, setPolicy] = useState(settings.policy);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => apiPut("/api/settings/policy", policy),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
  });

  const update = <K extends keyof Settings["policy"]>(key: K, value: Settings["policy"][K]) => {
    setSaved(false);
    setPolicy((p) => ({ ...p, [key]: value }));
  };

  const numberField = (key: keyof Settings["policy"], label: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`policy-${key}`}>{label}</Label>
      <Input
        id={`policy-${key}`}
        type="number"
        value={String(policy[key])}
        onChange={(e) => update(key, Number(e.target.value) as never)}
      />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Anti-overload policy</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="policy-mode">Approval mode</Label>
          <Select
            id="policy-mode"
            value={policy.approvalMode}
            onChange={(e) =>
              update("approvalMode", e.target.value as Settings["policy"]["approvalMode"])
            }
            className="w-64"
          >
            <option value="manual">manual — approve everything</option>
            <option value="hybrid">hybrid — auto-approve taste-fit ≥ threshold</option>
            <option value="auto">auto — all gates pass</option>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          {numberField("tasteFitThreshold", "Taste-fit threshold (0–100)")}
          {numberField("monthlyAcquisitionBudgetTracks", "Monthly budget (tracks)")}
          {numberField("maxTotalTracks", "Max total tracks")}
          {numberField("maxTotalGb", "Max total GB")}
          {numberField("decayMonths", "Decay after (months unplayed)")}
        </div>

        <div className="flex items-center gap-6">
          <span className="flex items-center gap-2 text-sm">
            <Switch
              aria-label="Rotation enabled"
              checked={policy.rotationEnabled}
              onCheckedChange={(checked) => update("rotationEnabled", checked)}
            />
            Rotation enabled
          </span>
          <span className="flex items-center gap-2 text-sm">
            <Switch
              aria-label="Prune reports"
              checked={policy.pruneReportEnabled}
              onCheckedChange={(checked) => update("pruneReportEnabled", checked)}
            />
            Prune reports
          </span>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save policy"}
          </Button>
          {saved ? <span className="text-sm text-success">Saved.</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
