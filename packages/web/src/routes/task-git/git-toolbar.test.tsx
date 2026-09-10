import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DiffStat } from '@qodeca/xezar-api-client'
import type { GitAction, GitActionBar, GitActionId } from '@/lib/git-actions'

import { AnimatedDiffStat, GitToolbar } from './git-toolbar'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

beforeEach(() => {
  // Radix positions the kebab menu with floating-ui, which observes the trigger's size.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

const enabled = (id: GitActionId, label: string): GitAction => ({ id, label, enabled: true })
const blocked = (id: GitActionId, label: string, reason: string): GitAction => ({
  id,
  label,
  enabled: false,
  reason,
})

/** A policy answer shaped like `gitActionPolicy`'s, with only the parts a test cares about. */
const bar = (extra: Partial<GitActionBar> = {}): GitActionBar => ({
  primary: enabled('commit', 'Commit'),
  secondary: [],
  menu: [],
  ...extra,
})

function renderToolbar(overrides: Partial<Parameters<typeof GitToolbar>[0]> = {}) {
  const onAction = vi.fn()
  const onModeChange = vi.fn()
  const onWrapChange = vi.fn()
  const result = render(
    <GitToolbar
      bar={bar()}
      mode="unified"
      wrap={false}
      onModeChange={onModeChange}
      onWrapChange={onWrapChange}
      onAction={onAction}
      {...overrides}
    />
  )
  return { ...result, onAction, onModeChange, onWrapChange }
}

const actionButton = (id: GitActionId) =>
  document.querySelector(`[data-action="${id}"]`) as HTMLElement

describe('GitToolbar', () => {
  it('renders whatever the policy returned, in its slots, and nothing it did not', () => {
    renderToolbar({
      bar: bar({
        primary: enabled('commit', 'Commit'),
        secondary: [enabled('push', 'Push'), enabled('create-pr', 'Create PR')],
      }),
    })

    expect(actionButton('commit')).not.toBeNull()
    expect(actionButton('push')).not.toBeNull()
    expect(actionButton('create-pr')).not.toBeNull()
    // No menu entries → no kebab at all, not an empty one.
    expect(screen.queryByRole('button', { name: 'More git actions' })).toBeNull()
  })

  describe('the optional leading chips', () => {
    it('omits the branch chip and the stat when the run has neither', () => {
      renderToolbar()

      expect(document.querySelector('[data-slot="branch-chip"]')).toBeNull()
      expect(document.querySelector('[data-slot="changes-stat"]')).toBeNull()
    })

    it('renders the branch chip and the aggregate stat when it has both', () => {
      renderToolbar({ branch: 'xez/1a2b3c4d', stat: { adds: 12, dels: 3, files: 2 } })

      expect(document.querySelector('[data-slot="branch-chip"]')?.textContent).toContain(
        'xez/1a2b3c4d'
      )
      const stat = document.querySelector('[data-slot="changes-stat"]') as HTMLElement
      expect(stat.textContent).toContain('+12')
      expect(stat.textContent).toContain('−3')
    })
  })

  describe('a plain action button', () => {
    it('clicks through to the parent mutation switch', () => {
      const { onAction } = renderToolbar({ bar: bar({ primary: enabled('commit', 'Commit') }) })

      fireEvent.click(actionButton('commit'))
      expect(onAction).toHaveBeenCalledWith('commit')
    })

    it("shows the policy's own reason as the tooltip while disabled, and does not fire", () => {
      const { onAction } = renderToolbar({
        bar: bar({
          primary: blocked('commit', 'Commit', 'Commit unavailable — no changes to commit'),
        }),
      })

      const button = actionButton('commit') as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title).toBe('Commit unavailable — no changes to commit')
      fireEvent.click(button)
      expect(onAction).not.toHaveBeenCalled()
    })

    it('carries no tooltip at all while enabled', () => {
      renderToolbar({ bar: bar({ primary: enabled('commit', 'Commit') }) })

      // Not the reason, and not an empty string either — an enabled button has nothing to explain.
      expect((actionButton('commit') as HTMLButtonElement).title).toBe('')
    })
  })

  describe('view-pr href guard (#431)', () => {
    it('renders a real link for an http(s) PR URL, opened safely', () => {
      renderToolbar({
        bar: bar({
          primary: { ...enabled('view-pr', 'View PR'), href: 'https://github.com/o/r/pull/7' },
        }),
      })

      const link = screen.getByRole('link', { name: /View PR/ }) as HTMLAnchorElement
      expect(link.getAttribute('href')).toBe('https://github.com/o/r/pull/7')
      expect(link.target).toBe('_blank')
      expect(link.rel).toBe('noopener noreferrer')
    })

    it.each([
      // Spelled without a call so `design-guardian.test.ts`'s no-native-dialogs sweep does not
      // read these fixtures as real `alert()` calls — the SCHEME is what is under test.
      'javascript:void 0',
      'data:text/html,<script>void 0</script>',
      'file:///etc/passwd',
      'not a url at all',
      undefined,
    ])('refuses %j and disables the button instead of falling through', (href) => {
      const { onAction } = renderToolbar({
        bar: bar({ primary: { ...enabled('view-pr', 'View PR'), href } }),
      })

      // The refusal must NOT reach the generic button below: the policy hardcodes view-pr as
      // enabled and the parent's view-pr case is a deliberate no-op, so a fall-through would
      // render a clickable button that silently does nothing.
      expect(screen.queryByRole('link')).toBeNull()
      const button = actionButton('view-pr') as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title).toBe(
        'View PR unavailable — the recorded PR link is not an http(s) URL'
      )
      fireEvent.click(button)
      expect(onAction).not.toHaveBeenCalled()
    })
  })

  describe('the overflow menu', () => {
    async function openMenu(menu: GitAction[]) {
      const rendered = renderToolbar({ bar: bar({ menu }) })
      fireEvent.pointerDown(screen.getByRole('button', { name: 'More git actions' }), {
        button: 0,
        ctrlKey: false,
        pointerType: 'mouse',
      })
      return { ...rendered, menu: within(await screen.findByRole('menu')) }
    }

    it('selects an enabled entry through to the parent', async () => {
      const { menu, onAction } = await openMenu([enabled('open-terminal', 'Open in terminal')])

      fireEvent.click(menu.getByRole('menuitem', { name: 'Open in terminal' }))
      await waitFor(() => expect(onAction).toHaveBeenCalledWith('open-terminal'))
    })

    it("keeps a disabled entry inert and carrying the policy's reason", async () => {
      const { menu, onAction } = await openMenu([
        blocked(
          'open-terminal',
          'Open in terminal',
          'Terminal unavailable — no agent session to resume'
        ),
      ])

      const item = menu.getByRole('menuitem', { name: 'Open in terminal' })
      expect(item.getAttribute('data-disabled')).not.toBeNull()
      expect(item.getAttribute('title')).toBe(
        'Terminal unavailable — no agent session to resume'
      )
      fireEvent.click(item)
      expect(onAction).not.toHaveBeenCalled()
    })
  })

  describe('the local view toggles', () => {
    it('reports a layout change without going anywhere near the policy', () => {
      const { onModeChange, onWrapChange, onAction } = renderToolbar()

      fireEvent.click(document.querySelector('[data-mode="split"]') as HTMLElement)
      fireEvent.click(document.querySelector('[data-slot="wrap-toggle"]') as HTMLElement)

      expect(onModeChange).toHaveBeenCalledWith('split')
      expect(onWrapChange).toHaveBeenCalledWith(true)
      expect(onAction).not.toHaveBeenCalled()
    })
  })
})

describe('AnimatedDiffStat', () => {
  const stat = (adds: number, dels: number): DiffStat => ({ adds, dels, files: 1 })
  const shown = () => document.querySelector('[data-slot="diff-stat"]')?.textContent ?? ''

  it('starts at the real value, so a screenshot never catches a fake zero', () => {
    render(<AnimatedDiffStat stat={stat(128, 14)} />)

    expect(shown()).toContain('+128')
    expect(shown()).toContain('−14')
  })

  it('jumps rather than tweens under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)

    const { rerender } = render(<AnimatedDiffStat stat={stat(0, 0)} />)
    rerender(<AnimatedDiffStat stat={stat(40, 5)} />)

    expect(shown()).toContain('+40')
    expect(shown()).toContain('−5')
    // Reduced means JUMP: not one frame is scheduled.
    expect(raf).not.toHaveBeenCalled()
  })

  describe('with a real animation frame', () => {
    /** A hand-cranked rAF: the test decides when each frame runs and what the clock says. */
    function stubFrames() {
      const pending = new Map<number, FrameRequestCallback>()
      let next = 1
      vi.stubGlobal('matchMedia', () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }))
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        pending.set(next, cb)
        return next++
      })
      const cancelled: number[] = []
      vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        cancelled.push(id)
        pending.delete(id)
      })
      vi.spyOn(performance, 'now').mockReturnValue(1_000)
      return {
        cancelled,
        pendingCount: () => pending.size,
        /** Run the one queued frame at `1000 + elapsed` ms. */
        advance(elapsed: number) {
          const [id, cb] = [...pending.entries()][0] ?? []
          if (cb === undefined || id === undefined) throw new Error('no frame queued')
          pending.delete(id)
          act(() => cb(1_000 + elapsed))
        },
      }
    }

    it('counts toward the new value on an easing curve', () => {
      const frames = stubFrames()
      const { rerender } = render(<AnimatedDiffStat stat={stat(0, 0)} />)
      rerender(<AnimatedDiffStat stat={stat(100, 0)} />)

      // Half of the 350ms duration, cubic ease-out: 1 - (1 - 0.5)³ = 0.875.
      frames.advance(175)
      expect(shown()).toContain('+88')
      expect(shown()).not.toContain('+100')
      // Not finished, so the tween keeps asking for the next frame.
      expect(frames.pendingCount()).toBe(1)
    })

    it('lands exactly on the target and stops asking for frames', () => {
      const frames = stubFrames()
      const { rerender } = render(<AnimatedDiffStat stat={stat(0, 0)} />)
      rerender(<AnimatedDiffStat stat={stat(100, 0)} />)

      frames.advance(400)
      expect(shown()).toContain('+100')
      expect(frames.pendingCount()).toBe(0)
    })

    it('re-tweens from where it stopped when the diff grows again mid-flight', () => {
      const frames = stubFrames()
      const { rerender } = render(<AnimatedDiffStat stat={stat(0, 0)} />)
      rerender(<AnimatedDiffStat stat={stat(100, 0)} />)
      frames.advance(400)

      rerender(<AnimatedDiffStat stat={stat(200, 0)} />)
      frames.advance(175)
      // From 100, not from 0 — a live agent turn growing the diff reads as movement.
      expect(shown()).toContain('+188')
    })

    it('cancels the frame and settles on the target when the tab unmounts mid-tween', () => {
      const frames = stubFrames()
      const { rerender, unmount } = render(<AnimatedDiffStat stat={stat(0, 0)} />)
      rerender(<AnimatedDiffStat stat={stat(100, 0)} />)
      frames.advance(175)

      unmount()
      expect(frames.cancelled.length).toBeGreaterThan(0)
      expect(frames.pendingCount()).toBe(0)
    })

    it('jumps when the engine has no requestAnimationFrame at all', () => {
      vi.stubGlobal('matchMedia', () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }))
      vi.stubGlobal('requestAnimationFrame', undefined)

      const { rerender } = render(<AnimatedDiffStat stat={stat(0, 0)} />)
      rerender(<AnimatedDiffStat stat={stat(77, 0)} />)

      expect(shown()).toContain('+77')
    })
  })
})
