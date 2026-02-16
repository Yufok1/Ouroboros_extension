const fs = require('fs');
const zlib = require('zlib');

if (fs.existsSync('champion_gen8.py')) {
    const data = zlib.gzipSync(fs.readFileSync('champion_gen8.py'));
    fs.writeFileSync('resources/capsule.gz', data);
    console.log('Compressed capsule:', data.length, 'bytes');
} else {
    console.log('No champion_gen8.py found, skipping compression');
}
