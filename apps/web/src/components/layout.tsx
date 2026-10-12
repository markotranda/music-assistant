import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Disc3, ListChecks, Settings2, TrendingUp, Users } from "lucide-react";
import { useState } from "react";
import { ApiRequestError, api } from "../lib/api";
import { cn } from "../lib/utils";
import { useUiStore } from "../stores/ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const NAV = [
  { to: "/", label: "Dashboard", icon: Disc3 },
  { to: "/bands", label: "Bands", icon: Users },
  { to: "/queue", label: "Queue", icon: ListChecks },
  { to: "/trends", label: "Trends", icon: TrendingUp },
  { to: "/settings", label: "Settings", icon: Settings2 },
] as const;

function TokenGate() {
  const setToken = useUiStore((s) => s.setToken);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form
        className="flex w-80 flex-col gap-3 rounded-lg border border-border bg-card p-6"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!value.trim()) {
            setError("Enter the API token");
            return;
          }
          setToken(value.trim());
        }}
      >
        <h1 className="text-lg font-semibold">Music Assistant</h1>
        <p className="text-sm text-muted-foreground">This instance requires an API token.</p>
        <Input
          type="password"
          placeholder="API token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit">Unlock</Button>
      </form>
    </div>
  );
}

export function Layout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const token = useUiStore((s) => s.token);

  // Auth probe: /api/dashboard 401s when a token is required. Re-runs when
  // the stored token changes, so unlocking is instant.
  const probe = useQuery({
    queryKey: ["auth-probe", token],
    queryFn: () => api("/api/dashboard"),
    retry: false,
  });

  const unauthorized =
    probe.isError && probe.error instanceof ApiRequestError && probe.error.status === 401;

  if (unauthorized) return <TokenGate />;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-52 flex-col gap-1 border-r border-border bg-card p-3">
        <div className="mb-4 flex items-center gap-2 px-2 py-1">
          <Disc3 className="h-5 w-5 text-foreground" />
          <span className="text-sm font-semibold">Music Assistant</span>
        </div>
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
              pathname === to && "bg-secondary text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
        <div className="mt-auto px-2 text-xs text-muted-foreground">
          {token ? "token active" : "open API"}
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden p-6">
        <Outlet />
      </main>
    </div>
  );
}
