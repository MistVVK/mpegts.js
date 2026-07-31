/*
 * Copyright (C) 2026 KonomiTV Project. All Rights Reserved.
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

const VP9_REGISTRATION_DESCRIPTOR = new Uint8Array([
    0x05, 0x04, 0x56, 0x50, 0x30, 0x39  // registration_descriptor: "VP09"
]);

const VP9_PRIVATE_DESCRIPTOR = new Uint8Array([
    0x80, 0x08,
    0x4B, 0x54, 0x56, 0x42,  // magic: "KTVB"
    0x09,                    // codec_id: VP9
    0x01,                    // mapping_version: 1
    0xF0,                    // one-AU/PES, raw VP9, data_alignment, keyframe RAI
    0x00                     // reserved
]);

/**
 * Project-private VP9 mapping v1 descriptor pair.
 *
 * "VP09" is intentionally used as an unregistered project-private marker. It
 * must not be interpreted as a registered SMPTE registration identifier.
 */
export const VP9_PRIVATE_MAPPING_V1_DESCRIPTORS = new Uint8Array([
    0x05, 0x04, 0x56, 0x50, 0x30, 0x39,
    0x80, 0x08, 0x4B, 0x54, 0x56, 0x42, 0x09, 0x01, 0xF0, 0x00
]);

function bytesEqualAt(data: Uint8Array, offset: number, expected: Uint8Array): boolean {
    if (offset < 0 || offset + expected.byteLength > data.byteLength) {
        return false;
    }
    for (let i = 0; i < expected.byteLength; i++) {
        if (data[offset + i] !== expected[i]) {
            return false;
        }
    }
    return true;
}

/**
 * Return true only for the exact project-private mapping v1 descriptor pair.
 *
 * The private descriptor must immediately follow the registration descriptor.
 * Unknown versions, flags, and non-zero reserved fields are deliberately
 * rejected.
 */
export function hasVP9PrivateMappingV1(descriptors: Uint8Array): boolean {
    // The mapping pair is a stream-identification contract, so accepting the
    // same bytes later in the loop would silently reinterpret another private
    // stream as VP9.
    if (!bytesEqualAt(descriptors, 0, VP9_REGISTRATION_DESCRIPTOR)) {
        return false;
    }
    const private_descriptor_offset = VP9_REGISTRATION_DESCRIPTOR.byteLength;
    if (!bytesEqualAt(descriptors, private_descriptor_offset, VP9_PRIVATE_DESCRIPTOR)) {
        return false;
    }

    // Additional descriptors may follow the mandatory pair, but the entire
    // loop still has to be structurally valid.
    for (let offset = private_descriptor_offset + VP9_PRIVATE_DESCRIPTOR.byteLength;
        offset < descriptors.byteLength;) {
        if (offset + 2 > descriptors.byteLength) {
            return false;
        }
        const descriptor_length = descriptors[offset + 1];
        const descriptor_end = offset + 2 + descriptor_length;
        if (descriptor_end > descriptors.byteLength) {
            return false;
        }
        offset = descriptor_end;
    }
    return true;
}

/**
 * VP9 raw bits are read from the most-significant bit of each byte first.
 * profile_low_bit is nevertheless signalled before profile_high_bit.
 */
class VP9RawBitsReader {

    private readonly data_: Uint8Array;
    private bit_offset_: number = 0;

    public constructor(data: Uint8Array) {
        this.data_ = data;
    }

    public readBit(): number {
        if (this.bit_offset_ >= this.data_.byteLength * 8) {
            throw new RangeError('Truncated VP9 uncompressed header');
        }
        const byte_offset = this.bit_offset_ >>> 3;
        const bit_in_byte = 7 - (this.bit_offset_ & 0x07);
        const value = (this.data_[byte_offset] >>> bit_in_byte) & 0x01;
        this.bit_offset_++;
        return value;
    }

    public readBits(length: number): number {
        let value = 0;
        for (let i = 0; i < length; i++) {
            value = value * 2 + this.readBit();
        }
        return value;
    }
}

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

const VP9_LEVEL_LIMITS = [
    {level: 10, maxSampleRate: 829440, maxPictureSize: 36864, maxBreadth: 512},
    {level: 11, maxSampleRate: 2764800, maxPictureSize: 73728, maxBreadth: 768},
    {level: 20, maxSampleRate: 4608000, maxPictureSize: 122880, maxBreadth: 960},
    {level: 21, maxSampleRate: 9216000, maxPictureSize: 245760, maxBreadth: 1344},
    {level: 30, maxSampleRate: 20736000, maxPictureSize: 552960, maxBreadth: 2048},
    {level: 31, maxSampleRate: 36864000, maxPictureSize: 983040, maxBreadth: 2752},
    {level: 40, maxSampleRate: 83558400, maxPictureSize: 2228224, maxBreadth: 4160},
    {level: 41, maxSampleRate: 160432128, maxPictureSize: 2228224, maxBreadth: 4160},
    {level: 50, maxSampleRate: 311951360, maxPictureSize: 8912896, maxBreadth: 8384},
    {level: 51, maxSampleRate: 588251136, maxPictureSize: 8912896, maxBreadth: 8384},
    {level: 52, maxSampleRate: 1176502272, maxPictureSize: 8912896, maxBreadth: 8384},
    {level: 60, maxSampleRate: 1176502272, maxPictureSize: 35651584, maxBreadth: 16832},
    {level: 61, maxSampleRate: 2353004544, maxPictureSize: 35651584, maxBreadth: 16832},
    {level: 62, maxSampleRate: 4706009088, maxPictureSize: 35651584, maxBreadth: 16832}
] as const;

type VP9ColorConfiguration = {
    bitDepth: number;
    chromaSubsampling: number;
    videoFullRangeFlag: number;
    colourPrimaries: number;
    transferCharacteristics: number;
    matrixCoefficients: number;
};

/**
 * Derive the lowest VP9 level that can carry the coded size at an assumed
 * 60fps. The private mapping has no timing or bitrate field, so level 0 is not
 * emitted: an unsupported picture size is rejected instead.
 */
export function deriveVP9Level(width: number, height: number): number | undefined {
    if (width <= 0 || height <= 0) {
        return undefined;
    }
    const picture_size = width * height;
    const sample_rate = picture_size * 60;
    const breadth = Math.max(width, height);

    for (let i = 0; i < VP9_LEVEL_LIMITS.length; i++) {
        const limit = VP9_LEVEL_LIMITS[i];
        if (sample_rate <= limit.maxSampleRate
                && picture_size <= limit.maxPictureSize
                && breadth <= limit.maxBreadth) {
            return limit.level;
        }
    }
    return undefined;
}

function mapColorSpace(color_space: number, bit_depth: number): {
    colourPrimaries: number,
    transferCharacteristics: number,
    matrixCoefficients: number
} {
    switch (color_space) {
        case 1:  // BT.601
        case 3:  // SMPTE 170
            return {colourPrimaries: 6, transferCharacteristics: 6, matrixCoefficients: 6};
        case 2:  // BT.709
            return {colourPrimaries: 1, transferCharacteristics: 1, matrixCoefficients: 1};
        case 4:  // SMPTE 240
            return {colourPrimaries: 7, transferCharacteristics: 7, matrixCoefficients: 7};
        case 5:  // BT.2020
            return {
                colourPrimaries: 9,
                transferCharacteristics: bit_depth === 12 ? 15 : 14,
                matrixCoefficients: 9
            };
        case 7:  // sRGB
            return {colourPrimaries: 1, transferCharacteristics: 13, matrixCoefficients: 0};
        default:  // Unknown / reserved
            return {colourPrimaries: 2, transferCharacteristics: 2, matrixCoefficients: 2};
    }
}

function readColorConfiguration(reader: VP9RawBitsReader, profile: number): VP9ColorConfiguration {
    const bit_depth = profile >= 2 ? (reader.readBit() === 1 ? 12 : 10) : 8;
    const color_space = reader.readBits(3);

    let video_full_range_flag: number;
    let subsampling_x: number;
    let subsampling_y: number;

    if (color_space !== 7) {
        video_full_range_flag = reader.readBit();
        if (profile === 1 || profile === 3) {
            subsampling_x = reader.readBit();
            subsampling_y = reader.readBit();
            if (reader.readBit() !== 0) {
                throw new Error('VP9 reserved_zero must be zero');
            }
        } else {
            subsampling_x = 1;
            subsampling_y = 1;
        }
    } else {
        if (profile !== 1 && profile !== 3) {
            throw new Error('VP9 sRGB is not valid for profile 0 or 2');
        }
        video_full_range_flag = 1;
        subsampling_x = 0;
        subsampling_y = 0;
        if (reader.readBit() !== 0) {
            throw new Error('VP9 reserved_zero must be zero');
        }
    }

    let chroma_subsampling: number;
    if (subsampling_x === 1 && subsampling_y === 1) {
        chroma_subsampling = 1;  // 4:2:0, colocated with luma
    } else if (subsampling_x === 1 && subsampling_y === 0) {
        chroma_subsampling = 2;  // 4:2:2
    } else if (subsampling_x === 0 && subsampling_y === 0) {
        chroma_subsampling = 3;  // 4:4:4
    } else {
        throw new Error('Unsupported VP9 chroma subsampling');
    }

    return {
        bitDepth: bit_depth,
        chromaSubsampling: chroma_subsampling,
        videoFullRangeFlag: video_full_range_flag,
        ... mapColorSpace(color_space, bit_depth)
    };
}

/**
 * TS 上の codec / render size をそのまま present に使う。
 * 壊れた render size だけ codec size にフォールバックする（固定 SAR 補完はしない）。
 */
function normalizeVP9PresentationSize(
    codec_width: number,
    codec_height: number,
    present_width: number,
    present_height: number
): {presentWidth: number; presentHeight: number} {
    let width = present_width;
    let height = present_height;
    if (!Number.isFinite(width)
            || !Number.isFinite(height)
            || width <= 0
            || height <= 0
            || width > codec_width * 8
            || height > codec_height * 8
            || width * 8 < codec_width
            || height * 8 < codec_height) {
        width = codec_width;
        height = codec_height;
    }
    return {presentWidth: width, presentHeight: height};
}

function readFrameConfiguration(
    reader: VP9RawBitsReader,
    profile: number,
    color: VP9ColorConfiguration
): VP9CodecConfiguration {
    const codec_width = reader.readBits(16) + 1;
    const codec_height = reader.readBits(16) + 1;

    let present_width = codec_width;
    let present_height = codec_height;
    if (reader.readBit() === 1) {
        present_width = reader.readBits(16) + 1;
        present_height = reader.readBits(16) + 1;
    }

    const level = deriveVP9Level(codec_width, codec_height);
    if (level == undefined) {
        throw new Error('VP9 coded size exceeds level 6.2');
    }

    const presentation = normalizeVP9PresentationSize(
        codec_width,
        codec_height,
        present_width,
        present_height
    );

    return {
        profile,
        level,
        ... color,
        codecWidth: codec_width,
        codecHeight: codec_height,
        presentWidth: presentation.presentWidth,
        presentHeight: presentation.presentHeight
    };
}

function verifySyncCode(reader: VP9RawBitsReader): void {
    if (reader.readBits(24) !== 0x498342) {
        throw new Error('Invalid VP9 frame sync code');
    }
}

/**
 * Validate and split a VP9 superframe index without changing sample bytes.
 *
 * A payload without a superframe marker is returned as one frame. If the last
 * byte looks like a superframe marker, the complete index must be valid.
 */
export function parseVP9SampleLayout(data: Uint8Array): VP9SampleLayout | null {
    if (data.byteLength === 0) {
        return null;
    }

    const marker = data[data.byteLength - 1];
    if ((marker & 0xE0) !== 0xC0) {
        return {frames: [data], isSuperframe: false};
    }

    const frame_count = (marker & 0x07) + 1;
    const magnitude = ((marker >>> 3) & 0x03) + 1;
    const index_size = 2 + frame_count * magnitude;
    const index_offset = data.byteLength - index_size;
    if (index_offset < 0 || data[index_offset] !== marker) {
        return null;
    }

    const frame_sizes: number[] = [];
    let size_offset = index_offset + 1;
    let total_frame_size = 0;
    for (let frame = 0; frame < frame_count; frame++) {
        let frame_size = 0;
        let multiplier = 1;
        for (let byte = 0; byte < magnitude; byte++) {
            frame_size += data[size_offset++] * multiplier;
            multiplier *= 256;
        }
        if (frame_size === 0) {
            return null;
        }
        frame_sizes.push(frame_size);
        total_frame_size += frame_size;
    }

    if (total_frame_size + index_size !== data.byteLength) {
        return null;
    }

    const frames: Uint8Array[] = [];
    let frame_offset = 0;
    for (const frame_size of frame_sizes) {
        frames.push(data.subarray(frame_offset, frame_offset + frame_size));
        frame_offset += frame_size;
    }
    return {frames, isSuperframe: true};
}

/**
 * Parse the fields needed to identify random access points and build vpcC.
 *
 * A regular inter frame does not repeat color or size configuration. In that
 * case the previous key/intra-only configuration is returned when its profile
 * matches.
 */
export function parseVP9FrameHeader(
    data: Uint8Array,
    previous_config?: VP9CodecConfiguration
): VP9FrameHeader | null {
    try {
        const reader = new VP9RawBitsReader(data);
        if (reader.readBits(2) !== 2) {
            return null;
        }

        const profile_low_bit = reader.readBit();
        const profile_high_bit = reader.readBit();
        const profile = (profile_high_bit << 1) | profile_low_bit;
        if (profile === 3 && reader.readBit() !== 0) {
            return null;
        }

        const show_existing_frame = reader.readBit() === 1;
        if (show_existing_frame) {
            reader.readBits(3);
            return {
                profile,
                isKeyframe: false,
                isIntraOnly: false,
                showFrame: true,
                showExistingFrame: true,
                config: previous_config?.profile === profile ? previous_config : undefined
            };
        }

        // libvpx's stream-info parser requires at least ten bytes before
        // reading the remainder of a non-show-existing uncompressed header.
        if (data.byteLength < 10) {
            return null;
        }

        const frame_type = reader.readBit();
        const show_frame = reader.readBit() === 1;
        const error_resilient_mode = reader.readBit() === 1;
        const is_keyframe = frame_type === 0;

        if (is_keyframe) {
            verifySyncCode(reader);
            const color = readColorConfiguration(reader, profile);
            return {
                profile,
                isKeyframe: true,
                isIntraOnly: true,
                showFrame: show_frame,
                showExistingFrame: false,
                config: readFrameConfiguration(reader, profile, color)
            };
        }

        const intra_only = show_frame ? false : reader.readBit() === 1;
        if (!error_resilient_mode) {
            reader.readBits(2);  // reset_frame_context
        }

        if (intra_only) {
            verifySyncCode(reader);
            const color = profile > 0
                ? readColorConfiguration(reader, profile)
                : {
                    bitDepth: 8,
                    chromaSubsampling: 1,
                    videoFullRangeFlag: 0,
                    ... mapColorSpace(1, 8)
                };
            reader.readBits(8);  // refresh_frame_flags
            return {
                profile,
                isKeyframe: false,
                isIntraOnly: true,
                showFrame: show_frame,
                showExistingFrame: false,
                config: readFrameConfiguration(reader, profile, color)
            };
        }

        return {
            profile,
            isKeyframe: false,
            isIntraOnly: false,
            showFrame: show_frame,
            showExistingFrame: false,
            config: previous_config?.profile === profile ? previous_config : undefined
        };
    } catch (_) {
        return null;
    }
}

export function buildVP9CodecString(config: VP9CodecConfiguration): string {
    return [
        'vp09',
        config.profile.toString(10).padStart(2, '0'),
        config.level.toString(10).padStart(2, '0'),
        config.bitDepth.toString(10).padStart(2, '0')
    ].join('.');
}

/**
 * Build VPCodecConfigurationRecord. The vpcC FullBox header is added by the
 * MP4 generator.
 */
export function buildVP9CodecConfigurationRecord(config: VP9CodecConfiguration): Uint8Array {
    return new Uint8Array([
        config.profile,
        config.level,
        ((config.bitDepth & 0x0F) << 4)
            | ((config.chromaSubsampling & 0x07) << 1)
            | (config.videoFullRangeFlag & 0x01),
        config.colourPrimaries,
        config.transferCharacteristics,
        config.matrixCoefficients,
        0x00, 0x00  // codecInitializationDataSize (must be zero for VP9)
    ]);
}

export function buildVP9VideoDetails(config: VP9CodecConfiguration): any {
    const chroma_format = config.chromaSubsampling <= 1
        ? 420
        : config.chromaSubsampling === 2 ? 422 : 444;
    const chroma_format_string = config.chromaSubsampling <= 1
        ? '4:2:0'
        : config.chromaSubsampling === 2 ? '4:2:2' : '4:4:4';

    return {
        codec_mimetype: buildVP9CodecString(config),
        level: config.level,
        level_string: (config.level / 10).toFixed(1),
        profile_idc: config.profile,
        profile_string: `${config.profile}`,
        bit_depth: config.bitDepth,
        ref_frames: 3,
        chroma_format,
        chroma_format_string,
        sar_ratio: (() => {
            let sar_width = config.presentWidth * config.codecHeight;
            let sar_height = config.presentHeight * config.codecWidth;
            let a = Math.abs(Math.floor(sar_width));
            let b = Math.abs(Math.floor(sar_height));
            while (b !== 0) {
                const t = b;
                b = a % b;
                a = t;
            }
            const divisor = a > 0 ? a : 1;
            return {
                width: Math.floor(sar_width / divisor) || 1,
                height: Math.floor(sar_height / divisor) || 1,
            };
        })(),
        codec_size: {width: config.codecWidth, height: config.codecHeight},
        present_size: {width: config.presentWidth, height: config.presentHeight},
        frame_rate: {fixed: false, fps: 0, fps_num: 0, fps_den: 1},
        ref_sample_duration: 1000 / 60,
        vp9_config: config,
        vpcc: buildVP9CodecConfigurationRecord(config)
    };
}
