import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      // `motion-reduce:animate-none`: the placeholder still reads as "not here yet" from its
      // shape and fill, so the pulse is decoration a reduced-motion reader can do without (G-08).
      className={cn(
        "animate-pulse rounded-md bg-accent motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
