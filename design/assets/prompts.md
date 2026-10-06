# design/assets/prompts.md — dbSDK brand asset generation log

Brand: **dbSDK** (lowercase "db", uppercase "SDK").
Generated: 2026-10-06. All artwork original; no reference images fed in; no stock or third-party assets.

## Mode actually used

- Skill: `imagegen` — **built-in `image_gen` tool** (the skill's preferred default mode; no `OPENAI_API_KEY` needed).
- Executor: parent orchestrator ran the two `image_gen` calls itself (OpenCode harness lacks the tool in delegated sessions); prompts below were authored by the design agent and executed **verbatim, no edits, no fallback**.
- Output delivered as PNGs in `~/.codex/generated_images/`; copied into owned workspace paths unchanged.

## 4.1 Banner — `banner.png`

```text
Use case: stylized-concept
Asset type: website hero banner for a developer tool (dbSDK), wide landscape 2048x1152
Primary request: a bespoke abstract artwork of database connections: a dense tangle of thin engraved ink lines and braided conduit strands entering from the lower right, resolving leftward into one calm, perfectly ordered grid plane — a sculptural "many connections, one interface" composition. The tangle should feel architectural and hand-drafted (cut-paper / engraved-ink editorial illustration), like a technical drawing come alive, with one small node in the ordered grid glowing in a single electric accent color.
Scene/backdrop: flat warm paper background (#F5EFE3) with subtle paper grain; faint blueprint-style grid of dotted construction lines
Subject: converging connection sculpture (lines, conduits, small terminal nodes, one accent node)
Style/medium: editorial engraved-ink illustration with layered cut-paper depth; matte, print-like
Composition/framing: wide cinematic band; all visual mass in the lower-right two-thirds; generous clean negative space across the left third and upper-left quadrant for typeset headline text
Lighting/mood: even, matte, no glow except a restrained warm halo on the single accent node (#E8541E)
Color palette: warm paper #F5EFE3, deep paper #E9E0CD, ink #191611, ink-soft #57503F, one electric accent #E8541E used sparingly (one node, two or three short line highlights)
Materials/textures: paper grain, fine hairline engraving strokes, slight ink bleed
Text (verbatim): none — absolutely no letters, numbers, wordmarks, or labels anywhere
Constraints: no text; keep left third and upper-left quadrant essentially empty for typography; abstract, elegant, engineering-blueprint feel
Avoid: stacked database cylinders, gradient blobs, generic SaaS cloud icons, neon synthwave glow, photorealistic hardware, servers/racks, 3D render gloss, watermarks, logos
```

Result: `design/assets/banner-master.png` (archival) / `apps/web/public/brand/banner.png` — **1672×941, 8-bit RGB, opaque** (16:9 aspect; model did not honor an explicit 2048×1152 request, 1672×941 is what the tool produced). No text baked in. Warm-paper engraved-ink connection tangle lower-right, ordered grid left, single orange accent node.

## 4.2 Icon — `icon.png`

```text
Use case: logo-brand
Asset type: square app/social/favicon mark for dbSDK, 1024x1024
Primary request: a distinct abstract mark for "dbSDK": a bold ink rounded-square keyline tile containing an abstract "unified connection" geometry — two interlocking rounded bracket forms (suggesting a database partition being unified) joined at a single small electric-orange node, with three thin conduit lines entering the node from different directions. Reads instantly at 16px and at 512px.
Scene/backdrop: none — genuinely transparent background (alpha channel), the mark floats as a cutout
Subject: abstract geometric mark as described; NOT a literal database icon
Style/medium: flat vector-like precision shapes with slight paper-grain ink texture; matte print feel
Composition/framing: mark centered with ~12% clear margin on all sides for safe circular cropping
Color palette: ink #191611 forms on transparent, single accent node + one short conduit highlight in #E8541E; optional #E9E0CD secondary fill inside one bracket
Materials/textures: flat matte, hairline precision, minimal
Text (verbatim): none — no letters, no wordmark
Constraints: transparent background requested explicitly; must survive being viewed at 16px (favicon) — high shape contrast, no thin fragile strokes below ~3% of canvas width
Avoid: stacked cylinders, cloud shapes, gradient blobs, gloss/bevel/3D effects, text, watermarks
```

Result: `design/assets/icon-master.png` (archival) / `apps/web/public/brand/icon.png` — **1254×1254, 8-bit RGBA** (again, tool's own size, not 1024×1024). **True alpha confirmed programmatically**: ~49.9% of pixels fully transparent, ink body ~49.2% at α≈252, negligible AA fringe. Opaque ink mean RGB (26,22,15) ≈ specified ink #191611.

## Derived variants (resize/convert only — sips + cwebp, no content editing)

| File | Size | Bytes | Encoder |
|---|---|---|---|
| banner.webp | 1672×941 | 217,920 | cwebp q85 |
| banner-1280.webp | 1280×720 | 109,114 | sips -Z 1280 → cwebp q85 |
| banner-768.webp | 768×432 | 41,490 | sips -Z 768 → cwebp q85 |
| icon.webp | 1254×1254 | 104,958 | cwebp `-preset icon q92 alpha_q 100` (alpha verified preserved post-encode) |
| icon-512.png | 512×512 | 202,232 | sips -Z 512 |
| icon-192.png | 192×192 | 32,136 | sips -Z 192 |
| icon-32.png | 32×32 | 2,039 | sips -Z 32 |
| icon-16.png | 16×16 | 817 | sips -Z 16 |

Note: lossless icon.webp was 690 KB; `-preset icon q92 alpha_q 100` cut it to 105 KB with alpha distribution decoded identical to source (46.7% fully transparent / 49.7% opaque ≥128), so the lossy-preset encode was chosen.

## Provenance

- Banner source: `~/.codex/generated_images/01a10f25-42cb-76b0-aebd-40ec72fd7d66/exec-5b278649-716c-4feb-aa79-33d88db121dd.png`
- Icon source: `~/.codex/generated_images/01a10f25-42cb-76b0-aebd-40ec72fd7d66/exec-40b93881-5c2f-45ef-a348-1d73248880c6.png`
- Masters copied byte-identical into `design/assets/` and `apps/web/public/brand/` (web copies are the served masters).
- Manifest with actual dimensions/alpha/bytes: `apps/web/public/brand/manifest.json`.

## Inspection notes (visual + programmatic)

- Banner: negative space in left third / upper-left quadrant is clear for typeset headline; accent orange used sparingly; matte paper feel; no baked text, no cliché elements observed.
- Icon: legible at 32px and 16px downscale (dark rounded-square keyline + orange accent retains shape contrast); corners transparent so safe for circular crop.
- Mobile crop check: banner-768.webp keeps the composition readable; headline negative space survives the crop-safe 768 thumb.
