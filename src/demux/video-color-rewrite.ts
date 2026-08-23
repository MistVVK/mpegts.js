export type VideoColorRewriteMode = 'None' | 'ToneMap' | 'SdrInHlg';

export const CICP_BT709_PRIMARIES = 1;
export const CICP_BT709_TRANSFER = 1;
export const CICP_SRGB_TRANSFER = 13;
export const CICP_PQ_TRANSFER = 16;
export const CICP_HLG_TRANSFER = 18;

export type VideoColorTuple = {
    colour_primaries: number;
    transfer_characteristics: number;
    matrix_coeffs: number;
};

export function normalizeVideoColorRewriteMode(mode: unknown): VideoColorRewriteMode {
    if (mode === 'ToneMap' || mode === 'SdrInHlg') {
        return mode;
    }
    return 'None';
}

export function resolveVideoColorRewrite(
    original: VideoColorTuple,
    mode: VideoColorRewriteMode,
): VideoColorTuple {
    const transfer = original.transfer_characteristics;
    if (mode === 'None' || (transfer !== CICP_HLG_TRANSFER && transfer !== CICP_PQ_TRANSFER)) {
        return original;
    }
    // SDR-in-HLG is a signalling reinterpretation of HLG-labelled SDR. PQ is never that case.
    if (mode === 'SdrInHlg') {
        if (transfer !== CICP_HLG_TRANSFER) {
            return original;
        }
        return {
            colour_primaries: original.colour_primaries,
            transfer_characteristics: CICP_BT709_TRANSFER,
            matrix_coeffs: original.matrix_coeffs,
        };
    }
    // ToneMap: keep HLG/PQ code values, but stop the browser HDR display path.
    return {
        colour_primaries: CICP_BT709_PRIMARIES,
        transfer_characteristics: CICP_SRGB_TRANSFER,
        matrix_coeffs: original.matrix_coeffs,
    };
}

export function writeBits(
    bytes: Uint8Array,
    bit_offset: number,
    bit_count: number,
    value: number,
): void {
    for (let index = 0; index < bit_count; index++) {
        const position = bit_offset + index;
        const byte_index = position >> 3;
        const bit_in_byte = 7 - (position & 7);
        const bit = (value >> (bit_count - 1 - index)) & 1;
        if (bit === 1) {
            bytes[byte_index] |= (1 << bit_in_byte);
        } else {
            bytes[byte_index] &= ~(1 << bit_in_byte);
        }
    }
}

export function writeColorTuple(
    bytes: Uint8Array,
    bit_offset: number,
    color: VideoColorTuple,
): void {
    writeBits(bytes, bit_offset, 8, color.colour_primaries);
    writeBits(bytes, bit_offset + 8, 8, color.transfer_characteristics);
    writeBits(bytes, bit_offset + 16, 8, color.matrix_coeffs);
}

export function rbspToEbsp(rbsp: Uint8Array): Uint8Array {
    const output: number[] = [];
    let zero_count = 0;
    for (let index = 0; index < rbsp.byteLength; index++) {
        const value = rbsp[index];
        if (zero_count === 2 && value <= 3) {
            output.push(0x03);
            zero_count = 0;
        }
        output.push(value);
        zero_count = value === 0 ? zero_count + 1 : 0;
    }
    return Uint8Array.from(output);
}

export function colorTuplesEqual(left: VideoColorTuple, right: VideoColorTuple): boolean {
    return left.colour_primaries === right.colour_primaries
        && left.transfer_characteristics === right.transfer_characteristics
        && left.matrix_coeffs === right.matrix_coeffs;
}

export type VideoColorRewriteResult = {
    data: Uint8Array;
    original: VideoColorTuple;
    effective: VideoColorTuple;
    rewritten: boolean;
};

export function applyColorRewriteToBytes(
    bytes: Uint8Array,
    color_bit_offset: number | undefined,
    original: VideoColorTuple,
    mode: VideoColorRewriteMode,
): VideoColorRewriteResult {
    const effective = resolveVideoColorRewrite(original, mode);
    if (color_bit_offset == null || colorTuplesEqual(original, effective)) {
        return {data: bytes, original, effective, rewritten: false};
    }
    const rewritten = bytes.slice();
    writeColorTuple(rewritten, color_bit_offset, effective);
    return {data: rewritten, original, effective, rewritten: true};
}
