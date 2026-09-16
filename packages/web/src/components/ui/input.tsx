import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The look a raw `<select>` / `<input>` wears when a pane keeps the NATIVE control on purpose —
 * settings fields and the repository branch picker do, for the platform's own dropdown behaviour
 * (G-11). Exported from the field primitive rather than wrapped in a `NativeSelect` component so
 * there is one string to fix and no second, half-adopted primitive. `min-h-tap` is the same
 * absolute 44px phone floor `Input` itself carries, and `text-base … md:text-sm` is the same iOS
 * rule: Safari zooms the page when a focused field's text is under 16px, and this string is
 * about to be copied into two dozen raw `<input>`/`<select>` sites (design review NB-3). It
 * inherited a flat `text-sm` from the settings pages it replaces; that is harmless on a
 * `<select>`, which opens a picker, and is exactly the zoom on an `<input>`.
 */
export const nativeFieldClass =
  "h-9 min-h-tap w-full rounded-md border border-input bg-card px-3 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0 md:text-sm"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // `min-h-tap … md:min-h-0`: the absolute 44px phone hit area (`--spacing-tap`), which the
        // density-scaled `h-9` misses at compact (31.5px) and ultra (27px).
        "h-9 min-h-tap w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-soft-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
