import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { ApiRequestError, apiPut } from "../../lib/api";
import type { Settings } from "../../lib/types";
import { useUiStore } from "../../stores/ui";

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function SecurityForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const setUiToken = useUiStore((s) => s.setToken);
  const [token, setToken] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: { token: string }) => apiPut("/api/settings/auth", body),
    onSuccess: (_data, body) => {
      setSaved(true);
      setError(null);
      setToken("");
      // Keep talking to the API with the token we just set.
      if (body.token) setUiToken(body.token);
      else setUiToken(null);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>API access</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Status:{" "}
          {settings.auth.tokenMasked ? (
            <>
              token active <span className="text-foreground">({settings.auth.tokenMasked})</span> —
              all <code>/api/*</code> calls require <code>Authorization: Bearer &lt;token&gt;</code>
              .
            </>
          ) : (
            "open — no token required (single-user LAN mode)."
          )}
        </p>

        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="api-token">Set token</Label>
            <Input
              id="api-token"
              type="password"
              placeholder="type a token or generate one"
              value={token}
              onChange={(e) => {
                setSaved(false);
                setToken(e.target.value);
              }}
            />
          </div>
          <Button
            variant="outline"
            onClick={() => {
              const generated = generateToken();
              setFreshToken(generated);
              save.mutate({ token: generated });
            }}
          >
            Generate
          </Button>
          <Button
            disabled={!token || save.isPending}
            onClick={() => {
              setFreshToken(null);
              save.mutate({ token });
            }}
          >
            Save
          </Button>
          {settings.auth.tokenMasked ? (
            <Button
              variant="destructive"
              onClick={() => {
                setFreshToken(null);
                save.mutate({ token: "" });
              }}
            >
              Disable
            </Button>
          ) : null}
        </div>

        {freshToken ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="font-medium">Copy this token now — it is shown once:</p>
            <code className="mt-1 block select-all break-all text-foreground">{freshToken}</code>
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {saved && !freshToken ? <p className="text-sm text-success">Saved.</p> : null}
      </CardContent>
    </Card>
  );
}
