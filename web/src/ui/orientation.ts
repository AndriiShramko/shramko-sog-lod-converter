// Scene orientation: the exact math SuperSplat's viewer applies, so the preview shows what the
// published scene will look like.
//
// splat-transform labels PLY data with Transform.PLY = Rz(180°) (PLY → engine space), applies a
// user rotation in ENGINE space (`-r x,y,z`: PlayCanvas Quat.setFromEulerAngles), then the
// SuperSplat viewer places the stored data under an entity rotated Rz(180°). Net effect on screen:
//     world = R_user · Rz(180°) · raw  (+ translation),   Y is up.
// Verified 2026-10-02: our pipeline's output matches `splat-transform -r` to the axis, and a
// top-down render of a Z-up drone scan shows roofs only with X = −90°.

export type Mat3 = Float32Array; // column-major 3×3
export type Vec3T = [number, number, number];

/** PlayCanvas Quat.setFromEulerAngles(ex, ey, ez) (degrees) → column-major rotation matrix. */
export const eulerToMat3 = (ex: number, ey: number, ez: number): Mat3 => {
    const h = (Math.PI / 180) * 0.5;
    const sx = Math.sin(ex * h), cx = Math.cos(ex * h);
    const sy = Math.sin(ey * h), cy = Math.cos(ey * h);
    const sz = Math.sin(ez * h), cz = Math.cos(ez * h);
    const x = sx * cy * cz - cx * sy * sz;
    const y = cx * sy * cz + sx * cy * sz;
    const z = cx * cy * sz - sx * sy * cz;
    const w = cx * cy * cz + sx * sy * sz;
    const m = new Float32Array(9);
    m[0] = 1 - 2 * (y * y + z * z); m[3] = 2 * (x * y - z * w); m[6] = 2 * (x * z + y * w);
    m[1] = 2 * (x * y + z * w); m[4] = 1 - 2 * (x * x + z * z); m[7] = 2 * (y * z - x * w);
    m[2] = 2 * (x * z - y * w); m[5] = 2 * (y * z + x * w); m[8] = 1 - 2 * (x * x + y * y);
    return m;
};

/** Rotation matrix → PlayCanvas Euler angles (degrees), via the engine's Quat.getEulerAngles. */
export const mat3ToEuler = (m: Mat3): Vec3T => {
    // matrix → quaternion (Shepperd)
    const t = m[0] + m[4] + m[8];
    let x, y, z, w;
    if (t > 0) {
        const s = Math.sqrt(t + 1) * 2;
        w = 0.25 * s; x = (m[5] - m[7]) / s; y = (m[6] - m[2]) / s; z = (m[1] - m[3]) / s;
    } else if (m[0] > m[4] && m[0] > m[8]) {
        const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
        w = (m[5] - m[7]) / s; x = 0.25 * s; y = (m[3] + m[1]) / s; z = (m[6] + m[2]) / s;
    } else if (m[4] > m[8]) {
        const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
        w = (m[6] - m[2]) / s; x = (m[3] + m[1]) / s; y = 0.25 * s; z = (m[7] + m[5]) / s;
    } else {
        const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
        w = (m[1] - m[3]) / s; x = (m[6] + m[2]) / s; y = (m[7] + m[5]) / s; z = 0.25 * s;
    }
    let ex, ey, ez;
    const a2 = 2 * (w * y - x * z);
    if (a2 <= -0.99999) { ex = 2 * Math.atan2(x, w); ey = -Math.PI / 2; ez = 0; } else if (a2 >= 0.99999) { ex = 2 * Math.atan2(x, w); ey = Math.PI / 2; ez = 0; } else {
        ex = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
        ey = Math.asin(a2);
        ez = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    }
    const r = (v: number) => {
        let d = Math.round((v * 180) / Math.PI * 100) / 100;
        if (d <= -180) d += 360;
        if (d > 180) d -= 360;
        return d === 0 ? 0 : d; // no -0
    };
    return [r(ex), r(ey), r(ez)];
};

const mul3 = (a: Mat3, b: Mat3): Mat3 => {
    const o = new Float32Array(9);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
    return o;
};

/** Turn the current orientation by `deg` around a WORLD axis (what the user sees on screen). */
export const turnWorld = (euler: Vec3T, axis: 0 | 1 | 2, deg: number): Vec3T => {
    const step: Vec3T = [0, 0, 0];
    step[axis] = deg;
    return mat3ToEuler(mul3(eulerToMat3(...step), eulerToMat3(...euler)));
};

/** R_user · Rz(180°): raw PLY coordinates → what the viewer shows (before translation). */
export const viewMatrix = (euler: Vec3T): Mat3 => {
    const r = eulerToMat3(euler[0], euler[1], euler[2]);
    // Rz(180) negates x and y: multiply r by diag(-1, -1, 1) on the right (negate columns 0 and 1)
    const m = new Float32Array(r);
    for (let i = 0; i < 3; i++) {
        m[i] = -r[i];
        m[3 + i] = -r[3 + i];
    }
    return m;
};

export const apply = (m: Mat3, x: number, y: number, z: number, out: Float32Array, o: number) => {
    out[o] = m[0] * x + m[3] * y + m[6] * z;
    out[o + 1] = m[1] * x + m[4] * y + m[7] * z;
    out[o + 2] = m[2] * x + m[5] * y + m[8] * z;
};

const quantile = (vals: Float32Array, q: number) => {
    const s = Float32Array.from(vals).sort();
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

/** Eigen-decomposition of a symmetric 3×3 (Jacobi). Returns eigenvalues and column eigenvectors. */
const eigSym3 = (a: number[][]) => {
    const A = a.map(r => r.slice());
    const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 30; sweep++) {
        let off = 0;
        for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += A[p][q] * A[p][q];
        if (off < 1e-18) break;
        for (let p = 0; p < 3; p++) {
            for (let q = p + 1; q < 3; q++) {
                if (Math.abs(A[p][q]) < 1e-30) continue;
                const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1), s = t * c;
                for (let k = 0; k < 3; k++) {
                    const akp = A[k][p], akq = A[k][q];
                    A[k][p] = c * akp - s * akq;
                    A[k][q] = s * akp + c * akq;
                }
                for (let k = 0; k < 3; k++) {
                    const apk = A[p][k], aqk = A[q][k];
                    A[p][k] = c * apk - s * aqk;
                    A[q][k] = s * apk + c * aqk;
                }
                for (let k = 0; k < 3; k++) {
                    const vkp = V[k][p], vkq = V[k][q];
                    V[k][p] = c * vkp - s * vkq;
                    V[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    return { values: [A[0][0], A[1][1], A[2][2]], vectors: [0, 1, 2].map(j => [V[0][j], V[1][j], V[2][j]]) };
};

export interface AutoOrient {
    euler: Vec3T;
    confident: boolean;
    upAxis: string; // e.g. "+Z" in raw file coordinates
}

/**
 * Guess which way is up: the thinnest axis of the scene (aerial scans, streets, rooms are wider
 * than tall), oriented towards the longer tail of the distribution (buildings and trees stand on
 * dense ground). Only a suggestion — the user confirms it in the preview.
 */
export const autoOrient = (raw: Float32Array, n: number): AutoOrient => {
    // engine space = Rz(180)·raw: (-x, -y, z)
    const E = new Float32Array(n * 3);
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < n; i++) {
        E[i * 3] = -raw[i * 3]; E[i * 3 + 1] = -raw[i * 3 + 1]; E[i * 3 + 2] = raw[i * 3 + 2];
        mx += E[i * 3]; my += E[i * 3 + 1]; mz += E[i * 3 + 2];
    }
    mx /= n; my /= n; mz /= n;
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) {
        const d = [E[i * 3] - mx, E[i * 3 + 1] - my, E[i * 3 + 2] - mz];
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += d[a] * d[b];
    }
    const { values, vectors } = eigSym3(C);
    const order = [0, 1, 2].sort((a, b) => values[a] - values[b]);
    const thin = vectors[order[0]];
    const ratio = Math.sqrt(Math.max(0, values[order[0]]) / Math.max(1e-12, values[order[1]]));
    // snap to the nearest engine axis
    let axis = 0;
    for (let k = 1; k < 3; k++) if (Math.abs(thin[k]) > Math.abs(thin[axis])) axis = k;
    const aligned = Math.abs(thin[axis]) > 0.85;
    // sign: longer tail = up
    const vals = new Float32Array(n);
    for (let i = 0; i < n; i++) vals[i] = E[i * 3 + axis];
    const q02 = quantile(vals, 0.02), q50 = quantile(vals, 0.5), q98 = quantile(vals, 0.98);
    // two weak cues for the sign, each wrong on some real scans (hilly ground, reflections):
    // (a) the longer tail points up (buildings, trees on top of the ground)
    const tail = (q98 - q50) >= (q50 - q02) ? 1 : -1;
    // (b) density falls off sharply under the ground and slowly above it
    const fall = densityFalloffSign(vals);
    const sign = tail;
    const agree = fall === tail;
    // rotation (engine Euler) that brings the engine axis (axis, sign) to +Y
    const table: Record<string, Vec3T> = {
        '0+': [0, 0, 90], '0-': [0, 0, -90],
        '1+': [0, 0, 0], '1-': [180, 0, 0],
        '2+': [-90, 0, 0], '2-': [90, 0, 0]
    };
    const euler = table[`${axis}${sign > 0 ? '+' : '-'}`];
    // name the axis in RAW file coordinates (engine x,y = -raw x,y)
    const rawSign = axis === 2 ? sign : -sign;
    const upAxis = `${rawSign > 0 ? '+' : '−'}${'XYZ'[axis]}`;
    return { euler, confident: aligned && ratio < 0.6 && agree, upAxis };
};

const densityFalloffSign = (vals: Float32Array): number => {
    const lo = quantile(vals, 0.005), hi = quantile(vals, 0.995);
    const bins = 200, h = new Float32Array(bins);
    const w = (hi - lo) / bins || 1;
    for (let i = 0; i < vals.length; i++) {
        const b = Math.floor((vals[i] - lo) / w);
        if (b >= 0 && b < bins) h[b]++;
    }
    const sm = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
        let s = 0, c = 0;
        for (let k = -2; k <= 2; k++) if (i + k >= 0 && i + k < bins) { s += h[i + k]; c++; }
        sm[i] = s / c;
    }
    let k = 0;
    for (let i = 1; i < bins; i++) if (sm[i] > sm[k]) k = i;
    let l = k, r = k;
    while (l > 0 && sm[l] > 0.1 * sm[k]) l--;
    while (r < bins - 1 && sm[r] > 0.1 * sm[k]) r++;
    return r - k > k - l ? 1 : -1;
};

/** Translation that puts the scene's centre at the origin and its ground at y = 0 (after rotation). */
export const centreTranslation = (raw: Float32Array, n: number, euler: Vec3T): Vec3T => {
    const m = viewMatrix(euler);
    const w = new Float32Array(3);
    const xs = new Float32Array(n), ys = new Float32Array(n), zs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        apply(m, raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2], w, 0);
        xs[i] = w[0]; ys[i] = w[1]; zs[i] = w[2];
    }
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return [r(-quantile(xs, 0.5)), r(-quantile(ys, 0.01)), r(-quantile(zs, 0.5))];
};
