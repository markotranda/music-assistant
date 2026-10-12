import type { LabelHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  // Primitive: consumers pass htmlFor or wrap their control.
  // biome-ignore lint/a11y/noLabelWithoutControl: generic label primitive
  return <label className={cn("text-sm font-medium text-foreground", className)} {...props} />;
}
