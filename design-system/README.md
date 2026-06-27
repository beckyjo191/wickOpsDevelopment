# WickOps — Claude Design bundle

Self-contained preview cards of the WickOps design system, ready to push to a
[claude.ai/design](https://claude.ai/design) project for a design review.

Tokens are extracted from [`src/index.css`](../src/index.css) and component styles
from [`src/App.css`](../src/App.css). Each `.html` is **standalone** (tokens inlined)
and shows the component in **light + dark** side by side. The first line of each file
is a `<!-- @dsCard group="…" -->` marker so the Design System pane indexes it
automatically.

## Cards

| File | Group | Covers |
|------|-------|--------|
| `foundations/colors.html` | Foundations | Brand, status, surfaces, text, borders |
| `foundations/typography.html` | Foundations | Inter type scale (incl. dense table step) + radii |
| `components/buttons.html` | Components | primary / secondary / ghost / danger, sm, states |
| `components/forms.html` | Components | input / select / label, compact `field--sm`, focus & error |
| `components/badges.html` | Components | neutral / primary / success / warning / danger |
| `components/cards.html` | Components | app-card, dash-module-card, empty-state |
| `components/alerts.html` | Components | danger / warning / caution / info alert cards |
| `components/dialog.html` | Components | confirm dialog (overlay + action pair) |
| `components/plan-card.html` | Components | pricing tiers, default & highlighted |
| `components/table.html` | Components | inventory table: header, zebra, hover, selected |

`_shared.css` is the documented token + component source of truth (not required by the
standalone previews).

## Fidelity note

Every token in these cards is copied verbatim from `src/index.css` for both themes,
including the dark status surfaces/borders (`--danger-surface: #2D1515` /
`--danger-border: #7F1D1D`, and the warning/caution/success/notice equivalents) — the
app fully defines its dark theme, so the cards match the running UI.

## Pushing to Claude Design

`/login` is unavailable in the current session (it was launched with a
`CLAUDE_CODE_OAUTH_TOKEN`, which can't carry design scopes). Push from a plain terminal:

1. `cd /Users/bekahwick/wickOpsDevelopment`
2. `claude`
3. `/login` → sign in with the claude.ai account (wickopsmanager@gmail.com)
4. Ask it to create a Claude Design project named **WickOps** and push `design-system/`,
   or run the `/design-sync` skill pointed at this folder.

The push (via the DesignSync tool) will: `create_project` → `finalize_plan`
(writes `design-system/**`) → `write_files`.
