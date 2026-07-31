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

global.self = globalThis;
if (globalThis.navigator === undefined) {
    globalThis.navigator = {userAgent: 'node.js'};
}

const {default: LiveLatencySynchronizer} =
    require('../src/player/live-latency-synchronizer.ts');
const {default: MSEPlayer} = require('../src/player/mse-player.ts');
const {default: PlayerEngineDedicatedThread} =
    require('../src/player/player-engine-dedicated-thread.ts');
const {default: PlayerEngineMainThread} =
    require('../src/player/player-engine-main-thread.ts');


class FakeMediaElement extends EventTarget {

    constructor() {
        super();
        this.currentTime = 1;
        this.playbackRate = 1;
        this.buffered = {
            length: 1,
            start: () => 0,
            end: () => 6
        };
    }
}


test('LiveLatencySynchronizer は生成後の liveSync 有効化を反映する', () => {
    const config = {
        isLive: true,
        liveSync: false,
        liveSyncMaxLatency: 3,
        liveSyncTargetLatency: 0.9,
        liveSyncPlaybackRate: 1.1,
        liveSyncMinLatency: undefined,
        liveSyncMinPlaybackRate: 0.95
    };
    const mediaElement = new FakeMediaElement();
    const synchronizer = new LiveLatencySynchronizer(config, mediaElement);

    mediaElement.dispatchEvent(new Event('timeupdate'));
    assert.equal(mediaElement.playbackRate, 1);

    config.liveSync = true;
    mediaElement.dispatchEvent(new Event('timeupdate'));
    assert.equal(mediaElement.playbackRate, 1.1);

    config.liveSync = false;
    mediaElement.dispatchEvent(new Event('timeupdate'));
    assert.equal(mediaElement.playbackRate, 1.1);
    synchronizer.destroy();
});


for (const [name, Engine] of [
    ['main-thread', PlayerEngineMainThread],
    ['dedicated-thread', PlayerEngineDedicatedThread]
]) {
    test(`${name} engine の configureLiveSync は設定を更新し OFF で等速へ戻す`, () => {
        const engine = Object.create(Engine.prototype);
        engine._config = {
            isLive: true,
            liveSync: true,
            liveSyncMaxLatency: 3,
            liveSyncTargetLatency: 0.9,
            liveSyncPlaybackRate: 1.1
        };
        engine._media_element = {playbackRate: 1.1};

        engine.configureLiveSync({
            liveSync: false,
            liveSyncMaxLatency: 4,
            liveSyncTargetLatency: 2,
            liveSyncPlaybackRate: 1.05
        });

        assert.equal(engine._config.liveSync, false);
        assert.equal(engine._config.liveSyncMaxLatency, 4);
        assert.equal(engine._config.liveSyncTargetLatency, 2);
        assert.equal(engine._config.liveSyncPlaybackRate, 1.05);
        assert.equal(engine._media_element.playbackRate, 1);
    });
}


test('MSEPlayer.configureLiveSync は公開APIから engine へ委譲する', () => {
    const calls = [];
    const player = Object.create(MSEPlayer.prototype);
    player._player_engine = {
        configureLiveSync: (config) => calls.push(config)
    };
    const config = {
        liveSync: true,
        liveSyncMaxLatency: 3,
        liveSyncTargetLatency: 0.9,
        liveSyncPlaybackRate: 1.1
    };

    player.configureLiveSync(config);
    assert.deepEqual(calls, [config]);
});
