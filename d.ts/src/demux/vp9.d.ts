/**
 * Project-private VP9 mapping v1 descriptor pair.
 *
 * "VP09" is intentionally used as an unregistered project-private marker. It
 * must not be interpreted as a registered SMPTE registration identifier.
 */
export declare const VP9_PRIVATE_MAPPING_V1_DESCRIPTORS: Uint8Array<ArrayBuffer>;
/**
 * Return true only for the exact project-private mapping v1 descriptor pair.
 *
 * The private descriptor must immediately follow the registration descriptor.
 * Unknown versions, flags, and non-zero reserved fields are deliberately
 * rejected.
 */
export declare function hasVP9PrivateMappingV1(descriptors: Uint8Array): boolean;
export interface VP9CodecConfiguration {
    profile: number;
    level: number;
    bitDepth: number;
    chromaSubsampling: number;
    videoFullRangeFlag: number;
    colourPrimaries: number;
    transferCharacteristics: number;
    matrixCoefficients: number;
    codecWidth: number;
    codecHeight: number;
    presentWidth: number;
    presentHeight: number;
}
export interface VP9FrameHeader {
    profile: number;
    isKeyframe: boolean;
    isIntraOnly: boolean;
    showFrame: boolean;
    showExistingFrame: boolean;
    config?: VP9CodecConfiguration;
}
export interface VP9SampleLayout {
    frames: Uint8Array[];
    isSuperframe: boolean;
}
/**
 * Derive the lowest VP9 level that can carry the coded size at an assumed
 * 60fps. The private mapping has no timing or bitrate field, so level 0 is not
 * emitted: an unsupported picture size is rejected instead.
 */
export declare function deriveVP9Level(width: number, height: number): number | undefined;
/**
 * Validate and split a VP9 superframe index without changing sample bytes.
 *
 * A payload without a superframe marker is returned as one frame. If the last
 * byte looks like a superframe marker, the complete index must be valid.
 */
export declare function parseVP9SampleLayout(data: Uint8Array): VP9SampleLayout | null;
/**
 * Parse the fields needed to identify random access points and build vpcC.
 *
 * A regular inter frame does not repeat color or size configuration. In that
 * case the previous key/intra-only configuration is returned when its profile
 * matches.
 */
export declare function parseVP9FrameHeader(data: Uint8Array, previous_config?: VP9CodecConfiguration): VP9FrameHeader | null;
export declare function buildVP9CodecString(config: VP9CodecConfiguration): string;
/**
 * Build VPCodecConfigurationRecord. The vpcC FullBox header is added by the
 * MP4 generator.
 */
export declare function buildVP9CodecConfigurationRecord(config: VP9CodecConfiguration): Uint8Array;
export declare function buildVP9VideoDetails(config: VP9CodecConfiguration): any;
