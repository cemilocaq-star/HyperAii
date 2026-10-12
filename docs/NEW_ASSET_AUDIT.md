# NEW ASSET AUDIT

Everything below was measured from the real archives (see `tools/`). Numbers marked UNKNOWN could not be read from the format.
Statuses: INTEGRATED / PARTIAL / ASSET-ONLY / BLOCKED / NOT VERIFIED. **No asset has been verified in a real browser/3D renderer.**

## 0. UPDATE (supersedes the conflicting statements below)
- **RAR extraction is complete.** `tools/rar3ppm.c` (own RAR3 decoder: PPMd var.H, LZ, standard VM filters) + `tools/rar_extract_full.py` extracted all 5 archives:
  **368 files, every file verified against the CRC32 stored in its RAR header** (IronMan.obj `cd8968fb`, IronManRigged.max `ec6f106e`, IronMan.mtl `b2bf590a`;
  explosion 1, john 1, Vader 174, Pilot 189). Root cause of the earlier "Bad RAR file data": system libarchive fails at the PPMd->LZ block switch (output byte 14 909 440)
  and cannot execute VM filters (the `.max` has 1109 DELTA filters). Not supported by the decoder: ITANIUM filter, non-standard VM programs, solid and encrypted archives, RAR5.
  E8/E8E9/RGB/AUDIO filters are implemented but were never exercised by this data (untested).
- **IronMan.obj is complete and valid:** 129 759 vertices, 217 038 triangles, 220 groups, 0 malformed lines, MTL colours (`Kd`) real, no textures. One `usemtl` (`Iron_man_leg:red`) carries a
  Maya namespace prefix; the baker strips it. The model is in a T-pose (width 1.76 for height 1.78 after normalising).
- **Full-body skins are integrated** (code + tests, NOT runtime verified): `skinIronMan`, `skinVader`, `skinPilot` in the existing `skin` slot. Sources are baked by `tools/bake_skin.py` into ONE vertex-coloured mesh
  (~6000 tris, height 1.8, feet y=0). Vader 86/86 and Pilot 154/154 materials were colour-sampled from their JPEG textures (material name == texture file stem held for all 240 materials; the MTL `map_Kd`
  names carry an exporter `_N` suffix). The body model replaces the capsule only in FFA; team/zombie keep the team-coloured capsule. Chaos tints reach the model. **Facing (front = -Z) is estimated from the feet; orientation, scale and pose are NOT verified.**
- **Corrections:** the skeleton.fbx numbers in section 9-12 are the correct ones (33 bones, 2 meshes, 2 animation stacks); the earlier 66/76/5 was wrong.
- **john.max** is an OLE compound file (`Scene` stream ~3 MB, `SummaryInformation`, no preview image); no geometry reader exists here -> BLOCKED. **explosion.c4d** is a Cinema 4D file whose embedded preview
  shows a *volumetric smoke/explosion simulation* with a container box, not a mesh -> it cannot be converted to a mesh format.
- **skeleton.fbx is used as a static skin (`skinSkeleton`), not as a rig.** Real parse: it is an *anatomical human skeleton* (skull, spine, ribs, arms, pelvis, legs; 2 meshes `sub01mesh` 3 928 v / 7 568 tris and `sub02mesh` 1 005 v / 1 855 tris in one shared space, A/T-pose),
  1 Material (DiffuseColor 0.23/0.97/0.85, texture reference missing), 33 `mixamorig:` bones, 2 animation stacks. The "animation" is a pose: 87 curves, 84 with a single key, 3 with 10 keys over 0.3 s -> there is
  no idle/walk/run clip to play, so a skeletal runtime would add nothing the engine's states could use. Geometry was exported by `tools/fbx_static_export.py` and baked with `tools/bake_skin.py` (flat colour, declared `flatColor: true`).
- Tools added: `tools/rar3ppm.c`, `tools/rar_extract_full.py`, `tools/rar_extract.py` (libarchive, with CRC/size checks), `tools/bake_skin.py`, `tools/decimate_obj.py`, `tools/blend_export.py`, `tools/fbx_static_export.py`.
- Tests: `node tests/run.js` = 416/416 PASS (10 consecutive runs); real-ws smoke 15/15; mutation: 115 mutants, 0 survivors, 0 invalid after fixing 1 survivor and 2 stale mutants
  (chunked runs, see the final report). Still NOT covered by committed unit tests: the literal-escape path, PPM-mode VM filters, E8/RGB/AUDIO filters, PPMd<->LZ block switching (verified once by the full-file CRCs only).


## 1. Archive inventory and 2. RAR extraction results
Method: no `unrar`/`7z`/`bsdtar`/network on the build machine, but the system `libarchive.so.13` is present; `tools/rar_extract.py` drives it through
`ctypes` (no rename-to-zip, no guessing). The tool verifies every file against the CRC32 stored in the RAR4 header itself (libarchive does **not**
report a CRC mismatch for stored files; this was found by a failing test).

| Archive | Format | Result | Files |
|---|---|---|---|
| explosion.rar | RAR4 | EXTRACTED, CRC32-verified | 1 (`.c4d`, Cinema 4D) |
| john.rar | RAR4 | EXTRACTED, CRC32-verified | 1 (`john.max`, 3ds Max) |
| starwarsdarthvader.rar | RAR4 | EXTRACTED, CRC32-verified 174/174 | OBJ, MTL, 3DS, 171 JPG |
| Pilot.rar | RAR4 | EXTRACTED, CRC32-verified 189/189 | OBJ, MTL, 3DS, 186 JPG |
| IronMan.rar | RAR4 | ~~PARTIAL~~ **EXTRACTED + CRC-verified (see section 0)** — old note: | MTL ok; `IronMan.obj` decoded 14 680 064 / 16 581 665 bytes then `Bad RAR file data`; `.max` (43 978 752 B) fails with `Parsing filters is unsupported` |

IronMan.obj: the decoded part is **not trustworthy** (malformed vertex lines appear from byte 5 083 346: bytes were lost/garbled). Only libarchive was
available; an own RAR3 decoder (LZ + PPMd + VM filters) was **not attempted**. Remaining real path: re-pack as ZIP/7z, or write that decoder.

## 3-6. Classification (from real structure)
| Asset | Category | Facts |
|---|---|---|
| Vader | FULL CHARACTER, static | OBJ 132 529 v / 100 311 tris, 86 groups = 86 materials = 86 textures (94/171 JPGs are 1x1 flat colour, rest ~1000x600, many duplicates), no skeleton (OBJ) |
| Pilot | FULL CHARACTER, static | OBJ 69 734 tris, 154 groups = 154 materials = 154 textures (~400x250, 2.6 MB), no skeleton |
| IronMan | FULL CHARACTER, static (OBJ) | fully decoded (section 0); source `.max` is named "Rigged" but a `.max` cannot be read here |
| Helmet | HEAD/ACCESSORY candidate | `.blend` 2.79: objects `Head`, `Mask`, `Cylinder.001`; modifiers Mirror + Subsurf (+ Solidify on Mask) |
| Omnitrix | ACCESSORY | OBJ 64 850 tris, 23 objects, 9 materials, no UVs, extents 24 x 7.7 x 24.8 |
| SurvivalKnife | WEAPON (melee) | OBJ 2 816 tris, 1 material, UVs present |
| Grenade | WEAPON (throwable) | OBJ 10 207 tris, 3 of 5 materials used, colour-only |
| Mjolnir | WEAPON/effect (existing logical id) | OBJ 440 324 tris, 48 objects (24 empty) |
| skeleton.fbx | FULL CHARACTER, skeletal | see 9-12 |
| explosion / john | VFX / character | native `.c4d` / `.max`: no runtime reader |

## 7. Materials and 8. Textures (dependency facts)
* Vader/Pilot: MTL says `map_Kd ORANGE1_1.jpg`, disk has `ORANGE1.jpg`. Proven for **all 240 materials**: material name == real JPG stem (exporter added `_N`). Not yet applied.
* Mjolnir: `.obj` references `Hammer_SketchFab.mtl` (absent; zip has `Mjolnir.mtl`); 3 of 4 `usemtl` names are undefined; no textures. **Required MTL dependency is missing.** Neutral metal fallback.
* Knife: only declared texture is an absolute path on the author's PC to an image not in the archive. `KnifeTexture..jpg` is not referenced anywhere -> not bound.
* Omnitrix: MTL has no colour data (all 9 `Kd` = 0.64). Colours come from a NAME-based palette (`green` -> green, rest neutral), a fallback, not asset data.
* Helmet: texture `corroded_metal_texture_by_ketronpl-d6mnkhy.jpg` exists; which mesh uses it (material slots) was not decoded.

## 9-12. skeleton.fbx (binary FBX 7.3), real parse
33 bones, all `mixamorig:` (Hips, Spine, Spine1, Spine2, Neck ...), 2 meshes (`sub01`, `sub02`), 2 geometries, 40 deformers, 2 animation stacks
(`Take 001`, `mixamo.com`), 3 layers, 87 curves, 1 material, 2 texture nodes without file paths. Y-up, 30 fps, no embedded textures.
**Correction:** an earlier note said 66 bones / 76 clusters / 5 animations; that came from double-counting strings and was wrong.

Compatibility root cause (checked in `public/index.html`, `public/animstate.js`): the existing character is **one `CapsuleGeometry`**
(`spawnRemote`) with cosmetic overlay parts. There is no skeleton, no `SkinnedMesh`, no `AnimationMixer`, no FBXLoader. "Animation" =
`deriveMoveState` (idle/walk/run/dash/death; used for footsteps and a vertical bob) + heading smoothing + the Thor/banana knockdown rotation.
Jump/fall/land/sprint/shoot are **not** animation states. There are no bones to map bone-map/clip-map onto, so an adapter has nothing to adapt:
playing this rig would need a second animation runtime, which the project rules forbid. Status: **BLOCKED (architecture)**.

## 13-14. Animation compatibility / profile
No animation-profile abstraction was added: with no model-driven animation consumer it would be unused code. Transitions that cannot be tested
because the states do not exist (jump/fall/land/sprint/shoot) are listed in the report as NOT IMPLEMENTED.

## 15. Licence
Mjolnir: UNKNOWN. Grenade: UNKNOWN. Omnitrix: UNKNOWN (character IP of a third party). Helmet/texture: UNKNOWN. Vader/IronMan: recognisable third-party IP,
no licence file -> **do not treat as free/commercially usable**. Knife: author's ReadMe allows game use, credit appreciated (Jagdoe). Skeleton: UNKNOWN.

## 16. Integration status
| Asset | STATUS | Where |
|---|---|---|
| Mjolnir | INTEGRATED (code), NOT VERIFIED (render); material BLOCKED | `thunderHammer` -> `models/thor/mjolnir.obj` (59 999 tris) |
| Omnitrix | INTEGRATED (code), NOT VERIFIED (render/placement estimated) | cosmetic `accessoryOmnitrix`, `models/accessories/omnitrix/omnitrix.obj` (2 483 tris) |
| Helmet | PARTIAL / ASSET-ONLY | `models/accessories/helmet/helmet.obj` (620 tris, UVs); Subsurf/Solidify NOT applied; not a cosmetic |
| Knife | ASSET-ONLY | `WEAPON_ASSET_STAGING.knife_01` (no melee gameplay exists) |
| Grenade | ASSET-ONLY | `WEAPON_ASSET_STAGING.grenade_01` (no projectile gameplay exists) |
| Vader, Pilot | ASSET-ONLY (not in repo) | extracted + CRC-verified; per-player cost (100k/70k tris, 86/154 draw calls) needs an atlas + UV-preserving decimation first |
| IronMan | INTEGRATED as `skinIronMan` (code), NOT VERIFIED (render) | see section 0 |
| john, explosion | BLOCKED | `.max` / `.c4d` have no web runtime reader and no exporter here |
| skeleton.fbx | INTEGRATED as static `skinSkeleton` (code), NOT VERIFIED (render); rig/animation unused (no usable clips) | see section 0 |

## 17. Chaos candidates
None created: **NOT IMPLEMENTED - no safe existing gameplay integration** (no melee/throwable/VFX/model-skin systems; `banana_weapon` and `thunderHammer` already exist).

## 19-20. Tests / runtime verification
`tests/assets.js` (Mjolnir, staging, Omnitrix, Helmet, RAR tool). Browser, device, 3D, audio: **NOT VERIFIED**.
