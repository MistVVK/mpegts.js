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


test('DedicatedThread constructorのclone失敗はworkerとlogging listenerを回収する', () => {
    const workPath = require.resolve('../src/utils/webworkify-webpack.js');
    const enginePath = require.resolve('../src/player/player-engine-dedicated-thread.ts');
    const originalWorkModule = require.cache[workPath];
    const fakeWorker = {
        objectURL: null,
        addEventListener: () => {},
        postMessage: (packet) => structuredClone(packet),
        terminateCalled: false,
        terminate() {
            this.terminateCalled = true;
        }
    };
    require.cache[workPath] = {
        id: workPath,
        filename: workPath,
        loaded: true,
        exports: () => fakeWorker,
        children: [],
        paths: []
    };
    delete require.cache[enginePath];

    try {
        const {default: LoggingControl} = require('../src/utils/logging-control.js');
        const {default: PlayerEngineDedicatedThread} = require(enginePath);
        const listenersBefore = LoggingControl.emitter.listenerCount('change');
        const unclonableHeaders = new Proxy(
            {'X-Prepare-Token': 'secret'},
            {},
        );

        assert.throws(
            () => new PlayerEngineDedicatedThread(
                {type: 'mpegts', isLive: true, url: 'https://example.test/live'},
                {oneShotHeaders: unclonableHeaders},
            ),
            {name: 'DataCloneError'},
        );
        assert.equal(fakeWorker.terminateCalled, true);
        assert.equal(LoggingControl.emitter.listenerCount('change'), listenersBefore);
    } finally {
        delete require.cache[enginePath];
        if (originalWorkModule === undefined) {
            delete require.cache[workPath];
        } else {
            require.cache[workPath] = originalWorkModule;
        }
    }
});
