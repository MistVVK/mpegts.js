/*
 * Copyright (C) 2021 magicxqq. All Rights Reserved.
 *
 * @author magicxqq <xqq@xqq.im>
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

import Log from '../utils/logger';
import DemuxErrors from './demux-errors';
import MediaInfo from '../core/media-info';
import {IllegalStateException} from '../utils/exception';
import BaseDemuxer from './base-demuxer';
import { PAT, PESData, SectionData, SliceQueue, PIDToSliceQueues, PMT, ProgramToPMTMap, StreamType } from './pat-pmt-pes';
import { AVCDecoderConfigurationRecord, H264AnnexBParser, H264NaluAVC1, H264NaluPayload, H264NaluType } from './h264';
import SPSParser from './sps-parser';
import { AACADTSParser, AACFrame, AACLOASParser, AudioSpecificConfig, LOASAACFrame } from './aac';
import { MPEG4AudioObjectTypes, MPEG4SamplingFrequencyIndex } from './mpeg4-audio';
import { PESPrivateData, PESPrivateDataDescriptor } from './pes-private-data';
import { parseSEI } from './sei';
import { readSCTE35, SCTE35Data } from './scte35';
import { H265AnnexBParser, H265NaluHVC1, H265NaluPayload, H265NaluType, HEVCDecoderConfigurationRecord } from './h265';
import H265Parser from './h265-parser';
import { SMPTE2038Data, smpte2038parse } from './smpte2038';
import { MP3Data } from './mp3';
import { AC3Config, AC3Frame, AC3Parser, EAC3Config, EAC3Frame, EAC3Parser } from './ac3';
import { KLVData, klv_parse } from './klv';
import AV1OBUInMpegTsParser, { parseAV1MPEG2TSDescriptors } from './av1';
import AV1OBUParser, { AV1Metadata } from './av1-parser';
import {
    normalizeVideoColorRewriteMode,
    type VideoColorRewriteMode,
    type VideoColorTuple,
} from './video-color-rewrite';
import {
    OpusMPEG2TSMetadata,
    parseOpusMPEG2TSAccessUnits,
    parseOpusMPEG2TSDescriptors
} from './opus';
import { PGSData } from './pgs-data';
import {
    buildVP9VideoDetails,
    hasVP9PrivateMappingV1,
    parseVP9FrameHeader,
    parseVP9SampleLayout,
    VP9CodecConfiguration
} from './vp9';

type AdaptationFieldInfo = {
    discontinuity_indicator?: number;
    random_access_indicator?: number;
    elementary_stream_priority_indicator?: number;
};
type AACAudioMetadata = {
    codec: 'aac',
    audio_object_type: MPEG4AudioObjectTypes;
    sampling_freq_index: MPEG4SamplingFrequencyIndex;
    sampling_frequency: number;
    channel_config: number;
};
type AC3AudioMetadata = {
    codec: 'ac-3',
    sampling_frequency: number;
    bit_stream_identification: number;
    bit_stream_mode: number;
    low_frequency_effects_channel_on: number;
    channel_mode: number;
};
type EAC3AudioMetadata = {
    codec: 'ec-3',
    sampling_frequency: number;
    bit_stream_identification: number;
    low_frequency_effects_channel_on: number;
    channel_mode: number;
    num_blks: number;
};
type OpusAudioMetadata = OpusMPEG2TSMetadata;
type AudioStreamKind = 'adts_aac' | 'loas_aac' | 'ac3' | 'eac3' | 'mp3' | 'opus';
type MP3AudioMetadata = {
    codec: 'mp3',
    object_type: number,
    sample_rate: number,
    channel_count: number;
};
type AudioData = {
    codec: 'aac';
    data: AACFrame;
} | {
    codec: 'ac-3';
    data: AC3Frame,
} | {
    codec: 'ec-3';
    data: EAC3Frame,
} | {
    codec: 'opus';
    meta: OpusAudioMetadata,
} | {
    codec: 'mp3';
    data: MP3Data;
}

class TSDemuxer extends BaseDemuxer {

    private readonly TAG: string = 'TSDemuxer';

    private config_: any;
    private ts_packet_size_: number;
    private sync_offset_: number;
    private first_parse_: boolean = true;

    private media_info_ = new MediaInfo();

    private timescale_ = 90;
    private duration_ = 0;

    private pat_: PAT;
    private current_program_: number;
    private current_pmt_pid_: number = -1;
    private pmt_: PMT;
    private program_pmt_map_: ProgramToPMTMap = {};

    private pes_slice_queues_: PIDToSliceQueues = {};
    private section_slice_queues_: PIDToSliceQueues = {};

    private video_metadata_: {
        vps: H265NaluHVC1 | undefined,
        sps: H264NaluAVC1 | H265NaluHVC1 | undefined,
        pps: H264NaluAVC1 | H265NaluHVC1 | undefined,
        av1c: Uint8Array | undefined,
        details: any
    } = {
        vps: undefined,
        sps: undefined,
        pps: undefined,
        av1c: undefined,
        details: undefined
    };

    private audio_metadata_: AACAudioMetadata | AC3AudioMetadata | EAC3AudioMetadata | OpusAudioMetadata | MP3AudioMetadata = {
        codec: undefined,
        audio_object_type: undefined,
        sampling_freq_index: undefined,
        sampling_frequency: undefined,
        channel_config: undefined
    };

    private last_pcr_: number | undefined;
    private last_pcr_base_: number = NaN;
    private timestamp_offset_: number = 0;

    private audio_last_sample_pts_: number = undefined;
    private opus_next_sample_pts_: number = undefined;
    private aac_last_incomplete_data_: Uint8Array = null;
    private selected_audio_pid_: number = undefined;
    private selected_audio_kind_: AudioStreamKind = undefined;

    private has_video_ = false;
    private has_audio_ = false;
    private video_init_segment_dispatched_ = false;
    private audio_init_segment_dispatched_ = false;
    private video_metadata_changed_ = false;
    private loas_previous_frame: LOASAACFrame | null = null;

    private video_track_ = {type: 'video', id: 1, sequenceNumber: 0, samples: [], length: 0};
    private audio_track_ = {type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0};

    public preferred_audio_track_index = 0;

    public constructor(probe_data: any, config: any) {
        super();

        this.ts_packet_size_ = probe_data.ts_packet_size;
        this.sync_offset_ = probe_data.sync_offset;
        this.config_ = config;
    }

    public setVideoColorRewrite(mode: VideoColorRewriteMode | unknown): void {
        this.config_.videoColorRewrite = normalizeVideoColorRewriteMode(mode);
    }

    private getVideoColorRewriteMode(): VideoColorRewriteMode {
        return normalizeVideoColorRewriteMode(this.config_?.videoColorRewrite);
    }

    private applyVideoColorToMediaInfo(
        original: VideoColorTuple | undefined,
        effective: VideoColorTuple | undefined,
    ): void {
        const mi = this.media_info_ as any;
        mi.colourPrimaries = original?.colour_primaries ?? null;
        mi.transferCharacteristics = original?.transfer_characteristics ?? null;
        mi.matrixCoefficients = original?.matrix_coeffs ?? null;
        mi.effectiveColourPrimaries = effective?.colour_primaries ?? null;
        mi.effectiveTransferCharacteristics = effective?.transfer_characteristics ?? null;
        mi.effectiveMatrixCoefficients = effective?.matrix_coeffs ?? null;
    }

    public destroy() {
        this.media_info_ = null;
        this.pes_slice_queues_ = null;
        this.section_slice_queues_ = null;

        this.video_metadata_ = null;
        this.audio_metadata_ = null;
        this.aac_last_incomplete_data_ = null;

        this.video_track_ = null;
        this.audio_track_ = null;

        super.destroy();
    }

    public static probe(buffer: ArrayBuffer) {
        let data = new Uint8Array(buffer);
        let sync_offset = -1;
        let ts_packet_size = 188;

        if (data.byteLength <= 3 * ts_packet_size) {
            return {needMoreData: true};
        }

        while (sync_offset === -1) {
            let scan_window = Math.min(1000, data.byteLength - 3 * ts_packet_size);

            for (let i = 0; i < scan_window; ) {
                // sync_byte should all be 0x47
                if (data[i] === 0x47
                        && data[i + ts_packet_size] === 0x47
                        && data[i + 2 * ts_packet_size] === 0x47) {
                    sync_offset = i;
                    break;
                } else {
                    i++;
                }
            }

            // find sync_offset failed in previous ts_packet_size
            if (sync_offset === -1) {
                if (ts_packet_size === 188) {
                    // try 192 packet size (BDAV, etc.)
                    ts_packet_size = 192;
                } else if (ts_packet_size === 192) {
                    // try 204 packet size (European DVB, etc.)
                    ts_packet_size = 204;
                } else {
                    // 192, 204 also failed, exit
                    break;
                }
            }
        }

        if (sync_offset === -1) {
            // both 188, 192, 204 failed, Non MPEG-TS
            return {match: false};
        }

        if (ts_packet_size === 192 && sync_offset >= 4) {
            Log.v('TSDemuxer', `ts_packet_size = 192, m2ts mode`);
            sync_offset -= 4;
        } else if (ts_packet_size === 204) {
            Log.v('TSDemuxer', `ts_packet_size = 204, RS encoded MPEG2-TS stream`);
        }

        return {
            match: true,
            consumed: 0,
            ts_packet_size,
            sync_offset
        };
    }

    public bindDataSource(loader) {
        loader.onDataArrival = this.parseChunks.bind(this);
        return this;
    }

    public resetMediaInfo() {
        this.media_info_ = new MediaInfo();
    }

    public parseChunks(chunk: ArrayBuffer, byte_start: number): number {
        if (!this.onError
                || !this.onMediaInfo
                || !this.onTrackMetadata
                || !this.onDataAvailable) {
            throw new IllegalStateException('onError & onMediaInfo & onTrackMetadata & onDataAvailable callback must be specified');
        }

        let offset = 0;

        if (this.first_parse_) {
            this.first_parse_ = false;
            offset = this.sync_offset_;
        }

        while (offset + this.ts_packet_size_ <= chunk.byteLength) {
            let file_position = byte_start + offset;

            if (this.ts_packet_size_ === 192) {
                // skip ATS field (2-bits copy-control + 30-bits timestamp) for m2ts
                offset += 4;
            }

            let data = new Uint8Array(chunk, offset, 188);

            let sync_byte = data[0];
            if (sync_byte !== 0x47) {
                Log.e(this.TAG, `sync_byte = ${sync_byte}, not 0x47`);
                break;
            }

            let payload_unit_start_indicator = (data[1] & 0x40) >>> 6;
            let transport_priority = (data[1] & 0x20) >>> 5;
            let pid = ((data[1] & 0x1F) << 8) | data[2];
            let adaptation_field_control = (data[3] & 0x30) >>> 4;
            let continuity_conunter = (data[3] & 0x0F);

            let is_pcr_pid: boolean = (this.pmt_ && this.pmt_.pcr_pid === pid) ? true : false;
            let adaptation_field_info: AdaptationFieldInfo = {};
            let ts_payload_start_index = 4;

            if (adaptation_field_control == 0x02 || adaptation_field_control == 0x03) {
                // Adaptation field exists along with / without payload
                let adaptation_field_length = data[4];
                if (adaptation_field_length > 0 && (is_pcr_pid || adaptation_field_control == 0x03)) {
                    // Parse adaptation field
                    adaptation_field_info.discontinuity_indicator = (data[5] & 0x80) >>> 7;
                    adaptation_field_info.random_access_indicator = (data[5] & 0x40) >>> 6;
                    adaptation_field_info.elementary_stream_priority_indicator = (data[5] & 0x20) >>> 5;

                    let PCR_flag = (data[5] & 0x10) >>> 4;
                    if (PCR_flag) {
                        let pcr_base = this.getPcrBase(data);
                        let pcr_extension = ((data[10] & 0x01) << 8) | data[11];
                        let pcr = pcr_base * 300 + pcr_extension;
                        this.last_pcr_ = pcr;
                    }
                }
                if (adaptation_field_control == 0x02 || 5 + adaptation_field_length === 188) {
                    // TS packet only has adaption field, jump to next
                    offset += 188;
                    if (this.ts_packet_size_ === 204) {
                        // skip parity word (16 bytes) for RS encoded TS
                        offset += 16;
                    }
                    continue;
                } else {
                    // Point ts_payload_start_index to the start of payload
                    ts_payload_start_index = 4 + 1 + adaptation_field_length;
                }
            }

            if (adaptation_field_control == 0x01 || adaptation_field_control == 0x03) {
                if (pid === 0 ||                      // PAT (pid === 0)
                    pid === this.current_pmt_pid_ ||  // PMT
                    (this.pmt_ != undefined && this.pmt_.pid_stream_type[pid] === StreamType.kSCTE35)) {  // SCTE35
                    let ts_payload_length = 188 - ts_payload_start_index;

                    this.handleSectionSlice(chunk,
                                            offset + ts_payload_start_index,
                                            ts_payload_length,
                                            {
                                                pid,
                                                file_position,
                                                payload_unit_start_indicator,
                                                continuity_conunter,
                                                random_access_indicator: adaptation_field_info.random_access_indicator
                                            });
                } else if (this.pmt_ != undefined && this.pmt_.pid_stream_type[pid] != undefined) {
                    // PES
                    let ts_payload_length = 188 - ts_payload_start_index;
                    let stream_type = this.pmt_.pid_stream_type[pid];

                    // process PES only for known common_pids
                    if (pid === this.pmt_.common_pids.h264
                            || pid === this.pmt_.common_pids.h265
                            || pid === this.pmt_.common_pids.av1
                            || pid === this.pmt_.common_pids.vp9
                            || pid === this.pmt_.common_pids.adts_aac
                            || pid === this.pmt_.common_pids.loas_aac
                            || pid === this.pmt_.common_pids.ac3
                            || pid === this.pmt_.common_pids.eac3
                            || pid === this.pmt_.common_pids.opus
                            || pid === this.pmt_.common_pids.mp3
                            || this.pmt_.pes_private_data_pids[pid] === true
                            || this.pmt_.timed_id3_pids[pid] === true
                            || this.pmt_.pgs_pids[pid] === true
                            || this.pmt_.synchronous_klv_pids[pid] === true
                            || this.pmt_.asynchronous_klv_pids[pid] === true
                            ) {
                        this.handlePESSlice(chunk,
                                            offset + ts_payload_start_index,
                                            ts_payload_length,
                                            {
                                                pid,
                                                stream_type,
                                                file_position,
                                                payload_unit_start_indicator,
                                                continuity_conunter,
                                                random_access_indicator: adaptation_field_info.random_access_indicator
                                            });
                    }
                }
            }

            offset += 188;

            if (this.ts_packet_size_ === 204) {
                // skip parity word (16 bytes) for RS encoded TS
                offset += 16;
            }
        }

        // dispatch parsed frames to the remuxer (consumer)
        this.dispatchAudioVideoMediaSegment();

        return offset;  // consumed bytes
    }

    private handleSectionSlice(buffer: ArrayBuffer, offset: number, length: number, misc: any): void {
        let data = new Uint8Array(buffer, offset, length);
        let slice_queue = this.section_slice_queues_[misc.pid];

        if (misc.payload_unit_start_indicator) {
            let pointer_field = data[0];

            if (slice_queue != undefined && slice_queue.total_length !== 0) {
                let remain_section = new Uint8Array(buffer, offset + 1, Math.min(length, pointer_field));
                slice_queue.slices.push(remain_section);
                slice_queue.total_length += remain_section.byteLength;

                if (slice_queue.total_length === slice_queue.expected_length) {
                    this.emitSectionSlices(slice_queue, misc);
                } else {
                    this.clearSlices(slice_queue, misc);
                }
            }

            for (let i = 1 + pointer_field; i < data.byteLength; ){
                let table_id = data[i + 0];
                if (table_id === 0xFF) { break; }

                let section_length = ((data[i + 1] & 0x0F) << 8) | data[i + 2];

                this.section_slice_queues_[misc.pid] = new SliceQueue();
                slice_queue = this.section_slice_queues_[misc.pid];

                slice_queue.expected_length = section_length + 3;
                slice_queue.file_position = misc.file_position;
                slice_queue.random_access_indicator = misc.random_access_indicator;

                let remain_section = new Uint8Array(buffer, offset + i, Math.min(length - i, slice_queue.expected_length - slice_queue.total_length));
                slice_queue.slices.push(remain_section);
                slice_queue.total_length += remain_section.byteLength;

                if (slice_queue.total_length === slice_queue.expected_length) {
                    this.emitSectionSlices(slice_queue, misc);
                } else if (slice_queue.total_length >= slice_queue.expected_length) {
                    this.clearSlices(slice_queue, misc);
                }

                i += remain_section.byteLength;
            }
        } else if (slice_queue != undefined && slice_queue.total_length !== 0) {
            let remain_section = new Uint8Array(buffer, offset, Math.min(length, slice_queue.expected_length - slice_queue.total_length));
            slice_queue.slices.push(remain_section);
            slice_queue.total_length += remain_section.byteLength;

            if (slice_queue.total_length === slice_queue.expected_length) {
                this.emitSectionSlices(slice_queue, misc);
            } else if (slice_queue.total_length >= slice_queue.expected_length) {
                this.clearSlices(slice_queue, misc);
            }
        }
    }

    private handlePESSlice(buffer: ArrayBuffer, offset: number, length: number, misc: any): void {
        let data = new Uint8Array(buffer, offset, length);

        let packet_start_code_prefix = (data[0] << 16) | (data[1] << 8) | (data[2]);
        let stream_id = data[3];
        let PES_packet_length = (data[4] << 8) | data[5];

        if (misc.payload_unit_start_indicator) {
            if (packet_start_code_prefix !== 1) {
                Log.e(this.TAG, `handlePESSlice: packet_start_code_prefix should be 1 but with value ${packet_start_code_prefix}`);
                return;
            }

            // handle queued PES slices:
            // Merge into a big Uint8Array then call parsePES()
            let slice_queue = this.pes_slice_queues_[misc.pid];
            if (slice_queue) {
                if (slice_queue.expected_length === 0 || slice_queue.expected_length === slice_queue.total_length) {
                    this.emitPESSlices(slice_queue, misc);
                } else {
                    this.clearSlices(slice_queue, misc);
                }
            }

            // Make a new PES queue for new PES slices
            this.pes_slice_queues_[misc.pid] = new SliceQueue();
            this.pes_slice_queues_[misc.pid].file_position = misc.file_position;
            this.pes_slice_queues_[misc.pid].random_access_indicator = misc.random_access_indicator;
        }

        if (this.pes_slice_queues_[misc.pid] == undefined) {
            // ignore PES slices without [PES slice that has payload_unit_start_indicator]
            return;
        }

        // push subsequent PES slices into pes_queue
        let slice_queue = this.pes_slice_queues_[misc.pid];
        slice_queue.slices.push(data);
        if (misc.payload_unit_start_indicator) {
            slice_queue.expected_length = PES_packet_length === 0 ? 0 : PES_packet_length + 6;
        }
        slice_queue.total_length += data.byteLength;

        if (slice_queue.expected_length > 0 && slice_queue.expected_length === slice_queue.total_length) {
            this.emitPESSlices(slice_queue, misc);
        } else if (slice_queue.expected_length > 0 && slice_queue.expected_length < slice_queue.total_length) {
            this.clearSlices(slice_queue, misc);
        }
    }

    private emitSectionSlices(slice_queue: SliceQueue, misc: any): void {
        let data = new Uint8Array(slice_queue.total_length);
        for (let i = 0, offset = 0; i < slice_queue.slices.length; i++) {
            let slice = slice_queue.slices[i];
            data.set(slice, offset);
            offset += slice.byteLength;
        }
        slice_queue.slices = [];
        slice_queue.expected_length = -1;
        slice_queue.total_length = 0;

        let section_data = new SectionData();
        section_data.pid = misc.pid;
        section_data.data = data;
        section_data.file_position = slice_queue.file_position;
        section_data.random_access_indicator = slice_queue.random_access_indicator;
        this.parseSection(section_data);
    }

    private emitPESSlices(slice_queue: SliceQueue, misc: any): void {
        let data = new Uint8Array(slice_queue.total_length);
        for (let i = 0, offset = 0; i < slice_queue.slices.length; i++) {
            let slice = slice_queue.slices[i];
            data.set(slice, offset);
            offset += slice.byteLength;
        }
        slice_queue.slices = [];
        slice_queue.expected_length = -1;
        slice_queue.total_length = 0;

        let pes_data = new PESData();
        pes_data.pid = misc.pid;
        pes_data.data = data;
        pes_data.stream_type = misc.stream_type;
        pes_data.file_position = slice_queue.file_position;
        pes_data.random_access_indicator = slice_queue.random_access_indicator;
        this.parsePES(pes_data);
    }

    private clearSlices(slice_queue: SliceQueue, misc: any): void {
        slice_queue.slices = [];
        slice_queue.expected_length = -1;
        slice_queue.total_length = 0;
    }

    private parseSection(section_data: SectionData): void {
        let data = section_data.data;
        let pid = section_data.pid;

        if (pid === 0x00) {
            this.parsePAT(data);
        } else if (pid === this.current_pmt_pid_) {
            this.parsePMT(data);
        } else if (this.pmt_ != undefined && this.pmt_.scte_35_pids[pid]) {
            this.parseSCTE35(data);
        }
    }

    private parsePES(pes_data: PESData): void {
        let data = pes_data.data;
        let packet_start_code_prefix = (data[0] << 16) | (data[1] << 8) | (data[2]);
        let stream_id = data[3];
        let PES_packet_length = (data[4] << 8) | data[5];

        if (packet_start_code_prefix !== 1) {
            Log.e(this.TAG, `parsePES: packet_start_code_prefix should be 1 but with value ${packet_start_code_prefix}`);
            return;
        }

        if (stream_id !== 0xBC  // program_stream_map
                && stream_id !== 0xBE  // padding_stream
                && stream_id !== 0xBF  // private_stream_2
                && stream_id !== 0xF0  // ECM
                && stream_id !== 0xF1  // EMM
                && stream_id !== 0xFF  // program_stream_directory
                && stream_id !== 0xF2  // DSMCC
                && stream_id !== 0xF8) {
            let PES_scrambling_control = (data[6] & 0x30) >>> 4;
            let data_alignment_indicator = (data[6] & 0x04) >>> 2;
            let PTS_DTS_flags = (data[7] & 0xC0) >>> 6;
            let PES_header_data_length = data[8];

            let pts: number | undefined;
            let dts: number | undefined;

            if (PTS_DTS_flags === 0x02 || PTS_DTS_flags === 0x03) {
                pts = this.getTimestamp(data, 9);
                dts = PTS_DTS_flags === 0x03 ? this.getTimestamp(data, 14) : pts;
            }

            let payload_start_index = 6 + 3 + PES_header_data_length;
            let payload_length: number;

            if (PES_packet_length !== 0) {
                if (PES_packet_length < 3 + PES_header_data_length) {
                    Log.v(this.TAG, `Malformed PES: PES_packet_length < 3 + PES_header_data_length`);
                    return;
                }
                payload_length = PES_packet_length - 3 - PES_header_data_length;
            } else {  // PES_packet_length === 0
                payload_length = data.byteLength - payload_start_index;
            }

            let payload = data.subarray(payload_start_index, payload_start_index + payload_length);

            switch (pes_data.stream_type) {
                case StreamType.kMPEG1Audio:
                case StreamType.kMPEG2Audio:
                    this.parseMP3Payload(payload, pts);
                    break;
                case StreamType.kPESPrivateData:
                    if (this.pmt_.common_pids.vp9 === pes_data.pid) {
                        if (stream_id !== 0xE0 || data_alignment_indicator !== 1) {
                            Log.e(this.TAG,
                                `VP9 private mapping v1 requires stream_id=0xE0 and data_alignment_indicator=1`);
                            return;
                        }
                        this.parseVP9Payload(payload, pts, dts, pes_data.file_position, pes_data.random_access_indicator);
                    } else if (this.pmt_.common_pids.av1 === pes_data.pid) {
                        if (stream_id !== 0xBD || data_alignment_indicator !== 1 || pts == undefined) {
                            Log.e(this.TAG,
                                `AV1 MPEG-2 TS mapping requires stream_id=0xBD, ` +
                                `data_alignment_indicator=1 and PTS`);
                            return;
                        }
                        this.parseAV1Payload(payload, pts, dts, pes_data.file_position, pes_data.random_access_indicator);
                    } else if (this.pmt_.common_pids.opus === pes_data.pid) {
                        if (stream_id !== 0xBD) {
                            Log.e(this.TAG, `Opus MPEG-2 TS mapping requires stream_id=0xBD`);
                            return;
                        }
                        this.parseOpusPayload(payload, pts);
                    } else if (this.pmt_.common_pids.ac3 === pes_data.pid) {
                        this.parseAC3Payload(payload, pts);
                    } else if (this.pmt_.common_pids.eac3 === pes_data.pid) {
                        this.parseEAC3Payload(payload, pts);
                    } else if (this.pmt_.asynchronous_klv_pids[pes_data.pid]) {
                        this.parseAsynchronousKLVMetadataPayload(payload, pes_data.pid, stream_id);
                    } else if (this.pmt_.smpte2038_pids[pes_data.pid]) {
                        this.parseSMPTE2038MetadataPayload(payload, pts, dts, pes_data.pid, stream_id);
                    } else {
                        this.parsePESPrivateDataPayload(payload, pts, dts, pes_data.pid, stream_id);
                    }
                    break;
                case StreamType.kADTSAAC:
                    this.parseADTSAACPayload(payload, pts);
                    break;
                case StreamType.kLOASAAC:
                    this.parseLOASAACPayload(payload, pts);
                    break;
                case StreamType.kAC3:
                    this.parseAC3Payload(payload, pts);
                    break;
                case StreamType.kEAC3:
                    this.parseEAC3Payload(payload, pts);
                    break;
                case StreamType.kMetadata:
                    if (this.pmt_.timed_id3_pids[pes_data.pid]) {
                        this.parseTimedID3MetadataPayload(payload, pts, dts, pes_data.pid, stream_id);
                    } else if (this.pmt_.synchronous_klv_pids[pes_data.pid]) {
                        this.parseSynchronousKLVMetadataPayload(payload, pts, dts, pes_data.pid, stream_id);
                    }
                    break;
                case StreamType.kPGS:
                    this.parsePGSPayload(payload, pts, dts, pes_data.pid, stream_id, this.pmt_.pgs_langs[pes_data.pid]);
                    break;
                case StreamType.kH264:
                    this.parseH264Payload(payload, pts, dts, pes_data.file_position, pes_data.random_access_indicator);
                    break;
                case StreamType.kH265:
                    this.parseH265Payload(payload, pts, dts, pes_data.file_position, pes_data.random_access_indicator);
                    break;
                default:
                    break;
            }
        } else if (stream_id === 0xBC  // program_stream_map
                       || stream_id === 0xBF  // private_stream_2
                       || stream_id === 0xF0  // ECM
                       || stream_id === 0xF1  // EMM
                       || stream_id === 0xFF  // program_stream_directory
                       || stream_id === 0xF2  // DSMCC_stream
                       || stream_id === 0xF8) {  // ITU-T Rec. H.222.1 type E stream
            if (pes_data.stream_type === StreamType.kPESPrivateData) {
                let payload_start_index = 6;
                let payload_length: number;

                if (PES_packet_length !== 0) {
                    payload_length = PES_packet_length;
                } else {  // PES_packet_length === 0
                    payload_length = data.byteLength - payload_start_index;
                }

                let payload = data.subarray(payload_start_index, payload_start_index + payload_length);
                this.parsePESPrivateDataPayload(payload, undefined, undefined, pes_data.pid, stream_id);
            }
        }
    }

    private parsePAT(data: Uint8Array): void {
        let table_id = data[0];
        if (table_id !== 0x00) {
            Log.e(this.TAG, `parsePAT: table_id ${table_id} is not corresponded to PAT!`);
            return;
        }

        let section_length = ((data[1] & 0x0F) << 8) | data[2];

        let transport_stream_id = (data[3] << 8) | data[4];
        let version_number = (data[5] & 0x3E) >>> 1;
        let current_next_indicator = data[5] & 0x01;
        let section_number = data[6];
        let last_section_number = data[7];

        let pat: PAT = null;

        if (current_next_indicator === 1 && section_number === 0) {
            pat = new PAT();
            pat.version_number = version_number;
        } else {
            pat = this.pat_;
            if (pat == undefined) {
                return;
            }
        }

        let program_start_index = 8;
        let program_bytes = section_length - 5 - 4;  // section_length - (headers + crc)
        let first_program_number = -1;
        let first_pmt_pid = -1;

        for (let i = program_start_index; i < program_start_index + program_bytes; i += 4) {
            let program_number = (data[i] << 8) | data[i + 1];
            let pid = ((data[i + 2] & 0x1F) << 8) | data[i + 3];

            if (program_number === 0) {
                // network_PID
                pat.network_pid = pid;
            } else {
                // program_map_PID
                pat.program_pmt_pid[program_number] = pid;

                if (first_program_number === -1) {
                    first_program_number = program_number;
                }

                if (first_pmt_pid === -1) {
                    first_pmt_pid = pid;
                }
            }
        }

        // Currently we only deal with first appeared PMT pid
        if (current_next_indicator === 1 && section_number === 0) {
            if (this.pat_ == undefined) {
                Log.v(this.TAG, `Parsed first PAT: ${JSON.stringify(pat)}`);
            }
            this.pat_ = pat;
            this.current_program_ = first_program_number;
            this.current_pmt_pid_ = first_pmt_pid;
        }
    }

    private parsePMT(data: Uint8Array): void {
        let table_id = data[0];
        if (table_id !== 0x02) {
            Log.e(this.TAG, `parsePMT: table_id ${table_id} is not corresponded to PMT!`);
            return;
        }

        let section_length = ((data[1] & 0x0F) << 8) | data[2];

        let program_number = (data[3] << 8) | data[4];
        let version_number = (data[5] & 0x3E) >>> 1;
        let current_next_indicator = data[5] & 0x01;
        let section_number = data[6];
        let last_section_number = data[7];

        let pmt: PMT = null;

        if (current_next_indicator === 1 && section_number === 0) {
            pmt = new PMT();
            pmt.program_number = program_number;
            pmt.version_number = version_number;
            this.program_pmt_map_[program_number] = pmt;
        } else {
            pmt = this.program_pmt_map_[program_number];
            if (pmt == undefined) {
                return;
            }
        }

        pmt.pcr_pid = ((data[8] & 0x1F) << 8) | data[9];
        let program_info_length = ((data[10] & 0x0F) << 8) | data[11];

        let info_start_index = 12 + program_info_length;
        let info_bytes = section_length - 9 - program_info_length - 4;

        type PMTAudioStream = {
            pid: number;
            stream_type: StreamType;
            kind: AudioStreamKind;
            opus_metadata?: OpusMPEG2TSMetadata;
        };
        const audio_streams: PMTAudioStream[] = [];
        let selected_audio_stream: PMTAudioStream | undefined;
        for (let i = info_start_index; i < info_start_index + info_bytes; ) {
            let stream_type = data[i] as StreamType;
            let elementary_PID = ((data[i + 1] & 0x1F) << 8) | data[i + 2];
            let ES_info_length = ((data[i + 3] & 0x0F) << 8) | data[i + 4];

            pmt.pid_stream_type[elementary_PID] = stream_type;

            // ARIB Stream Identifier Descriptor (tag 0x52) の component tag を保持する。
            for (let offset = i + 5; offset < i + 5 + ES_info_length; ) {
                const tag = data[offset];
                const length = data[offset + 1];
                if (tag === 0x52 && length >= 1) {
                    pmt.pid_component_tag[elementary_PID] = data[offset + 2];
                }
                offset += 2 + length;
            }

            let already_has_video = pmt.common_pids.h264
                || pmt.common_pids.h265
                || pmt.common_pids.av1
                || pmt.common_pids.vp9;
            if (stream_type === StreamType.kH264 && !already_has_video) {
                pmt.common_pids.h264 = elementary_PID;
            } else if (stream_type === StreamType.kH265 && !already_has_video) {
                pmt.common_pids.h265 = elementary_PID;
            } else if (stream_type === StreamType.kADTSAAC) {
                audio_streams.push({pid: elementary_PID, stream_type, kind: 'adts_aac'});
            } else if (stream_type === StreamType.kLOASAAC) {
                audio_streams.push({pid: elementary_PID, stream_type, kind: 'loas_aac'});
            } else if (stream_type === StreamType.kAC3) {
                audio_streams.push({pid: elementary_PID, stream_type, kind: 'ac3'}); // ATSC AC-3
            } else if (stream_type === StreamType.kEAC3) {
                audio_streams.push({pid: elementary_PID, stream_type, kind: 'eac3'}); // ATSC E-AC-3
            } else if (stream_type === StreamType.kMPEG1Audio || stream_type === StreamType.kMPEG2Audio) {
                audio_streams.push({pid: elementary_PID, stream_type, kind: 'mp3'});
            } else if (stream_type === StreamType.kPESPrivateData) {
                pmt.pes_private_data_pids[elementary_PID] = true;
                if (ES_info_length > 0) {
                    const descriptors = data.subarray(i + 5, i + 5 + ES_info_length);
                    const av1_configuration = parseAV1MPEG2TSDescriptors(descriptors);
                    const opus_metadata = parseOpusMPEG2TSDescriptors(descriptors);

                    if (!already_has_video && av1_configuration != null) {
                        pmt.common_pids.av1 = elementary_PID;
                        pmt.av1_codec_configuration = av1_configuration;
                    } else if (!already_has_video && hasVP9PrivateMappingV1(descriptors)) {
                        pmt.common_pids.vp9 = elementary_PID;
                    }
                    if (opus_metadata != null) {
                        audio_streams.push({
                            pid: elementary_PID,
                            stream_type,
                            kind: 'opus',
                            opus_metadata
                        });
                    }

                    // parse descriptor for PES private data
                    for (let offset = i + 5; offset < i + 5 + ES_info_length; ) {
                        let tag = data[offset + 0];
                        let length = data[offset + 1];
                        if (tag === 0x05) { // Registration Descriptor
                            let registration = String.fromCharCode(... Array.from(data.subarray(offset + 2, offset + 2 + length)));

                            if (registration === 'VANC') {
                                pmt.smpte2038_pids[elementary_PID] = true;
                            } /* else if (registration === 'AC-3' && !already_has_audio) {
                                pmt.common_pids.ac3 = elementary_PID; // DVB AC-3 (FIXME: NEED VERIFY)
                            } */ /* else if (registration === 'EC-3' && !alrady_has_audio) {
                                pmt.common_pids.eac3 = elementary_PID; // DVB EAC-3 (FIXME: NEED VERIFY)
                            } */
                            else if (registration === 'KLVA') {
                                pmt.asynchronous_klv_pids[elementary_PID] = true;
                            }
                        }

                        offset += 2 + length;
                    }
                    // provide descriptor for PES private data via callback
                    this.dispatchPESPrivateDataDescriptor(elementary_PID, stream_type, descriptors);
                }
            } else if (stream_type === StreamType.kMetadata) {
                if (ES_info_length > 0) {
                    // parse descriptor for PES private data
                    for (let offset = i + 5; offset < i + 5 + ES_info_length; ) {
                        let tag = data[offset + 0];
                        let length = data[offset + 1];

                        if (tag === 0x26) {
                            let metadata_application_format = (data[offset + 2] << 8) | (data[offset + 3] << 0);
                            let metadata_application_format_identifier = null;
                            if (metadata_application_format === 0xFFFF) {
                                metadata_application_format_identifier = String.fromCharCode(... Array.from(data.subarray(offset + 4, offset + 4 + 4)));
                            }
                            let metadata_format = data[offset + 4 + (metadata_application_format === 0xFFFF ? 4 : 0)];
                            let metadata_format_identifier = null;
                            if (metadata_format === 0xFF) {
                                let pad = 4 + (metadata_application_format === 0xFFFF ? 4 : 0) + 1;
                                metadata_format_identifier = String.fromCharCode(... Array.from(data.subarray(offset + pad, offset + pad + 4)));
                            }

                            if (metadata_application_format_identifier === 'ID3 ' && metadata_format_identifier === 'ID3 ') {
                                pmt.timed_id3_pids[elementary_PID] = true;
                            } else if (metadata_format_identifier === 'KLVA') {
                                pmt.synchronous_klv_pids[elementary_PID] = true;
                            }
                        }

                        offset += 2 + length;
                    }
                }
            } else if (stream_type === StreamType.kSCTE35) {
                pmt.scte_35_pids[elementary_PID] = true;
            } else if (stream_type === StreamType.kPGS) {
                pmt.pgs_langs[elementary_PID] = 'und';
                if (ES_info_length > 0) {
                    // parse descriptor
                    for (let offset = i + 5; offset < i + 5 + ES_info_length; ) {
                        let tag = data[offset + 0];
                        let length = data[offset + 1];
                        if (tag === 0x0a) { // ISO_639_LANGUAGE_DESCRIPTOR
                            const lang = String.fromCharCode(... Array.from(data.slice(offset + 2, offset + 5)));
                            pmt.pgs_langs[elementary_PID] = lang;
                        }
                        offset += 2 + length;
                    }
                }
                pmt.pgs_pids[elementary_PID] = true;
            }

            i += 5 + ES_info_length;
        }

        // 選択中の音声トラックが PMT 更新で消えた場合は、同じ PMT の Track1 へ即時復帰する。
        // UI 側から後で preferred_audio_track_index を戻すだけでは、次の PMT まで音声 PID が未選択になる。
        if (audio_streams.length > 0) {
            if (this.preferred_audio_track_index < 0
                    || this.preferred_audio_track_index >= audio_streams.length) {
                Log.w(this.TAG,
                    `Selected audio track is no longer available, fallback to Track1: ` +
                    `selected=${this.preferred_audio_track_index + 1}, tracks=${audio_streams.length}`);
                this.preferred_audio_track_index = 0;
            }

            selected_audio_stream = audio_streams[this.preferred_audio_track_index];
            pmt.common_pids[selected_audio_stream.kind] = selected_audio_stream.pid;
        }

        if (program_number === this.current_program_) {
            const previous_audio_track_count = this.media_info_.audioTrackCount;
            this.media_info_.audioTrackCount = audio_streams.length;
            this.media_info_.audioTrackComponentTags = audio_streams
                .map(({pid}) => pmt.pid_component_tag[pid] ?? null);

            const selected_audio_changed = this.selected_audio_pid_ != undefined
                && (this.selected_audio_pid_ !== selected_audio_stream?.pid
                    || this.selected_audio_kind_ !== selected_audio_stream?.kind);
            if (selected_audio_changed) {
                // 同一 codec/config の別 PID でも、旧 PID の sample・補間 PTS・
                // 未完 AAC frame を新しいトラックへ持ち越してはいけない。
                this.dispatchAudioMediaSegment(true);
                this.audio_last_sample_pts_ = undefined;
                this.opus_next_sample_pts_ = undefined;
                this.aac_last_incomplete_data_ = null;
                this.loas_previous_frame = null;
                delete this.pes_slice_queues_[this.selected_audio_pid_];
                if (selected_audio_stream != undefined) {
                    delete this.pes_slice_queues_[selected_audio_stream.pid];
                }
            }
            this.selected_audio_pid_ = selected_audio_stream?.pid;
            this.selected_audio_kind_ = selected_audio_stream?.kind;

            if (this.pmt_ == undefined) {
                Log.v(this.TAG, `Parsed first PMT: ${JSON.stringify(pmt)}`);
            }
            this.pmt_ = pmt;
            if (pmt.common_pids.h264 || pmt.common_pids.h265 || pmt.common_pids.av1 || pmt.common_pids.vp9) {
                this.has_video_ = true;
            }
            if (pmt.common_pids.adts_aac || pmt.common_pids.loas_aac || pmt.common_pids.ac3
                    || pmt.common_pids.eac3 || pmt.common_pids.opus || pmt.common_pids.mp3) {
                this.has_audio_ = true;
            }

            if (selected_audio_stream?.kind === 'opus') {
                const meta = selected_audio_stream.opus_metadata!;
                const sample = {codec: 'opus', meta} as const;
                if (!this.audio_init_segment_dispatched_ || this.detectAudioMetadataChange(sample)) {
                    this.dispatchAudioMediaSegment(true);
                    this.audio_metadata_ = meta;
                    this.dispatchAudioInitSegment(sample);
                }
            }

            // PMT が更新されて音声 PID 数が変化した場合は、Worker 外にも最新の MediaInfo を通知する。
            if (previous_audio_track_count !== null &&
                previous_audio_track_count !== this.media_info_.audioTrackCount &&
                this.media_info_.isComplete()) {
                this.onMediaInfo(this.media_info_);
            }
        }
    }

    private parseSCTE35(data: Uint8Array): void {
        const scte35 = readSCTE35(data);

        if (scte35.pts != undefined) {
            let pts_ms = Math.floor(scte35.pts / this.timescale_);
            scte35.pts = pts_ms;
        } else {
            scte35.nearest_pts = this.getNearestTimestampMilliseconds();
        }

        if (this.onSCTE35Metadata) {
            this.onSCTE35Metadata(scte35);
        }
    }

    private parseVP9Payload(
        data: Uint8Array,
        pts: number,
        dts: number,
        file_position: number,
        random_access_indicator: number
    ): void {
        if (pts == undefined || dts == undefined || data.byteLength === 0) {
            Log.e(this.TAG, `VP9 private mapping v1 requires PTS/DTS and a non-empty payload`);
            return;
        }

        const layout = parseVP9SampleLayout(data);
        if (layout == null) {
            Log.e(this.TAG, `Malformed VP9 superframe index`);
            return;
        }

        const previous_config = this.video_metadata_.details?.vp9_config as VP9CodecConfiguration | undefined;
        let current_config = previous_config;
        let is_keyframe = false;
        for (const frame of layout.frames) {
            const header = parseVP9FrameHeader(frame, current_config);
            if (header == null) {
                Log.e(this.TAG, `Malformed VP9 uncompressed frame header`);
                return;
            }
            is_keyframe ||= header.isKeyframe;
            if (header.config != undefined) {
                current_config = header.config;
            }
        }

        if (is_keyframe && random_access_indicator !== 1) {
            Log.e(this.TAG, `VP9 private mapping v1 requires RAI on a keyframe PES`);
            return;
        }

        if (current_config != undefined) {
            const details = buildVP9VideoDetails(current_config);
            const previous_details = this.video_metadata_.details;
            const metadata_changed = previous_details?.vp9_config != undefined
                && this.isVP9ConfigurationChanged(previous_details.vp9_config, current_config);

            if (!this.video_init_segment_dispatched_) {
                this.video_metadata_.details = details;
                this.dispatchVideoInitSegment();
            } else if (metadata_changed) {
                Log.v(this.TAG, `VP9: Codec configuration changed, attempt to re-generate InitSegment`);
                this.video_metadata_changed_ = true;
                this.dispatchVideoMediaSegment(true);
                this.video_metadata_.details = details;
                this.dispatchVideoInitSegment();
            }
        }

        if (!this.video_init_segment_dispatched_) {
            // A regular inter frame does not carry enough information for vpcC.
            return;
        }

        const pts_ms = Math.floor(pts / this.timescale_);
        const dts_ms = Math.floor(dts / this.timescale_);
        const sample = {
            units: [{data}],
            length: data.byteLength,
            isKeyframe: is_keyframe,
            dts: dts_ms,
            pts: pts_ms,
            cts: pts_ms - dts_ms,
            file_position
        };
        this.video_track_.samples.push(sample);
        this.video_track_.length += data.byteLength;
    }

    private isVP9ConfigurationChanged(
        previous: VP9CodecConfiguration,
        current: VP9CodecConfiguration
    ): boolean {
        return previous.profile !== current.profile
            || previous.level !== current.level
            || previous.bitDepth !== current.bitDepth
            || previous.chromaSubsampling !== current.chromaSubsampling
            || previous.videoFullRangeFlag !== current.videoFullRangeFlag
            || previous.colourPrimaries !== current.colourPrimaries
            || previous.transferCharacteristics !== current.transferCharacteristics
            || previous.matrixCoefficients !== current.matrixCoefficients
            || previous.codecWidth !== current.codecWidth
            || previous.codecHeight !== current.codecHeight
            || previous.presentWidth !== current.presentWidth
            || previous.presentHeight !== current.presentHeight;
    }

    private parseAV1Payload(data: Uint8Array, pts: number, dts: number, file_position: number, random_access_indicator: number) {
        const descriptor_configuration = this.pmt_.av1_codec_configuration;
        if (descriptor_configuration == null || data.byteLength === 0) {
            Log.e(this.TAG, `AV1 descriptor configuration or payload is missing`);
            return;
        }

        const av1_in_ts_parser = new AV1OBUInMpegTsParser(data);
        if (!av1_in_ts_parser.isValid()) {
            Log.e(this.TAG, `Malformed AV1 MPEG-2 TS start-code payload`);
            return;
        }

        const previous_details = this.video_metadata_.details as AV1Metadata | undefined;
        let details = previous_details ?? null;
        let payload: Uint8Array | null;
        const units: {data: Uint8Array}[] = [];
        let length = 0;
        let has_sequence_header = false;
        let has_frame = false;
        let keyframe = false;

        while ((payload = av1_in_ts_parser.readNextOBUPayload()) != null) {
            const rewrite = AV1OBUParser.rewriteSequenceHeaderOBU(
                payload,
                this.getVideoColorRewriteMode(),
            );
            if (rewrite != null) {
                payload = rewrite.obu;
                this.applyVideoColorToMediaInfo(rewrite.original, rewrite.effective);
            }
            const result = AV1OBUParser.parseOBUsWithStatus(payload, details);
            if (!result.valid) {
                Log.e(this.TAG, `Malformed or unsupported AV1 OBU payload`);
                return;
            }
            details = result.metadata;
            has_sequence_header ||= result.hasSequenceHeader;
            has_frame ||= result.hasFrame;
            keyframe ||= result.isKeyframe;
            units.push({data: payload});
            length += payload.byteLength;
        }

        if (!has_frame || details == null
                || details.codec_size == null
                || details.present_size == null
                || details.sar_ratio == null
                || !this.isAV1DescriptorCompatible(descriptor_configuration, details)) {
            Log.e(this.TAG, `AV1 access unit is incomplete or conflicts with its PMT descriptor`);
            return;
        }
        if (keyframe && random_access_indicator !== 1) {
            Log.e(this.TAG, `AV1 random access frame requires random_access_indicator=1`);
            return;
        }

        const previous_is_av1 = previous_details?.sequence_header != null
            && this.video_metadata_.av1c != null;
        const descriptor_changed = !previous_is_av1
            || !this.bytesEqual(
                this.video_metadata_.av1c!.subarray(0, descriptor_configuration.byteLength),
                descriptor_configuration
            );
        const sequence_header_changed = has_sequence_header && previous_is_av1
            && this.isAV1ConfigurationChanged(previous_details!, details);
        const configuration_changed = !previous_is_av1
            || descriptor_changed
            || sequence_header_changed;

        if (keyframe && has_sequence_header) {
            const av1c = new Uint8Array(
                descriptor_configuration.byteLength + details.sequence_header_data.byteLength
            );
            av1c.set(descriptor_configuration, 0);
            av1c.set(details.sequence_header_data, descriptor_configuration.byteLength);

            if (!this.video_init_segment_dispatched_) {
                this.video_metadata_.details = details;
                this.video_metadata_.av1c = av1c;
                this.dispatchVideoInitSegment();
            } else if (configuration_changed) {
                this.video_metadata_changed_ = true;
                this.dispatchVideoMediaSegment(true);
                this.video_metadata_.details = details;
                this.video_metadata_.av1c = av1c;
                this.dispatchVideoInitSegment();
            } else {
                this.video_metadata_.details = details;
            }
        } else {
            // PMT/sequence header が変化した構成は、新しい sequence header を伴う
            // random-access AU からのみ開始する。旧 av1C のまま sample を流さない。
            if (!this.video_init_segment_dispatched_ || configuration_changed) {
                return;
            }
            this.video_metadata_.details = details;
        }

        const pts_ms = Math.floor(pts / this.timescale_);
        const dts_ms = Math.floor(dts / this.timescale_);
        const av1_sample = {
            units,
            length,
            isKeyframe: keyframe,
            dts: dts_ms,
            pts: pts_ms,
            cts: pts_ms - dts_ms,
            file_position
        };
        this.video_track_.samples.push(av1_sample);
        this.video_track_.length += length;
    }

    private isAV1DescriptorCompatible(configuration: Uint8Array, details: AV1Metadata): boolean {
        if (configuration.byteLength !== 4) {
            return false;
        }

        const profile = configuration[1] >>> 5;
        const level = configuration[1] & 0x1F;
        const tier = configuration[2] >>> 7;
        const high_bitdepth = (configuration[2] >>> 6) & 0x01;
        const twelve_bit = (configuration[2] >>> 5) & 0x01;
        const bit_depth = high_bitdepth === 0 ? 8 : (profile === 2 && twelve_bit === 1 ? 12 : 10);

        return profile === details.profile_idc
            && level === details.level
            && tier === details.tier
            && bit_depth === details.bit_depth
            && ((configuration[2] >>> 4) & 0x01) === Number(details.mono_chrome)
            && ((configuration[2] >>> 3) & 0x01) === details.subsampling_x
            && ((configuration[2] >>> 2) & 0x01) === details.subsampling_y
            && (configuration[2] & 0x03) === details.chroma_sample_position;
    }

    private isAV1ConfigurationChanged(previous: AV1Metadata, current: AV1Metadata): boolean {
        if (previous.codec_mimetype !== current.codec_mimetype
                || previous.codec_size?.width !== current.codec_size?.width
                || previous.codec_size?.height !== current.codec_size?.height
                || previous.present_size?.width !== current.present_size?.width
                || previous.present_size?.height !== current.present_size?.height
                || previous.sequence_header_data.byteLength !== current.sequence_header_data.byteLength) {
            return true;
        }
        for (let i = 0; i < previous.sequence_header_data.byteLength; i++) {
            if (previous.sequence_header_data[i] !== current.sequence_header_data[i]) {
                return true;
            }
        }
        return false;
    }

    private bytesEqual(first: Uint8Array, second: Uint8Array): boolean {
        if (first.byteLength !== second.byteLength) {
            return false;
        }
        for (let i = 0; i < first.byteLength; i++) {
            if (first[i] !== second[i]) {
                return false;
            }
        }
        return true;
    }

    private parseH264Payload(data: Uint8Array, pts: number, dts: number, file_position: number, random_access_indicator: number) {
        let annexb_parser = new H264AnnexBParser(data);
        let nalu_payload: H264NaluPayload = null;
        let units: {type: H264NaluType, data: Uint8Array}[] = [];
        let length = 0;
        let keyframe = false;

        while ((nalu_payload = annexb_parser.readNextNaluPayload()) != null) {
            let nalu_avc1 = new H264NaluAVC1(nalu_payload);

            if (nalu_avc1.type === H264NaluType.kSliceSPS) {
                // Notice: parseSPS requires Nalu without startcode or length-header
                let details = SPSParser.parseSPS(nalu_payload.data);
                if (!this.video_init_segment_dispatched_) {
                    this.video_metadata_.sps = nalu_avc1;
                    this.video_metadata_.details = details;
                } else if (this.detectVideoMetadataChange(nalu_avc1, details) === true) {
                    Log.v(this.TAG, `H264: Critical h264 metadata has been changed, attempt to re-generate InitSegment`);
                    this.video_metadata_changed_ = true;
                    this.video_metadata_ = {vps: undefined, sps: nalu_avc1, pps: undefined, av1c: undefined, details: details};
                }
            } else if (nalu_avc1.type === H264NaluType.kSlicePPS) {
                if (!this.video_init_segment_dispatched_ || this.video_metadata_changed_) {
                    this.video_metadata_.pps = nalu_avc1;
                    if (this.video_metadata_.sps && this.video_metadata_.pps) {
                        if (this.video_metadata_changed_) {
                            // flush stashed frames before changing codec metadata
                            this.dispatchVideoMediaSegment(true);
                        }
                        // notify new codec metadata (maybe changed)
                        this.dispatchVideoInitSegment();
                    }
                }
            } else if (nalu_avc1.type === H264NaluType.kSliceIDR) {
                keyframe = true;
            } else if (nalu_avc1.type === H264NaluType.kSliceNonIDR && random_access_indicator === 1) {
                // For open-gop stream, use random_access_indicator to identify keyframe
                keyframe = true;
            } else if (nalu_avc1.type === H264NaluType.kSliceSEI) {
                this.parseSEIPayload(nalu_payload.data, pts, 'h264');
            }

            // Push samples to remuxer only if initialization metadata has been dispatched
            if (this.video_init_segment_dispatched_) {
                units.push(nalu_avc1);
                length += nalu_avc1.data.byteLength;
            }
        }

        let pts_ms = Math.floor(pts / this.timescale_);
        let dts_ms = Math.floor(dts / this.timescale_);

        if (units.length) {
            let track = this.video_track_;
            let avc_sample = {
                units,
                length,
                isKeyframe: keyframe,
                dts: dts_ms,
                pts: pts_ms,
                cts: pts_ms - dts_ms,
                file_position
            };
            track.samples.push(avc_sample);
            track.length += length;
        }
    }

    private parseH265Payload(data: Uint8Array, pts: number, dts: number, file_position: number, random_access_indicator: number) {
        let annexb_parser = new H265AnnexBParser(data);
        let nalu_payload: H265NaluPayload = null;
        let units: {type: H265NaluType, data: Uint8Array}[] = [];
        let length = 0;
        let keyframe = false;

        while ((nalu_payload = annexb_parser.readNextNaluPayload()) != null) {
            let nalu_hvc1 = new H265NaluHVC1(nalu_payload);

            if (nalu_hvc1.type === H265NaluType.kSliceVPS) {
                if (!this.video_init_segment_dispatched_) {
                    let details = H265Parser.parseVPS(nalu_payload.data);
                    this.video_metadata_.vps = nalu_hvc1;
                    this.video_metadata_.details = {
                        ... this.video_metadata_.details,
                        ... details
                    };
                }
            } else if (nalu_hvc1.type === H265NaluType.kSliceSPS) {
                const rewrite = H265Parser.rewriteSPSColor(
                    nalu_payload.data,
                    this.getVideoColorRewriteMode(),
                );
                if (rewrite.rewritten === true) {
                    nalu_payload.data = rewrite.nalu;
                    nalu_hvc1 = new H265NaluHVC1(nalu_payload);
                }
                this.applyVideoColorToMediaInfo(rewrite.original, rewrite.effective);
                let details = H265Parser.parseSPS(nalu_payload.data);
                if (!this.video_init_segment_dispatched_) {
                    this.video_metadata_.sps = nalu_hvc1;
                    this.video_metadata_.details = {
                        ... this.video_metadata_.details,
                        ... details
                    };
                } else if (this.detectVideoMetadataChange(nalu_hvc1, details) === true) {
                    Log.v(this.TAG, `H265: Critical h265 metadata has been changed, attempt to re-generate InitSegment`);
                    this.video_metadata_changed_ = true;
                    this.video_metadata_ = { vps: undefined, sps: nalu_hvc1, pps: undefined, av1c: undefined, details: details};
                }
            } else if (nalu_hvc1.type === H265NaluType.kSlicePPS) {
                if (!this.video_init_segment_dispatched_ || this.video_metadata_changed_) {
                    let details = H265Parser.parsePPS(nalu_payload.data);
                    this.video_metadata_.pps = nalu_hvc1;
                    this.video_metadata_.details = {
                        ... this.video_metadata_.details,
                        ... details
                    };

                    if (this.video_metadata_.vps && this.video_metadata_.sps && this.video_metadata_.pps) {
                        if (this.video_metadata_changed_) {
                            // flush stashed frames before changing codec metadata
                            this.dispatchVideoMediaSegment(true);
                        }
                        // notify new codec metadata (maybe changed)
                        this.dispatchVideoInitSegment();
                    }
                }
            } else if (nalu_hvc1.type === H265NaluType.kSliceIDR_W_RADL || nalu_hvc1.type === H265NaluType.kSliceIDR_N_LP || nalu_hvc1.type === H265NaluType.kSliceCRA_NUT) {
                keyframe = true;
            } else if (nalu_hvc1.type === H265NaluType.kSliceSEI || nalu_hvc1.type === H265NaluType.kSliceSEISuffix) {
                this.parseSEIPayload(nalu_payload.data, pts, 'h265');
            }

            // Push samples to remuxer only if initialization metadata has been dispatched
            if (this.video_init_segment_dispatched_) {
                units.push(nalu_hvc1);
                length += nalu_hvc1.data.byteLength;
            }
        }

        let pts_ms = Math.floor(pts / this.timescale_);
        let dts_ms = Math.floor(dts / this.timescale_);

        if (units.length) {
            let track = this.video_track_;
            let hvc_sample = {
                units,
                length,
                isKeyframe: keyframe,
                dts: dts_ms,
                pts: pts_ms,
                cts: pts_ms - dts_ms,
                file_position
            };
            track.samples.push(hvc_sample);
            track.length += length;
        }
    }

    private detectVideoMetadataChange(new_sps: H264NaluAVC1 | H265NaluHVC1, new_details: any): boolean {
        if (new_details.codec_mimetype !== this.video_metadata_.details.codec_mimetype) {
            Log.v(this.TAG, `Video: Codec mimeType changed from ` +
                            `${this.video_metadata_.details.codec_mimetype} to ${new_details.codec_mimetype}`);
            return true;
        }

        if (new_details.codec_size.width !== this.video_metadata_.details.codec_size.width
            || new_details.codec_size.height !== this.video_metadata_.details.codec_size.height) {
            let old_size = this.video_metadata_.details.codec_size;
            let new_size = new_details.codec_size;
            Log.v(this.TAG, `Video: Coded Resolution changed from ` +
                            `${old_size.width}x${old_size.height} to ${new_size.width}x${new_size.height}`);
            return true;
        }

        if (new_details.present_size.width !== this.video_metadata_.details.present_size.width) {
            Log.v(this.TAG, `Video: Present resolution width changed from ` +
                            `${this.video_metadata_.details.present_size.width} to ${new_details.present_size.width}`);
            return true;
        }

        if (new_details.colour_primaries !== this.video_metadata_.details.colour_primaries
            || new_details.transfer_characteristics !== this.video_metadata_.details.transfer_characteristics
            || new_details.matrix_coeffs !== this.video_metadata_.details.matrix_coeffs) {
            // Colour/transfer/matrix だけの差は codec 変更にしない。
            // ライブで videoColorRewrite を切り替えても新しい InitSegment を出さず、
            // 以降の in-band SPS だけを書き換える。
            Log.v(this.TAG, `Video: Colour signalling changed from ` +
                            `${this.video_metadata_.details.colour_primaries}/` +
                            `${this.video_metadata_.details.transfer_characteristics}/` +
                            `${this.video_metadata_.details.matrix_coeffs} to ` +
                            `${new_details.colour_primaries}/` +
                            `${new_details.transfer_characteristics}/` +
                            `${new_details.matrix_coeffs}; keep current InitSegment`);
            this.video_metadata_.details.colour_primaries = new_details.colour_primaries;
            this.video_metadata_.details.transfer_characteristics = new_details.transfer_characteristics;
            this.video_metadata_.details.matrix_coeffs = new_details.matrix_coeffs;
        }

        return false;
    }

    private isInitSegmentDispatched(): boolean {
        if (this.has_video_ && this.has_audio_) {  // both video & audio
            return this.video_init_segment_dispatched_ && this.audio_init_segment_dispatched_;
        }
        if (this.has_video_ && !this.has_audio_) {  // video only
            return this.video_init_segment_dispatched_;
        }
        if (!this.has_video_ && this.has_audio_) {  // audio only
            return this.audio_init_segment_dispatched_;
        }
        return false;
    }

    private dispatchVideoInitSegment() {
        let details = this.video_metadata_.details;
        let meta: any = {};

        meta.type = 'video';
        meta.id = this.video_track_.id;
        meta.timescale = 1000;
        meta.duration = this.duration_;

        meta.codecWidth = details.codec_size.width;
        meta.codecHeight = details.codec_size.height;
        meta.presentWidth = details.present_size.width;
        meta.presentHeight = details.present_size.height;

        meta.profile = details.profile_string;
        meta.level = details.level_string;
        meta.bitDepth = details.bit_depth;
        meta.chromaFormat = details.chroma_format;
        meta.sarRatio = details.sar_ratio;
        meta.frameRate = details.frame_rate;

        let fps_den = meta.frameRate.fps_den;
        let fps_num = meta.frameRate.fps_num;
        meta.refSampleDuration = details.ref_sample_duration != undefined
            ? details.ref_sample_duration
            : 1000 * (fps_den / fps_num);

        meta.codec = details.codec_mimetype;

        if (details.vpcc) {
            meta.vpcc = details.vpcc;
            if (this.video_init_segment_dispatched_ == false) {
                Log.v(this.TAG, `Generated first VPCodecConfigurationRecord for mimeType: ${meta.codec}`);
            }
        } else if (this.video_metadata_.av1c) {
            meta.av1c = this.video_metadata_.av1c;
            if (this.video_init_segment_dispatched_ == false) {
                Log.v(this.TAG, `Generated first AV1 for mimeType: ${meta.codec}`);
            }
        } else if (this.video_metadata_.vps) {
            let vps_without_header = this.video_metadata_.vps.data.subarray(4);
            let sps_without_header = this.video_metadata_.sps.data.subarray(4);
            let pps_without_header = this.video_metadata_.pps.data.subarray(4);
            let hvcc = new HEVCDecoderConfigurationRecord(vps_without_header, sps_without_header, pps_without_header, details);
            meta.hvcc = hvcc.getData();

            if (this.video_init_segment_dispatched_ == false) {
                Log.v(this.TAG, `Generated first HEVCDecoderConfigurationRecord for mimeType: ${meta.codec}`);
            }
        } else {
            let sps_without_header = this.video_metadata_.sps.data.subarray(4);
            let pps_without_header = this.video_metadata_.pps.data.subarray(4);
            let avcc = new AVCDecoderConfigurationRecord(sps_without_header, pps_without_header, details);
            meta.avcc = avcc.getData();

            if (this.video_init_segment_dispatched_ == false) {
                Log.v(this.TAG, `Generated first AVCDecoderConfigurationRecord for mimeType: ${meta.codec}`);
            }
        }
        this.onTrackMetadata('video', meta);
        this.video_init_segment_dispatched_ = true;
        this.video_metadata_changed_ = false;

        // notify new MediaInfo
        let mi = this.media_info_;
        mi.hasVideo = true;
        mi.width = meta.codecWidth;
        mi.height = meta.codecHeight;
        mi.fps = meta.frameRate.fps;
        mi.profile = meta.profile;
        mi.level = meta.level;
        mi.refFrames = details.ref_frames;
        mi.chromaFormat = details.chroma_format_string;
        mi.sarNum = meta.sarRatio.width;
        mi.sarDen = meta.sarRatio.height;
        mi.videoCodec = meta.codec;

        if (mi.hasAudio && mi.audioCodec) {
            mi.mimeType = `video/mp2t; codecs="${mi.videoCodec},${mi.audioCodec}"`;
        } else {
            mi.mimeType = `video/mp2t; codecs="${mi.videoCodec}"`;
        }

        if (mi.isComplete()) {
            this.onMediaInfo(mi);
        }
    }

    private dispatchVideoMediaSegment(force = false) {
        if (this.isInitSegmentDispatched()) {
            if (this.video_track_.length || force) {
                this.onDataAvailable(null, this.video_track_, force);
            }
        }
    }

    private dispatchAudioMediaSegment(force = false) {
        if (this.isInitSegmentDispatched()) {
            if (this.audio_track_.length || force) {
                this.onDataAvailable(this.audio_track_, null, force);
            }
        }
    }

    private dispatchAudioVideoMediaSegment() {
        if (this.isInitSegmentDispatched()) {
            if (this.audio_track_.length || this.video_track_.length) {
                this.onDataAvailable(this.audio_track_, this.video_track_);
            }
        }
    }

    private parseADTSAACPayload(data: Uint8Array, pts: number) {
        if (this.has_video_ && !this.video_init_segment_dispatched_) {
            // If first video IDR frame hasn't been detected,
            // Wait for first IDR frame and video init segment being dispatched
            return;
        }

        if (this.aac_last_incomplete_data_) {
            let buf = new Uint8Array(data.byteLength + this.aac_last_incomplete_data_.byteLength);
            buf.set(this.aac_last_incomplete_data_, 0);
            buf.set(data, this.aac_last_incomplete_data_.byteLength);
            data = buf;
        }

        let ref_sample_duration: number;
        let base_pts_ms: number;

        if (pts != undefined) {
            base_pts_ms = pts / this.timescale_;
        }
        if (this.audio_metadata_.codec === 'aac') {
            if (pts == undefined && this.audio_last_sample_pts_ != undefined) {
                ref_sample_duration = 1024 / this.audio_metadata_.sampling_frequency * 1000;
                base_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;
            } else if (pts == undefined){
                Log.w(this.TAG, `AAC: Unknown pts`);
                return;
            }

            if (this.aac_last_incomplete_data_ && this.audio_last_sample_pts_) {
                ref_sample_duration = 1024 / this.audio_metadata_.sampling_frequency * 1000;
                let new_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;

                if (Math.abs(new_pts_ms - base_pts_ms) > 1) {
                    Log.w(this.TAG, `AAC: Detected pts overlapped, ` +
                                    `expected: ${new_pts_ms}ms, PES pts: ${base_pts_ms}ms`);
                    base_pts_ms = new_pts_ms;
                }
            }
        }

        let adts_parser = new AACADTSParser(data);
        let aac_frame: AACFrame = null;
        let sample_pts_ms = base_pts_ms;
        let last_sample_pts_ms: number;

        while ((aac_frame = adts_parser.readNextAACFrame()) != null) {
            ref_sample_duration = 1024 / aac_frame.sampling_frequency * 1000;
            const audio_sample = {
                codec: 'aac',
                data: aac_frame
            } as const;

            if (this.audio_init_segment_dispatched_ == false || this.detectAudioMetadataChange(audio_sample)) {
                this.audio_metadata_ = {
                    codec: 'aac',
                    audio_object_type: aac_frame.audio_object_type,
                    sampling_freq_index: aac_frame.sampling_freq_index,
                    sampling_frequency: aac_frame.sampling_frequency,
                    channel_config: aac_frame.channel_config
                };
                // flush stashed frames before notify new AudioSpecificConfig
                this.dispatchAudioMediaSegment(true);
                // notify new AAC AudioSpecificConfig
                this.dispatchAudioInitSegment(audio_sample);
            }

            last_sample_pts_ms = sample_pts_ms;
            let sample_pts_ms_int = Math.floor(sample_pts_ms);

            let aac_sample = {
                unit: aac_frame.data,
                length: aac_frame.data.byteLength,
                pts: sample_pts_ms_int,
                dts: sample_pts_ms_int
            };
            this.audio_track_.samples.push(aac_sample);
            this.audio_track_.length += aac_frame.data.byteLength;

            sample_pts_ms += ref_sample_duration;
        }

        if (adts_parser.hasIncompleteData()) {
            this.aac_last_incomplete_data_ = adts_parser.getIncompleteData();
        }

        if (last_sample_pts_ms) {
            this.audio_last_sample_pts_ = last_sample_pts_ms;
        }
    }

    private parseLOASAACPayload(data: Uint8Array, pts: number) {
        if (this.has_video_ && !this.video_init_segment_dispatched_) {
            // If first video IDR frame hasn't been detected,
            // Wait for first IDR frame and video init segment being dispatched
            return;
        }

        if (this.aac_last_incomplete_data_) {
            let buf = new Uint8Array(data.byteLength + this.aac_last_incomplete_data_.byteLength);
            buf.set(this.aac_last_incomplete_data_, 0);
            buf.set(data, this.aac_last_incomplete_data_.byteLength);
            data = buf;
        }

        let ref_sample_duration: number;
        let base_pts_ms: number;

        if (pts != undefined) {
            base_pts_ms = pts / this.timescale_;
        }
        if (this.audio_metadata_.codec === 'aac') {
            if (pts == undefined && this.audio_last_sample_pts_ != undefined) {
                ref_sample_duration = 1024 / this.audio_metadata_.sampling_frequency * 1000;
                base_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;
            } else if (pts == undefined){
                Log.w(this.TAG, `AAC: Unknown pts`);
                return;
            }

            if (this.aac_last_incomplete_data_ && this.audio_last_sample_pts_) {
                ref_sample_duration = 1024 / this.audio_metadata_.sampling_frequency * 1000;
                let new_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;

                if (Math.abs(new_pts_ms - base_pts_ms) > 1) {
                    Log.w(this.TAG, `AAC: Detected pts overlapped, ` +
                                    `expected: ${new_pts_ms}ms, PES pts: ${base_pts_ms}ms`);
                    base_pts_ms = new_pts_ms;
                }
            }
        }

        let loas_parser = new AACLOASParser(data);
        let aac_frame: LOASAACFrame = null;
        let sample_pts_ms = base_pts_ms;
        let last_sample_pts_ms: number;

        while ((aac_frame = loas_parser.readNextAACFrame(this.loas_previous_frame ?? undefined)) != null) {
            this.loas_previous_frame = aac_frame;
            ref_sample_duration = 1024 / aac_frame.sampling_frequency * 1000;
            const audio_sample = {
                codec: 'aac',
                data: aac_frame
            } as const;

            if (this.audio_init_segment_dispatched_ == false || this.detectAudioMetadataChange(audio_sample)) {
                this.audio_metadata_ = {
                    codec: 'aac',
                    audio_object_type: aac_frame.audio_object_type,
                    sampling_freq_index: aac_frame.sampling_freq_index,
                    sampling_frequency: aac_frame.sampling_frequency,
                    channel_config: aac_frame.channel_config
                };
                // flush stashed frames before notify new AudioSpecificConfig
                this.dispatchAudioMediaSegment(true);
                // notify new AAC AudioSpecificConfig
                this.dispatchAudioInitSegment(audio_sample);
            }

            last_sample_pts_ms = sample_pts_ms;
            let sample_pts_ms_int = Math.floor(sample_pts_ms);

            let aac_sample = {
                unit: aac_frame.data,
                length: aac_frame.data.byteLength,
                pts: sample_pts_ms_int,
                dts: sample_pts_ms_int
            };
            this.audio_track_.samples.push(aac_sample);
            this.audio_track_.length += aac_frame.data.byteLength;

            sample_pts_ms += ref_sample_duration;
        }

        if (loas_parser.hasIncompleteData()) {
            this.aac_last_incomplete_data_ = loas_parser.getIncompleteData();
        }

        if (last_sample_pts_ms) {
            this.audio_last_sample_pts_ = last_sample_pts_ms;
        }
    }

    private parseAC3Payload(data: Uint8Array, pts: number) {
        if (this.has_video_ && !this.video_init_segment_dispatched_) {
            // If first video IDR frame hasn't been detected,
            // Wait for first IDR frame and video init segment being dispatched
            return;
        }

        let ref_sample_duration: number;
        let base_pts_ms: number;

        if (pts != undefined) {
            base_pts_ms = pts / this.timescale_;
        }

        if (this.audio_metadata_.codec === 'ac-3') {
            if (pts == undefined && this.audio_last_sample_pts_ != undefined) {
                ref_sample_duration = 1536 / this.audio_metadata_.sampling_frequency * 1000;
                base_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;
            } else if (pts == undefined){
                Log.w(this.TAG, `AC3: Unknown pts`);
                return;
            }
        }

        let adts_parser = new AC3Parser(data);
        let ac3_frame: AC3Frame = null;
        let sample_pts_ms = base_pts_ms;
        let last_sample_pts_ms: number;

        while ((ac3_frame = adts_parser.readNextAC3Frame()) != null) {
            ref_sample_duration = 1536 / ac3_frame.sampling_frequency * 1000;
            const audio_sample = {
                codec: 'ac-3',
                data: ac3_frame
            } as const;

            if (this.audio_init_segment_dispatched_ == false || this.detectAudioMetadataChange(audio_sample)) {
                this.audio_metadata_ = {
                    codec: 'ac-3',
                    sampling_frequency: ac3_frame.sampling_frequency,
                    bit_stream_identification: ac3_frame.bit_stream_identification,
                    bit_stream_mode: ac3_frame.bit_stream_mode,
                    low_frequency_effects_channel_on: ac3_frame.low_frequency_effects_channel_on,
                    channel_mode: ac3_frame.channel_mode,
                };
                // flush stashed frames before notify new AudioSpecificConfig
                this.dispatchAudioMediaSegment(true);
                // notify new AAC AudioSpecificConfig
                this.dispatchAudioInitSegment(audio_sample);
            }

            last_sample_pts_ms = sample_pts_ms;
            let sample_pts_ms_int = Math.floor(sample_pts_ms);

            let ac3_sample = {
                unit: ac3_frame.data,
                length: ac3_frame.data.byteLength,
                pts: sample_pts_ms_int,
                dts: sample_pts_ms_int
            };

            this.audio_track_.samples.push(ac3_sample);
            this.audio_track_.length += ac3_frame.data.byteLength;

            sample_pts_ms += ref_sample_duration;
        }

        if (last_sample_pts_ms) {
            this.audio_last_sample_pts_ = last_sample_pts_ms;
        }
    }

    private parseEAC3Payload(data: Uint8Array, pts: number) {
        if (this.has_video_ && !this.video_init_segment_dispatched_) {
            // If first video IDR frame hasn't been detected,
            // Wait for first IDR frame and video init segment being dispatched
            return;
        }

        let ref_sample_duration: number;
        let base_pts_ms: number;

        if (pts != undefined) {
            base_pts_ms = pts / this.timescale_;
        }

        if (this.audio_metadata_.codec === 'ec-3') {
            if (pts == undefined && this.audio_last_sample_pts_ != undefined) {
                ref_sample_duration = (256 * this.audio_metadata_.num_blks) / this.audio_metadata_.sampling_frequency * 1000; // TODO: AEC3 BLK
                base_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;
            } else if (pts == undefined){
                Log.w(this.TAG, `EAC3: Unknown pts`);
                return;
            }
        }

        let adts_parser = new EAC3Parser(data);
        let eac3_frame: EAC3Frame = null;
        let sample_pts_ms = base_pts_ms;
        let last_sample_pts_ms: number;

        while ((eac3_frame = adts_parser.readNextEAC3Frame()) != null) {
            ref_sample_duration = 1536 / eac3_frame.sampling_frequency * 1000; // TODO: EAC3 BLK
            const audio_sample = {
                codec: 'ec-3',
                data: eac3_frame
            } as const;

            if (this.audio_init_segment_dispatched_ == false || this.detectAudioMetadataChange(audio_sample)) {
                this.audio_metadata_ = {
                    codec: 'ec-3',
                    sampling_frequency: eac3_frame.sampling_frequency,
                    bit_stream_identification: eac3_frame.bit_stream_identification,
                    low_frequency_effects_channel_on: eac3_frame.low_frequency_effects_channel_on,
                    num_blks: eac3_frame.num_blks,
                    channel_mode: eac3_frame.channel_mode,
                };
                // flush stashed frames before notify new AudioSpecificConfig
                this.dispatchAudioMediaSegment(true);
                // notify new AAC AudioSpecificConfig
                this.dispatchAudioInitSegment(audio_sample);
            }

            last_sample_pts_ms = sample_pts_ms;
            let sample_pts_ms_int = Math.floor(sample_pts_ms);

            let ac3_sample = {
                unit: eac3_frame.data,
                length: eac3_frame.data.byteLength,
                pts: sample_pts_ms_int,
                dts: sample_pts_ms_int
            };

            this.audio_track_.samples.push(ac3_sample);
            this.audio_track_.length += eac3_frame.data.byteLength;

            sample_pts_ms += ref_sample_duration;
        }

        if (last_sample_pts_ms) {
            this.audio_last_sample_pts_ = last_sample_pts_ms;
        }
    }

    private parseOpusPayload(data: Uint8Array, pts: number) {
        if (this.has_video_ && !this.video_init_segment_dispatched_) {
            // If first video IDR frame hasn't been detected,
            // Wait for first IDR frame and video init segment being dispatched
            return;
        }

        if (this.audio_metadata_.codec !== 'opus') {
            return;
        }

        const access_units = parseOpusMPEG2TSAccessUnits(data);
        if (access_units == null) {
            Log.e(this.TAG, `Malformed Opus MPEG-2 TS access unit framing`);
            return;
        }

        let sample_pts_ms: number;
        if (pts != undefined) {
            sample_pts_ms = pts / this.timescale_;
        } else if (this.opus_next_sample_pts_ != undefined) {
            sample_pts_ms = this.opus_next_sample_pts_;
        } else {
            Log.w(this.TAG, `Opus: Unknown pts`);
            return;
        }

        let next_sample_pts_ms = sample_pts_ms;
        const samples = access_units.map((access_unit) => {
            const timestamp = Math.floor(next_sample_pts_ms);
            const sample = {
                unit: access_unit.data,
                length: access_unit.data.byteLength,
                pts: timestamp,
                dts: timestamp,
                duration: access_unit.duration_ms,
                trimStart: access_unit.trim_start,
                trimEnd: access_unit.trim_end
            };
            next_sample_pts_ms += access_unit.duration_ms;
            return sample;
        });

        for (const sample of samples) {
            this.audio_track_.samples.push(sample);
            this.audio_track_.length += sample.length;
        }
        this.audio_last_sample_pts_ = samples[samples.length - 1].pts;
        this.opus_next_sample_pts_ = next_sample_pts_ms;
    }

    private parseMP3Payload(data: Uint8Array, pts: number) {
        if (this.has_video_ && !this.video_init_segment_dispatched_) {
            // If first video IDR frame hasn't been detected,
            // Wait for first IDR frame and video init segment being dispatched
            return;
        }

        let _mpegAudioV10SampleRateTable = [44100, 48000, 32000, 0];
        let _mpegAudioV20SampleRateTable = [22050, 24000, 16000, 0];
        let _mpegAudioV25SampleRateTable = [11025, 12000, 8000,  0];
        let _mpegAudioL1BitRateTable = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1];
        let _mpegAudioL2BitRateTable = [0, 32, 48, 56,  64,  80,  96, 112, 128, 160, 192, 224, 256, 320, 384, -1];
        let _mpegAudioL3BitRateTable = [0, 32, 40, 48,  56,  64,  80,  96, 112, 128, 160, 192, 224, 256, 320, -1];

        let ver = (data[1] >>> 3) & 0x03;
        let layer = (data[1] & 0x06) >> 1;
        let bitrate_index = (data[2] & 0xF0) >>> 4;
        let sampling_freq_index = (data[2] & 0x0C) >>> 2;
        let channel_mode = (data[3] >>> 6) & 0x03;
        let channel_count = channel_mode !== 3 ? 2 : 1;

        let sample_rate = 0;
        let bit_rate = 0;
        let object_type = 34;  // Layer-3, listed in MPEG-4 Audio Object Types

        let codec = 'mp3';
        switch (ver) {
            case 0:  // MPEG 2.5
                sample_rate = _mpegAudioV25SampleRateTable[sampling_freq_index];
                break;
            case 2:  // MPEG 2
                sample_rate = _mpegAudioV20SampleRateTable[sampling_freq_index];
                break;
            case 3:  // MPEG 1
                sample_rate = _mpegAudioV10SampleRateTable[sampling_freq_index];
                break;
        }

        switch (layer) {
            case 1:  // Layer 3
                object_type = 34;
                if (bitrate_index < _mpegAudioL3BitRateTable.length) {
                    bit_rate = _mpegAudioL3BitRateTable[bitrate_index];
                }
                break;
            case 2:  // Layer 2
                object_type = 33;
                if (bitrate_index < _mpegAudioL2BitRateTable.length) {
                    bit_rate = _mpegAudioL2BitRateTable[bitrate_index];
                }
                break;
            case 3:  // Layer 1
                object_type = 32;
                if (bitrate_index < _mpegAudioL1BitRateTable.length) {
                    bit_rate = _mpegAudioL1BitRateTable[bitrate_index];
                }
                break;
        }

        const sample = new MP3Data();
        sample.object_type = object_type;
        sample.sample_rate = sample_rate;
        sample.channel_count = channel_count;
        sample.data = data;
        const audio_sample = {
            codec: 'mp3',
            data: sample
        } as const;


        if (this.audio_init_segment_dispatched_ == false) {
            this.audio_metadata_ = {
                codec: 'mp3',
                object_type,
                sample_rate,
                channel_count
            };
            // flush stashed frames before notify new AudioSpecificConfig
            this.dispatchAudioMediaSegment(true);
            // notify new AAC AudioSpecificConfig
            this.dispatchAudioInitSegment(audio_sample);
        }

        let mp3_sample = {
            unit: data,
            length: data.byteLength,
            pts: pts / this.timescale_,
            dts: pts / this.timescale_
        };
        this.audio_track_.samples.push(mp3_sample);
        this.audio_track_.length += data.byteLength;
    }

    private detectAudioMetadataChange(sample: AudioData): boolean {
        if (sample.codec !== this.audio_metadata_.codec) {
            Log.v(this.TAG, `Audio: Audio Codecs changed from ` +
                                `${this.audio_metadata_.codec} to ${sample.codec}`);
            return true;
        }

        if (sample.codec === 'aac' && this.audio_metadata_.codec === 'aac') {
            const frame = sample.data;
            if (frame.audio_object_type !== this.audio_metadata_.audio_object_type) {
                Log.v(this.TAG, `AAC: AudioObjectType changed from ` +
                                `${this.audio_metadata_.audio_object_type} to ${frame.audio_object_type}`);
                return true;
            }

            if (frame.sampling_freq_index !== this.audio_metadata_.sampling_freq_index) {
                Log.v(this.TAG, `AAC: SamplingFrequencyIndex changed from ` +
                                `${this.audio_metadata_.sampling_freq_index} to ${frame.sampling_freq_index}`);
                return true;
            }

            if (frame.channel_config !== this.audio_metadata_.channel_config) {
                Log.v(this.TAG, `AAC: Channel configuration changed from ` +
                                `${this.audio_metadata_.channel_config} to ${frame.channel_config}`);
                return true;
            }
        } else if (sample.codec === 'ac-3' && this.audio_metadata_.codec === 'ac-3') {
            const frame = sample.data;
            if (frame.sampling_frequency !== this.audio_metadata_.sampling_frequency) {
                Log.v(this.TAG, `AC3: Sampling Frequency changed from ` +
                                `${this.audio_metadata_.sampling_frequency} to ${frame.sampling_frequency}`);
                return true;
            }

            if (frame.bit_stream_identification !== this.audio_metadata_.bit_stream_identification) {
                Log.v(this.TAG, `AC3: Bit Stream Identification changed from ` +
                                `${this.audio_metadata_.bit_stream_identification} to ${frame.bit_stream_identification}`);
                return true;
            }

            if (frame.bit_stream_mode !== this.audio_metadata_.bit_stream_mode) {
                Log.v(this.TAG, `AC3: BitStream Mode changed from ` +
                                `${this.audio_metadata_.bit_stream_mode} to ${frame.bit_stream_mode}`);
                return true;
            }

            if (frame.channel_mode !== this.audio_metadata_.channel_mode) {
                Log.v(this.TAG, `AC3: Channel Mode changed from ` +
                                `${this.audio_metadata_.channel_mode} to ${frame.channel_mode}`);
                return true;
            }

            if (frame.low_frequency_effects_channel_on !== this.audio_metadata_.low_frequency_effects_channel_on) {
                Log.v(this.TAG, `AC3: Low Frequency Effects Channel On changed from ` +
                                `${this.audio_metadata_.low_frequency_effects_channel_on} to ${frame.low_frequency_effects_channel_on}`);
                return true;
            }
        } else if (sample.codec === 'opus' && this.audio_metadata_.codec === 'opus') {
            const data = sample.meta;

            if (data.sample_rate !== this.audio_metadata_.sample_rate) {
                Log.v(this.TAG, `Opus: SamplingFrequencyIndex changed from ` +
                                `${this.audio_metadata_.sample_rate} to ${data.sample_rate}`);
                return true;
            }

            if (data.channel_count !== this.audio_metadata_.channel_count) {
                Log.v(this.TAG, `Opus: Channel count changed from ` +
                                `${this.audio_metadata_.channel_count} to ${data.channel_count}`);
                return true;
            }

            if (data.channel_config_code !== this.audio_metadata_.channel_config_code) {
                Log.v(this.TAG, `Opus: Channel configuration changed from ` +
                                `${this.audio_metadata_.channel_config_code} to ${data.channel_config_code}`);
                return true;
            }
        } else if (sample.codec === 'mp3' && this.audio_metadata_.codec === 'mp3') {
            const data = sample.data;
            if (data.object_type !== this.audio_metadata_.object_type) {
                Log.v(this.TAG, `MP3: AudioObjectType changed from ` +
                                `${this.audio_metadata_.object_type} to ${data.object_type}`);
                return true;
            }

            if (data.sample_rate !== this.audio_metadata_.sample_rate) {
                Log.v(this.TAG, `MP3: SamplingFrequencyIndex changed from ` +
                                `${this.audio_metadata_.sample_rate} to ${data.sample_rate}`);
                return true;
            }

            if (data.channel_count !== this.audio_metadata_.channel_count) {
                Log.v(this.TAG, `MP3: Channel count changed from ` +
                                `${this.audio_metadata_.channel_count} to ${data.channel_count}`);
                return true;
            }
        }

        return false;
    }

    private dispatchAudioInitSegment(sample: AudioData) {
        let meta: any = {};
        meta.type = 'audio';
        meta.id = this.audio_track_.id;
        meta.timescale = 1000;
        meta.duration = this.duration_;

        if (this.audio_metadata_.codec === 'aac') {
            let aac_frame = sample.codec === 'aac' ? sample.data : null;
            let audio_specific_config = new AudioSpecificConfig(aac_frame);

            meta.audioSampleRate = audio_specific_config.sampling_rate;
            meta.channelCount = audio_specific_config.channel_count;
            meta.codec = audio_specific_config.codec_mimetype;
            meta.originalCodec = audio_specific_config.original_codec_mimetype;
            meta.config = audio_specific_config.config;
            meta.refSampleDuration = 1024 / meta.audioSampleRate * meta.timescale;
        } else if (this.audio_metadata_.codec === 'ac-3') {
            let ac3_frame = sample.codec === 'ac-3' ? sample.data : null;
            let ac3_config = new AC3Config(ac3_frame);
            meta.audioSampleRate = ac3_config.sampling_rate
            meta.channelCount = ac3_config.channel_count;
            meta.codec = ac3_config.codec_mimetype;
            meta.originalCodec = ac3_config.original_codec_mimetype;
            meta.config = ac3_config.config;
            meta.refSampleDuration = 1536 / meta.audioSampleRate * meta.timescale;
        } else if (this.audio_metadata_.codec === 'ec-3') {
            let ec3_frame = sample.codec === 'ec-3' ? sample.data : null;
            let ec3_config = new EAC3Config(ec3_frame);
            meta.audioSampleRate = ec3_config.sampling_rate
            meta.channelCount = ec3_config.channel_count;
            meta.codec = ec3_config.codec_mimetype;
            meta.originalCodec = ec3_config.original_codec_mimetype;
            meta.config = ec3_config.config;
            meta.refSampleDuration = (256 * ec3_config.num_blks) / meta.audioSampleRate * meta.timescale; // TODO: blk size
        } else if (this.audio_metadata_.codec === 'opus') {
            meta.audioSampleRate = this.audio_metadata_.sample_rate;
            meta.channelCount = this.audio_metadata_.channel_count;
            meta.channelConfigCode = this.audio_metadata_.channel_config_code;
            meta.codec = 'opus';
            meta.originalCodec = 'opus';
            meta.config = undefined;
            meta.refSampleDuration = 20;
        } else if (this.audio_metadata_.codec === 'mp3') {
            meta.audioSampleRate = this.audio_metadata_.sample_rate;
            meta.channelCount = this.audio_metadata_.channel_count;
            meta.codec = 'mp3';
            meta.originalCodec = 'mp3';
            meta.config = undefined;
        }

        if (this.audio_init_segment_dispatched_ == false) {
            Log.v(this.TAG, `Generated first AudioSpecificConfig for mimeType: ${meta.codec}`);
        }

        this.onTrackMetadata('audio', meta);
        this.audio_init_segment_dispatched_ = true;

        // notify new MediaInfo
        let mi = this.media_info_;
        mi.hasAudio = true;
        mi.audioCodec = meta.originalCodec;
        mi.audioSampleRate = meta.audioSampleRate;
        mi.audioChannelCount = meta.channelCount;

        if (mi.hasVideo && mi.videoCodec) {
            mi.mimeType = `video/mp2t; codecs="${mi.videoCodec},${mi.audioCodec}"`;
        } else {
            mi.mimeType = `video/mp2t; codecs="${mi.audioCodec}"`;
        }

        if (mi.isComplete()) {
            this.onMediaInfo(mi);
        }
    }

    private dispatchPESPrivateDataDescriptor(pid: number, stream_type: number, descriptor: Uint8Array) {
        let desc = new PESPrivateDataDescriptor();
        desc.pid = pid;
        desc.stream_type = stream_type;
        desc.descriptor = descriptor;

        if (this.onPESPrivateDataDescriptor) {
            this.onPESPrivateDataDescriptor(desc);
        }
    }

    private parsePESPrivateDataPayload(data: Uint8Array, pts: number, dts: number, pid: number, stream_id: number) {
        let private_data = new PESPrivateData();

        private_data.pid = pid;
        private_data.stream_id = stream_id;
        private_data.len = data.byteLength;
        private_data.data = data;

        if (pts != undefined) {
            let pts_ms = Math.floor(pts / this.timescale_);
            private_data.pts = pts_ms;
        } else {
            private_data.nearest_pts = this.getNearestTimestampMilliseconds();
        }

        if (dts != undefined) {
            let dts_ms = Math.floor(dts / this.timescale_);
            private_data.dts = dts_ms;
        }

        if (this.onPESPrivateData) {
            this.onPESPrivateData(private_data);
        }
    }

    private parseTimedID3MetadataPayload(data: Uint8Array, pts: number, dts: number, pid: number, stream_id: number) {
        let timed_id3_metadata = new PESPrivateData();

        timed_id3_metadata.pid = pid;
        timed_id3_metadata.stream_id = stream_id;
        timed_id3_metadata.len = data.byteLength;
        timed_id3_metadata.data = data;

        if (pts != undefined) {
            let pts_ms = Math.floor(pts / this.timescale_);
            timed_id3_metadata.pts = pts_ms;
        }

        if (dts != undefined) {
            let dts_ms = Math.floor(dts / this.timescale_);
            timed_id3_metadata.dts = dts_ms;
        }

        if (this.onTimedID3Metadata) {
            this.onTimedID3Metadata(timed_id3_metadata);
        }
    }

    private parsePGSPayload(data: Uint8Array, pts: number, dts: number, pid: number, stream_id: number, lang: string) {
        let pgs_data = new PGSData();

        pgs_data.pid = pid;
        pgs_data.lang = lang;
        pgs_data.stream_id = stream_id;
        pgs_data.len = data.byteLength;
        pgs_data.data = data;

        if (pts != undefined) {
            let pts_ms = Math.floor(pts / this.timescale_);
            pgs_data.pts = pts_ms;
        }

        if (dts != undefined) {
            let dts_ms = Math.floor(dts / this.timescale_);
            pgs_data.dts = dts_ms;
        }

        if (this.onPGSSubtitleData) {
            this.onPGSSubtitleData(pgs_data);
        }
    }

    private parseSynchronousKLVMetadataPayload(data: Uint8Array, pts: number, dts: number, pid: number, stream_id: number) {
        let synchronous_klv_metadata = new KLVData();

        synchronous_klv_metadata.pid = pid;
        synchronous_klv_metadata.stream_id = stream_id;
        synchronous_klv_metadata.len = data.byteLength;
        synchronous_klv_metadata.data = data;

        if (pts != undefined) {
            let pts_ms = Math.floor(pts / this.timescale_);
            synchronous_klv_metadata.pts = pts_ms;
        }

        if (dts != undefined) {
            let dts_ms = Math.floor(dts / this.timescale_);
            synchronous_klv_metadata.dts = dts_ms;
        }

        synchronous_klv_metadata.access_units = klv_parse(data);

        if (this.onSynchronousKLVMetadata) {
            this.onSynchronousKLVMetadata(synchronous_klv_metadata);
        }
    }

    private parseAsynchronousKLVMetadataPayload(data: Uint8Array, pid: number, stream_id: number) {
        let asynchronous_klv_metadata = new PESPrivateData();

        asynchronous_klv_metadata.pid = pid;
        asynchronous_klv_metadata.stream_id = stream_id;
        asynchronous_klv_metadata.len = data.byteLength;
        asynchronous_klv_metadata.data = data;

        if (this.onAsynchronousKLVMetadata) {
            this.onAsynchronousKLVMetadata(asynchronous_klv_metadata);
        }
    }

    private parseSMPTE2038MetadataPayload(data: Uint8Array, pts: number, dts: number, pid: number, stream_id: number) {
        let smpte2038_data = new SMPTE2038Data();

        smpte2038_data.pid = pid;
        smpte2038_data.stream_id = stream_id;
        smpte2038_data.len = data.byteLength;
        smpte2038_data.data = data;

        if (pts != undefined) {
            let pts_ms = Math.floor(pts / this.timescale_);
            smpte2038_data.pts = pts_ms;
        }
        smpte2038_data.nearest_pts = this.getNearestTimestampMilliseconds();

        if (dts != undefined) {
            let dts_ms = Math.floor(dts / this.timescale_);
            smpte2038_data.dts = dts_ms;
        }

        smpte2038_data.ancillaries = smpte2038parse(data);
        if (this.onSMPTE2038Metadata) {
            this.onSMPTE2038Metadata(smpte2038_data);
        }
    }

    private parseSEIPayload(data: Uint8Array, pts: number, codec: 'h264' | 'h265') {
        let timestamp = pts != undefined ? Math.floor(pts / this.timescale_) : undefined;
        let sei_data = parseSEI(data, timestamp, codec);

        if (sei_data && this.onSEI) {
            this.onSEI(sei_data);
        }
    }

    private getNearestTimestampMilliseconds(): number | undefined {
        // Prefer using last audio sample pts if audio track exists
        if (this.audio_last_sample_pts_ != undefined) {
            return Math.floor(this.audio_last_sample_pts_);
        } else if (this.last_pcr_ != undefined) {
            // Fallback to PCR time if audio track doesn't exist
            const pcr_time_ms = Math.floor(this.last_pcr_ / 300 / this.timescale_);
            return pcr_time_ms;
        }
        return undefined;
    }

    private getPcrBase(data: Uint8Array): number {
        let pcr_base = data[6] * 33554432 // 1 << 25
            + data[7] * 131072 // 1 << 17
            + data[8] * 512 // 1 << 9
            + data[9] * 2 // 1 << 1
            + (data[10] & 0x80) / 128 // 1 >> 7
            + this.timestamp_offset_;
        if (pcr_base + 0x100000000 < this.last_pcr_base_) {
            pcr_base += 0x200000000; // pcr_base wraparound
            this.timestamp_offset_ += 0x200000000;
        }
        this.last_pcr_base_ = pcr_base;
        return pcr_base;
    }

    private getTimestamp(data: Uint8Array, pos: number): number {
        let timestamp = (data[pos] & 0x0E) * 536870912 // 1 << 29
            + (data[pos + 1] & 0xFF) * 4194304 // 1 << 22
            + (data[pos + 2] & 0xFE) * 16384 // 1 << 14
            + (data[pos + 3] & 0xFF) * 128 // 1 << 7
            + (data[pos + 4] & 0xFE) / 2
            + this.timestamp_offset_;
        if (timestamp + 0x100000000 < this.last_pcr_base_) {
            timestamp += 0x200000000; // pts/dts wraparound
        }
        return timestamp;
    }

}

export default TSDemuxer;
