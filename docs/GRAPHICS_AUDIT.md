# Qrafika auditi (Phase 6)

> Hər rəqəm `python3 tools/graphics_audit.py` ilə fayllardan oxunub (`docs/graphics_audit_data.json`, təkrar işlətdikdə byte-eyni nəticə verir). Brauzer, GPU və real cihaz bu mühitdə yoxdur,
> ona görə **heç bir vizual nəticə VERIFIED deyil**; aşağıda "Runtime status" sütunu/sətri həmişə bunu göstərir.

## 1. Baseline
- Phase 6 sonunda `node tests/run.js` 545/545 idi (tarixi nəticə). Tapşırıqdakı "461/461" köhnə baza idi. Phase 7 sonunda real nəticə: bölmə 9.
- Tam mutasiya suite-inin nəticəsi bu sənəddə yox, hesabatdadır (işləmə vəziyyəti dəyişə bilər).

## 2. Renderer arxitekturası (koddan, 13 sual)
| # | Sual | Cavab (mənbə) |
|---|---|---|
| 1 | Texnologiya | three.js **r128**, CDN-dən (`index.html`), WebGL (r128 WebGL2-ni defolt seçir). Electron/Android/iOS eyni veb kodu işlədir. |
| 2 | Renderer/material sistemi | Tək `THREE.WebGLRenderer({antialias:true})`, stok `MeshStandardMaterial`/`MeshBasicMaterial`; GLB üçün `GLTFLoader`, OBJ üçün `OBJLoader`. |
| 3 | Shader-lər | Əl ilə yazılmış shader yalnız külək effektidir (`public/wind.js`: `onBeforeCompile` yamağı + hissəcik `ShaderMaterial`). Qalan hər şey stok. |
| 4 | İşıq mənbələri | `HemisphereLight(1.0)` + `DirectionalLight(0.6)`; ev xəritəsində `PointLight` (isti), Thor hadisəsində dinamik `PointLight`; `Fog(10..60)`. |
| 5 | Kölgələr | Bu işə qədər **yox idi**. İndi `public/gfx.js` + `index.html`: qrafika səviyyəsinə görə günəş kölgəsi (Low = yox, Medium = 1024 PCF, High = 2048 soft-PCF; telefon bir pillə aşağı). Real shadow map, saxta sprite deyil. |
| 6 | Texture ölçüləri | Cəmi 7 şəkil: aşağıdakı cədvəl. GLB-lərdə texture **yoxdur** (78 materialın hamısı düz rəngdir). |
| 7 | UV olan modellər | 13 silah + `all_weapons` + bıçaq + Grenade + 36 GLB: UV var. **UV yoxdur:** dəbilqə, Omnitrix, 4 skin, Mjolnir. |
| 8 | Normal çatışmayan | Yalnız dəbilqədə `vn` yoxdur (OBJLoader normalları hesablayır). Digər OBJ-lərdə normal var. GLB tangent yoxdur (normal map da yoxdur, ona görə problem deyil). |
| 9 | Səhv/fallback material | (a) 13 silah `all weapons.mtl`-ə istinad edir, orijinal fayl **yoxdur** → Phase 7: `public/weaponmat.js` ilə **RECONSTRUCTED** per-material cədvəl + generasiya olunmuş `all weapons.mtl` (orijinal deyil). (b) 36 təbiət GLB materialı `metallicFactor=1` (aşağıda, düzəldildi). (c) dəbilqə texture-u UV olmadığı üçün istifadə olunmurdu → Phase 7: **GENERATED** box-proyeksiya UV (`public/uvgen.js`) ilə tətbiq olunur. |
| 10 | Post-processing | **Yoxdur** (EffectComposer yüklənmir). Qərar: bölmə 5. |
| 11 | PC/mobil səviyyələri | Var: `graphicsQuality`/`particleQuality` + `IS_TOUCH_DEVICE` bir pillə aşağı qaydası (skybox, kölgə, pixel ratio, hissəcik, damage number). |
| 12 | Settings real renderə təsir edirmi | Əvvəl **yox** (yalnız damage number). İndi `graphicsQuality`: pixel ratio, kölgə, skybox ölçüsü, metal mühit. Canlı dəyişdikdə atomik tətbiq (PREPARE→VALIDATE→APPLY→VERIFY→COMMIT, uğursuzluqda ROLLBACK). |
| 13 | Render loop dublikatı | `requestAnimationFrame` çağırış yeri sayı 6 olaraq qalır (Phase 5-dən bəri dəyişməyib); əsas `animate()` tək dövrdür, külək və kölgə ondan çağırılır. |

## 3. Shader auditi
Bax `docs/SHADER_COMPATIBILITY.md`.

## 4. Material/texture auditi
### 4.1 Şəkillər
| Fayl | KB | Ölçü | POT | GPU MB (mips) |
|---|---|---|---|---|
| `meme/meme.jpg` | 5 | 360x360 | NO | 0.7 |
| `models/accessories/helmet/corroded_metal_texture_by_ketronpl-d6mnkhy.jpg` | 177 | 1032x774 | NO | 4.1 |
| `models/thor/thor_color.jpg` | 1240 | 2024x2024 | NO | 20.8 |
| `models/thor/thor_normal.jpg` | 580 | 2024x2024 | NO | 20.8 |
| `textures/skyboxes/day.png` | 1027 | 4096x2048 | yes | 42.7 |
| `textures/skyboxes/day_2k.png` | 466 | 2048x1024 | yes | 10.7 |
| `textures/skyboxes/night.png` | 1074 | 4096x2048 | yes | 42.7 |

- `thor_normal.jpg` həqiqətən **tangent-space normal map-dir** (orta rəng ≈ 126,127,253). Amma `mjolnir.obj`-un UV-si yoxdur və yeni Mjolnir modeli köhnə `thor.obj`-u əvəz edib, ona görə bu map (və `thor_color.jpg`) **heç yerdə istifadə olunmur** (yetim). Silinməyib.
- `night.png` runtime-da istifadə olunmur (yetim, silinməyib).
- Skybox: 4096x2048 ≈ 42,7 MB GPU (mips ilə); `day_2k.png` ≈ 10.7 MB (hesab; ölçmə deyil).
- Dəbilqə texture-u (`corroded_metal...jpg`, 1032x774, POT deyil) UV olmadığı üçün mesh-ə tətbiq olunmur (kod `hasUV` yoxlayır) → palitra rəngi.

### 4.2 OBJ modelləri (23 fayl)
MTL statusu: `ORIGINAL` = orijinal fayl, `RECONSTRUCTED` = bu layihədə yaradılmış əvəzedici (orijinal DEYİL), `MISSING` = yoxdur.

| Fayl | KB | Üçbucaq | UV | Normal | Vertex rəng | MTL | usemtl |
|---|---|---|---|---|---|---|---|
| `accessories/helmet/helmet.obj` | 41 | 620 | NO | NO | NO | - | - |
| `accessories/omnitrix/omnitrix.obj` | 145 | 2483 | NO | yes | NO | - | Material.004, Material.014, Material.020, Material.022, Material.023, Material.024, Material.025, Metal, green |
| `skins/ironman/ironman.obj` | 235 | 5998 | NO | yes | yes | - | - |
| `skins/pilot/pilot.obj` | 290 | 5989 | NO | yes | yes | - | - |
| `skins/skeleton/skeleton.obj` | 344 | 5996 | NO | yes | yes | - | - |
| `skins/vader/vader.obj` | 292 | 6000 | NO | yes | yes | - | - |
| `thor/mjolnir.obj` | 3549 | 59999 | NO | yes | NO | - | - |
| `weapons/all_weapons.obj` | 1363 | 20806 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.001, Material.002, Material.003, Material.004, Material.005, Material.006, Material.007, Material.008, Material.009, Material.010, Material.011, Material.012, None |
| `weapons/melee/knife/knife.obj` | 142 | 2816 | yes | yes | NO | - | - |
| `weapons/split/weapon_001.obj` | 125 | 2168 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.001 |
| `weapons/split/weapon_002.obj` | 77 | 1352 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.002 |
| `weapons/split/weapon_003.obj` | 218 | 3592 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.003 |
| `weapons/split/weapon_004.obj` | 102 | 1640 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.004 |
| `weapons/split/weapon_005.obj` | 109 | 1924 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | None |
| `weapons/split/weapon_006.obj` | 66 | 1124 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.005 |
| `weapons/split/weapon_007.obj` | 102 | 1740 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.006 |
| `weapons/split/weapon_008.obj` | 67 | 1124 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.007 |
| `weapons/split/weapon_009.obj` | 53 | 966 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.008 |
| `weapons/split/weapon_010.obj` | 104 | 1780 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.009 |
| `weapons/split/weapon_011.obj` | 53 | 944 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.010 |
| `weapons/split/weapon_012.obj` | 33 | 568 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.011 |
| `weapons/split/weapon_013.obj` | 120 | 1884 | yes | yes | NO | all weapons.mtl (RECONSTRUCTED) | Material.012 |
| `weapons/throwable/grenade/Grenade.obj` | 1217 | 10207 | yes | yes | NO | Grenade.mtl (ORIGINAL) | pCube5SG, pCube5SG1, pCube5SG2 |

### 4.3 GLB modelləri (36 fayl)
- Üçbucaq: max 320, cəmi 4342; hamısında UV və normal var; tangent yoxdur; skin/animasiya **yoxdur** (statik dekor).
- 78 material: **0 texture, 0 normal map, 0 metal/rough map, 0 real emissive** (audit skriptinin "emissive" sayı `emissiveFactor` açarının mövcudluğunu sayır, qiymət sıfırdır).
- **Tapıntı (düzəldildi):** 36 material (yarpaq, qabıq, torpaq, daş, taxta, gül rəngləri, göbələk) `metallicFactor=1`. three.js-də `metalness=1` diffuz rəngi sıfırlayır, mühit xəritəsi olmadan səth çox qaranlıq görünür. Heç biri metal deyil, mebel dəstində isə 0-dır.
  Düzəliş: `normalizeGltfMaterials` (bir GLB parse-ında bir dəfə, metal adı olan və ya metalness map-i olanlara toxunmur). **Gözlənilən nəticə: ağac/qaya/çəpər daha açıq görünür. Real görünüş NOT VERIFIED.**

## 5. Post-processing qərarı
Bloom/AO/vignette/tone mapping **tətbiq edilmədi.** Səbəblər: (a) `EffectComposer` və pass-lər three examples-dan əlavə CDN skriptləri tələb edir, bu mühitdə yoxlanıla bilməz; (b) hər pass mobildə tam ekran xərci əlavə edir və ölçmə yoxdur; (c) AO real kölgənin əvəzi deyil; (d) `outputEncoding`/tone mapping dəyişikliyi bütün rəng görünüşünü dəyişir və vizual yoxlama olmadan etibarlı deyil.
Namizədlər (real cihaz ölçməsindən sonra): ACES tone mapping + `sRGBEncoding`, yüngül vignette.

## 6. Qrafika settings
Bax `public/gfx.js` və `tests/gfx.js`. Mövcud `Quality` (low/medium/high) real təsir edir. **Adaptive rejimi yoxdur**: `settings.js` yalnız low/medium/high qəbul edir və FPS ölçmə mənbəyi yoxdur; təxmin edilmədi. Əlavə manual seçimlər (Shadow/Texture/Shader/AA/Bloom/AO) əlavə edilmədi: dəstəyi olmayan seçim UI-da göstərilməməlidir.

## 7. Performans (ölçülməyib, yalnız statik)
- Meşə dekoru: 74 obyekt, təxminən 7-7,6k üçbucaq, ≤148 draw call; ev: 58 obyekt, ≈6-7k üçbucaq, ≤187 draw call (üst hədd, frustum culling-dən əvvəl).
- Skinlər: 4 model x ~6k üçbucaq (cəmi 23983); Mjolnir 59 999 üçbucaq (yalnız Thor hadisəsində).
- Kölgə keçidi yalnız Medium/High-da kölgə atan obyektləri yenidən çəkir (draw call artımı). **FPS təsiri ölçülməyib.**
- Külək yellənməsi kölgənin depth keçidinə təsir etmir (kölgələr yellənmir) — məlum məhdudiyyət.

## 8. Runtime statusları
| Sahə | Status |
|---|---|
| Shader compile (külək, kölgə) | NOT VERIFIED |
| Material rendering (metalness düzəlişi) | NOT VERIFIED |
| Texture rendering | NOT VERIFIED |
| Normal mapping | N/A (aktiv istifadə olunan normal map yoxdur) |
| Kölgələr | NOT VERIFIED (məntiq və atomik tətbiq testlərlə, görünüş yox) |
| Post-processing | tətbiq edilməyib |
| Model detalı | NOT VERIFIED (vizual baxış aparılmayıb) |
| Animasiya | NOT VERIFIED |
| Mobil / Desktop performans | NOT VERIFIED |
| Electron / Android Chrome / iOS Safari | NOT VERIFIED |

## 9. Phase 7 nəticələri (real icra olunmuş)
**Testlər.** `node --check` (server, `public/*.js`, `tests/*.js`, `tools/*.js`, `index.html`-in inline skripti): bütün fayllar OK. `node tests/run.js` → **559/559 PASS**, **10 ardıcıl run**, hamısı 559/559, 0 FAIL. `tests/realws_smoke.js` → **15/15 PASS**. Yeni testlər: `weaponmat` (6), `uvgen` (5), `glslreport` (3).

**Mutasiya suite-i (`tests/mutation22.py`, `tools/run_mutation_suite.py`).** Ümumi **161** mutant: **KILLED 161, SURVIVED 0, TIMEOUT 0, ERROR 0, NOT RUN 0**.
Qeydlər: (1) nəticə bir fasiləsiz run deyil, konteyner bir neçə dəfə yenidən başladığı üçün diapazonlarla (`0:20`, `20:30`, `30:35` … `160:161`) yığılıb; hər diapazon öz baseline-ı ilə (559/559) icra olunub; (2) iki mutantın pattern-i mənim Phase 4 hit dəyişikliyim səbəbindən köhnəlmişdi (`slotmut: knife can crit`, `hit: client damage accepted`, əvvəlcə ERROR çıxdı); onları hazırkı koda uyğunlaşdırıb təkrar icra etdim, ikisi də tutuldu; testlər zəiflədilməyib, mutant silinməyib;
(3) mutantlar yalnız server və client qaydalarının mövcud davranışını yoxlayır; Phase 4-7-nin yeni modulları (`hitbox.js`, `wind.js`, `weaponmat.js`, `uvgen.js`) üçün mutantlar **yazılmayıb** (istifadəçi bunu istəməmişdi).

**Real WebGL.** `tools/glsl_compile_check.py`: custom GLSL WebGL1 + WebGL2-də kompilyasiya/link OK, nöqtə shader-ləri xətasız çəkildi, yellənmə GPU-da icra olunub və düsturla uyğundur (bax `docs/SHADER_COMPATIBILITY.md`). Mock three.js prefix, proqram GPU. **Oyunun özü işə salınmayıb: three.js r128 diskdə yoxdur və şəbəkə əlçatmazdır** (fayl sistemində ad və məzmunla axtarış, `curl`/`npm view` cavab vermədi).

**Status cədvəli**
| Sahə | Status |
|---|---|
| Custom GLSL kompilyasiya (mock prefix, WebGL1/2) | **VERIFIED** (proqram GPU) |
| Yellənmə riyaziyyatı (kök sabit, istiqamət, düstur) | **VERIFIED** (GPU-da icra) |
| three.js-in tam material proqramı, `onBeforeCompile` r128-də | NOT VERIFIED |
| Kölgələr (məntiq, atomik tətbiq, rollback) | testlərlə (unit); **görünüş NOT VERIFIED** |
| Metalness düzəlişi, silah finish-ləri, dəbilqə UV görünüşü | NOT VERIFIED |
| Normal map / tangent | N/A (istifadə olunan normal map yoxdur; `thor_normal.jpg` başqa meshə aiddir) |
| Model detalı, animasiya | NOT VERIFIED |
| Mobil / desktop performans (FPS) | NOT VERIFIED (ölçülməyib) |
| Electron, Android Chrome, iOS Safari | NOT VERIFIED |
