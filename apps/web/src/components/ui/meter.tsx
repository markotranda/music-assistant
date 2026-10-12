import { cn } from "../../lib/utils";

/**
 * State-colored progress meter (PLAN §4.2 budgets): green while healthy,
 * amber past 70%, red past 95%. Units are the caller's concern — pass a
 * display string and a real percentage (this fixed the GB/bytes mixup).
 */
export function Meter({
  label,
  valueText,
  percent,
  className,
}: {
  label: string;
  valueText: string;
  percent: number;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const fill = pct >= 95 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-primary";
  return (
    <div className={cn("flex items-center gap-3 text-sm", className)}>
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-meter-track">
        <span
          className={cn("block h-full rounded-full transition-all", fill)}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-32 shrink-0 text-right text-xs text-muted-foreground">{valueText}</span>
    </div>
  );
}
