'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {
    applyColorRewriteToBytes,
    resolveVideoColorRewrite,
    writeBits,
    writeColorTuple,
} = require('../src/demux/video-color-rewrite.ts');

test('ToneMap rewrites HLG and PQ to sRGB transfer and BT.709 primaries', () => {
    const hlg = resolveVideoColorRewrite(
        {colour_primaries: 9, transfer_characteristics: 18, matrix_coeffs: 9},
        'ToneMap',
    );
    assert.deepEqual(hlg, {
        colour_primaries: 1,
        transfer_characteristics: 13,
        matrix_coeffs: 9,
    });

    const pq = resolveVideoColorRewrite(
        {colour_primaries: 9, transfer_characteristics: 16, matrix_coeffs: 9},
        'ToneMap',
    );
    assert.deepEqual(pq, {
        colour_primaries: 1,
        transfer_characteristics: 13,
        matrix_coeffs: 9,
    });
});

test('SdrInHlg rewrites only HLG transfer 18 to 1', () => {
    const hlg = resolveVideoColorRewrite(
        {colour_primaries: 9, transfer_characteristics: 18, matrix_coeffs: 9},
        'SdrInHlg',
    );
    assert.deepEqual(hlg, {
        colour_primaries: 9,
        transfer_characteristics: 1,
        matrix_coeffs: 9,
    });

    const pq = resolveVideoColorRewrite(
        {colour_primaries: 9, transfer_characteristics: 16, matrix_coeffs: 9},
        'SdrInHlg',
    );
    assert.deepEqual(pq, {
        colour_primaries: 9,
        transfer_characteristics: 16,
        matrix_coeffs: 9,
    });
});

test('None and SDR leave the tuple unchanged', () => {
    const source = {colour_primaries: 9, transfer_characteristics: 14, matrix_coeffs: 9};
    assert.deepEqual(resolveVideoColorRewrite(source, 'None'), source);
    assert.deepEqual(resolveVideoColorRewrite(source, 'ToneMap'), source);
});

test('writeBits patches an unaligned 24-bit colour tuple', () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    writeBits(bytes, 3, 8, 0x09);
    writeColorTuple(bytes, 3, {
        colour_primaries: 9,
        transfer_characteristics: 18,
        matrix_coeffs: 9,
    });
    const rewritten = applyColorRewriteToBytes(
        bytes,
        3,
        {colour_primaries: 9, transfer_characteristics: 18, matrix_coeffs: 9},
        'SdrInHlg',
    );
    assert.equal(rewritten.rewritten, true);
    assert.equal(rewritten.effective.transfer_characteristics, 1);
});
