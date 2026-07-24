# UI Improvements — admin panel (`public/index.html`)

Structural/higher-risk items from the Playwright review (2026-07-24, screenshots at
1440 / 768 / 375 px). The low-risk fixes from the same review are already applied
(commit `419ede3`): mobile header wrap, inline favicon, aria-labels, keyboard-
operable dropzone. The items below were deliberately NOT changed inline because
they alter the build, the interaction model, or a security surface, and warrant an
explicit decision.

## 1. Tailwind is loaded from a CDN (`cdn.tailwindcss.com`) — STRUCTURAL
- **Evidence:** console warning on every load: *"cdn.tailwindcss.com should not be used in production."*
- **Why it matters here specifically:** the admin panel is served on the Tailscale-bound interface of a self-hosted VPS. A CDN dependency means (a) the panel is unstyled if the box has no outbound internet or the CDN is blocked, and (b) it violates a strict CSP — the same class of self-contained constraint the rest of the deploy respects. It also ships the full JIT compiler to the browser on every load.
- **Fix (build step):** compile Tailwind ahead of time (Tailwind CLI / PostCSS) into a single local `public/app.css`, or inline the ~2 KB of utilities this one page actually uses. Removes the CDN entirely.
- **Risk:** low-medium — needs a tiny build step or a hand-authored stylesheet; must re-verify every screen still matches. Out of scope for an inline low-risk fix.

## 2. Password inputs are not inside a `<form>` — MINOR / a11y
- **Evidence:** two console verbose warnings: *"Password field is not contained in a form."* (the settings-modal API-key inputs).
- **Why:** without a form, password managers and browser autofill behave inconsistently, and there is no native submit/Enter semantics.
- **Fix:** wrap each key section (or the whole modal body) in a `<form onsubmit="return false">` and move the Guardar buttons to `type="submit"`. Behavioral change to the modal, so it is a deliberate edit, not a drive-by.
- **Risk:** low, but it changes the modal's DOM/interaction — decide alongside item 3.

## 3. Admin panel does not expose the cascade profiles or `mode=structured` — FEATURE GAP
- **Evidence:** the panel is the Phase-1 single-engine "Qwen3-VL OCR" UI. It POSTs to the legacy `/api/ocr` (one forced model), not the `/v1` cascade. It offers no profile picker (fast/balanced/quality) and no structured-extraction (schema) affordance shipped in Phase 4.
- **Why it matters:** the product's core value (automatic cascade escalation) and its newest capability (schema-validated JSON) are invisible in the only UI. This is a product-scoped decision, not a bug.
- **Fix:** a follow-up phase — add a profile selector + a "structured" toggle with a schema editor that drives `/v1/ocr` and polls `/v1/jobs/:id`. Also tracked in `PENDING-ISSUES.md` (P4).
- **Risk:** feature work, its own phase.

## 4. Emoji glyphs in the model `<select>` and toggle buttons — COSMETIC / decide
- **Evidence:** the 🚀/⚖️/💎/⚡ engine icons and 👁/⚙ controls render as tofu on systems without an emoji font. (Confirmed only in the headless test environment; a normal desktop OS with an emoji font shows them fine.)
- **Fix (optional):** if the panel must look correct on minimal server-side browsers/kiosks, replace the decorative emoji with inline SVG icons. Otherwise leave as-is — on real client devices they render.
- **Risk:** trivial, but purely cosmetic and environment-dependent; not worth touching without a concrete need.

---

## What the review found healthy (no action)
- Consistent visual language (gray-50 canvas, white cards, blue accent, rounded corners), consistent button styling.
- All interaction states are present and visually distinct: idle/empty (disabled Copiar + "Esperando imagen…"), processing (spinner + "Extrayendo texto con {model}…"), success (green "✓ Listo · N ms" + enabled Copiar), error (red "✗ …").
- Empty-state clarity: the result panel and the settings placeholders ("(usando valor de .env)") read well.
- Layout at 1440 and 768 is clean and well-spaced; the settings modal is centered with a dimmed overlay and click-outside-to-close.
- After the low-risk fixes: 0 console errors, no horizontal overflow at 375, dropzone keyboard-operable.
