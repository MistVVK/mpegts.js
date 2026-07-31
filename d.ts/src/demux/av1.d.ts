/**
 * Validate that one tsOBU contains exactly one OBU and make its size explicit
 * for AV1 samples/configOBUs carried in ISO BMFF.
 */
export declare function normalizeAV1OBUForISOBMFF(data: Uint8Array): Uint8Array | null;
/**
 * Validate the mandatory AOM AV1 registration/video descriptor pair.
 *
 * The returned four bytes are normalized for AV1CodecConfigurationRecord:
 * hdr_wcg_idc occupies reserved bits in av1C and is therefore cleared.
 */
export declare function parseAV1MPEG2TSDescriptors(descriptors: Uint8Array): Uint8Array | null;
export declare class AV1OBUInMpegTsParser {
    private readonly payloads_;
    private current_payload_index_;
    private valid_;
    /**
     * Remove MPEG-2 TS emulation-prevention bytes and validate forbidden
     * start-code emulation sequences.
     */
    static ebsp2rbsp(data: Uint8Array): Uint8Array | null;
    constructor(data: Uint8Array);
    isValid(): boolean;
    readNextOBUPayload(): Uint8Array | null;
    private parse;
    private hasStartCodeAt;
    private findNextStartCodeOffset;
}
export default AV1OBUInMpegTsParser;
