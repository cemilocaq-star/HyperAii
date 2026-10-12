# Asset detailing planı (Phase 6)

Qaydalar: model yalnız **sübut olunmuş** geometry çatışmazlığında yaradılır. Bu mühitdə vizual baxış mümkün deyil, ona görə "geometry kifayətdirmi" sualının **vizual hissəsi qiymətləndirilməyib** (NOT ASSESSED);
yalnız fayllardan ölçülə bilən faktlar (üçbucaq, UV, normal, MTL, texture) "sübut olunmuş çatışmazlıq" sayılır. Rəqəmlər `docs/graphics_audit_data.json`-dandır (`tools/graphics_audit.py`).

**Yaradılmış yeni model sayı: 0.** Mövcud modellərdən heç biri üçün həndəsi çatışmazlıq sübut olunmayıb; təsadüfi primitive əlavə etmək tapşırığın öz qaydasına ziddir.

| Field | Məzmun |
|---|---|
| **Asset** | `models/nature/*.glb` (ağac, qaya, gül, çəpər, kötük, taxta, göbələk, yol, ot) — 18 fayl |
| Current state | Üslublu low-poly (≤320 üçbucaq), UV və normal var, texture yoxdur, düz rəng; 36 material `metallicFactor=1` |
| Missing detail | **Sübut olunmuş material qüsuru:** üzvi səthlər (yarpaq/qabıq/torpaq/daş/taxta) metal kimi konfiqurasiya olunub → tünd görünür. Həndəsə: üslub low-poly, əlavə detal üslubu pozar (vizual qiymətləndirilməyib) |
| Required solution | Material: `metalness=0` (edildi, `normalizeGltfMaterials`). Shader: külək yellənməsi (Phase 5) |
| New model needed | **NO** |
| Reason | Qüsur materialdadır, həndəsədə deyil (Variant B) |
| Performance cost | Material parametri: 0 əlavə xərc (təxmini, ölçülməyib) |
| Integration | `loadGLTF` → GLB başına bir dəfə, klonlar paylaşılan materiala baxır; collision/server layout toxunulmayıb |
| Tests | `tests/gltfmat.js` (4 test, real GLB faylları üzərində məlumat testi daxil) — PASS |
| Runtime status | NOT VERIFIED |

| Field | Məzmun |
|---|---|
| **Asset** | `models/furniture/*.glb` (ev xəritəsi, 18 fayl) |
| Current state | `metallicFactor=0`, UV/normal var, texture yoxdur |
| Missing detail | Sübut olunmuş qüsur yoxdur |
| Required solution | Yoxdur |
| New model needed | **NO** |
| Reason | Material düzgün konfiqurasiya olunub; həndəsə vizual qiymətləndirilməyib |
| Performance cost | 0 |
| Integration | Dəyişməyib |
| Tests | Mövcud asset testləri |
| Runtime status | NOT VERIFIED |

| Field | Məzmun |
|---|---|
| **Asset** | `models/weapons/split/weapon_001..013.obj`, `all_weapons.obj` |
| Current state | 1,1k-2,2k üçbucaq/silah, UV və normal var; hamısı `all weapons.mtl`-ə istinad edir (fayl **yoxdur**); `weapon_005` `usemtl None`; `weapon_006` ≡ `weapon_008` həndəsə dublikatı (material fərqli) |
| Missing detail | **Sübut olunmuş:** orijinal MTL çatışmır; heç bir arxivdə, layihə qovluğunda və fayl sistemində başqa nüsxə tapılmadı (yeganə `.rar` `tests/fixtures/ironman_mtl.rar`-dır; `tools/rar_extract.py` ilə açıldı: içində yalnız `IronMan/IronMan.mtl` var, 1162 bayt, materiallar darksilver/red/gold/silver/lambert1/yellow/black/14_-_Default — `Material.NNN` və ya `None` yoxdur, silah materialı yoxdur). Həndəsə: vizual qiymətləndirilməyib |
| Required solution | Phase 7: **RECONSTRUCTED** material cədvəli (`public/weaponmat.js`, 12 fərqli finish + `None` fallback) və ondan generasiya olunan `all weapons.mtl` (orijinal deyil). Runtime-da `usemtl` adına görə tətbiq olunur + prosedural mühit (Low-da yox). Orijinal MTL arxivi təqdim olunsa onunla əvəz edilməlidir |
| New model needed | **NO** |
| Reason | Çatışan şey model deyil, material faylıdır; silahların funksional növləri təsdiqlənməyib, ad/stat uydurulmayıb; dublikat dəyişdirilməyib |
| Performance cost | Mühit xəritəsi bir dəfə prefilter olunur (ölçülməyib); hər silah yükləməsində əlavə texture yoxdur |
| Integration | `loadRealWeapon` (sahiblik/dispose qaydaları Phase 3-dədir); `weaponId` və registry dəyişməyib |
| Tests | `tests/weaponlife.js`, `tests/weaponmat.js` (6 test: mtllib həll olunur, hər usemtl-in girişi var, 006≠008 materialı, generator ilə fayl eynidir, tint sərhədləri, client inteqrasiyası) — PASS |
| Runtime status | NOT VERIFIED (görünüş). **Asset status: RECONSTRUCTED** (rənglər uydurma dizayn palitrasıdır, orijinal rəssam məlumatı deyil) |

| Field | Məzmun |
|---|---|
| **Asset** | `models/weapons/melee/knife/knife.obj` |
| Current state | 2,8k üçbucaq, UV və normal var; qovluqda MTL və texture **yoxdur** |
| Missing detail | Sübut olunmuş çatışmazlıq yoxdur (texture dependency-si mövcud deyil) |
| Required solution | Yoxdur |
| New model needed | **NO** |
| Reason | Asılılıq yoxdur; vizual qiymətləndirilməyib |
| Performance cost | 0 |
| Integration | Dəyişməyib |
| Tests | Mövcud slot/knife testləri |
| Runtime status | NOT VERIFIED |

| Field | Məzmun |
|---|---|
| **Asset** | `models/weapons/throwable/grenade/Grenade.obj` |
| Current state | 10 207 üçbucaq; `Grenade.mtl` var (5 düz material, `map_` yoxdur → texture asılılığı yoxdur); UV/normal var |
| Missing detail | Sübut olunmuş çatışmazlıq yoxdur. Qeyd: 0,24 vahidlik obyekt üçün həndəsə ağırdır, amma Phase 2-də geometriya paylaşıldı və ölçülə bilən fayda yoxdur |
| Required solution | Yoxdur (LOD yaradılmadı: faydası ölçülə bilmir) |
| New model needed | **NO** |
| Reason | Funksional ehtiyac yoxdur |
| Performance cost | Atılan bomba başına geometriya kopyası artıq yoxdur (Phase 2) |
| Integration | `loadObjShared` |
| Tests | `tests/sharedobj.js` — PASS |
| Runtime status | NOT VERIFIED |

| Field | Məzmun |
|---|---|
| **Asset** | `models/skins/{ironman,pilot,skeleton,vader}/*.obj` |
| Current state | ~6k üçbucaq (decimated), vertex rəngləri var, **UV yoxdur**, normal var, MTL/texture yoxdur |
| Missing detail | UV yoxdur → texture/PBR map tətbiq oluna bilməz. Bu üslubun (vertex rəngi) nəticəsidir, səhv deyil |
| Required solution | Yoxdur: vertex rəngi ilə düzgün işləyir; texture əlavə etmək yeni UV tələb edir |
| New model needed | **NO** |
| Reason | Sübut olunmuş çatışmazlıq yoxdur; yeni UV həndəsəni pozmadan avtomatik yaradıla bilməz |
| Performance cost | 0 |
| Integration | Hit proxy-lər skindən asılı deyil (Phase 4) |
| Tests | Mövcud skin testləri |
| Runtime status | NOT VERIFIED |

| Field | Məzmun |
|---|---|
| **Asset** | `models/thor/mjolnir.obj` (+ yetim `thor_color.jpg`, `thor_normal.jpg`) |
| Current state | 59 999 üçbucaq, normal var, **UV yoxdur**, MTL yoxdur. `thor_normal.jpg` həqiqi tangent-space normal map-dir, amma UV olmadığı üçün istifadə oluna bilmir |
| Missing detail | Sübut olunmuş: UV çatışmır. **Texture-lar bu mesh-ə aid deyil:** köhnə `thor.obj` (orijinal yükləmə arxivindən oxundu) 36 650 təpə, 21 415 UV, ölçü 79x19x149, `mtllib thor hammer .mtl`; `mjolnir.obj` 24 855 təpə, 0 UV, ölçü 11x5x3 — fərqli mesh. `thor_normal.jpg` həmin köhnə mesh-in UV düzülüşü üçündür |
| Required solution | Material: prosedural mühit (metalness 0,85 tünd görünməsin deyə, edilib). UV yaratmaq və `thor_*.jpg`-ni tətbiq etmək edilmədi: texture başqa meshin UV-sinə görə çəkilib, avtomatik proyeksiya onu mənasız yerlərə qoyardı və normal map-in tangent düzülüşünü pozardı. Köhnə `thor.obj` istifadəçi tələbi ilə silinib (yalnız orijinal yükləmə arxivində qalır) |
| New model needed | **NO** |
| Reason | Yeni model Mjolnir-in funksiyasını artırmır; UV yalnız orijinal mənbədən düzgün alına bilər |
| Performance cost | Dəyişməyib; 60k üçbucaq tək obyekt, ölçülməyib |
| Integration | `ensureThorHammer`, `applyMetalEnv` |
| Tests | `tests/assets.js` |
| Runtime status | NOT VERIFIED |

| Field | Məzmun |
|---|---|
| **Asset** | `models/accessories/helmet/helmet.obj` (+ `corroded_metal_texture...jpg`) |
| Current state | 620 üçbucaq (OBJ modellərinin ən az detallısı), **UV yoxdur, vn yoxdur**; 1032x774 texture UV olmadığı üçün tətbiq olunmur (palitra rəngi) |
| Missing detail | **Sübut olunmuş:** UV yoxdur → mövcud texture istifadəsizdir. Həndəsə detalı vizual baxışdan sonra qiymətləndirilməlidir |
| Required solution | **İki variant ölçüldü** (qərar meyarı ölçmədən əvvəl təyin edilib: sıxlıq nisbəti ≤ √3, tikiş payı ≤ 30%, UV ∈ [0,1]): **A** = yalnız palitra rəngi (UV yoxdur); **B** = generasiya olunmuş box-proyeksiya UV + mövcud texture. Ölçmə: sıxlıq nisbəti 1,654, tikiş payı 0,226, UV ∈ [0,1] → **B seçildi** (`public/uvgen.js`, `tests/uvgen.js`). Omnitrix meyarı ödəmir (tikiş 0,32) və texture-u da yoxdur, toxunulmadı. Mühit xəritəsi də var |
| New model needed | **NO** |
| Reason | UV çatışmazlığı sübut olunub və UV ilə həll edildi; **həndəsi** detal çatışmazlığı sübut olunmayıb (620 üçbucaq vizual baxışsız qiymətləndirilə bilməz) |
| Performance cost | Əlavə UV: vertex başına 8 bayt (təxmini, ölçülməyib); detal mesh planlaşdırılmayıb, ona görə xərc qiymətləndirilməyib |
| Integration | Cosmetic registry (`shape:'model'`), attachment dəyişməyib |
| Tests | `tests/uvgen.js` (5 test: sərhəd, qərar qapısı real dəbilqədə, client inteqrasiyası davranışla), `tests/gltfmat.js` (env) — PASS |
| Runtime status | NOT VERIFIED (görünüş). **Asset status: ORIGINAL mesh + ORIGINAL texture + GENERATED UV** |
| **Növbəti addım** | Real cihazda dəbilqəyə yaxından baxıb UV tikişlərinin və detalın kifayətliyini yoxlamaq |

| Field | Məzmun |
|---|---|
| **Asset** | `models/accessories/omnitrix/omnitrix.obj` |
| Current state | 2 483 üçbucaq, normal var, UV yoxdur, 3 `usemtl` (MTL yoxdur → palitra) |
| Missing detail | Sübut olunmuş yoxdur (palitra ilə 3 material ayrılır) |
| Required solution | Mühit xəritəsi (edilib) |
| New model needed | **NO** |
| Reason | Material atributları kod tərəfindən verilir |
| Performance cost | 0 |
| Integration | Dəyişməyib |
| Tests | Kosmetika testləri |
| Runtime status | NOT VERIFIED |

| Field | Məzmun |
|---|---|
| **Asset** | Arena/xəritə (purple primitive xəritə, forest/house dekor) |
| Current state | Server layout və client generatoru eyni seed ilə; dekor kolliziyasızdır |
| Missing detail | Vizual baxış aparılmayıb |
| Required solution | Kölgə (edilib) və külək (Phase 5); yeni divar/prop əlavə edilmədi |
| New model needed | **NO** |
| Reason | Yeni vizual detal server collision uyğunsuzluğu riski yaradır və oxunaqlığı azalda bilər; ehtiyac sübut olunmayıb |
| Performance cost | Kölgə: Medium/High-da əlavə draw call (ölçülməyib) |
| Integration | `placeScatterPlan`, `markShadow` |
| Tests | `tests/gfx.js`, mövcud map testləri |
| Runtime status | NOT VERIFIED |

## Asset statusları (ORIGINAL VERIFIED / RECONSTRUCTED / GENERATED / FALLBACK / MISSING / NOT VERIFIED)
| Asset | Status | Qeyd |
|---|---|---|
| 13 silah OBJ + `all_weapons.obj` həndəsəsi | ORIGINAL (faylın özü; mənbəyi yoxlanmayıb) | UV+normal var |
| `all weapons.mtl` | **RECONSTRUCTED** (orijinal MISSING) | `tools/build_weapon_mtl.js`, `public/weaponmat.js`; rənglər uydurma dizayn palitrasıdır |
| Silah runtime materialı | **GENERATED/RECONSTRUCTED** per-usemtl; `None` və naməlum ad → **FALLBACK** | |
| `weapon_006` / `weapon_008` | ORIGINAL həndəsə dublikatı, fərqli material | silah növü təsdiqlənməyib, dəyişdirilməyib |
| Dəbilqə mesh + texture | ORIGINAL | |
| Dəbilqə UV | **GENERATED** (runtime, box proyeksiya) | orijinal unwrap deyil |
| Omnitrix | ORIGINAL mesh; palitra kodda | UV yoxdur, texture yoxdur |
| `mjolnir.obj` | ORIGINAL | UV yoxdur; texture yoxdur |
| `thor_color.jpg`, `thor_normal.jpg` | ORIGINAL, **yetim** (başqa meshə aiddir) | silinməyib |
| `night.png` | ORIGINAL, yetim | silinməyib |
| Skybox `day.png` | ORIGINAL | `day_2k.png` **GENERATED** (4096→2048 azaltma) |
| 36 GLB | ORIGINAL | metalness düzəlişi runtime-dadır, fayl dəyişməyib |
| `Grenade.obj`/`Grenade.mtl` | ORIGINAL | texture asılılığı yoxdur |
| Skelet/animasiya asset-i | **MISSING** (layihədə heç vaxt olmayıb) | bax aşağı |

## Çatışan asılılıqlar və araşdırılmış yollar
| Fayl | Nəticə | Yoxlanmış yollar |
|---|---|---|
| `all weapons.mtl` | Orijinal **tapılmadı**; **RECONSTRUCTED** əvəzedici yaradıldı və inteqrasiya olundu | layihə qovluğu, yüklənmiş arxiv, bütün fayl sistemi (ad və `94-weapons`/`weapons*.rar` axtarışı), `tests/fixtures/ironman_mtl.rar` **açıldı** (yalnız `IronMan/IronMan.mtl`, silah materialı yoxdur) |
| `thor hammer .mtl` | Aktual deyil | köhnə `thor.obj` silinib; `mjolnir.obj` MTL istifadə etmir |
| `night.png`, `thor_color.jpg`, `thor_normal.jpg` | Yetim, silinməyib | runtime/test istinadı yoxlanıb; `thor_*` başqa mesh-ə aiddir (yuxarıdakı rəqəmlər) |
| Skelet/animasiya | **MISSING** | layihədə `.fbx/.gltf/.blend/.max/.c4d/.dae/.bvh/.7z` yoxdur; 36 GLB-də 0 skin, 0 animasiya; yeganə arxiv `ironman_mtl.rar` (335 bayt test fixture; açıldı: yalnız `IronMan/IronMan.mtl`). Mövcud animasiya `public/animstate.js` prosedural emote sistemidir; yeni animation engine, ikinci `AnimationMixer` və ya saxta skelet yaradılmadı |
