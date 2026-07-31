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

global.self = {
    navigator: {
        userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'
    }
};

const {default: TSDemuxer} = require('../src/demux/ts-demuxer.ts');
const {StreamType} = require('../src/demux/pat-pmt-pes.ts');
const {
    default: AV1OBUInMpegTsParser,
    parseAV1MPEG2TSDescriptors
} = require('../src/demux/av1.ts');
const {default: AV1OBUParser} = require('../src/demux/av1-parser.ts');
const {
    getOpusPacketDurationSamples,
    parseOpusMPEG2TSAccessUnits,
    parseOpusMPEG2TSDescriptors
} = require('../src/demux/opus.ts');
const {default: MP4} = require('../src/remux/mp4-generator.js');
const {default: MP4Remuxer} = require('../src/remux/mp4-remuxer.js');
const {
    default: MSEController,
    formatMSECodec
} = require('../src/core/mse-controller.js');
const {default: Log} = require('../src/utils/logger.js');

Log.ENABLE_ERROR = false;
Log.ENABLE_INFO = false;
Log.ENABLE_WARN = false;
Log.ENABLE_DEBUG = false;
Log.ENABLE_VERBOSE = false;

function hex(value) {
    return new Uint8Array(Buffer.from(value.replaceAll(/\s+/g, ''), 'hex'));
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

function readTrunDurations(buffer) {
    const data = new Uint8Array(buffer);
    for (let typeOffset = 4; typeOffset + 16 <= data.byteLength; typeOffset++) {
        if (String.fromCharCode(...data.subarray(typeOffset, typeOffset + 4)) !== 'trun') {
            continue;
        }
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const sampleCount = view.getUint32(typeOffset + 8);
        const durations = [];
        for (let index = 0; index < sampleCount; index++) {
            durations.push(view.getUint32(typeOffset + 16 + index * 16));
        }
        return durations;
    }
    throw new Error('trun box was not found');
}

function encodeLEB128(value) {
    const bytes = [];
    do {
        let byte = value & 0x7F;
        value = Math.floor(value / 128);
        if (value !== 0) byte |= 0x80;
        bytes.push(byte);
    } while (value !== 0);
    return new Uint8Array(bytes);
}

function splitLowOverheadOBUs(data) {
    const result = [];
    for (let offset = 0; offset < data.byteLength; ) {
        const start = offset;
        const header = data[offset++];
        if ((header & 0x04) !== 0) offset++;
        if ((header & 0x02) === 0) {
            result.push(data.slice(start));
            break;
        }

        let size = 0;
        let multiplier = 1;
        while (true) {
            const value = data[offset++];
            size += (value & 0x7F) * multiplier;
            if ((value & 0x80) === 0) break;
            multiplier *= 128;
        }
        result.push(data.slice(start, offset + size));
        offset += size;
    }
    return result;
}

function escapeAV1OBU(data) {
    const result = [];
    let consecutiveZeros = 0;
    for (const value of data) {
        if (consecutiveZeros >= 2 && value <= 0x03) {
            result.push(0x03);
            consecutiveZeros = 0;
        }
        result.push(value);
        consecutiveZeros = value === 0x00 ? consecutiveZeros + 1 : 0;
    }
    return new Uint8Array(result);
}

function startCodeOBU(data) {
    return concatenate([new Uint8Array([0x00, 0x00, 0x01]), escapeAV1OBU(data)]);
}

function makeAV1TSPayload(obus) {
    return concatenate(obus.map(startCodeOBU));
}

function makePaddingOBU(size) {
    return concatenate([
        new Uint8Array([0x7A]),  // OBU_PADDING + obu_has_size_field
        encodeLEB128(size),
        new Uint8Array(size).fill(0x55)
    ]);
}

function makePAT(pmtPid = 0x0100) {
    return new Uint8Array([
        0x00, 0xB0, 0x0D,
        0x00, 0x01,
        0xC1,
        0x00, 0x00,
        0x00, 0x01,
        0xE0 | ((pmtPid >>> 8) & 0x1F),
        pmtPid & 0xFF,
        0x00, 0x00, 0x00, 0x00
    ]);
}

function makePMT(streams, {pcrPid = streams[0].pid, version = 0} = {}) {
    const elementaryStreams = streams.map(({pid, streamType, descriptors}) => {
        const es = new Uint8Array(5 + descriptors.byteLength);
        es[0] = streamType;
        es[1] = 0xE0 | ((pid >>> 8) & 0x1F);
        es[2] = pid & 0xFF;
        es[3] = 0xF0 | ((descriptors.byteLength >>> 8) & 0x0F);
        es[4] = descriptors.byteLength & 0xFF;
        es.set(descriptors, 5);
        return es;
    });
    const elementaryData = concatenate(elementaryStreams);
    const sectionLength = 9 + elementaryData.byteLength + 4;
    const section = new Uint8Array(3 + sectionLength);
    section.set([
        0x02,
        0xB0 | ((sectionLength >>> 8) & 0x0F),
        sectionLength & 0xFF,
        0x00, 0x01,
        0xC1 | ((version & 0x1F) << 1),
        0x00, 0x00,
        0xE0 | ((pcrPid >>> 8) & 0x1F),
        pcrPid & 0xFF,
        0xF0, 0x00
    ]);
    section.set(elementaryData, 12);
    return section;
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

class TSPacketBuilder {

    constructor() {
        this.continuityCounters = new Map();
    }

    section(pid, section) {
        return [this.packet(pid, concatenate([new Uint8Array([0x00]), section]), {
            payloadUnitStart: true
        })];
    }

    pes(pid, data, randomAccessIndicator = false) {
        const packets = [];
        for (let offset = 0; offset < data.byteLength; ) {
            const first = offset === 0;
            const maximumPayload = first && randomAccessIndicator ? 182 : 184;
            const length = Math.min(maximumPayload, data.byteLength - offset);
            packets.push(this.packet(pid, data.subarray(offset, offset + length), {
                payloadUnitStart: first,
                randomAccessIndicator: first && randomAccessIndicator
            }));
            offset += length;
        }
        return packets;
    }

    packet(pid, payload, options) {
        const continuityCounter = this.continuityCounters.get(pid) ?? 0;
        this.continuityCounters.set(pid, (continuityCounter + 1) & 0x0F);
        return makeTSPacket(pid, payload, {...options, continuityCounter});
    }
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

function makePES(payload, {
    streamId = 0xBD,
    dataAlignment = true,
    pts = 90000
} = {}) {
    const ptsData = pts == null ? new Uint8Array() : encodePTS(pts);
    const packetLength = 3 + ptsData.byteLength + payload.byteLength;
    const data = new Uint8Array(9 + ptsData.byteLength + payload.byteLength);
    data.set([
        0x00, 0x00, 0x01, streamId,
        (packetLength >>> 8) & 0xFF, packetLength & 0xFF,
        0x80 | (dataAlignment ? 0x04 : 0x00),
        pts == null ? 0x00 : 0x80,
        ptsData.byteLength
    ]);
    data.set(ptsData, 9);
    data.set(payload, 9 + ptsData.byteLength);
    return data;
}

function makeOpusAccessUnit(packet, {trimStart, trimEnd} = {}) {
    let flags = 0xE0;
    if (trimStart != null) flags |= 0x10;
    if (trimEnd != null) flags |= 0x08;

    let remaining = packet.byteLength;
    const size = [];
    while (remaining >= 0xFF) {
        size.push(0xFF);
        remaining -= 0xFF;
    }
    size.push(remaining);

    const trim = [];
    if (trimStart != null) trim.push((trimStart >>> 8) & 0xFF, trimStart & 0xFF);
    if (trimEnd != null) trim.push((trimEnd >>> 8) & 0xFF, trimEnd & 0xFF);
    return concatenate([
        new Uint8Array([0x7F, flags, ...size, ...trim]),
        packet
    ]);
}

function makeDemuxer(onTrackMetadata, onDataAvailable) {
    const demuxer = new TSDemuxer({ts_packet_size: 188, sync_offset: 0}, {});
    demuxer.onError = () => {};
    demuxer.onMediaInfo = () => {};
    demuxer.onTrackMetadata = onTrackMetadata;
    demuxer.onDataAvailable = onDataAvailable;
    return demuxer;
}

const AV1_DESCRIPTOR = hex('05 04 41 56 30 31 80 04 81 00 0c 00');
const AV1_64X36 = hex(
    '12 00 ' +
    '0a 0a 00 00 00 02 af f1 9b 5f 20 08 ' +
    '32 0e 10 00 c0 00 00 02 80 00 00 0a 05 77 64 80'
);
const AV1_80X48 = hex(
    '12 00 ' +
    '0a 0a 00 00 00 03 2c fb cd af 90 04 ' +
    '32 0f 10 00 a0 00 00 01 40 00 40 01 c5 78 50 68 c0'
);

function opusDescriptor(channelConfigCode, componentTag) {
    return new Uint8Array([
        0x05, 0x04, 0x4F, 0x70, 0x75, 0x73,
        0x7F, 0x02, 0x80, channelConfigCode,
        0x52, 0x01, componentTag
    ]);
}

test('AV1/Opus descriptor と private framing は未知・欠損データを fail-closed にする', () => {
    assert.deepEqual(
        parseAV1MPEG2TSDescriptors(AV1_DESCRIPTOR),
        new Uint8Array([0x81, 0x00, 0x0C, 0x00])
    );
    const badAV1Version = AV1_DESCRIPTOR.slice();
    badAV1Version[8] = 0x82;
    assert.equal(parseAV1MPEG2TSDescriptors(badAV1Version), null);
    assert.equal(
        AV1OBUInMpegTsParser.ebsp2rbsp(new Uint8Array([0x00, 0x00, 0x03])),
        null
    );
    const noSizeTemporalDelimiter = new AV1OBUInMpegTsParser(hex('00 00 01 10'));
    assert.equal(noSizeTemporalDelimiter.isValid(), true);
    assert.deepEqual(
        noSizeTemporalDelimiter.readNextOBUPayload(),
        new Uint8Array([0x12, 0x00])
    );
    assert.equal(
        AV1OBUParser.parseOBUsWithStatus(hex('4a 00')).valid,
        false
    );
    assert.equal(
        AV1OBUParser.parseOBUsWithStatus(hex('0a 01 00')).valid,
        false
    );

    assert.deepEqual(parseOpusMPEG2TSDescriptors(opusDescriptor(0x06, 0x11)), {
        codec: 'opus',
        channel_count: 6,
        channel_config_code: 0x06,
        sample_rate: 48000
    });
    assert.equal(parseOpusMPEG2TSDescriptors(opusDescriptor(0x00, 0x11)).channel_count, 2);
    assert.equal(parseOpusMPEG2TSDescriptors(opusDescriptor(0x80, 0x11)).channel_count, 2);
    assert.equal(parseOpusMPEG2TSDescriptors(opusDescriptor(0x81, 0x11)), null);

    const packet255 = new Uint8Array(255).fill(0xA5);
    packet255[0] = 0xF8;
    const framed = makeOpusAccessUnit(packet255, {trimStart: 12, trimEnd: 34});
    const accessUnits = parseOpusMPEG2TSAccessUnits(framed);
    assert.equal(accessUnits.length, 1);
    assert.deepEqual(accessUnits[0].data, packet255);
    assert.equal(accessUnits[0].trim_start, 12);
    assert.equal(accessUnits[0].trim_end, 34);
    assert.equal(accessUnits[0].duration_samples, 960);
    assert.equal(accessUnits[0].duration_ms, 20);
    assert.equal(parseOpusMPEG2TSAccessUnits(framed.subarray(0, framed.byteLength - 1)), null);

    const badReservedTrim = framed.slice();
    badReservedTrim[4] |= 0x80;
    assert.equal(parseOpusMPEG2TSAccessUnits(badReservedTrim), null);
    assert.equal(
        parseOpusMPEG2TSAccessUnits(makeOpusAccessUnit(hex('f8 01'), {trimStart: 961})),
        null
    );
    assert.equal(
        parseOpusMPEG2TSAccessUnits(concatenate([
            makeOpusAccessUnit(hex('f8 01'), {trimEnd: 1}),
            makeOpusAccessUnit(hex('f8 02'))
        ])),
        null
    );
});

test('Opus TOC duration と dOps channel mapping は可変長・dual mono・discrete を保持する', () => {
    assert.equal(getOpusPacketDurationSamples(hex('80 01')), 120);
    assert.equal(getOpusPacketDurationSamples(hex('90 01')), 480);
    assert.equal(getOpusPacketDurationSamples(hex('10 01')), 1920);
    assert.equal(getOpusPacketDurationSamples(hex('19 01 02')), 5760);
    assert.equal(getOpusPacketDurationSamples(hex('1b 03')), null);
    assert.equal(getOpusPacketDurationSamples(hex('fa')), null);

    const dOps07 = MP4.dOps({
        channelCount: 7,
        channelConfigCode: 0x07,
        audioSampleRate: 48000
    });
    assert.deepEqual(
        dOps07.subarray(18),
        new Uint8Array([0x01, 0x04, 0x03, 0x00, 0x04, 0x01, 0x02, 0x03, 0x05, 0x06])
    );

    const dOps82 = MP4.dOps({
        channelCount: 2,
        channelConfigCode: 0x82,
        audioSampleRate: 48000
    });
    assert.deepEqual(
        dOps82.subarray(18),
        new Uint8Array([0x01, 0x02, 0x00, 0x00, 0x01])
    );

    const dOpsDualMono = MP4.dOps({
        channelCount: 2,
        channelConfigCode: 0x00,
        audioSampleRate: 48000
    });
    assert.deepEqual(
        dOpsDualMono.subarray(18),
        new Uint8Array([0xFF, 0x01, 0x01, 0x00, 0x01])
    );
});

test('AV1 は TS packet 境界をまたぐ start code と複数 PES を復元し、構成変更を media→init の順で反映する', () => {
    const pmtPid = 0x0100;
    const videoPid = 0x0101;
    const obus64 = splitLowOverheadOBUs(AV1_64X36);
    const obus80 = splitLowOverheadOBUs(AV1_80X48);
    const changedDescriptor = AV1_DESCRIPTOR.slice();
    changedDescriptor[11] = 0x10;

    // RAI 付き先頭 TS packet の PES payload は 182 bytes。
    // PES header 14 bytes + TD 5 bytes + padding 161 bytes の直後に置くことで、
    // sequence-header start code の 00 00 / 01 を TS packet 境界で分割する。
    const firstPayload = makeAV1TSPayload([
        obus64[0],
        makePaddingOBU(155),
        obus64[1],
        obus64[2]
    ]);
    assert.equal(firstPayload.indexOf(0x01, 166), 168);

    const builder = new TSPacketBuilder();
    const stream = concatenate([
        ...builder.section(0x0000, makePAT(pmtPid)),
        ...builder.section(pmtPid, makePMT([
            {pid: videoPid, streamType: StreamType.kPESPrivateData, descriptors: AV1_DESCRIPTOR}
        ])),
        ...builder.pes(videoPid, makePES(firstPayload, {pts: 90000}), true),
        ...builder.pes(videoPid, makePES(makeAV1TSPayload(obus64), {pts: 93600}), true),
        ...builder.section(pmtPid, makePMT([
            {pid: videoPid, streamType: StreamType.kPESPrivateData, descriptors: changedDescriptor}
        ], {version: 1})),
        // PMT の codec configuration 更新後は、sequence header なしの AU を旧 av1C で流さない。
        ...builder.pes(videoPid, makePES(makeAV1TSPayload([obus64[2]]), {pts: 97200}), true),
        ...builder.pes(videoPid, makePES(makeAV1TSPayload(obus80), {pts: 100800}), true)
    ]);

    const metadata = [];
    const mediaSegments = [];
    const events = [];
    const demuxer = makeDemuxer(
        (type, meta) => {
            metadata.push({type, meta});
            events.push(`init:${meta.codecWidth}x${meta.codecHeight}`);
        },
        (audioTrack, videoTrack) => {
            if (videoTrack?.samples.length) {
                mediaSegments.push(videoTrack.samples.map((sample) => ({
                    pts: sample.pts,
                    isKeyframe: sample.isKeyframe,
                    units: sample.units.map((unit) => unit.data.slice())
                })));
                events.push(`media:${videoTrack.samples.length}`);
                videoTrack.samples = [];
                videoTrack.length = 0;
            }
        }
    );

    assert.equal(demuxer.parseChunks(stream.buffer, 0), stream.byteLength);
    assert.equal(demuxer.pmt_.common_pids.av1, videoPid);
    assert.equal(metadata.length, 2);
    assert.deepEqual(
        metadata.map(({meta}) => [meta.codec, meta.codecWidth, meta.codecHeight]),
        [
            ['av01.0.00M.08', 64, 36],
            ['av01.0.00M.08', 80, 48]
        ]
    );
    assert.deepEqual(
        metadata[0].meta.av1c.subarray(0, 4),
        new Uint8Array([0x81, 0x00, 0x0C, 0x00])
    );
    assert.deepEqual(
        metadata[1].meta.av1c.subarray(0, 4),
        new Uint8Array([0x81, 0x00, 0x0C, 0x10])
    );
    assert.deepEqual(events, [
        'init:64x36',
        'media:2',
        'init:80x48',
        'media:1'
    ]);
    assert.deepEqual(mediaSegments.flat().map(({pts}) => pts), [1000, 1040, 1120]);
    assert.equal(mediaSegments.flat().every(({isKeyframe}) => isKeyframe), true);
    assert.equal(mediaSegments[0][0].units.length, 4);
    assert.deepEqual(concatenate(mediaSegments[0][1].units), AV1_64X36);
    assert.deepEqual(concatenate(mediaSegments[1][0].units), AV1_80X48);
});

test('AV1 の truncated/unknown OBU と RAI 欠落は実 TS 経路でも sample/init を生成しない', async (t) => {
    const pmtPid = 0x0100;
    const videoPid = 0x0101;
    const obus = splitLowOverheadOBUs(AV1_64X36);
    const truncated = concatenate([
        makeAV1TSPayload(obus.slice(0, 2)),
        startCodeOBU(hex('32 05 00'))
    ]);
    const unknown = makeAV1TSPayload([hex('4a 00')]);
    const valid = makeAV1TSPayload(obus);

    for (const [name, payload, randomAccessIndicator] of [
        ['truncated OBU', truncated, true],
        ['unknown OBU', unknown, true],
        ['RAI missing', valid, false]
    ]) {
        await t.test(name, () => {
            const builder = new TSPacketBuilder();
            const stream = concatenate([
                ...builder.section(0x0000, makePAT(pmtPid)),
                ...builder.section(pmtPid, makePMT([
                    {pid: videoPid, streamType: StreamType.kPESPrivateData, descriptors: AV1_DESCRIPTOR}
                ])),
                ...builder.pes(videoPid, makePES(payload), randomAccessIndicator)
            ]);
            const metadata = [];
            const media = [];
            const demuxer = makeDemuxer(
                (type, meta) => metadata.push({type, meta}),
                (audioTrack, videoTrack) => media.push({audioTrack, videoTrack})
            );
            assert.equal(demuxer.parseChunks(stream.buffer, 0), stream.byteLength);
            assert.equal(metadata.length, 0);
            assert.equal(media.length, 0);
            assert.equal(demuxer.video_track_.samples.length, 0);
        });
    }
});

test('Opus は複数 PID の preferred track、multi-PES、PTS 補間、channel config を維持する', () => {
    const pmtPid = 0x0100;
    const audioPid1 = 0x0110;
    const audioPid2 = 0x0111;
    const packetA = hex('f8 ff fe');
    const packetB = hex('f8 aa bb cc');
    const packetC = hex('f8 10 20 30 40');
    const packetD = hex('f8 01');

    const builder = new TSPacketBuilder();
    const stream = concatenate([
        ...builder.section(0x0000, makePAT(pmtPid)),
        ...builder.section(pmtPid, makePMT([
            {
                pid: audioPid1,
                streamType: StreamType.kPESPrivateData,
                descriptors: opusDescriptor(0x02, 0x10)
            },
            {
                pid: audioPid2,
                streamType: StreamType.kPESPrivateData,
                descriptors: opusDescriptor(0x06, 0x11)
            }
        ], {pcrPid: audioPid2})),
        ...builder.pes(audioPid1, makePES(makeOpusAccessUnit(hex('f8 99')), {pts: 0})),
        ...builder.pes(audioPid2, makePES(makeOpusAccessUnit(packetA), {pts: 0})),
        ...builder.pes(audioPid2, makePES(makeOpusAccessUnit(packetB), {pts: null})),
        ...builder.pes(audioPid2, makePES(concatenate([
            makeOpusAccessUnit(packetC, {trimStart: 8}),
            makeOpusAccessUnit(packetD, {trimEnd: 16})
        ]), {pts: 3600}))
    ]);

    const metadata = [];
    const mediaSegments = [];
    const demuxer = makeDemuxer(
        (type, meta) => metadata.push({type, meta}),
        (audioTrack) => {
            if (audioTrack?.samples.length) {
                mediaSegments.push(audioTrack.samples.map((sample) => ({
                    pts: sample.pts,
                    data: sample.unit.slice()
                })));
                audioTrack.samples = [];
                audioTrack.length = 0;
            }
        }
    );
    demuxer.preferred_audio_track_index = 1;

    assert.equal(demuxer.parseChunks(stream.buffer, 0), stream.byteLength);
    assert.equal(demuxer.pmt_.common_pids.opus, audioPid2);
    assert.equal(demuxer.media_info_.audioTrackCount, 2);
    assert.deepEqual(demuxer.media_info_.audioTrackComponentTags, [0x10, 0x11]);
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].type, 'audio');
    assert.equal(metadata[0].meta.codec, 'opus');
    assert.equal(metadata[0].meta.channelCount, 6);
    assert.equal(metadata[0].meta.channelConfigCode, 0x06);

    const samples = mediaSegments.flat();
    assert.deepEqual(samples.map(({pts}) => pts), [0, 20, 40, 60]);
    assert.deepEqual(samples.map(({data}) => data), [packetA, packetB, packetC, packetD]);

    const dOps = MP4.dOps(metadata[0].meta);
    assert.equal(String.fromCharCode(...dOps.subarray(4, 8)), 'dOps');
    assert.deepEqual(
        dOps.subarray(8, 21),
        new Uint8Array([
            0x00, 0x06, 0x00, 0x00,
            0x00, 0x00, 0xBB, 0x80,
            0x00, 0x00,
            0x01, 0x04, 0x02
        ])
    );
});

test('Opus preferred track 切替時は旧 PID の補間 PTS と未完 PES を引き継がない', () => {
    const pmtPid = 0x0100;
    const audioPid1 = 0x0110;
    const audioPid2 = 0x0111;
    const packet1 = hex('f8 01');
    const packetWithoutPTS = hex('f8 02');
    const packetWithPTS = hex('f8 03');
    const streams = [
        {
            pid: audioPid1,
            streamType: StreamType.kPESPrivateData,
            descriptors: opusDescriptor(0x02, 0x10)
        },
        {
            pid: audioPid2,
            streamType: StreamType.kPESPrivateData,
            descriptors: opusDescriptor(0x02, 0x11)
        }
    ];

    const builder = new TSPacketBuilder();
    const first = concatenate([
        ...builder.section(0x0000, makePAT(pmtPid)),
        ...builder.section(pmtPid, makePMT(streams, {pcrPid: audioPid1})),
        ...builder.pes(audioPid1, makePES(makeOpusAccessUnit(packet1), {pts: 0}))
    ]);
    const switchedWithoutPTS = concatenate([
        ...builder.section(pmtPid, makePMT(streams, {pcrPid: audioPid2, version: 1})),
        ...builder.pes(audioPid2, makePES(makeOpusAccessUnit(packetWithoutPTS), {pts: null}))
    ]);
    const switchedWithPTS = concatenate([
        ...builder.pes(audioPid2, makePES(makeOpusAccessUnit(packetWithPTS), {pts: 90000}))
    ]);

    const metadata = [];
    const samples = [];
    const demuxer = makeDemuxer(
        (type, meta) => metadata.push({type, meta}),
        (audioTrack) => {
            if (audioTrack?.samples.length) {
                samples.push(...audioTrack.samples.map((sample) => ({
                    pts: sample.pts,
                    data: sample.unit.slice()
                })));
                audioTrack.samples = [];
                audioTrack.length = 0;
            }
        }
    );

    assert.equal(demuxer.parseChunks(first.buffer, 0), first.byteLength);
    assert.deepEqual(samples.map(({pts}) => pts), [0]);

    demuxer.preferred_audio_track_index = 1;
    assert.equal(
        demuxer.parseChunks(switchedWithoutPTS.buffer, first.byteLength),
        switchedWithoutPTS.byteLength
    );
    assert.equal(demuxer.pmt_.common_pids.opus, audioPid2);
    assert.deepEqual(samples.map(({pts}) => pts), [0]);

    assert.equal(
        demuxer.parseChunks(
            switchedWithPTS.buffer,
            first.byteLength + switchedWithoutPTS.byteLength
        ),
        switchedWithPTS.byteLength
    );
    assert.equal(metadata.length, 1);
    assert.deepEqual(samples.map(({pts}) => pts), [0, 1000]);
    assert.deepEqual(samples.map(({data}) => data), [packet1, packetWithPTS]);
});

test('Opus の可変 packet duration は PES 内と PTS なしの次 PES に連続して反映される', () => {
    const pmtPid = 0x0100;
    const audioPid = 0x0110;
    const packets = [
        hex('80 01'),       // 2.5 ms
        hex('90 02'),       // 10 ms
        hex('10 03'),       // 40 ms
        hex('19 04 05')     // 120 ms
    ];

    const builder = new TSPacketBuilder();
    const stream = concatenate([
        ...builder.section(0x0000, makePAT(pmtPid)),
        ...builder.section(pmtPid, makePMT([
            {
                pid: audioPid,
                streamType: StreamType.kPESPrivateData,
                descriptors: opusDescriptor(0x02, 0x10)
            }
        ], {pcrPid: audioPid})),
        ...builder.pes(audioPid, makePES(concatenate([
            makeOpusAccessUnit(packets[0]),
            makeOpusAccessUnit(packets[1])
        ]), {pts: 0})),
        ...builder.pes(audioPid, makePES(concatenate([
            makeOpusAccessUnit(packets[2]),
            makeOpusAccessUnit(packets[3])
        ]), {pts: null}))
    ]);

    const observed = [];
    const demuxer = makeDemuxer(
        () => {},
        (audioTrack) => {
            if (audioTrack?.samples.length) {
                observed.push(...audioTrack.samples.map((sample) => ({
                    pts: sample.pts,
                    duration: sample.duration,
                    data: sample.unit.slice()
                })));
                audioTrack.samples = [];
                audioTrack.length = 0;
            }
        }
    );

    assert.equal(demuxer.parseChunks(stream.buffer, 0), stream.byteLength);
    assert.deepEqual(observed.map(({pts}) => pts), [0, 2, 12, 52]);
    assert.deepEqual(observed.map(({duration}) => duration), [2.5, 10, 40, 120]);
    assert.deepEqual(observed.map(({data}) => data), packets);

    const remuxer = new MP4Remuxer({isLive: true, fixAudioTimestampGap: true});
    let mediaSegment;
    remuxer.onInitSegment = () => {};
    remuxer.onMediaSegment = (type, segment) => {
        if (type === 'audio') mediaSegment = segment;
    };
    remuxer._onTrackMetadataReceived('audio', {
        type: 'audio',
        id: 2,
        timescale: 1000,
        duration: 0,
        audioSampleRate: 48000,
        channelCount: 2,
        channelConfigCode: 0x02,
        codec: 'opus',
        originalCodec: 'opus',
        config: undefined,
        refSampleDuration: 20
    });
    const remuxTrack = {
        type: 'audio',
        id: 2,
        sequenceNumber: 0,
        samples: observed.map((sample) => ({
            unit: sample.data,
            length: sample.data.byteLength,
            pts: sample.pts,
            dts: sample.pts,
            duration: sample.duration
        })),
        length: observed.reduce((total, sample) => total + sample.data.byteLength, 0)
    };
    remuxer.remux(remuxTrack, null, true);
    assert.equal(mediaSegment.sampleCount, 4);
    assert.deepEqual(readTrunDurations(mediaSegment.data), [2, 10, 40, 120]);
});

test('Safari MSE は Opus 表記を使うが init segment の codec 値を破壊しない', () => {
    assert.equal(formatMSECodec('opus', true), 'Opus');
    assert.equal(formatMSECodec('opus', false), 'opus');
    assert.equal(formatMSECodec('av01.0.00M.08', true), 'av01.0.00M.08');

    let createdMimeType;
    const sourceBuffer = {
        updating: false,
        addEventListener: () => {}
    };
    const controller = new MSEController({isLive: true});
    controller._mediaSource = {
        readyState: 'open',
        streaming: true,
        addSourceBuffer: (mimeType) => {
            createdMimeType = mimeType;
            return sourceBuffer;
        }
    };
    const initSegment = {
        type: 'audio',
        container: 'audio/mp4',
        codec: 'opus',
        data: new ArrayBuffer(0)
    };
    controller.appendInitSegment(initSegment, true);

    assert.equal(createdMimeType, 'audio/mp4;codecs=Opus');
    assert.equal(initSegment.codec, 'opus');
});

test('AV1 applyPresentationSize は TS の render size のみを使い壊れた値だけ捨てる', () => {
    const base = {
        codec_mimetype: 'av01.0.08M.08',
        sequence_header_data: new Uint8Array([0x0A, 0x00]),
    };
    const garbage = {...base};
    AV1OBUParser.applyPresentationSize(garbage, 1440, 1080, 38465, 41);
    assert.deepEqual(garbage.codec_size, {width: 1440, height: 1080});
    // 壊れた render は codec size にフォールバック（固定 16:9 補完はしない）
    assert.deepEqual(garbage.present_size, {width: 1440, height: 1080});
    assert.deepEqual(garbage.sar_ratio, {width: 1, height: 1});

    const square = {...base};
    AV1OBUParser.applyPresentationSize(square, 1440, 1080, 1440, 1080);
    assert.deepEqual(square.present_size, {width: 1440, height: 1080});
    assert.deepEqual(square.sar_ratio, {width: 1, height: 1});

    // TS に render 1920x1080 があればそのまま SAR 4:3
    const fromTs = {...base};
    AV1OBUParser.applyPresentationSize(fromTs, 1440, 1080, 1920, 1080);
    assert.deepEqual(fromTs.present_size, {width: 1920, height: 1080});
    assert.deepEqual(fromTs.sar_ratio, {width: 4, height: 3});

    const hd = {...base};
    AV1OBUParser.applyPresentationSize(hd, 1280, 720, 1280, 720);
    assert.deepEqual(hd.present_size, {width: 1280, height: 720});
    assert.deepEqual(hd.sar_ratio, {width: 1, height: 1});
});
