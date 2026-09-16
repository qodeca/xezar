import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import { useAppearance } from '@/components/appearance-provider'
import { useTheme } from '@/components/theme-provider'
import { cn } from '@/lib/utils'
import type { Accent, Density, Width } from '@/lib/appearance'
import type { Theme } from '@/lib/theme'

import { SettingsField } from './settings-field'

/**
 * Settings → Appearance (R6 Step 1.3, spec §"Settings").
 *
 * Four knobs, each honest about where it persists:
 *  - THEME rides the existing theme system (localStorage `xez-theme`, shared with the legacy
 *    cockpit and the pre-paint script) — per-browser by design, like every OS theme choice;
 *  - ACCENT + DENSITY + READING WIDTH persist in `ui-state.json` through the AppearanceProvider
 *    (additive `appearance` key), mirrored to localStorage for pre-paint.
 *
 * Every control is a real one: accent swaps the `--primary` token family, density shrinks
 * or grows the Tailwind spacing token (see index.css). No dead knobs.
 */

const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }> = [
  { value: 'system', label: 'System', icon: MonitorIcon },
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
]

/** Swatches point at the STABLE family tokens (`--accent-lime`, `--violet`), not `--primary` —
 *  the whole point of the control is that `--primary` changes under it. */
const ACCENT_OPTIONS: Array<{ value: Accent; label: string; swatch: string }> = [
  { value: 'lime', label: 'Lime', swatch: 'var(--accent-lime)' },
  { value: 'violet', label: 'Violet', swatch: 'var(--violet)' },
]

const DENSITY_OPTIONS: Array<{ value: Density; label: string }> = [
  { value: 'roomy', label: 'Roomy' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
  { value: 'ultra', label: 'Compact for real' },
]

const WIDTH_OPTIONS: Array<{ value: Width; label: string }> = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'wide', label: 'Wide' },
]

/** One segmented radio group — the shared chassis of all four controls. It wraps instead of
 *  overflowing: four density options do not fit a 375px phone column on one line, and the
 *  settings body clips rather than scrolls sideways. */
function Segmented<V extends string>({
  slot,
  label,
  value,
  options,
  onChange,
}: {
  slot: string
  label: string
  value: V
  options: Array<{ value: V; label: string; icon?: ComponentType<SVGProps<SVGSVGElement>>; swatch?: string }>
  onChange: (value: V) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-slot={slot}
      className="inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-md border border-border bg-card p-0.5"
    >
      {options.map((option) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={option.value}
            onClick={() => onChange(option.value)}
            // `min-h-tap min-w-tap … md:` is the absolute 44px phone hit area at every density (A-01);
            // the explicit focus ring is the same one Button wears, so keyboard users see the segment.
            className={cn(
              'flex min-h-tap min-w-tap items-center justify-center gap-2 rounded-sm px-3 py-1.5 text-[13px] font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-0 md:min-w-0',
              checked
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.icon ? <option.icon aria-hidden="true" className="size-3.5" /> : null}
            {option.swatch ? (
              <span
                aria-hidden="true"
                className="size-3 rounded-full border border-border"
                style={{ background: option.swatch }}
              />
            ) : null}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const { accent, density, width, setAccent, setDensity, setWidth } = useAppearance()

  return (
    <div
      data-slot="appearance-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-section p-list pb-[calc(90px+env(safe-area-inset-bottom))] md:p-group md:pb-group"
    >
      <SettingsField title="Theme" hint="System follows your OS preference. Applies to this browser.">
        <Segmented slot="appearance-theme" label="Theme" value={theme} options={THEME_OPTIONS} onChange={setTheme} />
      </SettingsField>

      <SettingsField title="Accent" hint="The primary action color. Saved for you on this computer and used in every project.">
        <Segmented slot="appearance-accent" label="Accent" value={accent} options={ACCENT_OPTIONS} onChange={setAccent} />
      </SettingsField>

      <SettingsField
        title="Density"
        hint="Roomy adds space between things and the Compact options take it away — text stays the same size."
      >
        <Segmented slot="appearance-density" label="Density" value={density} options={DENSITY_OPTIONS} onChange={setDensity} />
      </SettingsField>

      <SettingsField
        title="Reading width"
        hint="Wide lets a task’s session and commits use more of the screen. Narrow keeps a comfortable reading column. The Changes tab is always full-width."
      >
        <Segmented slot="appearance-width" label="Reading width" value={width} options={WIDTH_OPTIONS} onChange={setWidth} />
      </SettingsField>
    </div>
  )
}
