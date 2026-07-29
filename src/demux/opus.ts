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

export interface OpusMPEG2TSMetadata {
    codec: 'opus';
    channel_count: number;
    channel_config_code: number;
    sample_rate: number;
}

export interface OpusMPEG2TSAccessUnit {
    data: Uint8Array;
    trim_start: number;
    trim_end: number;
    duration_samples: number;
    duration_ms: number;
}

const OPUS_REGISTRATION_DESCRIPTOR = new Uint8Array([
    0x05, 0x04, 0x4F, 0x70, 0x75, 0x73  // registration_descriptor: "Opus"
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

function isSupportedChannelConfiguration(channel_config_code: number): boolean {
    return channel_config_code === 0x00
        || (channel_config_code >= 0x01 && channel_config_code <= 0x08)
        || channel_config_code === 0x80
        || (channel_config_code >= 0x82 && channel_config_code <= 0x88);
}

function getChannelCount(channel_config_code: number): number {
    if (channel_config_code === 0x00 || channel_config_code === 0x80) {
        return 2;
    }
    return channel_config_code & 0x0F;
}

/**
 * Parse the exact descriptor pair emitted by FFmpeg and TSCodecBridge.
 */
export function parseOpusMPEG2TSDescriptors(descriptors: Uint8Array): OpusMPEG2TSMetadata | null {
    if (!bytesEqualAt(descriptors, 0, OPUS_REGISTRATION_DESCRIPTOR)) {
        return null;
    }

    const extension_offset = OPUS_REGISTRATION_DESCRIPTOR.byteLength;
    if (extension_offset + 4 > descriptors.byteLength
            || descriptors[extension_offset] !== 0x7F
            || descriptors[extension_offset + 1] !== 0x02
            || descriptors[extension_offset + 2] !== 0x80) {
        return null;
    }

    const channel_config_code = descriptors[extension_offset + 3];
    if (!isSupportedChannelConfiguration(channel_config_code)) {
        return null;
    }

    for (let offset = extension_offset + 4; offset < descriptors.byteLength; ) {
        if (offset + 2 > descriptors.byteLength) {
            return null;
        }
        const descriptor_end = offset + 2 + descriptors[offset + 1];
        if (descriptor_end > descriptors.byteLength) {
            return null;
        }
        offset = descriptor_end;
    }

    return {
        codec: 'opus',
        channel_count: getChannelCount(channel_config_code),
        channel_config_code,
        sample_rate: 48000
    };
}

/**
 * RFC 6716 の TOC から 48 kHz 単位の packet duration を得る。
 *
 * multi-stream packet でも先頭 stream の TOC と frame count は全 stream
 * で同一なので、self-delimited packet の全構造を展開せずに時間を求められる。
 */
export function getOpusPacketDurationSamples(data: Uint8Array): number | null {
    if (data.byteLength === 0) {
        return null;
    }

    const frame_durations = [
        480, 960, 1920, 2880,
        480, 960, 1920, 2880,
        480, 960, 1920, 2880,
        480, 960,
        480, 960,
        120, 240, 480, 960,
        120, 240, 480, 960,
        120, 240, 480, 960,
        120, 240, 480, 960
    ];

    const toc = data[0];
    const frame_duration = frame_durations[toc >>> 3];
    let frame_count: number;
    switch (toc & 0x03) {
        case 0:
            frame_count = 1;
            break;
        case 1:
            frame_count = 2;
            break;
        case 2:
            // VBR の 2-frame packet は TOC に続く第 1 frame の長さが必須。
            if (data.byteLength < 2) {
                return null;
            }
            frame_count = 2;
            break;
        case 3:
            if (data.byteLength < 2) {
                return null;
            }
            frame_count = data[1] & 0x3F;
            break;
    }

    const duration = frame_duration * frame_count;
    if (frame_count === 0 || duration > 5760) {
        return null;
    }
    return duration;
}

/**
 * Parse all Opus access units in one private PES atomically.
 */
export function parseOpusMPEG2TSAccessUnits(data: Uint8Array): OpusMPEG2TSAccessUnit[] | null {
    if (data.byteLength === 0) {
        return null;
    }

    const access_units: OpusMPEG2TSAccessUnit[] = [];
    let end_trim_seen = false;
    for (let offset = 0; offset < data.byteLength; ) {
        if (end_trim_seen) {
            return null;
        }
        if (offset + 3 > data.byteLength
                || data[offset] !== 0x7F
                || (data[offset + 1] & 0xE7) !== 0xE0) {
            return null;
        }

        const trim_start_present = (data[offset + 1] & 0x10) !== 0;
        const trim_end_present = (data[offset + 1] & 0x08) !== 0;
        let index = offset + 2;
        let size = 0;
        let size_byte: number;
        do {
            if (index >= data.byteLength) {
                return null;
            }
            size_byte = data[index++];
            size += size_byte;
            if (!Number.isSafeInteger(size)) {
                return null;
            }
        } while (size_byte === 0xFF);

        let trim_start = 0;
        let trim_end = 0;
        if (trim_start_present) {
            if (index + 2 > data.byteLength) {
                return null;
            }
            if ((data[index] & 0xE0) !== 0) {
                return null;
            }
            trim_start = ((data[index] & 0x1F) << 8) | data[index + 1];
            index += 2;
        }
        if (trim_end_present) {
            if (index + 2 > data.byteLength) {
                return null;
            }
            if ((data[index] & 0xE0) !== 0) {
                return null;
            }
            trim_end = ((data[index] & 0x1F) << 8) | data[index + 1];
            index += 2;
        }

        if (size === 0 || index + size > data.byteLength) {
            return null;
        }
        const packet = data.slice(index, index + size);
        const duration_samples = getOpusPacketDurationSamples(packet);
        if (duration_samples == null || trim_start + trim_end > duration_samples) {
            return null;
        }
        access_units.push({
            data: packet,
            trim_start,
            trim_end,
            duration_samples,
            duration_ms: duration_samples / 48
        });
        end_trim_seen = trim_end_present;
        offset = index + size;
    }

    return access_units;
}
