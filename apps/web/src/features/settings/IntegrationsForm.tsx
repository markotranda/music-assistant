import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import { ApiRequestError, apiPut } from "../../lib/api";
import type { Settings } from "../../lib/types";

/**
 * Secrets rule everywhere: empty input = keep the stored value (shown masked);
 * explicit "Clear" buttons send "" to remove it.
 */
export function IntegrationsForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [userAgent, setUserAgent] = useState(settings.integrations.musicbrainzUserAgent);
  const [deezer, setDeezer] = useState(settings.integrations.deezerEnabled);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPut("/api/settings/integrations", body),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      setApiKey("");
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Integrations</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="lastfm-key">Last.fm API key</Label>
          <div className="flex gap-2">
            <Input
              id="lastfm-key"
              type="password"
              placeholder={
                settings.integrations.lastfmApiKeyMasked
                  ? `stored: ${settings.integrations.lastfmApiKeyMasked} — type to replace`
                  : "not set"
              }
              value={apiKey}
              onChange={(e) => {
                setSaved(false);
                setApiKey(e.target.value);
              }}
            />
            {settings.integrations.lastfmApiKeyMasked ? (
              <Button variant="outline" onClick={() => save.mutate({ lastfmApiKey: "" })}>
                Clear
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="mb-ua">MusicBrainz user-agent</Label>
          <Input
            id="mb-ua"
            value={userAgent}
            onChange={(e) => {
              setSaved(false);
              setUserAgent(e.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">
            MusicBrainz requires contact info in the user-agent.
          </p>
        </div>

        <span className="flex items-center gap-2 text-sm">
          <Switch
            aria-label="Deezer top-tracks filter"
            checked={deezer}
            onCheckedChange={(v) => {
              setSaved(false);
              setDeezer(v);
            }}
          />
          Deezer top-tracks filter (merged-artist whitelist)
        </span>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center gap-3">
          <Button
            onClick={() =>
              save.mutate({
                musicbrainzUserAgent: userAgent,
                deezerEnabled: deezer,
                ...(apiKey ? { lastfmApiKey: apiKey } : {}),
              })
            }
            disabled={save.isPending}
          >
            {save.isPending ? "Saving…" : "Save integrations"}
          </Button>
          {saved ? <span className="text-sm text-success">Saved.</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
