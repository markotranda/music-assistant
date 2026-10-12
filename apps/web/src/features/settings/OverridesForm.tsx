import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import { ApiRequestError, apiPut } from "../../lib/api";
import type { Settings } from "../../lib/types";

/** "name = value" per line — the same shape as the legacy config maps. */
function mapToText(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k} = ${v}`)
    .join("\n");
}

function textToMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export function OverridesForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const [pinned, setPinned] = useState(mapToText(settings.overrides.pinnedMbids));
  const [fixes, setFixes] = useState(mapToText(settings.overrides.searchNameFixes));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      apiPut("/api/settings/overrides", {
        pinnedMbids: textToMap(pinned),
        searchNameFixes: textToMap(fixes),
      }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overrides</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="ov-pinned">Pinned MBIDs (merged acts)</Label>
          <textarea
            id="ov-pinned"
            className="min-h-24 rounded-md border border-border bg-transparent p-3 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder={"Terror = 697eba1a-bf52-46b1-a19f-4d7190b63e5c"}
            value={pinned}
            onChange={(e) => {
              setSaved(false);
              setPinned(e.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">
            When Last.fm merges same-name acts on one page, pin the real act's MBID here: the
            Last.fm ranking is then filtered to the real act's songs (own files + Deezer top
            tracks).
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="ov-fixes">Search-name fixes</Label>
          <textarea
            id="ov-fixes"
            className="min-h-24 rounded-md border border-border bg-transparent p-3 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder={"Motörhead = Motorhead"}
            value={fixes}
            onChange={(e) => {
              setSaved(false);
              setFixes(e.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">
            How a band name is searched on Last.fm/Deezer/YouTube when the spelled name finds the
            wrong thing.
          </p>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save overrides"}
          </Button>
          {saved ? <span className="text-sm text-success">Saved.</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
