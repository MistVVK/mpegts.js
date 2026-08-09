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
        userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36'
    }
};

const {defaultConfig} = require('../src/config.js');
const {default: MP4Remuxer} = require('../src/remux/mp4-remuxer.js');

const RECORDED_MSE_DURATION = 0xFFFFFFFE;

function createAudioMetadata() {
    return {
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
    };
}

function generateAudioInitSegment(config) {
    const remuxer = new MP4Remuxer(config);
    let initSegment;
    remuxer.onInitSegment = (type, segment) => {
        if (type === 'audio') initSegment = segment;
    };
    remuxer._onTrackMetadataReceived('audio', createAudioMetadata());
    return initSegment;
}

function readMvhdDuration(buffer) {
    const data = new Uint8Array(buffer);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let typeOffset = 4; typeOffset + 24 <= data.byteLength; typeOffset++) {
        if (String.fromCharCode(...data.subarray(typeOffset, typeOffset + 4)) === 'mvhd') {
            return view.getUint32(typeOffset + 20);
        }
    }
    throw new Error('mvhd box was not found');
}

test('既定ではライブ init segment の duration を変更しない', () => {
    assert.equal(defaultConfig.forceMSEStreamLivenessRecorded, false);
    const initSegment = generateAudioInitSegment({
        isLive: true,
        forceMSEStreamLivenessRecorded: false,
        fixAudioTimestampGap: true
    });

    assert.equal(readMvhdDuration(initSegment.data), 0);
    assert.equal(initSegment.mediaDuration, 0);
});

test('Chromium 回避設定では init segment だけを有限 duration にする', () => {
    const initSegment = generateAudioInitSegment({
        isLive: true,
        forceMSEStreamLivenessRecorded: true,
        fixAudioTimestampGap: true
    });

    assert.equal(readMvhdDuration(initSegment.data), RECORDED_MSE_DURATION);
    assert.equal(initSegment.mediaDuration, 0);
});
