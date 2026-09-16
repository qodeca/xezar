import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/* Button variants follow the cockpit design system:
 * `primary` (lime) and `contrast` (inverse surface) are the two CTAs, `danger` (solid) and
 * `danger-ghost` are the destructive affordances. There is deliberately no `secondary`/`link` —
 * the design system doesn't use them.
 *
 * Every size carries `min-h-tap min-w-tap md:min-h-0 md:min-w-0`: `--spacing-tap` is the absolute
 * 44px phone floor and `h-9` alone is only 36px at comfortable and 27px at "Compact for real".
 * `min-height` outranks `height`, so the phone rule wins without touching the desktop geometry,
 * and `md:` hands the density lever back.
 */
const TAP = "min-h-tap min-w-tap md:min-h-0 md:min-w-0"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.75 rounded-md font-semibold whitespace-nowrap transition-[background-color,border-color,opacity,filter] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:brightness-[0.96]",
        contrast: "bg-contrast text-contrast-foreground hover:brightness-[0.96]",
        outline: "border border-border bg-card hover:bg-muted",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        // The solid destructive confirm. Four routes had copied this exact string by hand (G-10);
        // they adopt the variant in their own batches.
        danger: "bg-danger text-danger-foreground hover:brightness-[0.96]",
        "danger-ghost": "text-danger hover:bg-danger/10",
      },
      size: {
        default: `h-9 px-3.5 text-[13.5px] ${TAP}`,
        sm: `h-7.5 rounded-sm px-2.5 text-[12.5px] ${TAP}`,
        icon: `size-9 ${TAP}`,
        "icon-sm": `size-7.5 rounded-sm ${TAP}`,
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "primary",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
