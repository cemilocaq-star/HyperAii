# TEST_CHECKLIST.md — Manual / device verification

This project has an automated offline test suite (`node tests/run.js`, 166
tests as of Phase 11) covering server logic. It has **no browser or mobile
device in its build/dev environment**, so everything below is genuinely
unchecked — nothing on this list has been marked done by me. Check items off
as you verify them for real.

## SERVER
- [ ] `npm install`
- [ ] `npm start`
- [ ] room create
- [ ] quick play
- [ ] join
- [ ] reconnect
- [ ] host migration
- [ ] dash
- [ ] stamina
- [ ] chaos (pink pop / duck weapon / green ogre all trigger and end)
- [ ] cosmetics (equip each slot: color, accessory, badge, title, emote, skin, outfit, head, hair)
- [ ] achievements (Thor survivor, JoJo secret)
- [ ] spectator (enter on death, prev/next, waiting state, auto-respawn exit)
- [ ] ping (badge shows a plausible number, toggle works)
- [ ] emotes (wheel on PC and mobile, cooldown, G key)

## PC
- [ ] Chrome
- [ ] Edge

## ANDROID
- [ ] Chrome
- [ ] touch movement
- [ ] dash
- [ ] emote wheel
- [ ] spectator

## IOS
- [ ] Safari
- [ ] touch movement
- [ ] dash
- [ ] emote wheel
- [ ] spectator

## MULTIPLAYER
- [ ] PC ↔ PC
- [ ] PC ↔ Android
- [ ] PC ↔ iPhone
- [ ] Android ↔ iPhone
- [ ] same Wi-Fi
- [ ] different networks

## PHASE 22 — manual (real browser/device required; nothing below was run)
- [ ] hit: nişan alıb vurmaq real brauzerdə hit marker verir; nişan almadan (kənara) vurmaq zərər vermir (aim rədd olunmur ki, normal oyunçu false-positive olmasın — lag ilə yoxla)
- [ ] troll pickup: sarı top götürülür → hamı üçün yox olur → ~8s sonra yeni yerdə görünür; götürən lənətlənir
- [ ] troll pickup: iki oyunçu eyni topu götürməyə çalışır — yalnız biri alır
- [ ] reconnect zamanı götürülmüş top gizli qalır
- [ ] nameplate: badge (🏆) + title + ad doğru görünür (PC + Android + iPhone)
- [ ] PC ↔ Android / PC ↔ iPhone / Android ↔ iPhone multiplayer; eyni şəbəkə və fərqli şəbəkə
- [ ] Electron paketləmə (`npm run dist`)
- [ ] (Phase 22 audit) səhifə açıq ikən Wi-Fi-ı 5-10s söndürüb-yandır: oyun davam edir, canvas ikiqat olmur, hərəkət sürəti normal qalır, pickup-lar düzgün
- [ ] (Phase 22 audit) real `npm install && npm start` ilə 2 brauzer tab: atəş → hit marker, təkrar klik spam-ı zərəri artırmır
- [ ] (Phase 22 audit) real express ilə statik fayl serving (`public/` açılır) — express stub-lanmış mühitdə yoxlanmayıb


## PHASE 3 — manual (real browser/device required; nothing below was run — no browser/GPU/phone in the build environment)
Hazırlıq: `npm start`, PC brauzerində `http://localhost:3000`, telefonda eyni Wi-Fi-dan `http://<PC-IP>:3000`. Server konsolunu açıq saxla.

### İki cihaz, eyni otaq (interest management)
- [ ] PC-də otaq yarat, telefonla kodla qoşul, hər ikisi ready → oyun başlayır; hər iki ekranda digər oyunçu görünür və adı/komandası/rəngi doğrudur
- [ ] Meşə xəritəsində iki oyunçu xəritənin əks kənarlarında dayanır (uzaq): uzaq oyunçu görünür və hərəkət edəndə kəskin "titrəmə" və ya teleportasiya yoxdur (uzaq oyunçu ~5 Hz yenilənir; interpolation yumşaq olmalıdır)
- [ ] Uzaq oyunçuya nişan alıb atəş: hit marker və damage əvvəlki kimi işləyir (uzaq məsafədə vurma hissi pisləşibsə, `server.js` → `INTEREST_CONFIG.farEvery/midEvery` dəyərini azalt və ya `enabled:false` ilə müqayisə et — qeyd et)
- [ ] Bir oyunçu **otaqdan çıxır** (menyu → Leave): qalan oyunçuda onun modeli ≤ ~1 s-də yox olur; qalan oyunçuların modelləri **itmir və boş/ağ qalmır**
- [ ] Çıxan oyunçu eyni otağa **yenidən qoşulur**: ≤ ~1 s-də (4 s yox!) tam görünür — adı/rəngi/skin-i ilə
- [ ] **Reconnect**: telefonda Wi-Fi 5–10 s söndür/yandır → oyun davam edir, rəqib dərhal tam görünür, ikiqat model yoxdur
- [ ] **Spectator**: oyunçu ölür → izləmə rejimi; izlənən oyunçu dəyişəndə hamı yumşaq hərəkət edir (ölü oyunçu hamını tam tezlikdə alır)
- [ ] Host migration: host çıxır → yeni host təyin olunur, oyun və görünüş pozulmur

### Resurslar / silahlar
- [ ] Silahı 15–20 dəfə dəyiş (1–9 + digər düymələr / mobil düymə): hər dəfə silah dərhal dəyişir, **bir frame belə boş əl / ağ-qara/korlanmış material yoxdur**, metal teksturu hər silahda eynidir
- [ ] Sürətli ardıcıl silah dəyişmə (spam): son seçilən silah qalır, köhnə silah geri qayıtmır
- [ ] Skin-li oyunçular (FFA, 4+ oyunçu): hamısında skin modeli var; biri çıxanda digərlərinin modelləri qalır
- [ ] Qumbara/bomba: bir neçə bomba atılır və partlayır; sonra yeni bomba atmaq işləyir, qumbara əlində görünür
- [ ] **Yaddaş**: Chrome DevTools → Performance monitor / Memory (PC) və ya Android `chrome://inspect` — 20–30 dəq oyun sessiyasında JS heap və GPU yaddaşı (təxmini) başlanğıc və sonda qeyd et; silah dəyişmə spamından əvvəl/sonra heap snapshot müqayisə et. **Rəqəmi bura yaz:** başlanğıc ___ MB / sonda ___ MB

### Qrafika
- [ ] Settings → Quality **Low**: oyunu yenidən aç (leave → reload) → meşə xəritəsində səma görünür (2048×1024), kəskin ləkə/zolaq yoxdur; yaddaş (DevTools) azalıb
- [ ] **Medium** PC-də (4096×2048 səma) və **Medium** telefonda (touch → 2048×1024) səma yaxşı görünür
- [ ] **High**: telefonda 4096×2048, PC-də 4096×2048; texture limitinə görə iPhone-da qara/boş səma yoxdur
- [ ] Qeyd: səma yalnız xəritə qurularkən seçilir — keyfiyyəti oyun içində dəyişmək onu dərhal dəyişmir (yeni oyun/yenidən yükləmə lazımdır)
- [ ] **Adaptive**: kodda **mövcud deyil** (yalnız Low/Medium/High) — bu maddə yoxlana bilməz; Adaptive tələb olunursa ayrıca implementasiya lazımdır
- [ ] Draw call / FPS ölçməsi (DevTools Performance və ya `renderer.info.render.calls`): meşə və ev xəritəsində PC və telefonda median FPS və p95 frame time yaz. **Nəticə:** PC ___ / Android ___ / iPhone ___

### Assetlər
- [ ] Silahların hamısı (13) düzgün formada görünür; `weapon_006` və `weapon_008` (eyni həndəsə, fərqli material) birbirindən fərqlənir
- [ ] Mjolnir (Thor hadisəsi) düzgün görünür (köhnə `thor.obj` silinib)

### Resurs ömrü (Phase 3 düzəlişləri) — real ölçmə (DevTools konsolu; `renderer` global `let`-dir, konsoldan oxunur)
- [ ] Başlanğıc: oyun açılır, konsolda `renderer.info.memory` → `geometries` / `textures` dəyərlərini yaz. **Nəticə:** geometries ___ / textures ___
- [ ] Silahı 30 dəfə dəyiş (müxtəlif silahlar), sonra `renderer.info.memory` yenidən: `textures` **artmamalıdır** (əvvəl hər yükləmədə +1 canvas texture yaranırdı); `geometries` silah sayı ilə **yox, yalnız 1 aktiv silah + sabit hissələr** qədər dəyişməlidir. **Nəticə:** geometries ___ / textures ___
- [ ] FFA otağında 3+ skin-li oyunçu: `Network` tabında `skins/*.obj` hər fayl üçün **1 sorğu** (oyunçu sayına görə təkrarlanmır). Oyunçu çıxanda digərlərinin modeli qalır
- [ ] Skin-li bütün oyunçular çıxıb yenisi qoşulur: skin yenidən yüklənir və görünür (son istifadəçi buraxanda cache azad olunur, boş/ağ model yoxdur)
- [ ] 10 bomba at: hər atışda `geometries` artmır (bomba geometriyası paylaşılır), partlayışdan sonra azalma/artma yoxdur. **Nəticə:** ___
- [ ] 20–30 dəq sessiyada JS heap (Memory tab → Heap snapshot başlanğıc/son) və `renderer.info.memory` müqayisəsi; trend ____ (artım varsa hansı tipdə: Geometry / Texture / Object3D)

### Phase 3 — iki cihaz, uzaq oyunçular, ölçmə paneli (bu mərhələ; heç biri icra olunmayıb)
- [ ] **Ölçmə paneli**: oyunu `...?perf=1` ilə aç (PC və telefon). Sol altda `calls / tris / geo / tex / prog / shared / remote` görünür; konsolda `bbStats()` eyni rəqəmləri verir. `calls` və `tris` **son çəkilən frame**-dir. Meşə və ev xəritəsində, boş otaqda və 4+ oyunçu ilə yaz. **Nəticə:** PC ___ / Telefon ___
- [ ] **İki cihaz, eyni otaq**: PC-də otaq yarat, telefonda kodla qoşul; hər ikisində oyunçular görünür, otaq kodu və xəritə (`mapSeed`) eynidir, dekor eyni yerlərdədir
- [ ] **Uzaq oyunçu**: iki cihazı xəritənin əks künclərinə apar (məsafə >60 vahid). Uzaq oyunçu görünür və hərəkət edir (daha seyrək yenilənə bilər), amma **itmir, donmur, geriyə atılmır**; yaxınlaşanda hərəkət yenə hamar olur
- [ ] **Uzaq nişan**: uzaq hədəfə atəş — vurğu və zərər adi kimi qeydə alınır (qərar server mövqeyi ilə verilir, client görüntüsü ilə yox). Hiss pisdirsə `INTEREST_CONFIG`-də `nearR/midR` böyüt və ya `enabled=false`
- [ ] **Çıxıb eyni hesabla qayıtmaq**: oyunçu otaqdan çıxır (və ya səhifəni bağlayıb tez qayıdır), 1–2 saniyə içində digər cihazda **dərhal** tam görünür (4 san gözləmə yoxdur)
- [ ] **Oyunçu çıxanda**: 3+ skin-li oyunçudan biri çıxır — qalanların modelləri və silahları yerindədir; `bbStats().sharedModels` / `sharedRefs` (model/istinad) azalır, `geo` artmır
- [ ] **Silah resursları**: `?perf=1` ilə 30 silah dəyişimi; `tex` artmır, `geo` sabit qalır (köhnə silah azad olunur), bir frame boş əl yoxdur
- [ ] **Reconnect / spectator**: şəbəkəni 5 san kəs → qayıt: bütün oyunçular dərhal tam görünür; öləndən sonra izləmə rejimində uzaq oyunçu **tam tezlikli** hərəkət edir
- [ ] **Uzun sessiya**: 20–30 dəq oynadıqdan sonra `bbStats()` başlanğıc/son: `geo`, `tex`, `shared` artımı yoxdur. **Nəticə:** ___
- [ ] **Low / Mid / High**: hər üçündə meşə xəritəsində səma və dekor düzgündür; **Adaptive** kodda yoxdur (yoxlanıla bilməz)

### Phase 5 — külək effektləri (heç biri icra olunmayıb; shader-lər bu mühitdə kompilyasiya edilə bilmədi)
- [ ] **Shader kompilyasiya**: meşə xəritəsini aç, brauzer konsolunda `THREE.WebGLProgram: shader error` və `wind: a shader failed to compile` mesajı **olmamalıdır**. Ağaclar və güllər görünür (qara/yox olmur). **Nəticə:** ___
- [ ] **Yellənmə**: ağacların gövdəsi yerindədir, yuxarı hissəsi küləyin istiqamətində (+x/+z) yumşaq yellənir; güllər ağaclardan daha çox yellənir; qonşu bitkilər eyni anda hərəkət etmir (hər birinin öz fazası var)
- [ ] **Güclənmə (gust)**: bir neçə saniyədən bir yellənmə gücü artır-azalır, toz/yarpaq hissəcikləri sürətlənir. Daşlar, kötüklər, çəpərlər və göbələklər tərpənmir
- [ ] **Hissəciklər**: oyunçunun ətrafında yumşaq, kiçik, küləklə sürüşən hissəciklər; kamera hərəkət edəndə qutunun kənarında qəfil yox olmur/peyda olmur (kənarda solur); hədəfləməyə mane olmur
- [ ] **Keyfiyyət**: Particle Low-da hissəcik yoxdur, Mid/High-da var (telefonda daha az). Yellənmə hər üçündə eynidir
- [ ] **Söndürmə**: `...?wind=0` ilə açanda ağaclar tərpənmir və hissəcik yoxdur (əvvəlki görünüş)
- [ ] **FPS**: `?perf=1` ilə `?wind=0` və adi rejimi müqayisə et (PC və telefon): `calls` +1 (hissəciklər), `tris` dəyişmir; FPS fərqi qeyd et. **Nəticə:** ___
- [ ] **Ev və Purple xəritələri**: külək yoxdur, heç nə dəyişməyib

### Phase 6 — qrafika (kölgə, material, mühit) — heç biri icra olunmayıb
- [ ] **Kölgə (Medium/High)**: Settings → Graphics → Quality. Medium/High-da ağaclar, qayalar və oyunçular yerə kölgə salır, kölgə oyunçu ilə birlikdə hərəkət edir və **titrəmir**. Low-da kölgə yoxdur. Konsolda `shader error` və `graphics: ... falling back` mesajı olmamalıdır. **Nəticə:** ___
- [ ] **Canlı keyfiyyət dəyişməsi**: oyun zamanı Low → High → Low. Hər dəfə şəkil normal qalır (qara/yox olan obyekt yox), konsolda xəta yoxdur. `?perf=1`-də `gfxTier`, `shadows`, `pixelRatio` seçilmiş səviyyəyə uyğundur, `gfxFallback = false`
- [ ] **Telefon**: eyni Quality dəyəri PC-dən bir pillə aşağı davranır (məs. High → Medium kölgə). Qızma/FPS düşməsi qeyd et. **Nəticə:** ___
- [ ] **Təbiət materialı (metalness düzəlişi)**: meşə xəritəsində ağac gövdəsi/yarpaq, qaya, çəpər, kötük **əvvəlkindən açıq** və təbii görünür (artıq metal-qara deyil). Mebel (ev xəritəsi) əvvəlki kimidir. Əvvəlki zip ilə yan-yana müqayisə et. **Nəticə:** ___
- [ ] **Metal mühit**: silahlar, Mjolnir və dəbilqə/Omnitrix Medium/High-da Low-dan **daha az tünd** görünür; ətrafdakı ağac/torpaq/skin işığı dəyişmir (mühit yalnız metal materiallarda). Low-da mühit yoxdur
- [ ] **Silah dəyişdirmə**: 13 silahı ardıcıl dəyiş, heç biri boş/qara görünmür, konsolda xəta yoxdur
- [ ] **Z-fighting və kölgə artefaktları**: yer səthində zolaq/"peterburq" kölgə (acne) və ya obyektin altında kölgə sızması yoxdur; qapı/divar yanında kölgə kəsilmir
- [ ] **FPS müqayisəsi** (`?perf=1`, eyni xəritə/seed): Low vs Medium vs High (PC və telefon): `calls`, `tris`, FPS. **Nəticə:** ___
- [ ] **Dəbilqə**: yaxından baxıb UV/detal qərarı ver (`docs/ASSET_DETAILING_PLAN.md`-də ən yüksək prioritet namizəd)

### Phase 7 — silah materialı, dəbilqə UV, real shader (heç biri oyunda icra olunmayıb)
- [ ] **Silah finish-ləri**: 13 silahı ardıcıl dəyiş; hər biri fərqli finish göstərir (gunmetal, mavi polad, mat qara, bürünc, zeytun, qum...), `weapon_005` neytral (fallback), `weapon_006` və `weapon_008` fərqli rəngdə, heç biri həddindən qara/ağ deyil. **Nəticə:** ___ (qeyd: bu rənglər RECONSTRUCTED dizayn palitrasıdır, orijinal deyil)
- [ ] **Dəbilqə**: alın dəbilqəsində aşınmış metal texture görünür, tikişlər (box proyeksiya) gözə çarpmır/çirkin deyil, dəbilqə əvvəlkindən pis görünmür. Pis görünürsə `public/uvgen.js` bloku `index.html`-də bir şərtlə söndürülə bilər. **Nəticə:** ___
- [ ] **Shader (real three.js-də)**: meşə xəritəsində konsol: `THREE.WebGLProgram: shader error` **olmamalıdır**; ağaclar görünür və yellənir. Bu, `tools/glsl_compile_check.py`-nin əhatə etmədiyi hissədir (three-in tam proqramı). **Nəticə:** ___
- [ ] **Real mobil GPU**: eyni səhnədə hissəciklər görünür (nöqtə ölçüsü limiti), yellənmə dəyişmir
- [ ] **Köhnə shader hesabatı**: GLSL dəyişdirsəniz `python3 tools/glsl_compile_check.py` işlədin, yoxsa `tests/glslreport.js` uğursuz olacaq
