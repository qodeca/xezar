### 2026-09-20 — Projects screenshot caption reconciliation

- The 375 px Projects capture still shows G-30: registered-project columns extend beyond the right edge. Retained this useful before-picture and corrected the manifest caption; the capture harness regenerated its README and three Projects PNGs.
- NB-1 visual re-check: 30 readable desktop PNG footers and all 13 tour frames show v0.16.0. The two Roomy desktop footers truncate to v0…; they cannot establish the full version visually. The existing rewrite derives the version from the 0.16.0 folder, so no stale-version re-capture was needed.
- Filtering the capture to settings-projects and the generated index leaves Tags empty: the storefront tag is added by the separate all-tasks scenario. The new pictures also show the current fixture registration date. No fixture or product change was made.
- Focused screenshot and design-system drift guards passed (49 tests), as did npm run typecheck. Canonical gates and independent design review remain subsequent stages.
- The full unfiltered capture run also changed `tour.gif` (13 → 14 frames) and `automations-dark-1280.png`, because live-stream sampling varies between runs; both were excluded from this PR by leader adjudication.
