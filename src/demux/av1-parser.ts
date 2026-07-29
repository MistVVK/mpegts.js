/*
 * Copyright (C) 2022 もにょてっく. All Rights Reserved.
 *
 * @author もにょ〜ん <monyone.teihen@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * AV1 の構文解析では、切断データを 0 埋めされた値として扱ってはいけない。
 * 既存の ExpGolomb は H.26x 向けの互換挙動として末尾の部分 word を返すため、
 * AV1 専用の境界検査付き bit reader を使用する。
 */
class AV1BitReader {

    private readonly data_: Uint8Array;
    private bit_offset_: number = 0;

    public constructor(data: Uint8Array) {
        this.data_ = data;
    }

    public readBits(bits: number): number {
        if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
            throw new RangeError('Invalid AV1 bit count');
        }
        if (this.bit_offset_ + bits > this.data_.byteLength * 8) {
            throw new RangeError('Truncated AV1 bitstream');
        }

        let value = 0;
        for (let i = 0; i < bits; i++) {
            const offset = this.bit_offset_++;
            value = value * 2
                + ((this.data_[offset >>> 3] >>> (7 - (offset & 7))) & 0x01);
        }
        return value;
    }

    public readBool(): boolean {
        return this.readBits(1) === 1;
    }

    public readUEG(): number {
        let leading_zeros = 0;
        while (!this.readBool()) {
            leading_zeros++;
            if (leading_zeros === 32) {
                return 0xFFFFFFFF;
            }
        }
        return (2 ** leading_zeros) - 1 + this.readBits(leading_zeros);
    }

    public destroy(): void {
        // 呼び出し側の既存ライフサイクルとの互換用。保持する外部資源はない。
    }
}

type OperatingPoint = {
    operating_point_idc: number,
    level: number,
    tier: number,
    decoder_model_present_for_this_op?: boolean
};

type SequenceHeaderDetails = {
    frame_id_numbers_present_flag: boolean,
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
}

type FrameResolutions = {
    UpscaledWidth: number;
    FrameWidth: number;
    FrameHeight: number;
    RenderWidth: number;
    RenderHeight: number;
}

export type AV1Metadata = {
    codec_mimetype: string,
    level: number,
    level_string: string,
    tier: number,
    profile_idc: number,
    profile_string: string,
    bit_depth: number,
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
    keyframe?: boolean;

    frame_rate: {
        fixed: boolean
        fps: number;
        fps_den: number;
        fps_num: number;
    },

    sar_ratio?: {
        width: number;
        height: number;
    },

    codec_size?: {
        width: number,
        height: number;
    },

    present_size?: {
        width: number,
        height: number,
    }
}

export type AV1OBUParseResult = {
    valid: boolean;
    metadata: AV1Metadata | null;
    hasSequenceHeader: boolean;
    hasFrame: boolean;
    isKeyframe: boolean;
};

class AV1OBUParser {

    static parseOBUs(uint8array: Uint8Array, meta?: AV1Metadata | null): AV1Metadata | null {
        const result = AV1OBUParser.parseOBUsWithStatus(uint8array, meta);
        return result.valid ? result.metadata : null;
    }

    static parseOBUsWithStatus(uint8array: Uint8Array, meta?: AV1Metadata | null): AV1OBUParseResult {
        let current_metadata = meta ?? null;
        let has_sequence_header = false;
        let has_frame = false;
        let is_keyframe = false;

        try {
            for (let offset = 0; offset < uint8array.byteLength; ) {
                const obu_start = offset;
                const header = uint8array[offset++];
                if ((header & 0x81) !== 0) {
                    throw new Error('Invalid AV1 OBU header');
                }

                const type = (header & 0x78) >>> 3;
                const extension_flag = (header & 0x04) !== 0;
                const has_size_field = (header & 0x02) !== 0;
                if (type === 0 || (type >= 8 && type <= 14)) {
                    throw new Error('Reserved or prohibited AV1 OBU type');
                }

                let temporal_id = 0;
                let spatial_id = 0;
                if (extension_flag) {
                    if (offset >= uint8array.byteLength) {
                        throw new Error('Truncated AV1 OBU extension header');
                    }
                    const extension_header = uint8array[offset++];
                    temporal_id = (extension_header & 0xE0) >>> 5;
                    spatial_id = (extension_header & 0x18) >>> 3;
                    if ((extension_header & 0x07) !== 0) {
                        throw new Error('Invalid AV1 OBU extension header');
                    }
                }

                let payload_size = uint8array.byteLength - offset;
                if (has_size_field) {
                    payload_size = 0;
                    let multiplier = 1;
                    let terminated = false;
                    for (let byte_count = 0; byte_count < 8; byte_count++) {
                        if (offset >= uint8array.byteLength) {
                            throw new Error('Truncated AV1 OBU size');
                        }
                        const value = uint8array[offset++];
                        payload_size += (value & 0x7F) * multiplier;
                        if (!Number.isSafeInteger(payload_size)) {
                            throw new Error('AV1 OBU size exceeds safe integer range');
                        }
                        if ((value & 0x80) === 0) {
                            terminated = true;
                            break;
                        }
                        multiplier *= 128;
                    }
                    if (!terminated) {
                        throw new Error('Invalid AV1 OBU size');
                    }
                }

                const payload_end = offset + payload_size;
                if (payload_end > uint8array.byteLength) {
                    throw new Error('Truncated AV1 OBU payload');
                }
                const payload = uint8array.subarray(offset, payload_end);

                if (type === 1) { // OBU_SEQUENCE_HEADER
                    if (payload.byteLength === 0) {
                        throw new Error('Empty AV1 sequence header');
                    }
                    current_metadata = {
                        ...AV1OBUParser.parseSeuqneceHeader(payload),
                        sequence_header_data: uint8array.slice(obu_start, payload_end),
                    };
                    has_sequence_header = true;
                } else if (type === 2) { // OBU_TEMPORAL_DELIMITER
                    if (payload.byteLength !== 0) {
                        throw new Error('Invalid AV1 temporal delimiter');
                    }
                } else if (type === 3 || type === 6) { // OBU_FRAME_HEADER / OBU_FRAME
                    if (current_metadata == null || payload.byteLength === 0) {
                        throw new Error('AV1 frame appeared before a sequence header');
                    }
                    current_metadata = AV1OBUParser.parseOBUFrameHeader(
                        payload,
                        temporal_id,
                        spatial_id,
                        current_metadata
                    );
                    has_frame = true;
                    is_keyframe ||= current_metadata.keyframe === true;
                }

                offset = payload_end;
                if (!has_size_field && offset !== uint8array.byteLength) {
                    throw new Error('AV1 OBU without size field is not last');
                }
            }
        } catch (_) {
            return {
                valid: false,
                metadata: null,
                hasSequenceHeader: false,
                hasFrame: false,
                isKeyframe: false,
            };
        }

        return {
            valid: true,
            metadata: current_metadata,
            hasSequenceHeader: has_sequence_header,
            hasFrame: has_frame,
            isKeyframe: is_keyframe,
        };
    }

    static parseSeuqneceHeader(uint8array: Uint8Array): Omit<AV1Metadata, 'sequence_header_data'> {
        let gb = new AV1BitReader(uint8array);

        let seq_profile = gb.readBits(3);
        let still_picture = gb.readBool();
        let reduced_still_picture_header = gb.readBool();
        if (seq_profile > 2 || (reduced_still_picture_header && !still_picture)) {
            throw new Error('Invalid AV1 sequence header profile or still-picture flags');
        }

        let fps = 0, fps_fixed = false, fps_num = 0, fps_den = 1;
        let decoder_model_info_present_flag = false;
        let buffer_delay_length_minus_1 = 0;
        let buffer_removal_time_length_minus_1 = 0;
        let frame_presentation_time_length_minus_1 = 0;
        let operating_points_cnt_minus_1 = 0;
        let operating_points: OperatingPoint[] = [];
        if (reduced_still_picture_header) {
            operating_points.push({
                operating_point_idc: 0,
                level: gb.readBits(5),
                tier: 0,
            });
        } else {
            let timing_info_present_flag = gb.readBool();
            if (timing_info_present_flag) {
                // timing_info
                let num_units_in_display_tick = gb.readBits(32);
                let time_scale = gb.readBits(32);
                if (num_units_in_display_tick === 0 || time_scale === 0) {
                    throw new Error('Invalid AV1 timing information');
                }
                let equal_picture_interval = gb.readBool();
                let num_ticks_per_picture_minus_1 = 0;
                if (equal_picture_interval) {
                    num_ticks_per_picture_minus_1 = gb.readUEG();
                }
                fps_den = num_units_in_display_tick * (num_ticks_per_picture_minus_1 + 1);
                fps_num = time_scale;
                if (!Number.isSafeInteger(fps_den) || fps_den <= 0) {
                    throw new Error('AV1 frame-rate denominator exceeds the safe integer range');
                }
                fps = fps_den > 0 ? fps_num / fps_den : 0;
                fps_fixed = equal_picture_interval;

                decoder_model_info_present_flag = gb.readBool();
                if (decoder_model_info_present_flag) {
                    // decoder_model_info
                    buffer_delay_length_minus_1 = gb.readBits(5);
                    gb.readBits(32); // num_units_in_decoding_tick
                    buffer_removal_time_length_minus_1 = gb.readBits(5);
                    frame_presentation_time_length_minus_1 = gb.readBits(5);
                }
            }

            let initial_display_delay_present_flag = gb.readBool();
            operating_points_cnt_minus_1 = gb.readBits(5);
            for (let i = 0; i <= operating_points_cnt_minus_1; i++) {
                let operating_point_idc = gb.readBits(12);
                let level = gb.readBits(5);
                let tier = level > 7 ? gb.readBits(1) : 0;

                operating_points.push({
                    operating_point_idc,
                    level,
                    tier
                });

                if (decoder_model_info_present_flag) {
                    const decoder_model_present_for_this_op = gb.readBool();
                    operating_points[operating_points.length - 1].decoder_model_present_for_this_op = decoder_model_present_for_this_op;
                    if (decoder_model_present_for_this_op) {
                        // operating_parameters_info
                        gb.readBits(buffer_delay_length_minus_1 + 1);
                        gb.readBits(buffer_delay_length_minus_1 + 1);
                        gb.readBool();
                    }
                }

                if (initial_display_delay_present_flag) {
                    let initial_display_delay_present_for_this_op = gb.readBool();
                    if (initial_display_delay_present_for_this_op) {
                        gb.readBits(4);
                    }
                }
            }
        }

        let operating_point = 0;
        let { level, tier } = operating_points[operating_point];

        let frame_width_bits_minus_1 = gb.readBits(4);
        let frame_height_bits_minus_1 = gb.readBits(4);

        let max_frame_width = gb.readBits(frame_width_bits_minus_1 + 1) + 1;
        let max_frame_height = gb.readBits(frame_height_bits_minus_1 + 1) + 1;

        let frame_id_numbers_present_flag = false;
        if (!reduced_still_picture_header) {
            frame_id_numbers_present_flag = gb.readBool();
        }
        let delta_frame_id_length_minus_2: number | undefined = undefined;
        let additional_frame_id_length_minus_1: number | undefined = undefined;
        if (frame_id_numbers_present_flag) {
            delta_frame_id_length_minus_2 = gb.readBits(4);
            additional_frame_id_length_minus_1 = gb.readBits(4);
        }

        let SELECT_SCREEN_CONTENT_TOOLS = 2;
        let SELECT_INTEGER_MV = 2;

        let use_128x128_superblock = gb.readBool();
        let enable_filter_intra = gb.readBool();
        let enable_intra_edge_filter = gb.readBool();
        let enable_interintra_compound = false;
        let enable_masked_compound = false;
        let enable_warped_motion = false;
        let enable_dual_filter = false;
        let enable_order_hint = false;
        let enable_jnt_comp = false;
        let enable_ref_frame_mvs = false;
        let seq_force_screen_content_tools = SELECT_SCREEN_CONTENT_TOOLS;
        let seq_force_integer_mv = SELECT_INTEGER_MV;
        let OrderHintBits = 0;
        if (!reduced_still_picture_header) {
            enable_interintra_compound = gb.readBool();
            enable_masked_compound = gb.readBool();
            enable_warped_motion = gb.readBool();
            enable_dual_filter = gb.readBool();
            enable_order_hint = gb.readBool();
            if (enable_order_hint) {
                enable_jnt_comp = gb.readBool();
                enable_ref_frame_mvs = gb.readBool();
            }
            let seq_choose_screen_content_tools = gb.readBool();
            if (seq_choose_screen_content_tools) {
                seq_force_screen_content_tools = SELECT_SCREEN_CONTENT_TOOLS;
            } else {
                seq_force_screen_content_tools = gb.readBits(1);
            }
            if (seq_force_screen_content_tools) {
                let seq_choose_integer_mv = gb.readBool();
                if (seq_choose_integer_mv) {
                    seq_force_integer_mv = SELECT_INTEGER_MV;
                } else {
                    seq_force_integer_mv = gb.readBits(1);
                }
            } else {
                seq_force_integer_mv = SELECT_INTEGER_MV;
            }
            if (enable_order_hint) {
                let order_hint_bits_minus_1 = gb.readBits(3);
                OrderHintBits = order_hint_bits_minus_1 + 1;
            } else {
                OrderHintBits = 0;
            }
        }

        let enable_superres = gb.readBool();
        let enable_cdef = gb.readBool();
        let enable_restoration = gb.readBool();
        // color_config
        let high_bitdepth = gb.readBool();
        let bitDepth = 8;
        let twelve_bit = false;
        if (seq_profile === 2 && high_bitdepth) {
            twelve_bit = gb.readBool();
            bitDepth = twelve_bit ? 12 : 10;
        } else {
            bitDepth = high_bitdepth ? 10 : 8;
        }
        let mono_chrome = false;
        if (seq_profile !== 1) {
            mono_chrome = gb.readBool();
        }
        let numPlanes = mono_chrome ? 1 : 3;
        let color_description_present_flag = gb.readBool();
        let CP_BT_709 = 1, CP_UNSPECIFIED = 2;
        let TC_UNSPECIFIED = 2, TC_SRGB = 13;
        let MC_UNSPECIFIED = 2, MC_IDENTITY = 0;
        let color_primaries = CP_UNSPECIFIED;
        let transfer_characteristics = TC_UNSPECIFIED;
        let matrix_coefficients = MC_UNSPECIFIED;
        if (color_description_present_flag) {
            color_primaries = gb.readBits(8);
            transfer_characteristics = gb.readBits(8);
            matrix_coefficients = gb.readBits(8);
        }
        let color_range = 1;
        let subsampling_x = 1;
        let subsampling_y = 1;
        let chroma_sample_position = 0;
        if (mono_chrome) {
            color_range = gb.readBits(1);
            subsampling_x = 1;
            subsampling_y = 1;
        } else {
            if (color_primaries === CP_BT_709 && transfer_characteristics === TC_SRGB && matrix_coefficients === MC_IDENTITY) {
                color_range = 1;
                subsampling_x = 0;
                subsampling_y = 0;
            } else {
                color_range = gb.readBits(1);
                if (seq_profile == 0) {
                    subsampling_x = 1;
                    subsampling_y = 1;
                } else if (seq_profile == 1) {
                    subsampling_x = 0;
                    subsampling_y = 0;
                } else {
                    if (bitDepth == 12) {
                        subsampling_x = gb.readBits(1);
                        if (subsampling_x) {
                            subsampling_y = gb.readBits(1);
                        } else {
                            subsampling_y = 0;
                        }
                    } else {
                        subsampling_x = 1;
                        subsampling_y = 0;
                    }
                }
                if (subsampling_x && subsampling_y) {
                    chroma_sample_position = gb.readBits(2);
                }
                gb.readBits(1); // separate_uv_delta_q
            }
        }
        //
        gb.readBool(); // film_grain_params_present

        gb.destroy();
        gb = null;

        let codec_mimetype = `av01.${seq_profile}.${AV1OBUParser.getLevelString(level, tier)}.${bitDepth.toString(10).padStart(2, '0')}`;
        return {
            codec_mimetype,
            level: level,
            tier: tier,
            level_string: AV1OBUParser.getLevelString(level, tier),
            profile_idc: seq_profile,
            profile_string: `${seq_profile}`,
            bit_depth: bitDepth,
            ref_frames: 1, // FIXME!!!
            chroma_format: AV1OBUParser.getChromaFormat(mono_chrome, subsampling_x, subsampling_y),
            chroma_format_string: AV1OBUParser.getChromaFormatString(mono_chrome, subsampling_x, subsampling_y),
            mono_chrome,
            subsampling_x,
            subsampling_y,
            chroma_sample_position,
            ref_sample_duration: fps > 0 ? 1000 / fps : 1000 / 60,

            sequence_header: {
                frame_id_numbers_present_flag,
                additional_frame_id_length_minus_1,
                delta_frame_id_length_minus_2,
                reduced_still_picture_header,
                decoder_model_info_present_flag,
                operating_points_cnt_minus_1,
                operating_points,
                buffer_removal_time_length_minus_1,
                frame_presentation_time_length_minus_1,
                equal_picture_interval: fps_fixed,
                seq_force_screen_content_tools,
                seq_force_integer_mv,
                enable_order_hint,
                order_hint_bits: OrderHintBits,
                enable_superres,
                frame_width_bit: frame_width_bits_minus_1 + 1,
                frame_height_bit: frame_height_bits_minus_1 + 1,
                max_frame_width,
                max_frame_height,
            },

            keyframe: undefined,

            frame_rate: {
                fixed: fps_fixed,
                fps,
                fps_den: fps_den,
                fps_num: fps_num,
            },
        };
    }

    static parseOBUFrameHeader(uint8array: Uint8Array, temporal_id: number, spatial_id: number, meta: AV1Metadata) {
        let { sequence_header } = meta;
        const result: AV1Metadata = {...meta};

        let gb = new AV1BitReader(uint8array);
        // obu_type is OBU_FRAME_HEADER, SeenFrameHeader = 0, OBU_REDUNDANT_FRAME_HEADER 1
        let NUM_REF_FRAMES = 8;
        let KEY_FRAME = 0;
        let INTER_FRAME = 1;
        let INTRA_ONLY_FRAME = 2;
        let SWITCH_FRAME = 3;
        let SELECT_SCREEN_CONTENT_TOOLS = 2;
        let SELECT_INTEGER_MV = 2;
        let PRIMARY_REF_NONE = 7;

        let FrameWidth = sequence_header.max_frame_width;
        let FrameHeight = sequence_header.max_frame_height;
        let RenderWidth = FrameWidth; // Stub
        let RenderHeight = FrameHeight; // Stub

        let idLen = 0;
        if (sequence_header.frame_id_numbers_present_flag) {
            idLen = sequence_header.additional_frame_id_length_minus_1! + sequence_header.delta_frame_id_length_minus_2! + 3;
        }
        let allFrames = (1 << NUM_REF_FRAMES) - 1;

        let show_existing_frame = false;
        let frame_type = 0;
        let keyframe = true;
        let show_frame = true;
        let showable_frame = false;
        let error_resilient_mode = false;
        if (!sequence_header.reduced_still_picture_header) {
            show_existing_frame = gb.readBool();
            if (show_existing_frame) {
                gb.readBits(3); // frame_to_show_map_idx
                if (sequence_header.decoder_model_info_present_flag
                        && !sequence_header.equal_picture_interval) {
                    gb.readBits(sequence_header.frame_presentation_time_length_minus_1 + 1);
                }
                if (sequence_header.frame_id_numbers_present_flag) {
                    gb.readBits(idLen); // display_frame_id
                }
                // It does not contain new frame data.
                return {...meta, keyframe: false};
            }

            frame_type = gb.readBits(2);
            keyframe = frame_type === INTRA_ONLY_FRAME || frame_type === KEY_FRAME;
            show_frame = gb.readBool();
            if (show_frame && sequence_header.decoder_model_info_present_flag && !sequence_header.equal_picture_interval) {
                gb.readBits(sequence_header.frame_presentation_time_length_minus_1 + 1);
            }
            if (show_frame) {
                showable_frame = frame_type !== KEY_FRAME;
            } else {
                showable_frame = gb.readBool();
            }
            if (frame_type === SWITCH_FRAME || (frame_type === KEY_FRAME && show_frame)) {
                error_resilient_mode = true;
            } else {
                error_resilient_mode = gb.readBool();
            }
        }
        result.keyframe = keyframe;

        let disable_cdf_update = gb.readBool();
        let allow_screen_content_tools = sequence_header.seq_force_screen_content_tools;
        if (sequence_header.seq_force_screen_content_tools === SELECT_SCREEN_CONTENT_TOOLS) {
            allow_screen_content_tools = gb.readBits(1);
        }
        let force_integer_mv = keyframe ? 1 : 0;
        if (allow_screen_content_tools) {
            force_integer_mv = sequence_header.seq_force_integer_mv;
            if (sequence_header.seq_force_integer_mv == SELECT_INTEGER_MV) {
                force_integer_mv = gb.readBits(1);
            }
        }
        let current_frame_id = 0;
        if (sequence_header.frame_id_numbers_present_flag) {
            current_frame_id = gb.readBits(idLen);
        }
        let frame_size_override_flag = false;
        if (frame_type == SWITCH_FRAME) {
            frame_size_override_flag = true;
        } else if (sequence_header.reduced_still_picture_header) {
            frame_size_override_flag = false;
        } else {
            frame_size_override_flag = gb.readBool();
        }
        let order_hint = sequence_header.order_hint_bits > 0
            ? gb.readBits(sequence_header.order_hint_bits)
            : 0;
        let primary_ref_frame = PRIMARY_REF_NONE;
        if (!(keyframe || error_resilient_mode)) {
            primary_ref_frame = gb.readBits(3);
        }
        if (sequence_header.decoder_model_info_present_flag) {
            let buffer_removal_time_present_flag = gb.readBool();
            if (buffer_removal_time_present_flag) {
                for (let opNum = 0; opNum <= sequence_header.operating_points_cnt_minus_1!; opNum++) {
                    if (sequence_header.operating_points[opNum].decoder_model_present_for_this_op) {
                        let opPtIdc = sequence_header.operating_points[opNum].operating_point_idc;
                        let inTemporalLayer = (opPtIdc >> temporal_id ) & 1
                        let inSpatialLayer = (opPtIdc >> (spatial_id + 8)) & 1
                        if (opPtIdc === 0 || (inTemporalLayer && inSpatialLayer)) {
                            gb.readBits(sequence_header.buffer_removal_time_length_minus_1 + 1);
                        }
                    }
                }
            }
        }
        let allow_high_precision_mv = 0;
        let use_ref_frame_mvs = 0;
        let allow_intrabc = 0;
        let refresh_frame_flags = allFrames;
        if (!(frame_type === SWITCH_FRAME || (frame_type == KEY_FRAME && show_frame))) {
            refresh_frame_flags = gb.readBits(8);
        }
        if (keyframe || refresh_frame_flags !== allFrames) {
            if (error_resilient_mode && sequence_header.enable_order_hint) {
                for (let i = 0; i < NUM_REF_FRAMES; i++) {
                    gb.readBits(sequence_header.order_hint_bits);
                }
            }
        }
        if (keyframe){
            const resolution = AV1OBUParser.frameSizeAndRenderSize(gb, frame_size_override_flag, sequence_header);
            result.codec_size = {
                width: resolution.FrameWidth,
                height: resolution.FrameHeight,
            }
            result.present_size = {
                width: resolution.RenderWidth,
                height: resolution.RenderHeight,
            }
            result.sar_ratio = {
                width: resolution.RenderWidth / resolution.FrameWidth,
                height: resolution.RenderHeight / resolution.FrameHeight,
            }
        }
        // fmp4 can't support reference frame resolution change, so ignored

        gb.destroy();
        gb = null;
        return result;
    }

    static frameSizeAndRenderSize(gb: AV1BitReader, frame_size_override_flag: boolean, sequence_header: SequenceHeaderDetails): FrameResolutions {
        let FrameWidth = sequence_header.max_frame_width;
        let FrameHeight = sequence_header.max_frame_height;
        if (frame_size_override_flag) {
            FrameWidth = gb.readBits(sequence_header.frame_width_bit) + 1;
            FrameHeight = gb.readBits(sequence_header.frame_height_bit) + 1;
        }

        let use_superress = false;
        if (sequence_header.enable_superres) {
            use_superress = gb.readBool();
        }
        let SuperresDenom = 8 /* SUPERRES_NUM */;
        if (use_superress) {
            let coded_denom = gb.readBits(3 /* SUPERRES_DENOM_BITS */);
            SuperresDenom = coded_denom + 9; /* SUPERRES_DENOM_MIN */
        }
        let UpscaledWidth = FrameWidth;
        FrameWidth = Math.floor((UpscaledWidth * 8 /* SUPERRES_NUM */ + (SuperresDenom / 2)) / SuperresDenom)

        let render_and_frame_size_different = gb.readBool();
        let RenderWidth = UpscaledWidth;
        let RenderHeight = FrameHeight;
        if (render_and_frame_size_different) {
            RenderWidth = gb.readBits(16) + 1;
            RenderHeight = gb.readBits(16) + 1;
        }

        return {
            UpscaledWidth,
            FrameWidth,
            FrameHeight,
            RenderWidth,
            RenderHeight
        };
    }

    static getLevelString(level: number, tier: number): string {
        return `${level.toString(10).padStart(2, '0')}${tier === 0 ? 'M' : 'H'}`;
    }

    static getChromaFormat(mono_chrome: boolean, subsampling_x: number, subsampling_y: number): number {
        if (mono_chrome) {
            return 0;
        } else if (subsampling_x === 0 && subsampling_y === 0) {
            return 3;
        } else if (subsampling_x === 1 && subsampling_y === 0) {
            return 2;
        } else if (subsampling_x === 1 && subsampling_y === 1) {
            return 1;
        } else {
            return Number.NaN;
        }
    }

    static getChromaFormatString(mono_chrome: boolean, subsampling_x: number, subsampling_y: number): string {
        if (mono_chrome) {
            return '4:0:0';
        } else if (subsampling_x === 0 && subsampling_y === 0) {
            return '4:4:4';
        } else if (subsampling_x === 1 && subsampling_y === 0) {
            return '4:2:2';
        } else if (subsampling_x === 1 && subsampling_y === 1) {
            return '4:2:0';
        } else {
            return 'Unknown';
        }
    }
}

export default AV1OBUParser;
