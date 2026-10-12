DEATH VOICES
============
Put your own audio files here (.wav / .mp3 / .ogg) - only files you recorded or have the right to use.
No audio ships with the game, so by default nothing plays on death.

1. Copy the files into this folder (simple names: letters, digits, _ . - only; e.g. death_1.mp3 ... death_6.mp3).
2. From the project root run:   node tools/build_death_manifest.js
   It rewrites manifest.json with the files it found.
3. Reload the game. When a player dies, one voice is picked at random (never the same one twice in a row).
   Your own death plays at full volume; other players' deaths get quieter with distance (silent beyond 40 units).
   Volume follows Settings: Master x SFX.
