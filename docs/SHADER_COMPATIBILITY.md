# Shader uyğunluğu (Phase 6)

**Phase 7-dən sonra:** custom GLSL **real WebGL kontekstində** (headless Chrome 131, ANGLE/SwiftShader proqram GPU-su) kompilyasiya və icra olunub (`tools/glsl_compile_check.py` → `docs/glsl_compile_report.json`). Amma bu mühitdə three.js r128 yoxdur (diskdə və şəbəkədə tapılmadı), ona görə **three.js-in tam proqramı, oyunun özü, görünüş və real/mobil GPU NOT VERIFIED qalır**.

## Inventar (ikinci shader manager yoxdur)
| Shader | Harada | Mexanizm | Fayl |
|---|---|---|---|
| Bitki yellənməsi | Ağac və gül materialları (meşə) | Stok `MeshStandardMaterial`-ın vertex shader-inə `onBeforeCompile` ilə `#include <common>` / `<begin_vertex>` əvəzlənməsi | `public/wind.js`, `index.html` |
| Külək hissəcikləri | Meşə, kamera ətrafında | `THREE.Points` + `ShaderMaterial` (1 draw call) | `public/wind.js`, `index.html` |
| Günəş kölgəsi | Medium/High | Three.js-in daxili shadow map shader-ləri (öz shader yazılmayıb) | `public/gfx.js`, `index.html` |
| Metal mühit | Silah/Mjolnir/aksesuar | Stok `MeshStandardMaterial.envMap` (PMREM, prosedural gradient) | `index.html` |

## GLSL xüsusiyyətləri
- Yalnız GLSL ES 1.00-da mövcud olanlar: `inverse()` və `transpose()` istifadə olunmur (dünya ofseti obyekt fəzasına `dot(mat3 sütunları)` ilə çevrilir) — WebGL1 fallback üçün. `tests/wind.js` bunu mətn səviyyəsində yoxlayır.
- `mod`, `smoothstep`, `clamp`, `discard` standartdır. `gl_PointSize` 1-6 arasında məhdudlaşdırılıb (bəzi mobil GPU-larda nöqtə ölçüsü limiti kiçikdir).
- Yellənmə vahid şəkil ölçüsü miqyasını fərz edir (`mat3(modelMatrix)` = fırlanma x vahid miqyas). Qeyri-vahid miqyaslı dekor üçün ofset bir qədər səhv olar (indiki dekor vahid miqyaslıdır: `obj.scale.setScalar`).
- `uWindTime` məhdudsuz artır; vertex shader-də `highp` (three defolt) ilə saatlarla sabitdir. Fragment precision hissəcik shader-ində yalnız rəng/alfa üçündür.


## Real WebGL sübutu (Phase 7)
Alət: `python3 tools/glsl_compile_check.py`; brauzer: `141.0.7390.37`; kontekstlər: WebGL1 və WebGL2 (`WebGL 2.0 (OpenGL ES 3.0 Chromium)`). GLSL-in SHA-256-sı hesabatda saxlanır; shader dəyişəndə `tests/glslreport.js` hesabat köhnəlibsə uğursuz olur.

| Yoxlama | Nəticə |
|---|---|
| Bitki yellənməsi (three-in vertex prefix-inin MOCK-u ilə) — WebGL1 və WebGL2 | kompilyasiya + link **OK** |
| Hissəcik vertex + fragment (`mediump` və `highp`) — WebGL1 və WebGL2 | kompilyasiya + link **OK**; 200 nöqtə çəkildi, `glError=0`, 516 piksel rasterləşdi |
| Nöqtə ölçüsü aralığı | `[1, 1023]` (bizim 1–6 px sıxılmamıza kifayət edir) — **proqram GPU üçün; real mobil GPU-larda limit fərqli ola bilər** |
| Yellənmə snippet-i GPU-da **icra olundu** (WebGL2 transform feedback, 3 model-matrix halı) | bitkinin dibi: yerdəyişmə **0**; şaquli sürüşmə **0**; itələmə yalnız küləyin istiqamətindədir; düsturla fərq ≤ 1.4e-05; fırlanma + miqyas + translasiya altında da doğru |
| Kök deformasiyası | kökdən 0,5 vahid yuxarıda itələmə < 0,02 (test: `tests/glslreport.js`) |

Bu sübutun **əhatə etmədikləri**: three.js-in `MeshStandardMaterial` proqramının tam qurulması (chunk-lar mock-lanıb), `onBeforeCompile` hook-unun r128 ilə işləməsi (hook imzası r128-in sənədləşdirilmiş API-sidir, amma icra olunmayıb), `renderer.info.programs[].diagnostics` ilə xəta aşkarlanması, görünüş, real GPU-lar, mobil.

## Fallback və xəta idarəsi
| Hal | Davranış |
|---|---|
| `?wind=0` | Bütün külək söndürülür (stok material, hissəcik yox) |
| Külək shader-i kompilyasiya olunmursa | ~180 frame sonra `renderer.info.programs[].diagnostics.runnable === false` aşkar olunarsa (**three r128-də bu sahənin davranışı yoxlanmayıb**) külək söndürülür, materiallar stok halına qayıdır, `console.warn` |
| Kölgə ilə shader xətası | ~240 frame sonra eyni yoxlama → profil **Low**-a düşür (saxlanmış ayar dəyişmir), `gfxFallback = true` (`?perf=1`-də göstərilir), `console.warn` |
| Qrafika plan etibarsızdır (məs. kölgə ölçüsü cihaz limitindən böyük) | VALIDATE mərhələsində rədd edilir, heç nə tətbiq olunmur |
| Tətbiq zamanı istisna / read-back uyğunsuzluğu | ROLLBACK: əvvəlki pixel ratio, kölgə növü/ölçüsü/sahəsi bərpa olunur |
| Metal mühit yaradıla bilmirsə | Mühit yoxdur, bir xəbərdarlıq, silahlar birbaşa işıqda qalır |
| Eyni shader hər frame yenidən kompilyasiya | Yoxdur: yamaq bir dəfə qoyulur, `customProgramCacheKey` sabitdir; kölgə dəyişəndə materiallar **bir dəfə** `needsUpdate` alır |

Heç bir xəta "uğurlu" kimi gizlədilmir: yuxarıdakı hər yol `console.warn` yazır. Qeyd: kompilyasiya xətası **aşkarlanması** best-effort-dur və real brauzerdə yoxlanmalıdır (`TEST_CHECKLIST.md`).

## Məlum məhdudiyyətlər
- Yellənən ağacların kölgəsi yellənmir (depth keçidi stok material istifadə edir).
- `outputEncoding`/tone mapping dəyişdirilməyib (bütün rəng görünüşünü dəyişərdi; vizual yoxlama tələb edir).
- AO və post-processing yoxdur (səbəblər: `docs/GRAPHICS_AUDIT.md` bölmə 5).
