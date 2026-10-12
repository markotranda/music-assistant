import { useQuery } from "@tanstack/react-query";

type Health = {
  status: "ok";
  version: string;
  time: string;
};

function StatusBadge() {
  const { data, isError, isPending } = useQuery<Health>({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch("/health");
      if (!res.ok) {
        throw new Error(`health check failed: ${res.status}`);
      }
      return res.json() as Promise<Health>;
    },
    retry: false,
  });

  if (isPending) {
    return <span className="text-zinc-400">checking…</span>;
  }
  if (isError) {
    return <span className="text-red-400">server unreachable</span>;
  }
  return <span className="text-emerald-400">server ok · v{data.version}</span>;
}

export function App() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-zinc-950 text-zinc-100">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-4xl font-bold tracking-tight">Music Assistant</h1>
        <p className="text-zinc-400">Follows trends. Doesn&apos;t overload your library.</p>
      </div>
      <div className="rounded-lg border border-zinc-800 px-4 py-2 text-sm">
        <StatusBadge />
      </div>
    </main>
  );
}
