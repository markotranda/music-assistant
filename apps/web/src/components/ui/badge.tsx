import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      default: "bg-secondary text-secondary-foreground",
      success: "bg-success/15 text-success",
      warning: "bg-warning/15 text-warning",
      destructive: "bg-destructive/15 text-destructive",
      outline: "border border-border text-muted-foreground",
    },
  },
  defaultVariants: { variant: "default" },
});

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Plan/job status -> badge look. */
export function statusVariant(status: string): VariantProps<typeof badgeVariants>["variant"] {
  switch (status) {
    case "OWNED":
    case "done":
      return "success";
    case "DOWNLOADING":
    case "running":
    case "pending":
      return "warning";
    case "FAILED":
    case "failed":
      return "destructive";
    default:
      return "outline";
  }
}
