/**
 * AV1 の構文解析では、切断データを 0 埋めされた値として扱ってはいけない。
 * 既存の ExpGolomb は H.26x 向けの互換挙動として末尾の部分 word を返すため、
 * AV1 専用の境界検査付き bit reader を使用する。
 */
import { type VideoColorRewriteMode, type VideoColorTuple } from './video-color-rewrite';
declare class AV1BitReader {
    private readonly data_;
    private bit_offset_;
    constructor(data: Uint8Array);
    readBits(bits: number): number;
    readBool(): boolean;
    getBitOffset(): number;
    readUEG(): number;
    destroy(): void;
}
type OperatingPoint = {
    operating_point_idc: number;
    level: number;
    tier: number;
    decoder_model_present_for_this_op?: boolean;
};
type SequenceHeaderDetails = {
    frame_id_numbers_present_flag: boolean;
    additional_frame_id_length_minus_1?: number;
    delta_frame_id_length_minus_2?: number;
    reduced_still_picture_header: boolean;
    decoder_model_info_present_flag: boolean;
    operating_points_cnt_minus_1?: number;
    operating_points: OperatingPoint[];
    buffer_removal_time_length_minus_1: number;
    frame_presentation_time_length_minus_1: number;
    equal_picture_interval: boolean;
    seq_force_screen_content_tools: number;
    seq_force_integer_mv: number;
    enable_order_hint: boolean;
    order_hint_bits: number;
    enable_superres: boolean;
    frame_width_bit: number;
    frame_height_bit: number;
    max_frame_width: number;
    max_frame_height: number;
};
type FrameResolutions = {
    UpscaledWidth: number;
    FrameWidth: number;
    FrameHeight: number;
    RenderWidth: number;
    RenderHeight: number;
};
export type AV1Metadata = {
    codec_mimetype: string;
    level: number;
    level_string: string;
    tier: number;
    profile_idc: number;
    profile_string: string;
    bit_depth: number;
    ref_frames: number;
    chroma_format: number;
    chroma_format_string: string;
    mono_chrome: boolean;
    subsampling_x: number;
    subsampling_y: number;
    chroma_sample_position: number;
    ref_sample_duration: number;
    sequence_header: SequenceHeaderDetails;
    sequence_header_data: Uint8Array;
    colour_primaries?: number;
    transfer_characteristics?: number;
    matrix_coeffs?: number;
    color_bit_offset?: number;
    keyframe?: boolean;
    frame_rate: {
        fixed: boolean;
        fps: number;
        fps_den: number;
        fps_num: number;
    };
    sar_ratio?: {
        width: number;
        height: number;
    };
    codec_size?: {
        width: number;
        height: number;
    };
    present_size?: {
        width: number;
        height: number;
    };
};
export type AV1OBUParseResult = {
    valid: boolean;
    metadata: AV1Metadata | null;
    hasSequenceHeader: boolean;
    hasFrame: boolean;
    isKeyframe: boolean;
};
declare class AV1OBUParser {
    static parseOBUs(uint8array: Uint8Array, meta?: AV1Metadata | null): AV1Metadata | null;
    static parseOBUsWithStatus(uint8array: Uint8Array, meta?: AV1Metadata | null): AV1OBUParseResult;
    static parseSeuqneceHeader(uint8array: Uint8Array): Omit<AV1Metadata, 'sequence_header_data'>;
    static parseOBUFrameHeader(uint8array: Uint8Array, temporal_id: number, spatial_id: number, meta: AV1Metadata): AV1Metadata;
    /**
     * TS 上の codec / render size から present_size と整数 SAR を確定する。
     * SAR はビットストリームの値のみを使い、解像度に応じた固定補完はしない。
     * 壊れた render size だけ codec size にフォールバックする。
     */
    static applyPresentationSize(result: AV1Metadata, frame_width: number, frame_height: number, render_width: number, render_height: number): void;
    static gcd(a: number, b: number): number;
    static frameSizeAndRenderSize(gb: AV1BitReader, frame_size_override_flag: boolean, sequence_header: SequenceHeaderDetails): FrameResolutions;
    static getLevelString(level: number, tier: number): string;
    static getChromaFormat(mono_chrome: boolean, subsampling_x: number, subsampling_y: number): number;
    static getChromaFormatString(mono_chrome: boolean, subsampling_x: number, subsampling_y: number): string;
    static rewriteSequenceHeaderOBU(obu: Uint8Array, mode: VideoColorRewriteMode | unknown): {
        obu: Uint8Array;
        original: VideoColorTuple;
        effective: VideoColorTuple;
        rewritten: boolean;
    } | null;
}
export default AV1OBUParser;
