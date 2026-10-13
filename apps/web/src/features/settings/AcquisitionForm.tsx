import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select } from "../../components/ui/select";
import { ApiRequestError, apiPut } from "../../lib/api";
import type { Settings } from "../../lib/types";

/** "default" in the chain text = yt-dlp's own default player client. */
function chainToText(chain: (string | null)[]): string {
  return chain.map((c) => c ?? "default").join(", ");
}

function textToChain(text: string): (string | null)[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === "default" ? null : s));
}

export function AcquisitionForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const [acq, setAcq] = useState(settings.acquisition);
  const [chain, setChain] = useState(chainToText(settings.acquisition.playerClients));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      apiPut("/api/settings/acquisition", { ...acq, playerClients: textToChain(chain) }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
  });

  const update = <K extends keyof Settings["acquisition"]>(
    key: K,
    value: Settings["acquisition"][K],
  ) => {
    setSaved(false);
    setAcq((a) => ({ ...a, [key]: value }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Acquisition (yt-dlp)</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="acq-format">Audio format</Label>
            <Select
              id="acq-format"
              value={acq.audioFormat}
              onChange={(e) => update("audioFormat", e.target.value)}
            >
              {["mp3", "m4a", "flac", "opus", "vorbis", "aac", "alac", "wav"].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="acq-quality">Quality (0 best – 9 worst)</Label>
            <Input
              id="acq-quality"
              value={acq.audioQuality}
              onChange={(e) => update("audioQuality", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="acq-min">Min duration (s)</Label>
            <Input
              id="acq-min"
              type="number"
              value={acq.minDurationS}
              onChange={(e) => update("minDurationS", Number(e.target.value))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="acq-max">Max duration (s)</Label>
            <Input
              id="acq-max"
              type="number"
              value={acq.maxDurationS}
              onChange={(e) => update("maxDurationS", Number(e.target.value))}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="acq-clients">Player-client fallback chain</Label>
          <Input
            id="acq-clients"
            value={chain}
            onChange={(e) => {
              setSaved(false);
              setChain(e.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">
            Comma-separated; “default” = yt-dlp default. The legacy chain is default, web_safari,
            android,web.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-6">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={acq.embedArt}
              onChange={(e) => update("embedArt", e.target.checked)}
            />
            Embed cover art (Cover Art Archive)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={acq.replayGain}
              onChange={(e) => update("replayGain", e.target.checked)}
            />
            Write ReplayGain (ffmpeg loudness scan)
          </label>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save acquisition"}
          </Button>
          {saved ? <span className="text-sm text-success">Saved.</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
