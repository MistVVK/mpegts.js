export type VideoColorRewriteMode = 'None' | 'ToneMap' | 'SdrInHlg';
export declare const CICP_BT709_PRIMARIES = 1;
export declare const CICP_BT709_TRANSFER = 1;
export declare const CICP_SRGB_TRANSFER = 13;
export declare const CICP_PQ_TRANSFER = 16;
export declare const CICP_HLG_TRANSFER = 18;
export type VideoColorTuple = {
    colour_primaries: number;
    transfer_characteristics: number;
    matrix_coeffs: number;
};
export declare function normalizeVideoColorRewriteMode(mode: unknown): VideoColorRewriteMode;
export declare function resolveVideoColorRewrite(original: VideoColorTuple, mode: VideoColorRewriteMode): VideoColorTuple;
export declare function writeBits(bytes: Uint8Array, bit_offset: number, bit_count: number, value: number): void;
export declare function writeColorTuple(bytes: Uint8Array, bit_offset: number, color: VideoColorTuple): void;
export declare function rbspToEbsp(rbsp: Uint8Array): Uint8Array;
export declare function colorTuplesEqual(left: VideoColorTuple, right: VideoColorTuple): boolean;
export type VideoColorRewriteResult = {
    data: Uint8Array;
    original: VideoColorTuple;
    effective: VideoColorTuple;
    rewritten: boolean;
};
export declare function applyColorRewriteToBytes(bytes: Uint8Array, color_bit_offset: number | undefined, original: VideoColorTuple, mode: VideoColorRewriteMode): VideoColorRewriteResult;
