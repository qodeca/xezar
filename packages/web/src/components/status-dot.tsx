import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* The 7px status dot — the design system's single carrier of status color.
 * Rows, pills and nav items stay neutral; the dot is what's tinted.
 * `size-1.75` is 7px at comfortable and follows the density lever, which the hand-typed seven
 * pixels it replaced did not.
 * `pulse` marks a transitioning state (running / waiting) and uses Tailwind's stock `animate-pulse`
 * rather than a bespoke keyframe, per the design system's "quiet motion" rule — and now carries the
 * `motion-reduce:animate-none` that rule always implied but the code never shipped (G-08). The
 * colour, not the motion, is what says which state this is, so the guard loses no information.
 */
const statusDotVariants = cva("inline-block size-1.75 shrink-0 rounded-full", {
  variants: {
    tone: {
      success: "bg-success",
      pending: "bg-pending",
      danger: "bg-danger",
      violet: "bg-violet",
      neutral: "bg-soft-foreground",
    },
    pulse: {
      true: "animate-pulse motion-reduce:animate-none",
      false: "",
    },
  },
  defaultVariants: {
    tone: "neutral",
    pulse: false,
  },
})

export type StatusDotTone = NonNullable<
  VariantProps<typeof statusDotVariants>["tone"]
>

function StatusDot({
  className,
  tone = "neutral",
  pulse = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statusDotVariants>) {
  return (
    <span
      data-slot="status-dot"
      data-tone={tone}
      className={cn(statusDotVariants({ tone, pulse, className }))}
      {...props}
    />
  )
}

export { StatusDot, statusDotVariants }
