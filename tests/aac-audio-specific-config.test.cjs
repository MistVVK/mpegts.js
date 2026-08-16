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

const {AudioSpecificConfig} = require('../src/demux/aac.ts');

const CHROMIUM_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';

function withUserAgent(userAgent, callback) {
    const previous = global.navigator;
    global.navigator = {userAgent};
    try {
        return callback();
    } finally {
        global.navigator = previous;
    }
}

function createFrame(audioObjectType, samplingIndex, channelConfig) {
    return {
        audio_object_type: audioObjectType,
        sampling_freq_index: samplingIndex,
        sampling_frequency: 0,
        channel_config: channelConfig,
        data: new Uint8Array()
    };
}

function configBytes(config) {
    return Array.from(new Uint8Array(config));
}

test('Chromium の 48kHz stereo AAC-LC は mp4a.40.2 の 2 バイト設定になる', () => {
    const specificConfig = withUserAgent(CHROMIUM_UA, () => {
        return new AudioSpecificConfig(createFrame(2, 3, 2));
    });

    assert.equal(specificConfig.codec_mimetype, 'mp4a.40.2');
    assert.equal(specificConfig.original_codec_mimetype, 'mp4a.40.2');
    assert.equal(specificConfig.config.length, 2);
    assert.deepEqual(configBytes(specificConfig.config), [0x11, 0x90]);
});

test('Chromium の 48kHz 5.1ch AAC-LC は mp4a.40.2 の 2 バイト設定になる', () => {
    const specificConfig = withUserAgent(CHROMIUM_UA, () => {
        return new AudioSpecificConfig(createFrame(2, 3, 6));
    });

    assert.equal(specificConfig.codec_mimetype, 'mp4a.40.2');
    assert.equal(specificConfig.original_codec_mimetype, 'mp4a.40.2');
    assert.equal(specificConfig.config.length, 2);
    assert.deepEqual(configBytes(specificConfig.config), [0x11, 0xB0]);
});

test('Chromium の低サンプルレート AAC-LC は従来どおり HE-AAC を宣言する', () => {
    const specificConfig = withUserAgent(CHROMIUM_UA, () => {
        return new AudioSpecificConfig(createFrame(2, 6, 2));
    });

    assert.equal(specificConfig.codec_mimetype, 'mp4a.40.5');
    assert.equal(specificConfig.original_codec_mimetype, 'mp4a.40.2');
    assert.equal(specificConfig.config.length, 4);
    assert.deepEqual(configBytes(specificConfig.config), [0x2B, 0x11, 0x88, 0x00]);
});

test('Firefox の 48kHz stereo AAC-LC は従来どおり LC-AAC のままになる', () => {
    const specificConfig = withUserAgent(FIREFOX_UA, () => {
        return new AudioSpecificConfig(createFrame(2, 3, 2));
    });

    assert.equal(specificConfig.codec_mimetype, 'mp4a.40.2');
    assert.equal(specificConfig.original_codec_mimetype, 'mp4a.40.2');
    assert.equal(specificConfig.config.length, 2);
    assert.deepEqual(configBytes(specificConfig.config), [0x11, 0x90]);
});

test('Chromium の 48kHz HE-AAC 入力はプロファイル切替用の HE-AAC 宣言を維持する', () => {
    const specificConfig = withUserAgent(CHROMIUM_UA, () => {
        return new AudioSpecificConfig(createFrame(5, 3, 2));
    });

    assert.equal(specificConfig.codec_mimetype, 'mp4a.40.5');
    assert.equal(specificConfig.original_codec_mimetype, 'mp4a.40.5');
    assert.equal(specificConfig.config.length, 4);
    assert.deepEqual(configBytes(specificConfig.config), [0x29, 0x91, 0x88, 0x00]);
});
