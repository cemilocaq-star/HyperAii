# Phase 3 — optimization validation, resource lifecycle, asset recovery, LOD/impostor/occlusion decisions

Environment of every statement below: Node + offline stubs (+ real `ws` loopback for the smoke test). **No browser, GPU or phone.**
Anything that needs a renderer is marked NOT VERIFIED. Numbers marked "static" are counted from files/code, not measured at runtime.

## 1. Resource lifecycle (changed code: `public/index.html`, `server.js`)

| Resource | Owner | Released when | Verified how |
|---|---|---|---|
| Shared OBJ geometry (skins, Grenade) | `objCache` entry (`loadObjShared`) | **last** registered clone is disposed (reference count), exactly once | `tests/sharedobj.js` (15 tests, stubs) |
| Clone root of a shared model | the consumer (player body, view item, bomb prototype) | `disposeObject3D` → `releaseSharedObj` (WeakMap registry, double release ignored) | same |
| Materials of shared-model clones | each consumer (always replaced/cloned) | with the consumer's `disposeObject3D` | same |
| Thrown bombs | copies of the prototype via `Object3D.clone` — NOT registered, take no reference; rely on the prototype (never disposed) | geometry is never freed by a bomb | same |
| View-weapon metal texture | the page (`getViewMetalTexture`, ONE canvas texture) | never (maps are not disposed by `disposeObject3D`) | `tests/weaponlife.js` |
| View-weapon geometry + material | the weapon wrapper (private parse) | when it is replaced by another weapon, same synchronous step as the swap | `tests/weaponlife.js` |
| Placeholder gun boxes | `initScene` | freed at the first real weapon swap | `tests/weaponlife.js` |

Problems found and fixed in this phase
1. `loadRealWeapon` removed the old weapon / placeholder without disposing them (private geometry + material kept until page unload) and created a new `CanvasTexture` on every load. → fixed (table above). An empty parsed file or extra meshes in a file no longer leak either.
2. `loadObjShared` never freed anything. → reference counted. Found while designing it: a consumer that disposes **inside its own callback** (stale-load guard) could free the model under the other waiters; all clones are now taken before any consumer runs.
3. Interest management (server): a token that left the room and came back with an *unchanged* meta signature was sent position-only entries; the client had already dropped it on the roster and would ignore them for up to ~4 s. → the per-socket "already told" map now forgets players that are gone.
4. Scope check, not a bug: leaving a room does `location.reload()` (client), so no client resource can survive a room change; server rooms keep their own state (`room.players`, `room.interestEpoch`) and per-socket interest state lives in a `WeakMap` keyed by the socket.

Not changed on purpose: weapons keep a private parse per switch (≈100 KB OBJ each); sharing them through `loadObjShared` would need an ownership change in the 13 weapon structure tests for no measured gain.

## 2. LOD / impostor / occlusion / instancing — decisions (static numbers)

Scene load, counted from the files and `scatterPlan` (8 seeds each):
* forest decor: **74 instances, 7.0–7.6 k triangles, ≤148 primitive draw calls** before frustum culling (16 distinct models).
* house decor: **58 instances, 5.7–7.0 k triangles, 156–187 primitive draw calls** before frustum culling (17 distinct models).
* biggest decor model: 320 triangles; no decor GLB has skins/animations (0 of 36).
* remote player body: ≈6 k triangles each, room maximum 12 players → ≤ ~66 k triangles for 11 remote skins (upper bound).
* biggest single objects: `mjolnir.obj` ≈60 k triangles (Thor event only), `Grenade.obj` ≈10 k triangles per thrown bomb.
* Map walls/obstacles and effects are not in these counts.

| Technique | Object count / load | Estimated saving | Extra cost / risk | Measurable here? | Decision |
|---|---|---|---|---|---|
| Mesh LOD for decor | avg ≈100 tris per instance | negligible (a few k tris in total) | per-frame distance logic, popping | no | **Not implemented** |
| Mesh LOD for skins | 6 k tris × ≤11 | ≤ ~40 k tris at most, only far players | needs decimated assets that cannot be visually checked here; silhouette risk | no | **Not implemented** (candidate only if a device shows GPU-bound frames with 8+ skinned players) |
| LOD for Mjolnir (60 k) | 1 object, during the Thor event only | unknown | decimation + visual check | no | **Not implemented**; first candidate if a device stutters during Thor |
| LOD for thrown bombs (10 k each) | few at a time, 0.24 units tall | small | proxy asset + visual check | no | **Not implemented**; geometry upload per throw was already removed by sharing |
| Billboard impostors for trees | 16 trees × 78–204 tris | ≤ ~3 k tris | alpha overdraw, orientation/popping, new shader/texture path | no | **Not implemented**; no real candidate (forbidden for gameplay-critical objects anyway) |
| Occlusion culling | 58–74 small props, open maps | below its own CPU cost | wrong hiding = visible bugs; no hardware queries in r128 integration | no | **Not implemented** |
| Instancing/batching of decor | 74 instances / 16 models | draw calls could drop ≈75 % (148 → ≈32 for the forest) | an `InstancedMesh` is culled as a whole (loses per-object frustum culling); needs per-model merging; scene change must stay identical for the same `mapSeed` | no (needs `renderer.info`) | **Not implemented.** Smallest next step if a phone shows draw-call-bound frames: one `InstancedMesh` per (model, primitive) for the forest/house scatter only. Measure first with `?perf=1` (draw calls, triangles, geometries, textures) |

Native frustum culling (three.js `frustumCulled`, default true; no `frustumCulled=false` anywhere) stays the only render culling. Render culling never touches collision, LOS or server state.

## 3. Asset status

| Item | Finding | Status |
|---|---|---|
| `all weapons.mtl` | `all_weapons.obj` says `mtllib all weapons.mtl`; no such file (nor `all_weapons.mtl`, nor any `.mtl` for weapons) exists in the project or in any archive supplied so far. The client never loads MTL (`MTLLoader` count 0), it assigns materials in code, so runtime is not affected. Not recreated: an invented material would not be the original. | **BLOCKED** — needs the original `94-weapons.rar` (or the MTL). |
| 13 split weapon OBJ (`weapon_001..013`) | all present, runtime paths exist with exact case, geometry untouched | unchanged |
| `weapon_006` vs `weapon_008` | identical geometry (same vertices/faces, translated 20 units on z), different material (`Material.005` vs `Material.007`) | kept as is, not merged/renamed |
| weapon names "UNKNOWN" | not touched | unchanged |
| `thor_color.jpg`, `thor_normal.jpg` | no runtime reference; named only in tests/docs. The deleted `thor.obj` pointed to a missing `thor hammer .mtl`, so which texture belonged to which material cannot be proven. Not deleted (rule: do not delete unused textures blindly). | kept; **decision for you** |
| `night.png` | no reference in client, server or tests | kept; **decision for you** |
| Skybox | `day.png` 4096×2048 (original), `day_2k.png` 2048×1024 for low / touch+medium; fallback to original if the reduced file fails | VERIFIED logic, NOT VERIFIED on device |
| Skeleton / animation assets | none exist: 0 of 36 GLB have skins or animations, OBJ has no skeleton; animation is procedural (`animstate.js`) | **BLOCKED** (not supplied, as in the earlier audit) |
| Runtime asset paths | every `models/…`, `textures/…` literal in `index.html` / `server.js` / `maplayouts.js` exists with exact case | VERIFIED (static) |
