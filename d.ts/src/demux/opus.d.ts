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
/**
 * Parse the exact descriptor pair emitted by FFmpeg and TSCodecBridge.
 */
export declare function parseOpusMPEG2TSDescriptors(descriptors: Uint8Array): OpusMPEG2TSMetadata | null;
/**
 * RFC 6716 の TOC から 48 kHz 単位の packet duration を得る。
 *
 * multi-stream packet でも先頭 stream の TOC と frame count は全 stream
 * で同一なので、self-delimited packet の全構造を展開せずに時間を求められる。
 */
export declare function getOpusPacketDurationSamples(data: Uint8Array): number | null;
/**
 * Parse all Opus access units in one private PES atomically.
 */
export declare function parseOpusMPEG2TSAccessUnits(data: Uint8Array): OpusMPEG2TSAccessUnit[] | null;
