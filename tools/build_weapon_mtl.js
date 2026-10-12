// Writes the RECONSTRUCTED "all weapons.mtl" next to the OBJ files that reference it (public/models/weapons and public/models/weapons/split).
// Source of truth: public/weaponmat.js. Usage: node tools/build_weapon_mtl.js
const fs = require('fs'), path = require('path');
const WM = require(path.join(__dirname, '..', 'public', 'weaponmat.js'));
const DIRS = ['public/models/weapons', 'public/models/weapons/split'].map((d) => path.join(__dirname, '..', d));
function build() { const text = WM.toMtl(); for (const d of DIRS) fs.writeFileSync(path.join(d, 'all weapons.mtl'), text); return text; }
module.exports = { build, DIRS };
if (require.main === module) { const t = build(); console.log('wrote "all weapons.mtl" (RECONSTRUCTED) x' + DIRS.length + ', ' + t.split('\n').filter((l) => l.startsWith('newmtl')).length + ' materials'); }
