import type { TranscodeResult } from '../upchunk';

export type MaxResolutionTier = '1080p' | '2160p';

// Reason codes mirror the keys Mux reports in `non_standard_input_reasons`, plus a few
// client-only codes for things we detect but Mux never sees.
export type NonStandardReason =
  | 'container'
  | 'video_codec'
  | 'unsupported_pixel_format'
  | 'video_resolution'
  | 'video_frame_rate'
  | 'video_gop_size'
  | 'video_bitrate'
  | 'audio_codec'
  | 'audio_channels'
  | 'duration'
  | 'undecodable_source'
  | 'unrecognized_input'
  | 'too_large_for_in_memory';

export interface VideoTrackSummary {
  id: number;
  codec: string | null;
  codecString: string | null;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  frameRate: number | null;
  averageBitrate: number | null;
  maxKeyFrameInterval: number | null;
  maxGopBitrate: number | null;
  gopScanComplete: boolean;
  hdr: boolean;
  canDecode: boolean;
}

export interface AudioTrackSummary {
  id: number;
  codec: string | null;
  codecString: string | null;
  channels: number;
  sampleRate: number;
  canDecode: boolean;
}

export interface MediaSummary {
  container: string;
  isIsobmff: boolean;
  durationSeconds: number | null;
  video: VideoTrackSummary[];
  audio: AudioTrackSummary[];
}

export interface VideoTrackVerdict {
  id: number;
  transcode: boolean;
  reasons: NonStandardReason[];
  targetWidth: number;
  targetHeight: number;
  resize: boolean;
  targetFrameRate?: number;
  targetBitrate: number;
}

export interface AudioTrackVerdict {
  id: number;
  transcode: boolean;
  reasons: NonStandardReason[];
  targetChannels: number;
  targetSampleRate: number;
}

export interface ConformanceReport {
  tier: MaxResolutionTier;
  standard: boolean;
  needsWork: boolean;
  remux: boolean;
  reasons: NonStandardReason[];
  video: VideoTrackVerdict[];
  audio: AudioTrackVerdict[];
}

export interface GopScanOptions {
  maxPackets?: number;
  maxSeconds?: number;
  timeBudgetMs?: number;
}

export interface MuxTranscoderOptions {
  maxResolutionTier?: MaxResolutionTier;
  mode?: 'auto' | 'always';
  keyFrameInterval?: number;
  videoBitrate?: number;
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  audioFallback?: 'opus' | 'none';
  fallbackToOriginal?: boolean;
  maxInputBytes?: number;
  gopScan?: GopScanOptions;
}

export type ResolvedMuxTranscoderOptions = Required<
  Omit<MuxTranscoderOptions, 'videoBitrate' | 'gopScan'>
> & {
  videoBitrate?: number;
  gopScan: Required<GopScanOptions>;
};

export const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;

export const resolveOptions = (
  options: MuxTranscoderOptions = {}
): ResolvedMuxTranscoderOptions => ({
  maxResolutionTier: options.maxResolutionTier ?? '1080p',
  mode: options.mode ?? 'auto',
  keyFrameInterval: options.keyFrameInterval ?? 5,
  videoBitrate: options.videoBitrate,
  hardwareAcceleration: options.hardwareAcceleration ?? 'no-preference',
  audioFallback: options.audioFallback ?? 'opus',
  fallbackToOriginal: options.fallbackToOriginal ?? true,
  maxInputBytes: options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
  gopScan: {
    maxPackets: options.gopScan?.maxPackets ?? 60000,
    maxSeconds: options.gopScan?.maxSeconds ?? 600,
    timeBudgetMs: options.gopScan?.timeBudgetMs ?? 3000,
  },
});

export type VideoTrackConversion =
  | { transcode: false }
  | {
      transcode: true;
      codec: 'avc';
      width?: number;
      height?: number;
      frameRate?: number;
      bitrate: number;
      keyFrameInterval: number;
      hardwareAcceleration: 'no-preference' | 'prefer-hardware' | 'prefer-software';
    };

export type AudioTrackConversion =
  | { transcode: false }
  | {
      transcode: true;
      codec: 'aac' | 'opus';
      numberOfChannels: number;
      sampleRate: number;
    };

export interface ConversionPlan {
  video: Map<number, VideoTrackConversion>;
  audio: Map<number, AudioTrackConversion>;
  notes: string[];
  isNoop: boolean;
}

export interface MuxTranscodeResult extends TranscodeResult {
  reasons: NonStandardReason[];
  notes: string[];
  report?: ConformanceReport;
  summary?: MediaSummary;
}

export type MuxTranscodeErrorCode =
  | 'unsupported_encoder'
  | 'conversion_invalid'
  | 'conversion_failed';

export class MuxTranscodeError extends Error {
  constructor(
    public readonly code: MuxTranscodeErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'MuxTranscodeError';
  }
}
