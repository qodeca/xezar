# Designs

UI designs for xezar, one folder per feature: `designs/<feature-name>/`.

Every design folder contains:

- **Static HTML mockups** on the shared design-system stylesheet plus a feature-specific `styles.css`. They must open straight from disk, with no build and no server. Start with `index.html`.
  - A placeholder link, such as a sidebar item, points at the design's own page when one exists. `href="#"` is only for items with no page in the design.
- **A `README.md` handoff document** for developers and the rest of the team. It covers:
  - summary, problem evidence, users and goals / non-goals
  - screens, component specs and every state
  - copy deck
  - developer notes (data, routes, files, tests)
  - accessibility and responsive rules
  - acceptance criteria
  - open decisions, delivery plan, risks and references

Mockups follow the design system in [`docs/design-system/`](../docs/design-system/README.md) – read it first. Every page links the shared stylesheet `docs/design-system/cockpit.css` by relative path (`../../docs/design-system/cockpit.css`), which carries the cockpit's tokens for both themes and the base component classes; the design's own `styles.css` holds only feature-specific rules and never redeclares a token or a base class. The rules are in [`docs/design-system/new-designs.md`](../docs/design-system/new-designs.md). Mockups are references, not shipped code: never import their CSS into the app.

A design is not "done" until it has had a UX/UI design review (`xezar-ux-design`).

| Design | Status |
|---|---|
| [quality-checks](quality-checks/README.md) | Draft – waiting for owner decisions and design review |
