# Rules for new designs

A feature design lives in `designs/<feature>/` (convention in [designs/README.md](../../designs/README.md)):
static HTML mockups plus a `README.md` handoff. This page says how such a mockup uses the design system.

## 1. Link the shared stylesheet

Every mockup page links `docs/design-system/cockpit.css` by relative path, before its own stylesheet:

```html
<link rel="stylesheet" href="../../docs/design-system/cockpit.css">
<link rel="stylesheet" href="styles.css">
<script src="theme.js"></script>
```

`cockpit.css` carries the tokens for both themes, the appearance attributes and the base component
classes. It resolves the cockpit's own font files, so a mockup opened from disk renders in Inter and
JetBrains Mono. The drift test keeps its token values identical to `index.css`.

## 2. Keep the local stylesheet feature-specific

`designs/<feature>/styles.css` holds only what the feature adds: its new surfaces, its states, its
responsive overrides. It MUST NOT:

- redeclare a token (`--card`, `--radius`, …) or add a fake one; use `var(--name)` from the sheet;
- copy a base class (`.btn`, `.pill`, `.dot`, `.nav`, `.page-head`, `.dialog`, …); extend it with a
  feature class instead (`.check-card`, `.rule-strip`);
- contain a raw hex colour. The only hex in the repository's UI lives in `index.css`.

If a mockup needs a look the shared sheet does not have and the cockpit does, add the class to
`cockpit.css` with the cockpit's values and a source comment. If the cockpit does not have it either, it
is a new component: put it in the local sheet and call it out in the README as a proposal.

## 3. Use the grammar, not a new one

- Reuse the components in [components.md](components.md) and the patterns in [patterns.md](patterns.md)
  by name in the README ("uses `CenteredState tone="danger"`", "a `Pill` with `dot="danger"`").
- Status colour lives in the dot. A red or violet fill on a chip is a new grammar and needs a decision.
- Words carry the meaning; colour and icons reinforce. Every state has its own sentence.
- Copy follows [writing.md](writing.md): sentence case, `…`, ` — `, no Oxford comma, `xezar` lower case.
- Nav badges are violet. A badge in another colour is a decision the design review owns (the
  quality-checks design proposes a red one and says so).

## 4. Show every state

A mockup is not done until it shows: default, empty, loading, error, refusal (hosted mode 409), and
the phone layout (375 px; the specimen phone frame is 390 px wide). The `states.html` page in `designs/quality-checks/` is the model.

## 5. Behave under every appearance

Use the theme switch (`theme.js`) on every page. Check the page with `.light`, with
`data-accent="violet"` and at `data-density="ultra"` on `<html>` (the specimen pages have controls for
all four; a mockup only needs the light/dark toggle, the rest can be set in devtools).

## 6. Mobile

- No horizontal scroll at 375 px. Tables get `.table-scroll` or reflow to cards.
- 44px touch targets on phone.
- The desktop page header hides below `md`; a mobile top bar names the page.

## 7. Accessibility

The bar is in `.xezar/skills/xezar-ux-design.md`, point 7. In the mockup: real `<button>`s and `<a>`s,
`aria-current="page"` on the active nav item, `aria-label` on icon-only controls, `sr-only` text for a
count a badge shows in colour, and `role="status"` on anything that announces.

## 8. Handoff

The README names, for each new surface, the components it reuses and the files a developer will touch,
and it lists every place the design departs from this design system as an open decision. It ends with
a `## Design review` section that reads "Pending" until the review lands. Then the `design-review`
workflow (or a human design reviewer) reviews it and posts a `## Design review` comment on the PR; the
README's own `## Design review` section links that comment with every finding's disposition, and
`designs/README.md` moves the row to Approved (SDLC.md § The design gate). The lifecycle of a design
folder, from Draft to Archived, is in `designs/README.md` § Lifecycle.

## 9. Specimens are the reference

`docs/design-system/specimens/` shows every token, component and pattern with its states, on the same
stylesheet. When a mockup and a specimen disagree, the specimen wins unless the README says why.
