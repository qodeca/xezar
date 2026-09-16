"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-4.5 data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        // The 44px phone hit area (`--spacing-tap`) as a centred pseudo-element rather than a
        // `min-h-tap`: the root IS the visible track, so growing it would draw a 44px pill. The
        // overlay belongs to this button, so a tap anywhere in it toggles the switch. Released at
        // `md:`, and settings rows stack far enough apart that it never covers its neighbour.
        "before:absolute before:top-1/2 before:left-1/2 before:size-tap before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] md:before:hidden",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          // `bg-background` covers both themes: in dark it equals --primary-foreground, so the thumb
          // reads correctly on the lime checked track without a `dark:` variant.
          "pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
