// Rebuilds public/sfx/death/manifest.json from the audio files present in that folder.
// Usage: node tools/build_death_manifest.js [dir]   (default: public/sfx/death)
const fs = require('fs'), path = require('path');
const SAFE = /^[A-Za-z0-9_.\-]+\.(wav|mp3|ogg)$/; // the same rule the client applies to manifest entries
function build(dir) {
  const files = fs.readdirSync(dir).filter((f) => SAFE.test(f)).sort();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ files }, null, 2) + '\n');
  return files;
}
module.exports = { build, SAFE };
if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public', 'sfx', 'death'));
  const files = build(dir);
  console.log(files.length + ' death voice file(s) listed in ' + path.join(dir, 'manifest.json'));
  for (const f of files) console.log('  ' + f);
  if (!files.length) console.log('  (none found - add .wav/.mp3/.ogg files to the folder first)');
}
