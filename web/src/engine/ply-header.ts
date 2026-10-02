// Parses the header of a 3D Gaussian Splatting PLY without reading the body, and describes
// how to pull the standard splat properties out of each binary record.
//
// Only the header bytes are needed (the caller passes the first few hundred KB of the file).
// The body is never touched here — the router streams it later.

export type PlyFormat = 'binary_little_endian' | 'binary_big_endian';

export interface PlyProperty {
    name: string;
    type: PlyScalarType;
    size: number;
    offset: number; // byte offset inside one vertex record
}

export type PlyScalarType = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

export interface PlyHeader {
    format: PlyFormat;
    vertexCount: number;
    properties: PlyProperty[];
    stride: number;          // bytes per vertex record
    headerBytes: number;     // bytes up to and including "end_header\n"
    bodyOffset: number;      // byte offset of the first vertex record (after any earlier elements)
    comments: string[];
    shRestCount: number;     // number of f_rest_* properties (0, 9, 24 or 45)
    shBands: 0 | 1 | 2 | 3;
    is2dgs: boolean;         // no scale_2 → 2D Gaussian splatting
    extraProperties: string[]; // properties that are not part of the splat (e.g. nx, ny, nz)
}

const TYPE_ALIASES: Record<string, PlyScalarType> = {
    char: 'int8', int8: 'int8',
    uchar: 'uint8', uint8: 'uint8',
    short: 'int16', int16: 'int16',
    ushort: 'uint16', uint16: 'uint16',
    int: 'int32', int32: 'int32',
    uint: 'uint32', uint32: 'uint32',
    float: 'float32', float32: 'float32',
    double: 'float64', float64: 'float64'
};

const TYPE_SIZES: Record<PlyScalarType, number> = {
    int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8
};

const SH_REST_COUNTS = [0, 9, 24, 45];

/** Thrown for inputs we cannot convert; `code` is stable for the UI and error reports. */
export class InputError extends Error {
    code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'InputError';
        this.code = code;
    }
}

/**
 * Parse a PLY header. `bytes` must contain at least the whole header.
 * @param bytes - The first bytes of the file (256 KB is plenty for any splat PLY).
 */
export const parsePlyHeader = (bytes: Uint8Array): PlyHeader => {
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
    if (magic !== 'ply') {
        throw new InputError('not-ply', 'This file is not a PLY file (it does not start with "ply").');
    }

    // find "end_header" followed by \n (or \r\n)
    const text = new TextDecoder('latin1').decode(bytes);
    const endIdx = text.indexOf('end_header');
    if (endIdx < 0) {
        throw new InputError('header-too-long', 'Could not find the end of the PLY header in the first part of the file.');
    }
    let headerBytes = endIdx + 'end_header'.length;
    if (text[headerBytes] === '\r') headerBytes++;
    if (text[headerBytes] !== '\n') {
        throw new InputError('bad-header', 'The PLY header is malformed (no newline after end_header).');
    }
    headerBytes++;

    const lines = text.substring(0, endIdx).split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

    let format: PlyFormat | null = null;
    const comments: string[] = [];
    type Element = { name: string; count: number; props: { name: string; type: PlyScalarType }[]; hasList: boolean };
    const elements: Element[] = [];

    for (const line of lines.slice(1)) {
        const words = line.split(/\s+/);
        switch (words[0]) {
            case 'format':
                if (words[1] === 'ascii') {
                    throw new InputError('ascii-ply', 'ASCII PLY is not supported. Export a binary PLY from your training tool.');
                }
                if (words[1] !== 'binary_little_endian' && words[1] !== 'binary_big_endian') {
                    throw new InputError('bad-format', `Unknown PLY format "${words[1]}".`);
                }
                format = words[1];
                break;
            case 'comment':
                comments.push(line.substring('comment'.length).trim());
                break;
            case 'obj_info':
                break;
            case 'element':
                elements.push({ name: words[1], count: parseInt(words[2], 10), props: [], hasList: false });
                break;
            case 'property': {
                const el = elements[elements.length - 1];
                if (!el) throw new InputError('bad-header', 'PLY property declared before any element.');
                if (words[1] === 'list') {
                    el.hasList = true;
                    break;
                }
                const type = TYPE_ALIASES[words[1]];
                if (!type) throw new InputError('bad-header', `Unknown PLY property type "${words[1]}".`);
                el.props.push({ name: words[2], type });
                break;
            }
            default:
                // tolerate unknown keywords
                break;
        }
    }

    if (!format) throw new InputError('bad-header', 'The PLY header has no format line.');

    const vertexIdx = elements.findIndex(e => e.name === 'vertex');
    if (vertexIdx < 0) {
        if (elements.some(e => e.name === 'chunk')) {
            throw new InputError('compressed-ply', 'This is a compressed PLY (SuperSplat .compressed.ply). Please use the original uncompressed PLY.');
        }
        throw new InputError('no-vertex', 'The PLY has no "vertex" element, so it holds no splats.');
    }
    if (elements.some(e => e.name === 'chunk')) {
        throw new InputError('compressed-ply', 'This is a compressed PLY (SuperSplat .compressed.ply). Please use the original uncompressed PLY.');
    }

    // byte offset of the vertex body: skip earlier fixed-size elements
    let bodyOffset = headerBytes;
    for (let i = 0; i < vertexIdx; i++) {
        const el = elements[i];
        if (el.hasList) throw new InputError('unsupported-layout', `The PLY element "${el.name}" before the splats has list properties; this layout is not supported.`);
        bodyOffset += el.count * el.props.reduce((a, p) => a + TYPE_SIZES[p.type], 0);
    }

    const vertex = elements[vertexIdx];
    if (vertex.hasList) {
        throw new InputError('unsupported-layout', 'The PLY vertex element has list properties; this is not a Gaussian splat PLY.');
    }
    if (!Number.isFinite(vertex.count) || vertex.count <= 0) {
        throw new InputError('empty', 'The PLY declares zero splats.');
    }

    let offset = 0;
    const properties: PlyProperty[] = vertex.props.map((p) => {
        const prop = { name: p.name, type: p.type, size: TYPE_SIZES[p.type], offset };
        offset += prop.size;
        return prop;
    });
    const names = new Set(properties.map(p => p.name));

    const required = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    const missing = required.filter(n => !names.has(n));
    if (missing.length > 0) {
        throw new InputError('not-splat', `This PLY is not a Gaussian splat: it lacks ${missing.join(', ')}. (A plain point cloud or mesh cannot be converted.)`);
    }

    let shRestCount = 0;
    while (names.has(`f_rest_${shRestCount}`)) shRestCount++;
    if (!SH_REST_COUNTS.includes(shRestCount)) {
        throw new InputError('bad-sh', `Unexpected number of spherical-harmonic coefficients (f_rest_*): ${shRestCount}. Expected 0, 9, 24 or 45.`);
    }

    const standard = new Set([...required, 'scale_2', ...Array.from({ length: shRestCount }, (_, i) => `f_rest_${i}`)]);
    const extraProperties = properties.map(p => p.name).filter(n => !standard.has(n));

    return {
        format,
        vertexCount: vertex.count,
        properties,
        stride: offset,
        headerBytes,
        bodyOffset,
        comments,
        shRestCount,
        shBands: SH_REST_COUNTS.indexOf(shRestCount) as 0 | 1 | 2 | 3,
        is2dgs: !names.has('scale_2'),
        extraProperties
    };
};

/**
 * Names, in output order, of the properties we keep for every splat. Extra columns such as
 * normals are dropped — they are not part of the splat and SOG never stores them.
 */
export const keptPropertyNames = (header: PlyHeader): string[] => {
    const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
    for (let i = 0; i < header.shRestCount; i++) names.push(`f_rest_${i}`);
    names.push('opacity', 'scale_0', 'scale_1');
    if (!header.is2dgs) names.push('scale_2');
    names.push('rot_0', 'rot_1', 'rot_2', 'rot_3');
    return names;
};

/** Comments that change how the splat is evaluated and therefore must survive into the tiles. */
export const modelComments = (header: PlyHeader): string[] => {
    return header.comments.filter(c => /SplatRenderMode|antialiased/i.test(c));
};

/** Build a canonical little-endian float32 PLY header for `count` splats with `props`. */
export const buildPlyHeader = (count: number, props: string[], comments: string[]): Uint8Array => {
    const lines = ['ply', 'format binary_little_endian 1.0'];
    for (const c of comments) lines.push(`comment ${c}`);
    lines.push(`element vertex ${count}`);
    for (const p of props) lines.push(`property float ${p}`);
    lines.push('end_header');
    return new TextEncoder().encode(`${lines.join('\n')}\n`);
};
