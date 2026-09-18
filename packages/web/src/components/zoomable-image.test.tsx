import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ZoomableImage } from './zoomable-image'

afterEach(cleanup)

const LIGHTBOX = '[data-slot="image-lightbox"]'

function trigger(): HTMLButtonElement {
  const el = document.querySelector('[data-slot="image-zoom-trigger"]')
  if (!(el instanceof HTMLButtonElement)) throw new Error('no image-zoom trigger rendered')
  return el
}

describe('ZoomableImage', () => {
  it('opens a lightbox on click and closes on Escape', async () => {
    render(<ZoomableImage src="/api/v1/runs/r1/images/shot.png" alt="shot" data-slot="thread-image" />)
    expect(document.querySelector(LIGHTBOX)).toBeNull()

    fireEvent.click(trigger())
    await waitFor(() => expect(document.querySelector(LIGHTBOX)).not.toBeNull())

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector(LIGHTBOX)).toBeNull())
  })

  /**
   * #453 A06: the thumbnail used to be a bare `<img onClick>`, which no keyboard reader could
   * reach at all. It is a real button now, so the browser's own Enter/Space activation applies —
   * asserted here as the property that matters (a focusable, named, activatable trigger), because
   * jsdom does not synthesise a click from a keydown the way a browser does. The rendered
   * Enter/Space path is `e2e/design-debt-b8.e2e.ts`.
   */
  it('gives the thumbnail a real keyboard trigger with an accessible name', () => {
    render(<ZoomableImage src="/img.png" alt="a screenshot of the failing test" />)
    const button = trigger()
    expect(button.tabIndex).toBe(0)
    expect(button.getAttribute('aria-label')).toBe('Open preview of a screenshot of the failing test')
    // The picture itself is never the control any more.
    const img = button.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('onclick')).toBeNull()
  })

  it('names the trigger without an alt text too', () => {
    render(<ZoomableImage src="/img.png" />)
    expect(trigger().getAttribute('aria-label')).toBe('Open image preview')
  })

  /** Focus containment and return are Radix's, so what this pins is that we USE them. */
  it('moves focus into the dialog and hands it back to the thumbnail on close', async () => {
    render(<ZoomableImage src="/img.png" alt="pic" />)
    const button = trigger()
    button.focus()
    fireEvent.click(button)
    await waitFor(() => expect(document.querySelector(LIGHTBOX)).not.toBeNull())

    const lightbox = document.querySelector(LIGHTBOX) as HTMLElement
    await waitFor(() => expect(lightbox.contains(document.activeElement)).toBe(true))

    fireEvent.click(screen.getByText('Close'))
    await waitFor(() => expect(document.querySelector(LIGHTBOX)).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it('carries an explicit close control and an accessible name', async () => {
    render(<ZoomableImage src="/img.png" alt="pic" />)
    fireEvent.click(trigger())
    await waitFor(() => expect(document.querySelector(LIGHTBOX)).not.toBeNull())

    const lightbox = document.querySelector(LIGHTBOX) as HTMLElement
    expect(lightbox.getAttribute('role')).toBe('dialog')
    // The name is a real title element now, not an `aria-label` string: `aria-labelledby` points
    // at the sr-only DialogTitle, so the preview keeps the name it always announced.
    const titleId = lightbox.getAttribute('aria-labelledby')
    expect(titleId).toBeTruthy()
    expect(document.getElementById(titleId as string)?.textContent).toBe('Image preview')
    expect(screen.getByText('Image preview')).toBeTruthy()
    expect(lightbox.querySelector('[data-slot="dialog-close"]')).not.toBeNull()
  })

  /**
   * The Close control is the last child of the content, so it paints over the picture whatever
   * size the picture composites to — AC-8's "zoom/pan does not hide the close action". The
   * rendered stacking is measured in the browser spec; here it is the DOM order that guarantees it.
   */
  it('renders the close control after the image, so a large picture cannot cover it', async () => {
    render(<ZoomableImage src="/img.png" alt="pic" />)
    fireEvent.click(trigger())
    await waitFor(() => expect(document.querySelector(LIGHTBOX)).not.toBeNull())

    const lightbox = document.querySelector(LIGHTBOX) as HTMLElement
    const children = [...lightbox.children]
    const image = children.findIndex((child) => child.tagName === 'IMG')
    const close = children.findIndex((child) => child.getAttribute('data-slot') === 'dialog-close')
    expect(image).toBeGreaterThanOrEqual(0)
    expect(close).toBeGreaterThan(image)
  })

  it('says an unavailable image in words instead of offering a preview of nothing', () => {
    render(<ZoomableImage src="/gone.png" alt="a pruned worktree screenshot" />)
    fireEvent.error(document.querySelector('img') as HTMLImageElement)

    expect(document.querySelector('[data-slot="image-zoom-trigger"]')).toBeNull()
    const fallback = document.querySelector('[data-slot="image-unavailable"]') as HTMLElement
    expect(fallback).not.toBeNull()
    expect(fallback.textContent).toBe('Image unavailable')
    expect(fallback.getAttribute('aria-label')).toBe('a pruned worktree screenshot — image unavailable')
  })

  it('keeps the caller’s data-slot and sizing on the picture', () => {
    render(
      <ZoomableImage src="/img.png" alt="shot" data-slot="thread-image" className="max-h-72 rounded-lg" />,
    )
    const img = trigger().querySelector('img') as HTMLImageElement
    expect(img.className).toContain('max-h-72')
    expect(img.className).toContain('rounded-lg')
    // `rest` still lands where consumers put it (`ImageItem` finds its own images by this slot).
    expect(document.querySelector('[data-slot="thread-image"]')).not.toBeNull()
  })
})
