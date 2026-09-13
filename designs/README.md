# Designs

UI designs for xezar, one folder per feature: `designs/<feature-name>/`.

Every design folder contains:

- **Static HTML mockups** with their own styles. They must open straight from disk, with no build and no server. Start with `index.html`.
  - A placeholder link, such as a sidebar item, points at the design's own page when one exists. `href="#"` is only for items with no page in the design.
- **A `README.md` handoff document** for developers and the rest of the team. It covers:
  - summary, problem evidence, users and goals / non-goals
  - screens, component specs and every state
  - copy deck
  - developer notes (data, routes, files, tests)
  - accessibility and responsive rules
  - acceptance criteria
  - open decisions, delivery plan, risks and references

Mockups copy the design tokens from `packages/web/src/styles/index.css`. They are references, not shipped code: never import their CSS into the app.

A design is not "done" until it has had a UX/UI design review (`xezar-ux-design`).

| Design | Status |
|---|---|
| [quality-checks](quality-checks/README.md) | Draft – waiting for owner decisions and design review |
