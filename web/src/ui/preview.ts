// Lightweight scene preview for choosing orientation before converting.
//
// A giant scene is never loaded: a few hundred thousand splats are sampled from blocks spread
// across the file (a few tens of MB read, seconds even for 17 GB) and drawn as coloured points
// with WebGL2 — fine on any laptop. The view uses the same transform SuperSplat applies
// (see orientation.ts), with Y up, a ground grid and axes, so "upright here" = "upright there".

import { viewMatrix, type Vec3T } from './orientation';
import type { PreviewSample } from './preview-sample';

const VS = `#version 300 es
in vec3 aPos;
in vec3 aCol;
uniform mat4 uViewProj;
uniform mat3 uModel;
uniform vec3 uMove;
uniform float uSize;
out vec3 vCol;
void main() {
    vec3 w = uModel * aPos + uMove;
    gl_Position = uViewProj * vec4(w, 1.0);
    gl_PointSize = uSize;
    vCol = aCol;
}`;
const FS = `#version 300 es
precision mediump float;
in vec3 vCol;
out vec4 o;
void main() { o = vec4(vCol, 1.0); }`;
const LVS = `#version 300 es
in vec3 aPos;
in vec3 aCol;
uniform mat4 uViewProj;
out vec3 vCol;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); vCol = aCol; }`;

const compile = (gl: WebGL2RenderingContext, vs: string, fs: string) => {
    const p = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
        gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    return p;
};

// column-major 4×4 helpers
const perspective = (fovy: number, aspect: number, near: number, far: number) => {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
};
const lookAt = (eye: number[], target: number[], up: number[]) => {
    const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
        -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
};
const mul4 = (a: Float32Array, b: Float32Array) => {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
    }
    return o;
};
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
};

export class PreviewView {
    private gl: WebGL2RenderingContext;
    private prog: WebGLProgram;
    private lineProg: WebGLProgram;
    private vao: WebGLVertexArrayObject;
    private lineVao: WebGLVertexArrayObject;
    private lineBuf: WebGLBuffer;
    private lineCount = 0;
    private count = 0;
    private euler: Vec3T = [0, 0, 0];
    private move: Vec3T = [0, 0, 0];
    private yaw = 0.6;
    private pitch = 0.5;
    private dist = 1;
    private centre = [0, 0, 0];
    private radius = 1;
    private sample: PreviewSample | null = null;
    private frame = 0;

    constructor(private canvas: HTMLCanvasElement) {
        const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
        if (!gl) throw new Error('WebGL2 is not available');
        this.gl = gl;
        this.prog = compile(gl, VS, FS);
        this.lineProg = compile(gl, LVS, FS);
        this.vao = gl.createVertexArray()!;
        this.lineVao = gl.createVertexArray()!;
        this.lineBuf = gl.createBuffer()!;
        this.bindControls();
    }

    setSample(s: PreviewSample) {
        const gl = this.gl;
        this.sample = s;
        this.count = s.count;
        gl.bindVertexArray(this.vao);
        const pb = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, pb);
        gl.bufferData(gl.ARRAY_BUFFER, s.raw, gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(this.prog, 'aPos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
        const cb = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, cb);
        gl.bufferData(gl.ARRAY_BUFFER, s.color, gl.STATIC_DRAW);
        const aCol = gl.getAttribLocation(this.prog, 'aCol');
        gl.enableVertexAttribArray(aCol);
        gl.vertexAttribPointer(aCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);
        gl.bindVertexArray(null);
        this.refit();
    }

    setTransform(euler: Vec3T, move: Vec3T) {
        this.euler = euler;
        this.move = move;
        this.refit();
    }

    /** Frame the transformed sample and rebuild the ground grid at its lowest level. */
    private refit() {
        const s = this.sample;
        if (!s) return;
        const m = viewMatrix(this.euler);
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        const ys: number[] = [];
        const step = Math.max(1, Math.floor(s.count / 20000));
        for (let i = 0; i < s.count; i += step) {
            const x = s.raw[i * 3], y = s.raw[i * 3 + 1], z = s.raw[i * 3 + 2];
            const w = [m[0] * x + m[3] * y + m[6] * z + this.move[0], m[1] * x + m[4] * y + m[7] * z + this.move[1], m[2] * x + m[5] * y + m[8] * z + this.move[2]];
            for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
            ys.push(w[1]);
        }
        ys.sort((a, b) => a - b);
        const ground = ys[Math.floor(ys.length * 0.02)] ?? 0;
        this.centre = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        this.radius = Math.max(1e-3, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
        this.dist = this.radius * 2.2;
        this.buildLines(ground);
        this.draw();
    }

    private buildLines(groundY: number) {
        const gl = this.gl;
        const v: number[] = [];
        const R = this.radius * 1.2, [cx, , cz] = this.centre, N = 10;
        const g = [0.25, 0.3, 0.36];
        for (let i = -N; i <= N; i++) {
            const t = (i / N) * R;
            v.push(cx - R, groundY, cz + t, ...g, cx + R, groundY, cz + t, ...g);
            v.push(cx + t, groundY, cz - R, ...g, cx + t, groundY, cz + R, ...g);
        }
        // axes at the scene centre on the ground: X red, Y (up) green, Z blue
        const a = this.radius * 0.35;
        const o = [cx, groundY, cz];
        v.push(...o, 1, 0.3, 0.3, o[0] + a, o[1], o[2], 1, 0.3, 0.3);
        v.push(...o, 0.3, 1, 0.4, o[0], o[1] + a, o[2], 0.3, 1, 0.4);
        v.push(...o, 0.4, 0.6, 1, o[0], o[1], o[2] + a, 0.4, 0.6, 1);
        const data = new Float32Array(v);
        this.lineCount = data.length / 6;
        gl.bindVertexArray(this.lineVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        const aPos = gl.getAttribLocation(this.lineProg, 'aPos');
        const aCol = gl.getAttribLocation(this.lineProg, 'aCol');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(aCol);
        gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 24, 12);
        gl.bindVertexArray(null);
    }

    draw() {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.render());
    }

    private render() {
        const gl = this.gl;
        const c = this.canvas;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        gl.viewport(0, 0, w, h);
        gl.clearColor(0.043, 0.051, 0.063, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        const eye = [
            this.centre[0] + this.dist * Math.cos(this.pitch) * Math.sin(this.yaw),
            this.centre[1] + this.dist * Math.sin(this.pitch),
            this.centre[2] + this.dist * Math.cos(this.pitch) * Math.cos(this.yaw)
        ];
        const vp = mul4(perspective(Math.PI / 4, w / h, this.radius * 0.01, this.radius * 20), lookAt(eye, this.centre, [0, 1, 0]));
        gl.useProgram(this.lineProg);
        gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uViewProj'), false, vp);
        gl.bindVertexArray(this.lineVao);
        gl.drawArrays(gl.LINES, 0, this.lineCount);
        if (this.count > 0) {
            gl.useProgram(this.prog);
            gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uViewProj'), false, vp);
            gl.uniformMatrix3fv(gl.getUniformLocation(this.prog, 'uModel'), false, viewMatrix(this.euler));
            gl.uniform3fv(gl.getUniformLocation(this.prog, 'uMove'), this.move);
            gl.uniform1f(gl.getUniformLocation(this.prog, 'uSize'), Math.max(1.5, 2 * dpr));
            gl.bindVertexArray(this.vao);
            gl.drawArrays(gl.POINTS, 0, this.count);
        }
        gl.bindVertexArray(null);
    }

    private bindControls() {
        const c = this.canvas;
        let drag: { x: number; y: number } | null = null;
        c.addEventListener('pointerdown', (e) => {
            drag = { x: e.clientX, y: e.clientY };
            c.setPointerCapture(e.pointerId);
        });
        c.addEventListener('pointermove', (e) => {
            if (!drag) return;
            this.yaw -= (e.clientX - drag.x) * 0.008;
            this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + (e.clientY - drag.y) * 0.008));
            drag = { x: e.clientX, y: e.clientY };
            this.draw();
        });
        const end = () => { drag = null; };
        c.addEventListener('pointerup', end);
        c.addEventListener('pointercancel', end);
        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.dist = Math.max(this.radius * 0.1, Math.min(this.radius * 8, this.dist * Math.exp(e.deltaY * 0.001)));
            this.draw();
        }, { passive: false });
        c.addEventListener('dblclick', () => {
            this.yaw = 0.6;
            this.pitch = 0.5;
            this.dist = this.radius * 2.2;
            this.draw();
        });
        new ResizeObserver(() => this.draw()).observe(c);
    }

    /** Preset camera: from the side (horizon level) or from above. */
    view(kind: 'side' | 'top') {
        this.pitch = kind === 'top' ? 1.45 : 0.08;
        this.draw();
    }
}
