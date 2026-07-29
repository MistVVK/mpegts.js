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

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourceRoot = path.resolve(__dirname, '..', 'src') + path.sep;
const defaultJavaScriptLoader = require.extensions['.js'];

function compileSource(module, filename) {
    if (!filename.startsWith(sourceRoot)) {
        defaultJavaScriptLoader(module, filename);
        return;
    }

    const source = fs.readFileSync(filename, 'utf8');
    const result = ts.transpileModule(source, {
        fileName: filename,
        compilerOptions: {
            allowJs: true,
            esModuleInterop: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2019
        }
    });
    module._compile(result.outputText, filename);
}

require.extensions['.js'] = compileSource;
require.extensions['.ts'] = compileSource;
