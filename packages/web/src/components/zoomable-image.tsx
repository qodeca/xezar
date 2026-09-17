import { useState, type ImgHTMLAttributes } from 'react'

import { resolveApiUrl } from '@qodeca/xezar-api-client'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/**
 * An image that enlarges to a full-screen lightbox (#image-zoom). Used for conversation
 * images — the agent's own screenshots and the user's attachments — so a thumbnail can be read
 * without leaving the thread. Dismiss by clicking the backdrop, pressing Escape, or the Close
 * control in the corner.
 *
 * `src` is always a cockpit-served `/api/...` URL (the server persists them into the transcript
 * — `/api/runs/:id/images/…` — and `taskImages`/`runFileRawUrl` are the same origin), so the
 * project scope is applied HERE, at render time (multi-project spec, step 3.1): transcripts
 * store the unscoped legacy URL forever, and re-scoping on use keeps them valid under
 * `/api/p/<id>`. `apiPath` is the identity unscoped and skips already-scoped paths.
 *
 * ## Why this is a real Dialog and not a portalled div (#453 A06, B8)
 *
 * It used to be an `<img onClick>` over a hand-rolled `role="dialog"` portal. That shape gave a
 * keyboard reader nothing: an `img` is not focusable, so the preview could not be OPENED without
 * a pointer, and once open there was no focus move, no trap, no focus return and no close control
 * — only a window-level Escape listener. All four are what `DialogPrimitive` already does
 * correctly, so the fix is to USE it rather than to re-implement a focus scope here: the
 * thumbnail is a real `DialogTrigger` button (Enter and Space open it, and Radix hands focus back
 * to it on close), and `DialogContent` moves focus in, traps Tab inside, and renders the
 * 44 px-floored Close button. The only thing this file still spells is the full-bleed scrim look,
 * which is why `bg-black/80` is allowed outside `components/ui/` (design-guardian
 * `no-raw-black-white`): a dark backdrop is theme-agnostic by design.
 *
 * The Close control is rendered by `DialogContent` AFTER `children`, so it paints over the image
 * however large the image composites — a zoomed picture can never cover the way out.
 */
export function ZoomableImage({
  src: rawSrc,
  alt = '',
  className,
  ...rest
}: {
  src: string
  alt?: string
  className?: string
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'className' | 'onClick'>) {
  const src = resolveApiUrl(rawSrc)
  // A cockpit-served image can still be gone — a pruned worktree, a deleted run directory. An
  // `<img>` that failed paints the browser's own broken-image glyph and would open a black
  // lightbox over nothing, so absence is said in words instead (README rule 10) and the preview
  // is not offered: there is nothing to enlarge.
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <span
        {...rest}
        data-slot="image-unavailable"
        role="img"
        aria-label={alt === '' ? 'Image unavailable' : `${alt} — image unavailable`}
        className={cn(
          'inline-flex max-w-full items-center rounded-md border border-border bg-muted px-2 py-1 text-xs text-soft-foreground',
          className,
        )}
      >
        Image unavailable
      </span>
    )
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={alt === '' ? 'Open image preview' : `Open preview of ${alt}`}
          data-slot="image-zoom-trigger"
          // `min-*-tap` released at `md:`: a thumbnail smaller than the phone floor grows its
          // TARGET around the picture rather than the picture itself (Q2, a flat 44 px at every
          // density). The image keeps the caller's own sizing, so the thread layout is unchanged.
          className="inline-flex min-h-tap min-w-tap max-w-full cursor-zoom-in items-center justify-center self-start rounded-md p-0 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-0 md:min-w-0"
        >
          {/* `rest` stays on the PICTURE, where it has always been: `ImageItem` finds its own
              images by `data-slot="thread-image"`, and a consumer's width/height or `title`
              describes the image rather than the control around it. */}
          <img
            {...rest}
            src={src}
            alt={alt}
            loading="lazy"
            onError={() => setFailed(true)}
            className={cn('max-w-full', className)}
          />
        </button>
      </DialogTrigger>
      <DialogContent
        data-slot="image-lightbox"
        // Full-bleed over the primitive's centred card: no card surface, no border, no radius, no
        // width cap at any breakpoint (`sm:max-w-none` is needed too — tailwind-merge keeps a
        // modifier'd class when the override carries none) — the picture is the content.
        //
        // `bg-black/60`, not the documented `bg-black/80`, and that is not a look change:
        // `DialogContent` always paints its own `DialogOverlay` (`bg-black/50`) underneath, so the
        // COMPOSITE is 1 − (0.5 × 0.4) = 0.8 — the same 80 % scrim this component has always had.
        // Change one of the two numbers and the other has to move with it.
        className="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 items-center justify-center gap-0 rounded-none border-0 bg-black/60 p-4 shadow-none backdrop-blur-sm sm:max-w-none"
      >
        <DialogTitle className="sr-only">Image preview</DialogTitle>
        <DialogDescription className="sr-only">
          {alt === '' ? 'The image at full size.' : alt}
        </DialogDescription>
        <img
          src={src}
          alt={alt}
          onError={() => setFailed(true)}
          className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
        />
      </DialogContent>
    </Dialog>
  )
}
