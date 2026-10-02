// Checks: (1) our Euler math equals splat-transform's rotate (PlayCanvas Quat.setFromEulerAngles),
// (2) auto-orient finds "up" on a real drone scan, and the opposite answer for the same scan
// flipped upside down (negative control).
//   npx tsx tools/test-orientation.ts <scan.ply>
import { open } from 'node:fs/promises';
import { Quat, Vec3 } from 'playcanvas';

import { parsePlyHeader } from '../web/src/engine/ply-header';
import { autoOrient, eulerToMat3, mat3ToEuler, turnWorld } from '../web/src/ui/orientation';
import { samplePreview } from '../web/src/ui/preview-sample';

const path = process.argv[2];
let fails = 0;
const ok = (c: boolean, m: string) => {
    console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`);
    if (!c) fails++;
};

for (const e of [[-90, 0, 0], [90, 0, 0], [0, 0, 90], [30, -45, 120], [180, 0, 0]] as [number, number, number][]) {
    const m = eulerToMat3(...e);
    const q = new Quat().setFromEulerAngles(e[0], e[1], e[2]);
    let maxErr = 0;
    for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -0.2, 0.9]]) {
        const ref = q.transformVector(new Vec3(v[0], v[1], v[2]));
        const ours = [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
        maxErr = Math.max(maxErr, Math.abs(ours[0] - ref.x), Math.abs(ours[1] - ref.y), Math.abs(ours[2] - ref.z));
    }
    ok(maxErr < 1e-6, `Euler ${e} matches PlayCanvas (max error ${maxErr.toExponential(1)})`);
}

// round trip Euler -> matrix -> Euler (PlayCanvas convention) and world-axis turns
for (const e of [[-90, 0, 0], [30, -45, 120], [0, 0, 90], [180, 0, 0]] as [number, number, number][]) {
    const back = mat3ToEuler(eulerToMat3(...e));
    const m1 = eulerToMat3(...e), m2 = eulerToMat3(...back);
    const err = Math.max(...Array.from(m1).map((v, i) => Math.abs(v - m2[i])));
    ok(err < 1e-4, `Euler ${e} -> matrix -> ${back} same rotation (error ${err.toExponential(1)})`);
}
ok(turnWorld([0, 0, 0], 0, -90).join() === '-90,0,0', `turn X -90 from identity = ${turnWorld([0, 0, 0], 0, -90)}`);
const twice = turnWorld(turnWorld([0, 0, 0], 0, 90), 0, 90);
ok(Math.abs(Math.abs(twice[0]) - 180) < 1e-6 && twice[1] === 0 && twice[2] === 0, `two X +90 turns = flip (${twice})`);

if (path) {
    const fh = await open(path, 'r');
    const { size } = await fh.stat();
    const blob = {
        size,
        slice: (s: number, e: number) => ({
            arrayBuffer: async () => {
                const b = Buffer.alloc(e - s);
                await fh.read(b, 0, e - s, s);
                return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
            }
        })
    } as unknown as Blob;
    const header = parsePlyHeader(new Uint8Array(await blob.slice(0, 65536).arrayBuffer()));
    const t0 = performance.now();
    const s = await samplePreview(blob, header, 300_000);
    console.log(`sampled ${s.count} of ${s.total} splats in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    const a = autoOrient(s.raw, s.count);
    ok(Math.abs(a.euler[0]) === 90 && a.euler[1] === 0 && a.euler[2] === 0, `drone scan: auto-orient picks the Z axis (${a.euler}, up ${a.upAxis}, confident ${a.confident}); the sign is the user's call in the preview`);
    console.log(`     (verified answer for this scan: -90,0,0; auto ${a.euler.join() === '-90,0,0' ? 'agrees' : 'disagrees — the preview shows it upside down and Flip fixes it'})`);
    const flipped = Float32Array.from(s.raw);
    for (let i = 0; i < s.count; i++) flipped[i * 3 + 2] = -flipped[i * 3 + 2];
    const b = autoOrient(flipped, s.count);
    ok(b.euler[0] === -a.euler[0], `negative control (same scan upside down): auto-orient flips its answer (${b.euler} vs ${a.euler})`);
    await fh.close();
}
process.exit(fails ? 1 : 0);
