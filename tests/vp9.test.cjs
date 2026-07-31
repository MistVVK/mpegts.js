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

'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {default: TSDemuxer} = require('../src/demux/ts-demuxer.ts');
const {StreamType} = require('../src/demux/pat-pmt-pes.ts');
const {default: MP4} = require('../src/remux/mp4-generator.js');
const {default: Log} = require('../src/utils/logger.js');
const {
    VP9_PRIVATE_MAPPING_V1_DESCRIPTORS,
    buildVP9CodecConfigurationRecord,
    buildVP9CodecString,
    deriveVP9Level,
    hasVP9PrivateMappingV1,
    parseVP9FrameHeader,
    parseVP9SampleLayout
} = require('../src/demux/vp9.ts');

Log.ENABLE_ERROR = false;
Log.ENABLE_INFO = false;
Log.ENABLE_WARN = false;
Log.ENABLE_DEBUG = false;
Log.ENABLE_VERBOSE = false;

class BitWriter {

    constructor() {
        this.bits = [];
    }

    write(value, length) {
        for (let bit = length - 1; bit >= 0; bit--) {
            this.bits.push((value >>> bit) & 0x01);
        }
    }

    finish(minimumBytes = 0) {
        while ((this.bits.length & 0x07) !== 0) {
            this.bits.push(0);
        }
        while (this.bits.length < minimumBytes * 8) {
            this.bits.push(0);
        }

        const data = new Uint8Array(this.bits.length >>> 3);
        for (let i = 0; i < this.bits.length; i++) {
            data[i >>> 3] |= this.bits[i] << (7 - (i & 0x07));
        }
        return data;
    }
}

function buildKeyframe({
    profile,
    bitDepth,
    width,
    height,
    renderWidth = width,
    renderHeight = height,
    colorSpace = 2,
    fullRange = 0
}) {
    const writer = new BitWriter();
    writer.write(2, 2);  // frame_marker
    writer.write(profile & 0x01, 1);  // profile_low_bit
    writer.write((profile >>> 1) & 0x01, 1);  // profile_high_bit
    if (profile === 3) writer.write(0, 1);
    writer.write(0, 1);  // show_existing_frame
    writer.write(0, 1);  // KEY_FRAME
    writer.write(1, 1);  // show_frame
    writer.write(0, 1);  // error_resilient_mode
    writer.write(0x498342, 24);

    if (profile >= 2) writer.write(bitDepth === 12 ? 1 : 0, 1);
    writer.write(colorSpace, 3);
    if (colorSpace !== 7) {
        writer.write(fullRange, 1);
        if (profile === 1 || profile === 3) {
            writer.write(1, 1);
            writer.write(1, 1);
            writer.write(0, 1);
        }
    } else {
        writer.write(0, 1);
    }

    writer.write(width - 1, 16);
    writer.write(height - 1, 16);
    const differentRenderSize = renderWidth !== width || renderHeight !== height;
    writer.write(differentRenderSize ? 1 : 0, 1);
    if (differentRenderSize) {
        writer.write(renderWidth - 1, 16);
        writer.write(renderHeight - 1, 16);
    }
    return writer.finish(10);
}

function buildInterFrame(profile) {
    const writer = new BitWriter();
    writer.write(2, 2);
    writer.write(profile & 0x01, 1);
    writer.write((profile >>> 1) & 0x01, 1);
    if (profile === 3) writer.write(0, 1);
    writer.write(0, 1);  // show_existing_frame
    writer.write(1, 1);  // INTER_FRAME
    writer.write(1, 1);  // show_frame
    writer.write(0, 1);  // error_resilient_mode
    writer.write(0, 2);  // reset_frame_context
    return writer.finish(10);
}

function concatenate(arrays) {
    const length = arrays.reduce((total, data) => total + data.byteLength, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const data of arrays) {
        result.set(data, offset);
        offset += data.byteLength;
    }
    return result;
}

function buildSuperframe(frames) {
    const largest = Math.max(... frames.map((frame) => frame.byteLength));
    const magnitude = largest <= 0xFF ? 1 : largest <= 0xFFFF ? 2 : 3;
    const marker = 0xC0 | ((magnitude - 1) << 3) | (frames.length - 1);
    const index = new Uint8Array(2 + frames.length * magnitude);
    index[0] = marker;
    let offset = 1;
    for (const frame of frames) {
        let size = frame.byteLength;
        for (let byte = 0; byte < magnitude; byte++) {
            index[offset++] = size & 0xFF;
            size = Math.floor(size / 256);
        }
    }
    index[index.byteLength - 1] = marker;
    return concatenate([... frames, index]);
}

function makePMT(descriptors, pid = 0x0101) {
    const esInfoLength = descriptors.byteLength;
    const es = new Uint8Array(5 + esInfoLength);
    es[0] = StreamType.kPESPrivateData;
    es[1] = 0xE0 | ((pid >>> 8) & 0x1F);
    es[2] = pid & 0xFF;
    es[3] = 0xF0 | ((esInfoLength >>> 8) & 0x0F);
    es[4] = esInfoLength & 0xFF;
    es.set(descriptors, 5);

    const sectionLength = 9 + es.byteLength + 4;
    const section = new Uint8Array(3 + sectionLength);
    section.set([
        0x02,
        0xB0 | ((sectionLength >>> 8) & 0x0F),
        sectionLength & 0xFF,
        0x00, 0x01,  // program_number
        0xC1,        // version 0, current_next_indicator
        0x00, 0x00,  // section_number, last_section_number
        0xE0 | ((pid >>> 8) & 0x1F),
        pid & 0xFF,  // PCR_PID
        0xF0, 0x00  // program_info_length
    ]);
    section.set(es, 12);
    return section;
}

function makePAT(pmtPid = 0x0100) {
    return new Uint8Array([
        0x00, 0xB0, 0x0D,
        0x00, 0x01,  // transport_stream_id
        0xC1,        // version 0, current_next_indicator
        0x00, 0x00,
        0x00, 0x01,  // program_number
        0xE0 | ((pmtPid >>> 8) & 0x1F),
        pmtPid & 0xFF,
        0x00, 0x00, 0x00, 0x00  // CRC32 (not validated by the demuxer)
    ]);
}

function makeTSPacket(pid, payload, {
    payloadUnitStart = false,
    continuityCounter = 0,
    randomAccessIndicator = false
} = {}) {
    const maximumPayload = randomAccessIndicator ? 182 : 184;
    if (payload.byteLength > maximumPayload) {
        throw new RangeError('TS payload is too large');
    }

    const packet = new Uint8Array(188);
    packet.fill(0xFF);
    packet[0] = 0x47;
    packet[1] = (payloadUnitStart ? 0x40 : 0x00) | ((pid >>> 8) & 0x1F);
    packet[2] = pid & 0xFF;

    let payloadOffset = 4;
    if (payload.byteLength < 184 || randomAccessIndicator) {
        packet[3] = 0x30 | (continuityCounter & 0x0F);
        const adaptationFieldLength = 183 - payload.byteLength;
        packet[4] = adaptationFieldLength;
        if (adaptationFieldLength > 0) {
            packet[5] = randomAccessIndicator ? 0x40 : 0x00;
        }
        payloadOffset = 5 + adaptationFieldLength;
    } else {
        packet[3] = 0x10 | (continuityCounter & 0x0F);
    }
    packet.set(payload, payloadOffset);
    return packet;
}

function packetizePES(pid, pes, randomAccessIndicator) {
    const packets = [];
    let offset = 0;
    let continuityCounter = 0;
    while (offset < pes.byteLength) {
        const first = offset === 0;
        const maximumPayload = first && randomAccessIndicator ? 182 : 184;
        const length = Math.min(maximumPayload, pes.byteLength - offset);
        packets.push(makeTSPacket(pid, pes.subarray(offset, offset + length), {
            payloadUnitStart: first,
            continuityCounter,
            randomAccessIndicator: first && randomAccessIndicator
        }));
        offset += length;
        continuityCounter = (continuityCounter + 1) & 0x0F;
    }
    return packets;
}

function encodePTS(pts) {
    return new Uint8Array([
        0x20 | (Math.floor(pts / 0x40000000) << 1) | 1,
        Math.floor(pts / 0x400000) & 0xFF,
        ((Math.floor(pts / 0x8000) & 0x7F) << 1) | 1,
        Math.floor(pts / 0x80) & 0xFF,
        ((pts & 0x7F) << 1) | 1
    ]);
}

function makePES(payload, {streamId = 0xE0, dataAlignment = true, pts = 90000} = {}) {
    const packetLength = 3 + 5 + payload.byteLength;
    const data = new Uint8Array(14 + payload.byteLength);
    data.set([
        0x00, 0x00, 0x01, streamId,
        (packetLength >>> 8) & 0xFF, packetLength & 0xFF,
        0x80 | (dataAlignment ? 0x04 : 0x00),
        0x80,
        0x05
    ]);
    data.set(encodePTS(pts), 9);
    data.set(payload, 14);
    return data;
}

function makeDemuxer(descriptors = VP9_PRIVATE_MAPPING_V1_DESCRIPTORS) {
    const demuxer = new TSDemuxer({ts_packet_size: 188, sync_offset: 0}, {});
    const metadata = [];
    demuxer.onError = () => {};
    demuxer.onMediaInfo = () => {};
    demuxer.onTrackMetadata = (type, meta) => metadata.push({type, meta});
    demuxer.onDataAvailable = () => {};
    demuxer.current_program_ = 1;
    demuxer.parsePMT(makePMT(descriptors));
    return {demuxer, metadata};
}

function parsePrivatePES(demuxer, payload, {
    streamId = 0xE0,
    dataAlignment = true,
    pts = 90000,
    randomAccessIndicator = 1
} = {}) {
    demuxer.parsePES({
        pid: 0x0101,
        data: makePES(payload, {streamId, dataAlignment, pts}),
        stream_type: StreamType.kPESPrivateData,
        file_position: 1234,
        random_access_indicator: randomAccessIndicator
    });
}

function findFourCC(data, fourCC) {
    const bytes = Array.from(fourCC, (character) => character.charCodeAt(0));
    for (let offset = 0; offset <= data.byteLength - bytes.length; offset++) {
        if (bytes.every((value, index) => data[offset + index] === value)) {
            return offset;
        }
    }
    return -1;
}

test('VP9 private mapping v1 は完全一致する隣接 descriptor pair だけを受理する', () => {
    assert.equal(hasVP9PrivateMappingV1(VP9_PRIVATE_MAPPING_V1_DESCRIPTORS), true);

    const withPrefix = concatenate([
        new Uint8Array([0x52, 0x01, 0x80]),
        VP9_PRIVATE_MAPPING_V1_DESCRIPTORS
    ]);
    assert.equal(hasVP9PrivateMappingV1(withPrefix), false);

    const withSuffix = concatenate([
        VP9_PRIVATE_MAPPING_V1_DESCRIPTORS,
        new Uint8Array([0x52, 0x01, 0x80])
    ]);
    assert.equal(hasVP9PrivateMappingV1(withSuffix), true);
    assert.equal(
        hasVP9PrivateMappingV1(concatenate([
            VP9_PRIVATE_MAPPING_V1_DESCRIPTORS,
            new Uint8Array([0x52, 0x02, 0x80])
        ])),
        false
    );

    for (const index of [13, 14, 15]) {
        const invalid = VP9_PRIVATE_MAPPING_V1_DESCRIPTORS.slice();
        invalid[index] ^= 0x01;
        assert.equal(hasVP9PrivateMappingV1(invalid), false);
    }

    const separated = concatenate([
        VP9_PRIVATE_MAPPING_V1_DESCRIPTORS.subarray(0, 6),
        new Uint8Array([0x52, 0x01, 0x80]),
        VP9_PRIVATE_MAPPING_V1_DESCRIPTORS.subarray(6)
    ]);
    assert.equal(hasVP9PrivateMappingV1(separated), false);
    assert.equal(hasVP9PrivateMappingV1(VP9_PRIVATE_MAPPING_V1_DESCRIPTORS.subarray(0, 15)), false);
});

test('profile 0/2 keyframe を MSB-first で解析し codec string と vpcC を生成する', () => {
    const profile0 = buildKeyframe({
        profile: 0,
        bitDepth: 8,
        width: 1920,
        height: 1080
    });
    assert.equal(profile0[0], 0x82);
    const header0 = parseVP9FrameHeader(profile0);
    assert.equal(header0.isKeyframe, true);
    assert.equal(header0.profile, 0);
    assert.equal(header0.config.bitDepth, 8);
    assert.equal(header0.config.codecWidth, 1920);
    assert.equal(header0.config.codecHeight, 1080);
    assert.equal(header0.config.level, 41);
    assert.equal(buildVP9CodecString(header0.config), 'vp09.00.41.08');
    assert.deepEqual(
        buildVP9CodecConfigurationRecord(header0.config),
        new Uint8Array([0x00, 0x29, 0x82, 0x01, 0x01, 0x01, 0x00, 0x00])
    );

    const profile2 = buildKeyframe({
        profile: 2,
        bitDepth: 10,
        width: 3840,
        height: 2160,
        renderWidth: 1920,
        renderHeight: 1080,
        fullRange: 1
    });
    assert.equal(profile2[0], 0x92);
    const header2 = parseVP9FrameHeader(profile2);
    assert.equal(header2.isKeyframe, true);
    assert.equal(header2.profile, 2);
    assert.equal(header2.config.bitDepth, 10);
    assert.equal(header2.config.codecWidth, 3840);
    assert.equal(header2.config.codecHeight, 2160);
    assert.equal(header2.config.presentWidth, 1920);
    assert.equal(header2.config.presentHeight, 1080);
    assert.equal(header2.config.level, 51);
    assert.equal(buildVP9CodecString(header2.config), 'vp09.02.51.10');
    assert.equal(buildVP9CodecConfigurationRecord(header2.config)[2], 0xA3);
    assert.equal(deriveVP9Level(1920, 1080), 41);
    assert.equal(deriveVP9Level(3840, 2160), 51);
});

test('libvpx-vp9 で生成した profile 0/2 keyframe の実データを解析する', () => {
    // FFmpeg 7.1.5 / libvpx-vp9, 64x36 black frame, IVF frame payload.
    const profile0 = new Uint8Array([
        0x82, 0x49, 0x83, 0x42, 0x00, 0x03, 0xF0, 0x02,
        0x36, 0x00, 0x38, 0x24, 0x1C, 0x18, 0x4A, 0x00,
        0x00, 0x30, 0x60, 0x00, 0x00, 0x13, 0xBF, 0xFF,
        0xFD, 0x59, 0x15, 0x80, 0x00, 0x00, 0x00
    ]);
    const profile2 = new Uint8Array([
        0x92, 0x49, 0x83, 0x42, 0x00, 0x01, 0xF8, 0x01,
        0x1B, 0x00, 0x1C, 0x12, 0x0E, 0x0C, 0x2C, 0x00,
        0x00, 0x18, 0x60, 0x00, 0x00, 0x13, 0xBF, 0xFF,
        0xFC, 0x93, 0xAD, 0x00, 0x00, 0x00, 0x00
    ]);

    const header0 = parseVP9FrameHeader(profile0);
    assert.equal(header0.profile, 0);
    assert.equal(header0.config.bitDepth, 8);
    assert.equal(header0.config.level, 10);
    assert.equal(header0.config.codecWidth, 64);
    assert.equal(header0.config.codecHeight, 36);

    const header2 = parseVP9FrameHeader(profile2);
    assert.equal(header2.profile, 2);
    assert.equal(header2.config.bitDepth, 10);
    assert.equal(header2.config.level, 10);
    assert.equal(header2.config.codecWidth, 64);
    assert.equal(header2.config.codecHeight, 36);
});

test('inter frame は profile が一致する直前設定を継承し、不正 header は拒否する', () => {
    const keyframe = buildKeyframe({
        profile: 2,
        bitDepth: 10,
        width: 3840,
        height: 2160
    });
    const config = parseVP9FrameHeader(keyframe).config;
    const inter = buildInterFrame(2);
    const interHeader = parseVP9FrameHeader(inter, config);
    assert.equal(interHeader.isKeyframe, false);
    assert.equal(interHeader.isIntraOnly, false);
    assert.equal(interHeader.config, config);

    assert.equal(parseVP9FrameHeader(buildInterFrame(0), config).config, undefined);
    assert.equal(parseVP9FrameHeader(new Uint8Array([0x00, ... new Uint8Array(9)])), null);

    const badSync = keyframe.slice();
    badSync[1] ^= 0x01;
    assert.equal(parseVP9FrameHeader(badSync), null);
    assert.equal(parseVP9FrameHeader(keyframe.subarray(0, 5)), null);
});

test('superframe index を検証して各 frame を分離する', () => {
    const keyframe = buildKeyframe({
        profile: 0,
        bitDepth: 8,
        width: 1280,
        height: 720
    });
    const inter = buildInterFrame(0);
    const sample = buildSuperframe([keyframe, inter]);
    const layout = parseVP9SampleLayout(sample);
    assert.equal(layout.isSuperframe, true);
    assert.deepEqual(layout.frames[0], keyframe);
    assert.deepEqual(layout.frames[1], inter);

    const malformed = sample.slice();
    malformed[malformed.byteLength - 2] += 1;
    assert.equal(parseVP9SampleLayout(malformed), null);
    assert.deepEqual(parseVP9SampleLayout(keyframe).frames[0], keyframe);
});

test('MP4 generator は vp09 sample entry と version 1 vpcC を生成する', () => {
    const keyframe = buildKeyframe({
        profile: 2,
        bitDepth: 10,
        width: 3840,
        height: 2160
    });
    const config = parseVP9FrameHeader(keyframe).config;
    const vpcc = buildVP9CodecConfigurationRecord(config);
    const sampleEntry = MP4.vp09({
        codecWidth: config.codecWidth,
        codecHeight: config.codecHeight,
        vpcc
    });

    assert.equal(String.fromCharCode(... sampleEntry.subarray(4, 8)), 'vp09');
    const vpcCOffset = findFourCC(sampleEntry, 'vpcC');
    assert.notEqual(vpcCOffset, -1);
    assert.deepEqual(
        sampleEntry.subarray(vpcCOffset + 4, vpcCOffset + 16),
        new Uint8Array([0x01, 0x00, 0x00, 0x00, ... vpcc])
    );

    const stsd = MP4.stsd({
        type: 'video',
        codec: buildVP9CodecString(config),
        codecWidth: config.codecWidth,
        codecHeight: config.codecHeight,
        vpcc
    });
    assert.notEqual(findFourCC(stsd, 'vp09'), -1);
    assert.equal(findFourCC(stsd, 'avc1'), -1);
});

test('PMT/PES は mapping v1、E0、alignment、RAI を満たす VP9 AU だけを受理する', () => {
    const keyframe = buildKeyframe({
        profile: 0,
        bitDepth: 8,
        width: 1920,
        height: 1080
    });
    const inter = buildInterFrame(0);
    const superframe = buildSuperframe([keyframe, inter]);

    const {demuxer, metadata} = makeDemuxer();
    assert.equal(demuxer.pmt_.common_pids.vp9, 0x0101);
    assert.equal(demuxer.has_video_, true);

    parsePrivatePES(demuxer, superframe);
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].type, 'video');
    assert.equal(metadata[0].meta.codec, 'vp09.00.41.08');
    assert.deepEqual(metadata[0].meta.vpcc, new Uint8Array([0x00, 0x29, 0x82, 0x01, 0x01, 0x01, 0x00, 0x00]));
    assert.equal(demuxer.video_track_.samples.length, 1);
    assert.equal(demuxer.video_track_.samples[0].isKeyframe, true);
    assert.deepEqual(demuxer.video_track_.samples[0].units[0].data, superframe);

    parsePrivatePES(demuxer, inter, {pts: 180000, randomAccessIndicator: 0});
    assert.equal(demuxer.video_track_.samples.length, 2);
    assert.equal(demuxer.video_track_.samples[1].isKeyframe, false);
    assert.deepEqual(demuxer.video_track_.samples[1].units[0].data, inter);

    for (const invalidOptions of [
        {streamId: 0xBD},
        {dataAlignment: false},
        {randomAccessIndicator: 0}
    ]) {
        const invalid = makeDemuxer();
        parsePrivatePES(invalid.demuxer, keyframe, invalidOptions);
        assert.equal(invalid.metadata.length, 0);
        assert.equal(invalid.demuxer.video_track_.samples.length, 0);
    }
});

test('PMT は未知 version/flags/reserved の VP9 mapping を fail-closed にする', () => {
    for (const index of [13, 14, 15]) {
        const descriptors = VP9_PRIVATE_MAPPING_V1_DESCRIPTORS.slice();
        descriptors[index] ^= 0x01;
        const {demuxer} = makeDemuxer(descriptors);
        assert.equal(demuxer.pmt_.common_pids.vp9, undefined);
        assert.equal(demuxer.has_video_, false);
    }
});

test('188-byte TS packet をまたぐ VP9 PES を PMT の private PID から復元する', () => {
    const pmtPid = 0x0100;
    const videoPid = 0x0101;
    const keyframeHeader = buildKeyframe({
        profile: 2,
        bitDepth: 10,
        width: 3840,
        height: 2160
    });
    const keyframe = concatenate([keyframeHeader, new Uint8Array(300)]);
    const pes = makePES(keyframe);

    const patPacket = makeTSPacket(
        0x0000,
        concatenate([new Uint8Array([0x00]), makePAT(pmtPid)]),
        {payloadUnitStart: true}
    );
    const pmtPacket = makeTSPacket(
        pmtPid,
        concatenate([new Uint8Array([0x00]), makePMT(VP9_PRIVATE_MAPPING_V1_DESCRIPTORS, videoPid)]),
        {payloadUnitStart: true}
    );
    const stream = concatenate([
        patPacket,
        pmtPacket,
        ... packetizePES(videoPid, pes, true)
    ]);

    const metadata = [];
    const mediaSegments = [];
    const demuxer = new TSDemuxer({ts_packet_size: 188, sync_offset: 0}, {});
    demuxer.onError = () => {};
    demuxer.onMediaInfo = () => {};
    demuxer.onTrackMetadata = (type, meta) => metadata.push({type, meta});
    demuxer.onDataAvailable = (audioTrack, videoTrack) => mediaSegments.push({audioTrack, videoTrack});

    const consumed = demuxer.parseChunks(stream.buffer, 0);
    assert.equal(consumed, stream.byteLength);
    assert.equal(demuxer.pmt_.common_pids.vp9, videoPid);
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].meta.codec, 'vp09.02.51.10');
    assert.equal(mediaSegments.length, 1);
    assert.equal(mediaSegments[0].videoTrack.samples.length, 1);
    assert.deepEqual(mediaSegments[0].videoTrack.samples[0].units[0].data, keyframe);
});
