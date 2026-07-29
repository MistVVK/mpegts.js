/*
 * Copyright (C) 2023 もにょてっく. All Rights Reserved.
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

const AV1_REGISTRATION_DESCRIPTOR = new Uint8Array([
    0x05, 0x04, 0x41, 0x56, 0x30, 0x31  // registration_descriptor: "AV01"
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

function encodeLEB128(value: number): Uint8Array {
    const bytes: number[] = [];
    do {
        let byte = value & 0x7F;
        value = Math.floor(value / 128);
        if (value !== 0) {
            byte |= 0x80;
        }
        bytes.push(byte);
    } while (value !== 0);
    return new Uint8Array(bytes);
}

/**
 * Validate that one tsOBU contains exactly one OBU and make its size explicit
 * for AV1 samples/configOBUs carried in ISO BMFF.
 */
export function normalizeAV1OBUForISOBMFF(data: Uint8Array): Uint8Array | null {
    if (data.byteLength === 0 || (data[0] & 0x81) !== 0) {
        return null;
    }

    const type = (data[0] & 0x78) >>> 3;
    if (type === 0 || (type >= 8 && type <= 14)) {
        return null;
    }

    const extension_flag = (data[0] & 0x04) !== 0;
    const has_size_field = (data[0] & 0x02) !== 0;
    const payload_offset = extension_flag ? 2 : 1;
    if (payload_offset > data.byteLength
            || (extension_flag && (data[1] & 0x07) !== 0)) {
        return null;
    }

    if (has_size_field) {
        let offset = payload_offset;
        let payload_size = 0;
        let multiplier = 1;
        let terminated = false;
        for (let byte_count = 0; byte_count < 8; byte_count++) {
            if (offset >= data.byteLength) {
                return null;
            }
            const value = data[offset++];
            payload_size += (value & 0x7F) * multiplier;
            if (!Number.isSafeInteger(payload_size)) {
                return null;
            }
            if ((value & 0x80) === 0) {
                terminated = true;
                break;
            }
            multiplier *= 128;
        }
        return terminated && offset + payload_size === data.byteLength ? data : null;
    }

    const size = encodeLEB128(data.byteLength - payload_offset);
    const normalized = new Uint8Array(data.byteLength + size.byteLength);
    normalized[0] = data[0] | 0x02;
    if (extension_flag) {
        normalized[1] = data[1];
    }
    normalized.set(size, payload_offset);
    normalized.set(data.subarray(payload_offset), payload_offset + size.byteLength);
    return normalized;
}

/**
 * Validate the mandatory AOM AV1 registration/video descriptor pair.
 *
 * The returned four bytes are normalized for AV1CodecConfigurationRecord:
 * hdr_wcg_idc occupies reserved bits in av1C and is therefore cleared.
 */
export function parseAV1MPEG2TSDescriptors(descriptors: Uint8Array): Uint8Array | null {
    if (!bytesEqualAt(descriptors, 0, AV1_REGISTRATION_DESCRIPTOR)) {
        return null;
    }

    const video_descriptor_offset = AV1_REGISTRATION_DESCRIPTOR.byteLength;
    if (video_descriptor_offset + 6 > descriptors.byteLength
            || descriptors[video_descriptor_offset] !== 0x80
            || descriptors[video_descriptor_offset + 1] !== 0x04) {
        return null;
    }

    const configuration = descriptors.subarray(video_descriptor_offset + 2, video_descriptor_offset + 6);
    if (configuration[0] !== 0x81) {  // marker=1, version=1
        return null;
    }
    if ((configuration[1] >>> 5) > 2) {  // seq_profile
        return null;
    }
    if ((configuration[3] & 0x20) !== 0) {  // reserved_zero
        return null;
    }
    if ((configuration[3] & 0x10) === 0 && (configuration[3] & 0x0F) !== 0) {
        return null;
    }

    // A truncated descriptor anywhere in the loop makes the mapping invalid.
    for (let offset = video_descriptor_offset + 6; offset < descriptors.byteLength; ) {
        if (offset + 2 > descriptors.byteLength) {
            return null;
        }
        const descriptor_end = offset + 2 + descriptors[offset + 1];
        if (descriptor_end > descriptors.byteLength) {
            return null;
        }
        offset = descriptor_end;
    }

    return new Uint8Array([
        configuration[0],
        configuration[1],
        configuration[2],
        configuration[3] & 0x1F
    ]);
}

export class AV1OBUInMpegTsParser {

    private readonly payloads_: Uint8Array[] = [];
    private current_payload_index_: number = 0;
    private valid_: boolean = true;

    /**
     * Remove MPEG-2 TS emulation-prevention bytes and validate forbidden
     * start-code emulation sequences.
     */
    public static ebsp2rbsp(data: Uint8Array): Uint8Array | null {
        const output = new Uint8Array(data.byteLength);
        let output_offset = 0;
        let consecutive_zeros = 0;

        for (let i = 0; i < data.byteLength; i++) {
            const value = data[i];
            if (consecutive_zeros >= 2) {
                if (value === 0x03) {
                    if (i + 1 >= data.byteLength || data[i + 1] > 0x03) {
                        return null;
                    }
                    consecutive_zeros = 0;
                    continue;
                }
                if (value <= 0x02) {
                    return null;
                }
            }

            output[output_offset++] = value;
            consecutive_zeros = value === 0x00 ? consecutive_zeros + 1 : 0;
        }

        return output.subarray(0, output_offset);
    }

    public constructor(data: Uint8Array) {
        this.parse(data);
    }

    public isValid(): boolean {
        return this.valid_;
    }

    public readNextOBUPayload(): Uint8Array | null {
        if (!this.valid_ || this.current_payload_index_ >= this.payloads_.length) {
            return null;
        }
        return this.payloads_[this.current_payload_index_++];
    }

    private parse(data: Uint8Array): void {
        if (data.byteLength < 4 || !this.hasStartCodeAt(data, 0)) {
            this.valid_ = false;
            return;
        }

        let start_code_offset = 0;
        while (start_code_offset < data.byteLength) {
            const payload_offset = start_code_offset + 3;
            const next_start_code_offset = this.findNextStartCodeOffset(data, payload_offset);
            if (payload_offset >= next_start_code_offset) {
                this.valid_ = false;
                this.payloads_.length = 0;
                return;
            }

            const payload = AV1OBUInMpegTsParser.ebsp2rbsp(
                data.subarray(payload_offset, next_start_code_offset)
            );
            if (payload == null || payload.byteLength === 0) {
                this.valid_ = false;
                this.payloads_.length = 0;
                return;
            }
            const normalized_payload = normalizeAV1OBUForISOBMFF(payload);
            if (normalized_payload == null) {
                this.valid_ = false;
                this.payloads_.length = 0;
                return;
            }
            this.payloads_.push(normalized_payload);

            if (next_start_code_offset === data.byteLength) {
                break;
            }
            start_code_offset = next_start_code_offset;
        }
    }

    private hasStartCodeAt(data: Uint8Array, offset: number): boolean {
        return offset + 3 <= data.byteLength
            && data[offset] === 0x00
            && data[offset + 1] === 0x00
            && data[offset + 2] === 0x01;
    }

    private findNextStartCodeOffset(data: Uint8Array, start_offset: number): number {
        for (let offset = start_offset; offset + 3 <= data.byteLength; offset++) {
            if (this.hasStartCodeAt(data, offset)) {
                return offset;
            }
        }
        return data.byteLength;
    }
}

export default AV1OBUInMpegTsParser;
