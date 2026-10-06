# design/assets/prompts-redesign.md — dbSDK brand regeneration prompts (round 3, palette migration)

Owner: design sub-agent (GLM-5.3-Flash). This file documents the creative direction and exact
production prompts for the redesigned banner + icon. Parent runs built-in imagegen with these
prompts verbatim, then delegates final optimization.

## 1. Why regeneration (context)

Round 2 assets (`design/assets/banner-master.png`, `icon-master.png` → `apps/web/public/brand/`)
use warm paper / ink / electric orange. The user rejected that identity direction and mandated a
new palette (https://coolors.co/palette/780000-c1121f-fdf0d5-003049-669bbc). Old files stay in
place untouched until the new assets exist and are accepted; nothing is overwritten in-place —
new masters land as `-v2` filenames.

Palette mapping from round 2 → round 3:

| Old role | Old value | New value | New role |
|---|---|---|---|
| paper | `#F5EFE3` | `#FDF0D5` | cream backdrop (primary light) |
| ink (primary artwork) | `#191611` | `#003049` | primary navy — forms, mass, structure |
| ink-soft / detail | `#57503F` | `#669BBC` | muted blue — supporting lines, secondary detail |
| accent (single hot) | `#E8541E` | `#C1121F` | red signal accent — one node, sparse highlights |
| — | — | `#780000` | deep maroon — reserved for UI depth/edges, tiny use in art only |

Direction change, not just recolor: round 2 was "engraved ink on paper grain." That reads
vintage/editorial and fights the new modern cream/navy/red UI. Round 3 is **flat modern
geometric poster art**: bold clean shapes, crisp hairline detail, no heavy texture, no ink bleed.
Influence: the opencoredev sister sites (social-sdk.dev, email-sdk.dev, domain-sdk.dev,
sandbox-sdk.app) — flat bold color blocking, asymmetric hero composition, generous negative
space, confident single accent. dbSDK's art must feel like it belongs in that family while
staying unique.

Core visual story (unchanged from round 2, restated): **many connections, one interface.**
A converging tangle of lines resolves into one ordered form; exactly one red signal node marks
the point of unification. Distinctive asymmetry over generic logo symmetry.

## 2. Shared constraints (apply to both prompts)

- No typography of any kind — no letters, numbers, wordmarks, labels, watermarks, corner tags.
- No database cylinders, no generic gradient 3D server/cloud, no glossy 3D render look.
- No heavy texture/grain/noise — the art must sit clean against flat UI color blocks
  (#FDF0D5 sections, #003049 panels). Texture that reads "dirty" on cream is forbidden.
- Exactly one red (#C1121F) accent focal point; muted blue (#669BBC) for supporting detail only;
  navy (#003049) is the primary mass; cream (#FDF0D5) is the backdrop. Deep maroon (#780000)
  at most a whisper (one deep edge or shadow shape), never a second focal color.
- Matte, flat, print-poster finish. Crisp edges. High shape contrast.

## 3. Production prompts (hand to imagegen verbatim)

### 3.1 Banner — target `design/assets/banner-master-v2.png` (then web copy `banner-v2.png`)

```text
Use case: stylized-concept
Asset type: website hero banner for a developer tool (dbSDK), wide landscape 1536x1024 or 2048x1152
Primary request: bold flat modern geometric poster artwork expressing "many connections, one interface": from the lower-right corner, dozens of thin precise conduit lines in muted blue (#669BBC) enter the frame in an irregular asymmetric fan, weaving and converging with growing order into a single bold navy (#003049) geometric plane — a clean abstract slab of parallel horizontal bars, like a stylized table of ordered rows — that occupies the right two-thirds of the frame. Where all lines meet the slab, exactly one small node glows in vivid red (#C1121F), the single focal signal point, with two or three short red line highlights tracing into the convergence. A few lines continue leftward past the slab as a sparse, calm continuation, thinning out quickly.
Scene/backdrop: flat cream background (#FDF0D5), completely matte and clean, with an optional extremely subtle structural touch: one thin navy hairline rule or a small flat navy geometric cutout shape in the upper-left, nothing busy
Subject: converging asymmetric line-to-plane composition; abstract, architectural, confident; no literal database iconography
Style/medium: flat vector poster illustration, modern Swiss-geometric meets technical schematic; crisp hairline strokes, bold solid shapes, matte print finish
Composition/framing: strong asymmetry — all visual mass in the lower-right two-thirds; the entire left third and upper-left quadrant kept as clean empty cream negative space for typeset headline text; banner must crop safely to a 4:5 or square mobile crop with the convergence node still visible
Lighting/mood: flat and even, zero glow except a small restrained red halo on the single red node
Color palette: cream #FDF0D5 (backdrop), navy #003049 (primary slab and key forms), muted blue #669BBC (conduit lines, secondary detail), red #C1121F (one node plus 2-3 short highlights only), deep maroon #780000 at most as one subtle edge or shadow on the navy slab
Materials/textures: none — flat clean fills, no grain, no noise, no ink bleed
Text (verbatim): none — absolutely no letters, numbers, wordmarks, labels, or corner tags anywhere
Avoid: database cylinders, stacked discs, generic gradient 3D server or cloud shapes, glossy 3D renders, neon synthwave, photoreal hardware, watermarks, logos, text, heavy paper texture
```

Generation notes: one imagegen call; request the largest wide size available (2048x1152 preferred,
1536x1024 acceptable). No baked text — the site typesets "dbSDK" in the left negative space.

### 3.2 Icon — target `design/assets/icon-master-v2.png` (then web copy `icon-v2.png`)

```text
Use case: logo-brand
Asset type: square app/favicon/social mark for dbSDK, 1024x1024
Primary request: a distinctive abstract mark for "dbSDK" built from one bold idea — many lines, one node: a solid navy (#003049) rounded square tile with a bold cream (#FDF0D5) cutout glyph inside; the glyph is an asymmetric converging geometry — four clean conduit lines entering from different edges (three from the left/bottom in cream, one from the top-right in muted blue #669BBC) all meeting at a single small vivid red (#C1121F) circular node placed slightly off-center, with a short bold cream wedge or bar extending from the node toward the lower-right, suggesting a unified result. The mark is asymmetric on purpose and instantly recognizable at 16px and at 512px.
Scene/backdrop: genuinely transparent background (alpha channel) — the rounded tile floats as a cutout; if true transparency is impossible, render the tile on flat cream #FDF0D5 and say so in output metadata
Subject: abstract geometric connection mark; NOT a literal database icon, NOT a letter
Style/medium: flat vector precision, bold solid shapes, matte finish, high shape contrast
Composition/framing: rounded-square tile centered with ~12% clear margin on all sides for safe circular cropping; glyph strokes no thinner than ~4% of canvas width so the mark survives 16px
Lighting/mood: flat, even, no glow
Color palette: navy #003049 tile, cream #FDF0D5 primary glyph lines and wedge, muted blue #669BBC one secondary line, red #C1121F the single node; no maroon, no gradients
Materials/textures: none — flat clean fills only
Text (verbatim): none — no letters, numbers, or wordmark
Avoid: database cylinders, cloud shapes, gradient blobs, gloss, bevel, 3D effects, drop shadows, text, watermarks
```

Generation notes: one imagegen call; explicitly request transparency and preserve alpha. If the
model cannot emit true alpha (record actual result in the manifest, `alpha: true/false`), the
flat-cream-tile fallback is acceptable because the mark itself is a self-contained tile.

### 3.3 Optional edit-variant (only if parent prefers retaining round 2 composition)

If keeping the round 2 composition helps continuity, this is the explicit edit prompt:

```text
Edit design/assets/banner-master.png: keep the exact composition (tangle of lines entering from lower right resolving into one ordered grid plane, one accent node, clean left-third negative space) and change only the colors and finish: warm paper #F5EFE3 becomes cream #FDF0D5, engraved ink #191611 becomes navy #003049, soft detail strokes become muted blue #669BBC, the electric orange accent #E8541E becomes red #C1121F, and remove all paper grain and ink-bleed texture, replacing it with flat clean matte fills and crisp edges. Everything else identical.
```

Recommendation: prefer the fresh 3.1/3.2 prompts. The recolor route keeps the vintage engraved
feel that the user rejected; only the geometry would survive, not the direction.

## 4. Post-generation handoff (for parent / optimization agent)

1. Inspect both masters via `tools.browser.preview`. Checklist: zero text artifacts; banner left
   third genuinely clean; convergence node visible in a square crop of the banner center-right;
   icon legible at 32px and 16px; alpha real (or recorded as false); exactly one red focal point;
   no texture noise; no cylinders/clouds/3D gloss.
2. If a check fails, re-run imagegen with the same prompt plus a targeted correction clause —
   do not hand-edit content outside imagegen.
3. Optimization (resize/webp/favicons) may be local (sips/cwebp) — content untouched. Suggested
   final web filenames, keeping round 2 files intact until swap: `banner-v2.png`, `banner-v2.webp`,
   `banner-v2-1280.webp`, `banner-v2-768.webp`, `icon-v2.png`, `icon-v2.webp`,
   `icon-v2-512/192/32/16.png`, with `manifest.json` updated to version 2 once accepted.
4. Record model, mode, sizes, and verdicts in this file under §5.

## 5. Generation log (fill after imagegen runs)

- Banner: built-in imagegen, stylized-concept mode per §3.1 verbatim, source
  `/Users/preetham/.codex/generated_images/01a10f25-42cb-76b0-aebd-40ec72fd7d66/exec-54586934-2f6a-4034-87ee-3c7ba349f577.png`,
  1536x1024 RGB (no alpha). **PASS with one note.** Forensics (stdlib PNG decode,
  `design/assets/analyze-banner.py`): no baked text; left third 99.95% clean cream; mean
  luminance gradient 0.48/255 in a flat region (no noise/texture); palette cream 81.82%,
  navy 14.23%, blue 1.02%, blends 2.93%; zero green; single red node at (0.64, 0.37) of
  frame, safely visible in 4:5 and square crops. Note: rendered node red is #E44039
  (228,64,57), brighter than mandated #C1121F. Shipped as usable; optional imagegen edit
  can darken the node to exact palette if the parent wants strict fidelity. Not a blocker.
- Icon: built-in imagegen, logo-brand mode per §3.2 verbatim, source
  `/Users/preetham/.codex/generated_images/01a10f25-42cb-76b0-aebd-40ec72fd7d66/exec-e7719bf5-4640-425f-9b8e-775dfccdd4e0.png`,
  1254x1254 RGBA, **alpha true**. **FAIL: do not certify, do not publish.** Forensics
  (`design/assets/analyze-icon.py`, `probe-holes.py`): the black/transparent blemishes the
  parent saw are REAL damaged alpha, not display artifacts — ~4,666 fully transparent pixels
  plus semi-transparent blotches (alpha 9-200, runs 50-90px wide) INSIDE the navy tile,
  surrounded on all sides by navy: right side x[980..1044] y[419..456] and y[609..660],
  lower-left x[381..496] y[773..815] and y[1028..1044]. Also 62 green pixels at alpha 1-10
  (max 4% opacity, practically invisible) on the tile edge, top color pure (0,255,0).
  Everything else is sound: corners transparent at 12% margin, palette otherwise pure
  (navy 73.67%, cream 18.64%, blue 5.50%, red 1.61%), zero dark/black color pixels.
  16/32px legibility not certified while tile fill is damaged.
- Icon correction: parent should run imagegen edit mode with
  `design/assets/icon-edit-prompt-v2.txt` against `design/assets/icon-master-v2.png`.
  New master lands as `design/assets/icon-master-v2-fixed.png`; design agent then re-verifies
  (same forensic scripts) and only then publishes `/brand/icon-v2.*` + flips manifest status.
- Optimization round: banner published as `/brand/banner-v2.png`, `banner-v2.webp` (66,628 B),
  `banner-v2-1280.webp` (1280x853, 45,236 B), `banner-v2-768.webp` (768x512, 20,934 B);
  masters archived as `design/assets/*-v2.png`; round 2 files untouched. Manifest v2 at
  `apps/web/public/brand/manifest-v2.json` (banner final, icon provisional with evidence).
- Verdicts per §4 checklist: banner PASS (red-hue note above); icon FAIL on interior alpha
  damage, pending one imagegen edit.

## 6. Round 4-5 log (opaque fallback resolves the icon)

- Round 4, icon edit: parent ran imagegen edit mode with `icon-edit-prompt-v2.txt` on
  `icon-master-v2.png`; output `icon-master-v2-fixed.png` (1254x1254, 876,774 B, hasAlpha).
  **FAIL again**: right-side holes gone, lower-left blotch remained (2,414 interior
  transparent holes, largest clusters n=918 at x[435..474] y[769..810] and n=776 at
  x[408..447] y[983..1010], plus ~28,264 semi-transparent interior pixels, alpha 0-224).
  Never published. Transparency route declared exhausted (two damaged outputs).
- Round 5, icon opaque fallback: fresh generation, built-in imagegen,
  `transparent_background=false`, prompt `icon-opaque-prompt-v2.txt` verbatim, no input
  image. Source `/Users/preetham/.codex/generated_images/01a10f25-42cb-76b0-aebd-40ec72fd7d66/exec-eb8aa40d-c0d1-495f-bd30-b30ec9eb04c9.png`
  (1254x1254 RGB, 932,717 B). Copied byte-identical (cmp) to
  `design/assets/icon-master-v2-opaque.png`. **PASS.** Simple check per mandate: PNG
  colortype 2 (8-bit truecolor), no alpha channel, no tRNS chunk, so interior alpha holes
  are structurally impossible; visual inspection clean (flat navy tile on uniform cream,
  cream converging glyph, one muted-blue line, single red node, no blotches); 32px glyph
  clear, 16px recognizable navy mark.
- Published (sips resize / cwebp 1.6.0 q85, no content edits): `/brand/icon-v2.png`
  (1254x1254, 932,717 B), `/brand/icon-v2.webp` (19,104 B), `/brand/icon-v2-512.webp`
  (6,044 B), favicons `/brand/icon-v2-512.png` (233,592 B), `/brand/icon-v2-192.png`
  (30,814 B), `/brand/icon-v2-32.png` (1,470 B), `/brand/icon-v2-16.png` (691 B).
- Manifest: `apps/web/public/brand/manifest-v2.json` icon status flipped to final, alpha
  honestly recorded as false (opaque cream background), full provenance added. Round 2
  rejected assets archived to `design/assets/rejected-round2/`; `/brand` is v2-only.
- Final verdicts: banner v2 PASS, icon v2 PASS (opaque route). No open brand blockers.
