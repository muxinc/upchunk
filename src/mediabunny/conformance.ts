import type {
  AudioTrackSummary,
  AudioTrackVerdict,
  ConformanceReport,
  MaxResolutionTier,
  MediaSummary,
  NonStandardReason,
  ResolvedMuxTranscoderOptions,
  VideoTrackSummary,
  VideoTrackVerdict,
} from './types';

export const MAX_DURATION_SECONDS = 12 * 60 * 60;
const MIN_TARGET_BITRATE = 1e6;
const BITRATE_HEADROOM = 0.85;
// Rough bits-per-pixel-per-frame used to estimate a sane H.264 bitrate when the source
// bitrate could not be measured.
const FALLBACK_BITS_PER_PIXEL = 0.1;
const FALLBACK_FRAME_RATE = 30;
// H.264 needs more bits than these codecs for comparable quality.
const CODEC_EFFICIENCY_VS_AVC: Record<string, number> = {
  av1: 1.5,
  hevc: 1.4,
  vp9: 1.3,
};
const STANDARD_AUDIO_CHANNEL_COUNTS = [1, 2, 6];
const STANDARD_VIDEO_CODECS = ['avc', 'hevc'];
// 8-bit 4:2:0 AVC profiles: Baseline, Main, Extended, High
const STANDARD_AVC_PROFILES = [66, 77, 88, 100];
// HEVC Main and Main 10 (10-bit 4:2:0 is allowed for HEVC)
const STANDARD_HEVC_PROFILES = [1, 2];

export interface TierLimits {
  maxDimension: number;
  maxAverageBitrate: number;
  maxGopBitrate: number | null;
  maxKeyFrameInterval: { avc: number; hevc: number };
  minFrameRate: number;
  maxFrameRate: number;
}

export const TIER_LIMITS: Record<MaxResolutionTier, TierLimits> = {
  '1080p': {
    maxDimension: 2048,
    maxAverageBitrate: 8e6,
    maxGopBitrate: 16e6,
    maxKeyFrameInterval: { avc: 20, hevc: 10 },
    minFrameRate: 5,
    maxFrameRate: 120,
  },
  '2160p': {
    maxDimension: 4096,
    maxAverageBitrate: 20e6,
    maxGopBitrate: null,
    maxKeyFrameInterval: { avc: 10, hevc: 6 },
    minFrameRate: 5,
    maxFrameRate: 60,
  },
};

export interface VideoProfile {
  family: 'avc' | 'hevc' | 'other';
  profile: number | null;
}

// Parses the profile out of a WebCodecs codec string, e.g. `avc1.640028` (High) or
// `hvc1.2.4.L120.B0` (Main 10). Returns a null profile when it cannot be determined.
export const parseVideoProfile = (
  codecString: string | null | undefined
): VideoProfile => {
  if (!codecString) return { family: 'other', profile: null };
  const [prefix, ...rest] = codecString.split('.');
  if (prefix === 'avc1' || prefix === 'avc3') {
    const profileHex = rest[0]?.slice(0, 2);
    const profile = profileHex ? parseInt(profileHex, 16) : NaN;
    return { family: 'avc', profile: Number.isNaN(profile) ? null : profile };
  }
  if (prefix === 'hvc1' || prefix === 'hev1') {
    const profileToken = (rest[0] ?? '').replace(/^[ABC]/, '');
    const profile = parseInt(profileToken, 10);
    return { family: 'hevc', profile: Number.isNaN(profile) ? null : profile };
  }
  return { family: 'other', profile: null };
};

const hasStandardPixelFormat = (video: VideoTrackSummary): boolean => {
  const { family, profile } = parseVideoProfile(video.codecString);
  if (profile === null) return true;
  if (family === 'avc') return STANDARD_AVC_PROFILES.includes(profile);
  if (family === 'hevc') return STANDARD_HEVC_PROFILES.includes(profile);
  return true;
};

const toEven = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

const fitWithinDimension = (
  width: number,
  height: number,
  maxDimension: number
): { width: number; height: number } => {
  const longestSide = Math.max(width, height);
  if (longestSide <= maxDimension) {
    return { width: toEven(width), height: toEven(height) };
  }
  const scale = maxDimension / longestSide;
  return {
    width: toEven(width * scale),
    height: toEven(height * scale),
  };
};

const chooseTargetBitrate = (
  video: VideoTrackSummary,
  target: { width: number; height: number },
  limits: TierLimits,
  override: number | undefined
): number => {
  if (override) return override;
  const cap = limits.maxAverageBitrate * BITRATE_HEADROOM;
  const sourcePixels = Math.max(1, video.codedWidth * video.codedHeight);
  const pixelRatio = Math.min(1, (target.width * target.height) / sourcePixels);
  const sourceBitrate =
    video.averageBitrate ??
    sourcePixels * (video.frameRate ?? FALLBACK_FRAME_RATE) * FALLBACK_BITS_PER_PIXEL;
  const efficiency = CODEC_EFFICIENCY_VS_AVC[video.codec ?? ''] ?? 1;
  const base = Math.min(sourceBitrate * efficiency, cap);
  return Math.round(
    Math.min(cap, Math.max(MIN_TARGET_BITRATE, base * pixelRatio))
  );
};

const analyzeVideoTrack = (
  video: VideoTrackSummary,
  limits: TierLimits,
  options: ResolvedMuxTranscoderOptions
): VideoTrackVerdict => {
  const reasons: NonStandardReason[] = [];
  const codecIsStandard =
    !!video.codec && STANDARD_VIDEO_CODECS.includes(video.codec);

  if (!codecIsStandard) {
    reasons.push('video_codec');
  } else if (!hasStandardPixelFormat(video)) {
    reasons.push('unsupported_pixel_format');
  }

  // mediabunny sizes the rotated, square-pixel frame, which is what the display
  // dimensions describe. Coded dimensions are what Mux measures, so check both.
  const displayWidth = video.displayWidth || video.codedWidth;
  const displayHeight = video.displayHeight || video.codedHeight;
  const target = fitWithinDimension(
    displayWidth,
    displayHeight,
    limits.maxDimension
  );
  const longestSide = Math.max(
    video.codedWidth,
    video.codedHeight,
    displayWidth,
    displayHeight
  );
  const resize = longestSide > limits.maxDimension;
  if (resize) {
    reasons.push('video_resolution');
  }

  let targetFrameRate: number | undefined;
  if (video.frameRate !== null) {
    if (video.frameRate > limits.maxFrameRate) {
      reasons.push('video_frame_rate');
      targetFrameRate = limits.maxFrameRate;
    } else if (video.frameRate < limits.minFrameRate) {
      // Report-only: duplicating frames to reach 5 fps is not worth the bytes.
      reasons.push('video_frame_rate');
    }
  }

  if (codecIsStandard && video.maxKeyFrameInterval !== null) {
    const codecLimit =
      video.codec === 'hevc'
        ? limits.maxKeyFrameInterval.hevc
        : limits.maxKeyFrameInterval.avc;
    if (video.maxKeyFrameInterval > codecLimit) {
      reasons.push('video_gop_size');
    }
  }

  const overAverageBitrate =
    video.averageBitrate !== null &&
    video.averageBitrate > limits.maxAverageBitrate;
  const overGopBitrate =
    limits.maxGopBitrate !== null &&
    video.maxGopBitrate !== null &&
    video.maxGopBitrate > limits.maxGopBitrate;
  if (overAverageBitrate || overGopBitrate) {
    reasons.push('video_bitrate');
  }

  const fixableReasons = reasons.filter(
    (reason) =>
      reason !== 'video_frame_rate' ||
      (video.frameRate !== null && video.frameRate > limits.maxFrameRate)
  );
  const transcode = options.mode === 'always' || fixableReasons.length > 0;

  if (transcode && !video.canDecode) {
    reasons.push('undecodable_source');
  }

  return {
    transcode,
    reasons,
    resize,
    targetFrameRate,
    id: video.id,
    targetWidth: target.width,
    targetHeight: target.height,
    targetBitrate: chooseTargetBitrate(
      video,
      target,
      limits,
      options.videoBitrate
    ),
  };
};

const analyzeAudioTrack = (
  audio: AudioTrackSummary,
  options: ResolvedMuxTranscoderOptions
): AudioTrackVerdict => {
  const reasons: NonStandardReason[] = [];
  if (audio.codec !== 'aac') {
    reasons.push('audio_codec');
  }
  let targetChannels = audio.channels;
  if (!STANDARD_AUDIO_CHANNEL_COUNTS.includes(audio.channels)) {
    reasons.push('audio_channels');
    targetChannels = audio.channels > 6 ? 6 : 2;
  }
  const transcode = options.mode === 'always' || reasons.length > 0;
  if (transcode && !audio.canDecode) {
    reasons.push('undecodable_source');
  }
  return {
    transcode,
    reasons,
    targetChannels,
    id: audio.id,
    targetSampleRate: Math.min(audio.sampleRate || 48000, 48000),
  };
};

export const analyzeMediaSummary = (
  summary: MediaSummary,
  options: ResolvedMuxTranscoderOptions
): ConformanceReport => {
  const tier = options.maxResolutionTier;
  const limits = TIER_LIMITS[tier];
  const reasons = new Set<NonStandardReason>();

  if (summary.container === 'unknown') {
    return {
      tier,
      standard: false,
      needsWork: false,
      remux: false,
      reasons: ['unrecognized_input'],
      video: [],
      audio: [],
    };
  }

  const remux = !summary.isIsobmff;
  if (remux) reasons.add('container');

  if (
    summary.durationSeconds !== null &&
    summary.durationSeconds > MAX_DURATION_SECONDS
  ) {
    reasons.add('duration');
  }

  const video = summary.video.map((track) =>
    analyzeVideoTrack(track, limits, options)
  );
  const audio = summary.audio.map((track) => analyzeAudioTrack(track, options));
  [...video, ...audio].forEach((verdict) =>
    verdict.reasons.forEach((reason) => reasons.add(reason))
  );

  const needsWork =
    remux ||
    video.some((verdict) => verdict.transcode) ||
    audio.some((verdict) => verdict.transcode);

  return {
    tier,
    needsWork,
    remux,
    video,
    audio,
    standard: reasons.size === 0,
    reasons: [...reasons],
  };
};
