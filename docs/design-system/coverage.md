# Coverage

One row per token, primitive, shared component and pattern. `packages/web/src/design-system-drift.test.ts` reads this file: every primitive and shared component path must appear here in backticks, and every custom property in `packages/web/src/styles/index.css` must appear as `` `--name` `` somewhere in `docs/design-system/*.md`.

Status values:

- **Documented** – the entry describes what the code does today, with a source path.
- **Documented with known gap** – documented, and the code disagrees with itself; the gap id points at `known-gaps.md`.
- **Not applicable** – the file is in the inventory but is not a visual component; the reason says why.

## 1. Tokens

Source: `packages/web/src/styles/index.css`. Every token below has both theme values in `foundations.md` and is carried verbatim by `cockpit.css` (the drift test compares them).

### 1.1 Theme tokens (`:root`, overridden in `.light` where noted)

| Token | Light override in `.light` | Documented in | Status |
| --- | --- | --- | --- |
| `--background` | yes | foundations.md §1.1 | Documented |
| `--foreground` | yes | foundations.md §1.1 | Documented |
| `--card` | yes | foundations.md §1.1 | Documented |
| `--card-2` | yes | foundations.md §1.1 | Documented |
| `--sidebar` | yes | foundations.md §1.1 | Documented |
| `--muted` | yes | foundations.md §1.1 | Documented |
| `--muted-foreground` | yes | foundations.md §1.1 | Documented |
| `--soft-foreground` | yes | foundations.md §1.1 | Documented |
| `--border` | yes | foundations.md §1.1 | Documented |
| `--input` | yes | foundations.md §1.1 | Documented |
| `--contrast` | yes | foundations.md §1.1 | Documented |
| `--contrast-foreground` | yes | foundations.md §1.1 | Documented |
| `--accent-lime` | no – same in both themes | foundations.md §1.2 | Documented |
| `--primary` | no – same in both themes | foundations.md §1.2 | Documented |
| `--primary-foreground` | no – same in both themes | foundations.md §1.2 | Documented |
| `--violet` | no – same in both themes | foundations.md §1.2 | Documented |
| `--violet-foreground` | no – same in both themes | foundations.md §1.2 | Documented |
| `--ring` | yes | foundations.md §1.2 | Documented |
| `--danger` | no – same in both themes | foundations.md §1.3 | Documented |
| `--danger-foreground` | no – same in both themes | foundations.md §1.3 | Documented |
| `--success` | no – same in both themes | foundations.md §1.3 | Documented |
| `--pending` | no – same in both themes | foundations.md §1.3 | Documented |
| `--info` | yes | foundations.md §1.3 | Documented |
| `--conflict` | yes | foundations.md §1.3 | Documented |
| `--pending-strong` | yes | foundations.md §1.3 | Documented |
| `--diff-add-bg` | yes | foundations.md §1.4 | Documented |
| `--diff-add-strong` | no – same in both themes | foundations.md §1.4 | Documented |
| `--diff-del-bg` | yes | foundations.md §1.4 | Documented |
| `--diff-del-strong` | no – same in both themes | foundations.md §1.4 | Documented |
| `--grad` | no – same in both themes | foundations.md §1.2 | Documented |
| `--sans` | no – same in both themes | foundations.md §3 | Documented |
| `--mono` | no – same in both themes | foundations.md §3 | Documented |
| `--measure` | no – same in both themes | foundations.md §9 | Documented |
| `--syn-key` | yes | foundations.md §1.5 | Documented |
| `--syn-str` | yes | foundations.md §1.5 | Documented |
| `--syn-fn` | yes | foundations.md §1.5 | Documented |
| `--syn-com` | yes | foundations.md §1.5 | Documented |
| `--syn-num` | yes | foundations.md §1.5 | Documented |
| `--syn-punc` | yes | foundations.md §1.5 | Documented |
| `--syn-var` | yes | foundations.md §1.5 | Documented |
| `--popover` | no – same in both themes | foundations.md §1.6 | Documented |
| `--popover-foreground` | no – same in both themes | foundations.md §1.6 | Documented |
| `--card-foreground` | no – same in both themes | foundations.md §1.6 | Documented |
| `--accent` | no – same in both themes | foundations.md §1.6 | Documented |
| `--accent-foreground` | no – same in both themes | foundations.md §1.6 | Documented |
| `--secondary` | no – same in both themes | foundations.md §1.6 | Documented |
| `--secondary-foreground` | no – same in both themes | foundations.md §1.6 | Documented |
| `--destructive` | no – same in both themes | foundations.md §1.6 | Documented |
| `--destructive-foreground` | no – same in both themes | foundations.md §1.6 | Documented |

### 1.2 Appearance overrides

| Token | Declared in | Documented in | Status |
| --- | --- | --- | --- |
| `--primary`, `--primary-foreground`, `--ring` | `:root[data-accent='violet']` | theming.md §Accent, foundations.md §1.2 | Documented |
| `--spacing` | `:root[data-density='roomy']`, `:root[data-density='compact']`, `:root[data-density='ultra']` (default `0.25rem` in `@theme static`) | foundations.md §4, theming.md | Documented |
| `--measure` | `:root[data-width='wide']` (also `:root`) | foundations.md §9, theming.md | Documented |

### 1.3 Static scales (`@theme static`)

| Token | Documented in | Status |
| --- | --- | --- |
| `--spacing` | foundations.md §4 (default value) | Documented |
| `--spacing-row` | foundations.md §4.1 | Documented |
| `--spacing-stack` | foundations.md §4.1 | Documented |
| `--spacing-list` | foundations.md §4.1 | Documented |
| `--spacing-inset` | foundations.md §4.1 | Documented |
| `--spacing-group` | foundations.md §4.1 | Documented |
| `--spacing-section` | foundations.md §4.1 | Documented |
| `--radius-sm` | foundations.md §5 | Documented |
| `--radius` | foundations.md §5 | Documented |
| `--radius-lg` | foundations.md §5 | Documented |
| `--radius-xl` | foundations.md §5 | Documented |
| `--shadow-xs` | foundations.md §6 | Documented |
| `--shadow-sm` | foundations.md §6 | Documented |
| `--shadow-md` | foundations.md §6 | Documented |
| `--shadow-modal` | foundations.md §6 (light value in `.light`) | Documented |

### 1.4 Tailwind mapping (`@theme inline`)

Each entry maps a utility name to a theme token. Listed in foundations.md §1.7; the utility column in every token table is derived from it.

| Mapping | Utility family | Status |
| --- | --- | --- |
| `--color-background` | `bg-/text-/border-background` | Documented |
| `--color-foreground` | `bg-/text-/border-foreground` | Documented |
| `--color-card` | `bg-/text-/border-card` | Documented |
| `--color-card-foreground` | `bg-/text-/border-card-foreground` | Documented |
| `--color-card-2` | `bg-/text-/border-card-2` | Documented |
| `--color-sidebar` | `bg-/text-/border-sidebar` | Documented |
| `--color-muted` | `bg-/text-/border-muted` | Documented |
| `--color-muted-foreground` | `bg-/text-/border-muted-foreground` | Documented |
| `--color-soft-foreground` | `bg-/text-/border-soft-foreground` | Documented |
| `--color-border` | `bg-/text-/border-border` | Documented |
| `--color-input` | `bg-/text-/border-input` | Documented |
| `--color-contrast` | `bg-/text-/border-contrast` | Documented |
| `--color-contrast-foreground` | `bg-/text-/border-contrast-foreground` | Documented |
| `--color-primary` | `bg-/text-/border-primary` | Documented |
| `--color-primary-foreground` | `bg-/text-/border-primary-foreground` | Documented |
| `--color-violet` | `bg-/text-/border-violet` | Documented |
| `--color-violet-foreground` | `bg-/text-/border-violet-foreground` | Documented |
| `--color-ring` | `bg-/text-/border-ring` | Documented |
| `--color-danger` | `bg-/text-/border-danger` | Documented |
| `--color-danger-foreground` | `bg-/text-/border-danger-foreground` | Documented |
| `--color-success` | `bg-/text-/border-success` | Documented |
| `--color-pending` | `bg-/text-/border-pending` | Documented |
| `--color-pending-strong` | `bg-/text-/border-pending-strong` | Documented |
| `--color-info` | `bg-/text-/border-info` | Documented |
| `--color-conflict` | `bg-/text-/border-conflict` | Documented |
| `--color-diff-add` | `bg-/text-/border-diff-add` | Documented |
| `--color-diff-add-strong` | `bg-/text-/border-diff-add-strong` | Documented |
| `--color-diff-del` | `bg-/text-/border-diff-del` | Documented |
| `--color-diff-del-strong` | `bg-/text-/border-diff-del-strong` | Documented |
| `--color-popover` | `bg-/text-/border-popover` | Documented |
| `--color-popover-foreground` | `bg-/text-/border-popover-foreground` | Documented |
| `--color-accent` | `bg-/text-/border-accent` | Documented |
| `--color-accent-foreground` | `bg-/text-/border-accent-foreground` | Documented |
| `--color-secondary` | `bg-/text-/border-secondary` | Documented |
| `--color-secondary-foreground` | `bg-/text-/border-secondary-foreground` | Documented |
| `--color-destructive` | `bg-/text-/border-destructive` | Documented |
| `--color-destructive-foreground` | `bg-/text-/border-destructive-foreground` | Documented |
| `--font-sans` | `font-sans` | Documented |
| `--font-mono` | `font-mono` | Documented |
| `--radius-md` | `rounded-md` | Documented |

## 2. Primitives (`packages/web/src/components/ui/`)

| Source | Component | Documented in | Status |
| --- | --- | --- | --- |
| `packages/web/src/components/ui/alert-dialog.tsx` | AlertDialog | components.md §1 AlertDialog | Documented |
| `packages/web/src/components/ui/badge.tsx` | Badge | components.md §1 Badge | Documented |
| `packages/web/src/components/ui/button.tsx` | Button | components.md §1 Button | Documented with known gap (G-10) |
| `packages/web/src/components/ui/card.tsx` | Card | components.md §1 Card | Documented with known gap (G-02, G-20) |
| `packages/web/src/components/ui/collapsible.tsx` | Collapsible | components.md §1 Collapsible | Documented |
| `packages/web/src/components/ui/command.tsx` | Command | components.md §1 Command | Documented |
| `packages/web/src/components/ui/dialog.tsx` | Dialog | components.md §1 Dialog | Documented with known gap (G-06) |
| `packages/web/src/components/ui/dropdown-menu.tsx` | DropdownMenu | components.md §1 DropdownMenu | Documented with known gap (G-07) |
| `packages/web/src/components/ui/input.tsx` | Input | components.md §1 Input | Documented with known gap (G-12) |
| `packages/web/src/components/ui/label.tsx` | Label | components.md §1 Label | Documented |
| `packages/web/src/components/ui/popover.tsx` | Popover | components.md §1 Popover | Documented with known gap (G-07) |
| `packages/web/src/components/ui/scroll-area.tsx` | ScrollArea | components.md §1 ScrollArea | Documented with known gap (G-20) |
| `packages/web/src/components/ui/select.tsx` | Select | components.md §1 Select | Documented with known gap (G-11, G-20) |
| `packages/web/src/components/ui/separator.tsx` | Separator | components.md §1 Separator | Documented with known gap (G-20) |
| `packages/web/src/components/ui/sheet.tsx` | Sheet | components.md §1 Sheet | Documented |
| `packages/web/src/components/ui/skeleton.tsx` | Skeleton | components.md §1 Skeleton | Documented with known gap (G-08) |
| `packages/web/src/components/ui/switch.tsx` | Switch | components.md §1 Switch | Documented |
| `packages/web/src/components/ui/tabs.tsx` | Tabs | components.md §1 Tabs | Documented |
| `packages/web/src/components/ui/textarea.tsx` | Textarea | components.md §1 Textarea | Documented with known gap (G-07) |
| `packages/web/src/components/ui/toaster.tsx` | Toaster | components.md §1 Toaster | Documented with known gap (G-16) |
| `packages/web/src/components/ui/tooltip.tsx` | Tooltip | components.md §1 Tooltip | Documented with known gap (G-06) |

## 3. Shared components (`packages/web/src/components/`, `composer/`, `diff/`)

| Source | Export(s) | Documented in | Status |
| --- | --- | --- | --- |
| `packages/web/src/components/add-project-dialog.tsx` | AddProjectDialog | components.md §2 AddProjectDialog and CloneProjectDialog | Documented |
| `packages/web/src/components/app-shell-container.tsx` | AppShellContainer | components.md §2 AppShellContainer | Documented |
| `packages/web/src/components/app-shell.tsx` | AppShell | components.md §2 AppShell | Documented with known gap (G-14) |
| `packages/web/src/components/app-shell.tsx` | BrandTile development-build badge (private, #442) | components.md §2 AppShell, Brand tile and development-build badge; decisions.md D-08 | Documented |
| `packages/web/src/components/appearance-provider.tsx` | AppearanceProvider | components.md §2 AppearanceProvider | Not applicable – context only, no markup (components.md §2 AppearanceProvider). |
| `packages/web/src/components/centered-state.tsx` | CenteredState, TwinkleBackdrop | components.md §2 CenteredState and TwinkleBackdrop | Documented with known gap (G-05) |
| `packages/web/src/components/clone-project-dialog.tsx` | CloneProjectDialog | components.md §2 AddProjectDialog and CloneProjectDialog | Documented |
| `packages/web/src/components/code-editor.tsx` | CodeEditor | components.md §2 CodeEditor | Documented |
| `packages/web/src/components/command-palette.tsx` | CommandPalette | components.md §2 CommandPalette | Documented with known gap (G-14) |
| `packages/web/src/components/default-agent-picker.tsx` | DefaultAgentPicker | components.md §2 DefaultAgentPicker | Documented |
| `packages/web/src/components/diff-stat.tsx` | DiffStatLabel | components.md §2 DiffStatLabel | Documented |
| `packages/web/src/components/directional-usage.tsx` | DirectionalUsage | components.md §2 DirectionalUsage | Documented |
| `packages/web/src/components/editable-title.tsx` | EditableTitle | components.md §2 EditableTitle | Documented |
| `packages/web/src/components/engine-pills.tsx` | EnginePills | components.md §2 EnginePills | Documented |
| `packages/web/src/components/facet-filter.tsx` | FacetFilter, ToggleChip, SegmentedControl | components.md §2 FacetFilter, ToggleChip, SegmentedControl | Documented |
| `packages/web/src/components/folder-browser.tsx` | FolderBrowser | components.md §2 FolderBrowser | Documented |
| `packages/web/src/components/ghost-code-backdrop.tsx` | GhostCodeBackdrop | components.md §2 GhostCodeBackdrop and icons | Documented with known gap (G-14) |
| `packages/web/src/components/icons.tsx` | Icons | components.md §2 GhostCodeBackdrop and icons | Documented |
| `packages/web/src/components/last-location-controller.tsx` | LastLocationController | components.md §2 LastLocationController | Not applicable – renders nothing; it stores the last route (components.md §2 LastLocationController). |
| `packages/web/src/components/list-view.tsx` | ListView | components.md §2 ListView | Documented |
| `packages/web/src/components/nav-items.ts` | NavItems | components.md §2 NavItems | Not applicable – data only; the nav item list the sidebar renders (components.md §2 NavItems). |
| `packages/web/src/components/onboarding-offer-container.tsx` | OnboardingOfferContainer | components.md §2 OnboardingOfferRow and OnboardingOfferContainer | Documented |
| `packages/web/src/components/onboarding-offer-row.tsx` | OnboardingOfferRow | components.md §2 OnboardingOfferRow and OnboardingOfferContainer | Documented |
| `packages/web/src/components/open-in-menu.tsx` | OpenInMenu | components.md §2 OpenInMenu | Documented |
| `packages/web/src/components/picker-pill.tsx` | PickerPill, RunnerPill | components.md §2 PickerPill and RunnerPill | Documented with known gap (G-03) |
| `packages/web/src/components/pill.tsx` | Pill | components.md §2 Pill | Documented |
| `packages/web/src/components/pin-toggle.tsx` | PinToggle | components.md §2 PinToggle | Documented |
| `packages/web/src/components/project-groups.tsx` | ProjectGroups | components.md §2 ProjectGroups | Documented with known gap (G-14) |
| `packages/web/src/components/prompt-template-menu.tsx` | PromptTemplateMenu | components.md §2 PromptTemplateMenu | Documented |
| `packages/web/src/components/provider-banner-container.tsx` | ProviderBannerContainer | components.md §2 ProviderBanner and ProviderBannerContainer | Documented |
| `packages/web/src/components/provider-banner.tsx` | ProviderBanner | components.md §2 ProviderBanner and ProviderBannerContainer | Documented |
| `packages/web/src/components/reference-chip.tsx` | ReferenceChip | components.md §2 ReferenceChip | Documented |
| `packages/web/src/components/reference-conflict-action.tsx` | ReferenceConflictAction | components.md §2 ReferenceConflictAction | Documented |
| `packages/web/src/components/reference-status.tsx` | ReferenceStatus registry | components.md §2 ReferenceStatus registry | Not applicable – a registry of status → tone/label; rendered by ReferenceChip (components.md §2 ReferenceStatus registry). |
| `packages/web/src/components/route-error-boundary.tsx` | RouteErrorBoundary | components.md §2 RouteErrorBoundary | Documented |
| `packages/web/src/components/run-diff.tsx` | RunDiff | components.md §2 RunDiff | Documented with known gap (G-09) |
| `packages/web/src/components/run-notifications.tsx` | RunNotifications | components.md §2 RunNotifications | Documented |
| `packages/web/src/components/skill-detail.tsx` | SkillDetail | components.md §2 SkillDetail, SkillEmptyHint, SkillsImportPanel | Documented |
| `packages/web/src/components/skill-empty-hint.tsx` | SkillEmptyHint | components.md §2 SkillDetail, SkillEmptyHint, SkillsImportPanel | Documented |
| `packages/web/src/components/skills-import-panel.tsx` | SkillsImportPanel | components.md §2 SkillDetail, SkillEmptyHint, SkillsImportPanel | Documented |
| `packages/web/src/components/status-dot.tsx` | StatusDot | components.md §2 StatusDot | Documented with known gap (G-08) |
| `packages/web/src/components/tab-link.tsx` | TabLink | components.md §2 TabLink | Documented |
| `packages/web/src/components/task-agent.tsx` | TaskAgent cells | components.md §2 TaskAgent cells | Documented |
| `packages/web/src/components/task-quick-list.tsx` | TaskQuickList | components.md §2 TaskQuickList | Documented |
| `packages/web/src/components/theme-provider.tsx` | ThemeProvider | components.md §2 ThemeProvider and ThemeToggle | Not applicable – context only, no markup (components.md §2 ThemeProvider and ThemeToggle). |
| `packages/web/src/components/theme-toggle.tsx` | ThemeToggle | components.md §2 ThemeProvider and ThemeToggle | Documented |
| `packages/web/src/components/tools-menu.tsx` | ToolsMenu | components.md §2 ToolsMenu | Documented |
| `packages/web/src/components/zoomable-image.tsx` | ZoomableImage | components.md §2 ZoomableImage | Documented |
| `packages/web/src/components/composer/composer.tsx` | Composer | components.md §2 Composer | Documented with known gap (G-21) |
| `packages/web/src/components/composer/composer-attachments.ts` | Composer attachments helpers | components.md §2 Composer | Not applicable – pure helpers for the Composer (components.md §2 Composer). |
| `packages/web/src/components/composer/composer-text.ts` | Composer text helpers | components.md §2 Composer | Not applicable – pure helpers for the Composer (components.md §2 Composer). |
| `packages/web/src/components/composer/dictation.ts` | Composer dictation | components.md §2 Composer | Not applicable – a speech-recognition hook, no markup (components.md §2 Composer). |
| `packages/web/src/components/diff/index.ts` | Diff facade | components.md §2 Diff (facade, engine and helpers) | Not applicable – re-export facade (components.md §2 Diff). |
| `packages/web/src/components/diff/diff.tsx` | Diff | components.md §2 Diff (facade, engine and helpers) | Documented with known gap (G-09) |
| `packages/web/src/components/diff/diff-view.tsx` | DiffView | components.md §2 Diff (facade, engine and helpers) | Documented with known gap (G-09) |
| `packages/web/src/components/diff/image-preview.tsx` | ImagePreview | components.md §2 Diff (facade, engine and helpers) | Documented |
| `packages/web/src/components/diff/diff-scroll.ts` | Diff scroll helper | components.md §2 Diff (facade, engine and helpers) | Not applicable – scroll helper, no markup (components.md §2 Diff). |
| `packages/web/src/components/diff/parse-patch.ts` | parsePatch | components.md §2 Diff (facade, engine and helpers) | Not applicable – patch parser, no markup (components.md §2 Diff). |
| `packages/web/src/components/diff/word-diff.ts` | wordDiff | components.md §2 Diff (facade, engine and helpers) | Not applicable – word-level diff algorithm, no markup (components.md §2 Diff). |
| `packages/web/src/components/diff/types.ts` | Diff types | components.md §2 Diff (facade, engine and helpers) | Not applicable – types only (components.md §2 Diff). |

## 4. Patterns

| Pattern | Documented in | Specimen | Status |
| --- | --- | --- | --- |
| 1. App shell | patterns.md §1 | `specimens/patterns.html` | Documented with known gap (G-14) |
| 2. Sidebar navigation and badges | patterns.md §2 | `specimens/patterns.html` | Documented with known gap (G-14) |
| 3. Page headers | patterns.md §3 | `specimens/patterns.html` | Documented with known gap (G-01) |
| 4. Lists, cards and tables | patterns.md §4 | `specimens/patterns.html` | Documented with known gap (G-02, G-17) |
| 5. Status | patterns.md §5 | `specimens/patterns.html` | Documented with known gap (G-04) |
| 6. Empty, loading and error states | patterns.md §6 | `specimens/patterns.html` | Documented with known gap (G-05, G-08) |
| 7. Dialogs, sheets, command palette, toasts and notifications | patterns.md §7 | `specimens/patterns.html` | Documented with known gap (G-10, G-16) |
| 8. Settings and forms | patterns.md §8 | `specimens/patterns.html` | Documented with known gap (G-11, G-12, G-13, G-22) |
| 9. The mobile drawer | patterns.md §9 | `specimens/patterns.html` | Documented |
| 10. Live updates | patterns.md §10 | `specimens/patterns.html` | Documented |

## 5. Foundations, behaviour and writing

| Area | Documented in | Specimen | Status |
| --- | --- | --- | --- |
| Colour roles | foundations.md §2 | `specimens/foundations.html` | Documented with known gap (G-04) |
| Typography | foundations.md §3 | `specimens/foundations.html` | Documented |
| Spacing and density | foundations.md §4, theming.md | `specimens/foundations.html` | Documented |
| Radius | foundations.md §5 | `specimens/foundations.html` | Documented |
| Shadow | foundations.md §6 | `specimens/foundations.html` | Documented |
| Motion and reduced motion | foundations.md §7, behaviour.md | `specimens/foundations.html` | Documented with known gap (G-06, G-08) |
| Iconography | foundations.md §8 | `specimens/foundations.html` | Documented with known gap (G-19) |
| Layout and reading width | foundations.md §9, theming.md | `specimens/foundations.html` | Documented |
| Breakpoints | foundations.md §10, behaviour.md | – | Documented |
| `no-hover:` | foundations.md §11 | – | Documented with known gap (G-21) |
| Safe areas and the keyboard | foundations.md §12 | – | Documented |
| Base layer (`border-color`, `html`/`body` height and overflow, placeholder, scrollbars) | foundations.md §13 | – | Documented |
| Theming (theme, accent, density, width, pre-paint) | theming.md | every specimen's doc bar | Documented |
| Keyboard, focus and announcements | behaviour.md | `specimens/components.html` | Documented with known gap (G-06) |
| UX writing | writing.md | – | Documented with known gap (G-15, G-16) |
| Number formatting | writing.md | – | Documented with known gap (G-18) |

MCP connection Claude recovery guidance uses Collapsible and a ghost Button, with wrapping text and token colours. Attachment and live status go through the one shared leader control (`mcp-leader-control.tsx`, #403 merged with #404): Claude Code is one row of its client table (`attach: 'direct'`), the status is live over the `mcp-leader` WebSocket topic while the section is on screen, and no client-specific attach action exists. When the server retains an attachment whose client no longer owns the project (a `*-not-owner` blocker), the control shows its client selector again, defaulting to the owner, with one sentence saying that attaching replaces the retained leader.
