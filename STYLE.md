# Styling MDCopia

The site uses one stylesheet: `css/style.css`. It's organized into 12 numbered sections; jump to the comment block for the area you want to change.

## Quick wins

Almost every visual change can be made by editing the **theme tokens** at the top of `css/style.css` (`:root { ... }`). Edit one number, every page updates.

| Want to change | Edit |
|---|---|
| Royal blue brand color | `--royal-blue`, `--royal-blue-deep`, `--royal-blue-light`, `--royal-blue-pale` |
| Gold accent | `--gold`, `--gold-light`, `--gold-pale` |
| Body font size everywhere | `body { font-size: 18px }` (line 56-ish) and `--font-body` for the family |
| Hero brand size | `.hero__brand { font-size: 72px }` (in §9) |
| Logo word colors (MD vs Copia) | `.hero__brand .md` / `.copia` and `.nav__logo .md` / `.c` |
| Max content width | `--max-content` |
| Tap target / button minimum height | `--tap-min`, `--input-h` |
| Border radius | `--radius`, `--radius-card` |

## Switching brand colors

To experiment, change just these three values and reload:

```css
--royal-blue:       #1B3A6B;  /* primary */
--royal-blue-deep:  #0F2647;  /* hover */
--gold:             #C5A55A;  /* accent */
```

Everything that uses `var(--royal-blue)` or `var(--gold)` updates automatically — buttons, nav underlines, the hero logo, the gold rule, the loading bar, the password gate, focus rings.

## Switching fonts

Edit the `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?...">` line in each HTML page (or `index.html` only if you're testing). Then update the three font-family tokens:

```css
--font-display: "Playfair Display", Georgia, serif;
--font-body:    "Source Sans 3", "Segoe UI", system-ui, sans-serif;
--font-mono:    "Courier Prime", "Courier New", monospace;
```

Recommended pairs to try:
- **Crimson Pro + Inter** — slightly warmer serif + a tighter sans
- **Cormorant Garamond + IBM Plex Sans** — more classical
- **Fraunces + Manrope** — modern revival

## Section map of `style.css`

```
1  Theme tokens         — every reusable color/size/font lives here
2  Reset + base         — body defaults; the gate visibility hook lives here
3  Typography           — h1/h2/h3 sizes, .lead, .section-rule
4  Layout               — .page, .section, .section-inner
5  Navigation + footer  — fixed top nav + mobile hamburger + footer
6  Buttons              — .btn .btn--primary / .btn--secondary / .btn--block
7  Forms                — .field labels + inputs + helper text
8  Cards                — .card, .card--blue, .card--quote, .valuation-card
9  Page-specific        — hero, promise band, why, privacy, verify, success
10 Password gate        — overlay #mdcopia-gate
11 Utilities            — .hidden, .center, focus-visible
12 Responsive           — single 768px breakpoint, mobile-first overrides
```

## Live editing in the browser

While the dev server is running (`python -m http.server 8000` from the repo root), open any page and edit `css/style.css` — refresh the page to see changes.

Open DevTools → Elements → click any element → modify CSS in the right panel to test in real time. Once you've found a value you like, copy it back into `style.css`.

## Where new things go

- **Reusable component** (button variant, alert box): add to `style.css` in the appropriate section, name with the `.component__element--modifier` BEM-ish convention used here.
- **One-page-only style**: add it to a `<style>` block at the top of that page's HTML head. Don't pollute `style.css` with one-off rules.
- **Theme variant** (e.g., dark mode later): add a `[data-theme="dark"]` block right under `:root` that overrides the same tokens.

## Don't

- Don't add CSS frameworks (Tailwind, Bootstrap). They'll fight every value in `:root`.
- Don't add hover-only behaviors. Site users include physicians on iPads — touch first.
- Don't shrink body text below 16px. Per spec, primary users are 50–70 years old.
- Don't change `body { visibility: hidden }` — the password gate depends on it.
