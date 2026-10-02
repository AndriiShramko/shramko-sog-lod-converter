// After `vite build`: write dist/release.json with a content hash of the build, so the page,
// error reports and the deploy script all name the same release.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = process.env.SOG_OUT ? join(process.cwd(), process.env.SOG_OUT) : fileURLToPath(new URL('../../dist/', import.meta.url));
const files = [];
const walk = (d) => {
    for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (!p.endsWith('.map') && !p.endsWith('release.json')) files.push(p);
    }
};
walk(dist);
files.sort();
const h = createHash('sha256');
for (const f of files) {
    h.update(relative(dist, f).split('\\').join('/'));
    h.update(readFileSync(f));
}
const sha = h.digest('hex').substring(0, 12);
writeFileSync(join(dist, 'release.json'), `${JSON.stringify({ sha, built: new Date().toISOString() })}\n`);
console.log(`release ${sha} (${files.length} files)`);
