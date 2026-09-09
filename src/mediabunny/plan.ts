import {
  AudioTrackConversion,
  ConformanceReport,
  ConversionPlan,
  MediaSummary,
  MuxTranscodeError,
  ResolvedMuxTranscoderOptions,
  VideoTrackConversion,
} from './types';

export interface EncoderCapabilities {
  canEncodeVideo: (
    codec: 'avc',
    options: { width: number; height: number }
  ) => Promise<boolean>;
  canEncodeAudio: (
    codec: 'aac' | 'opus',
    options: { numberOfChannels: number; sampleRate: number }
  ) => Promise<boolean>;
  mp4AudioCodecs: string[];
}

const planVideoTrack = async (
  report: ConformanceReport,
  trackId: number,
  options: ResolvedMuxTranscoderOptions,
  capabilities: EncoderCapabilities
): Promise<VideoTrackConversion> => {
  const verdict = report.video.find((candidate) => candidate.id === trackId);
  if (!verdict || !verdict.transcode) return { transcode: false };

  if (verdict.reasons.includes('undecodable_source')) {
    throw new MuxTranscodeError(
      'unsupported_encoder',
      'This browser cannot decode the source video track'
    );
  }
  const size = { width: verdict.targetWidth, height: verdict.targetHeight };
  if (!(await capabilities.canEncodeVideo('avc', size))) {
    throw new MuxTranscodeError(
      'unsupported_encoder',
      `This browser cannot encode H.264 at ${size.width}x${size.height}`
    );
  }
  // Only constrain the longer side so mediabunny scales proportionally, which
  // also keeps this correct for sources carrying rotation metadata.
  const resize = !verdict.resize
    ? {}
    : size.width >= size.height
    ? { width: size.width }
    : { height: size.height };
  return {
    ...resize,
    transcode: true,
    codec: 'avc',
    frameRate: verdict.targetFrameRate,
    bitrate: verdict.targetBitrate,
    keyFrameInterval: options.keyFrameInterval,
    hardwareAcceleration: options.hardwareAcceleration,
  };
};

const planAudioTrack = async (
  report: ConformanceReport,
  summary: MediaSummary,
  trackId: number,
  options: ResolvedMuxTranscoderOptions,
  capabilities: EncoderCapabilities,
  notes: string[]
): Promise<AudioTrackConversion> => {
  const verdict = report.audio.find((candidate) => candidate.id === trackId);
  const source = summary.audio.find((candidate) => candidate.id === trackId);
  if (!verdict || !source || !verdict.transcode) return { transcode: false };

  if (verdict.reasons.includes('undecodable_source')) {
    throw new MuxTranscodeError(
      'unsupported_encoder',
      'This browser cannot decode the source audio track'
    );
  }

  const sampleRate = verdict.targetSampleRate;
  const aacConfig = { sampleRate, numberOfChannels: verdict.targetChannels };
  if (await capabilities.canEncodeAudio('aac', aacConfig)) {
    return { transcode: true, codec: 'aac', ...aacConfig };
  }
  if (verdict.targetChannels === 6) {
    const stereo = { sampleRate, numberOfChannels: 2 };
    if (await capabilities.canEncodeAudio('aac', stereo)) {
      notes.push('aac_5_1_encoder_unavailable_using_stereo');
      return { transcode: true, codec: 'aac', ...stereo };
    }
  }
  if (source.codec && capabilities.mp4AudioCodecs.includes(source.codec)) {
    notes.push(`aac_encoder_unavailable_copying_${source.codec}`);
    return { transcode: false };
  }
  if (options.audioFallback === 'opus') {
    const opusConfig = {
      sampleRate: 48000,
      numberOfChannels: Math.min(source.channels, 2),
    };
    if (await capabilities.canEncodeAudio('opus', opusConfig)) {
      notes.push('aac_encoder_unavailable_using_opus');
      return { transcode: true, codec: 'opus', ...opusConfig };
    }
  }
  throw new MuxTranscodeError(
    'unsupported_encoder',
    'This browser cannot encode AAC (or Opus) audio. Consider registering @mediabunny/aac-encoder.'
  );
};

export const buildConversionPlan = async (
  report: ConformanceReport,
  summary: MediaSummary,
  options: ResolvedMuxTranscoderOptions,
  capabilities: EncoderCapabilities
): Promise<ConversionPlan> => {
  const notes: string[] = [];
  const video = new Map<number, VideoTrackConversion>();
  const audio = new Map<number, AudioTrackConversion>();

  for (const track of summary.video) {
    video.set(
      track.id,
      await planVideoTrack(report, track.id, options, capabilities)
    );
  }
  for (const track of summary.audio) {
    audio.set(
      track.id,
      await planAudioTrack(
        report,
        summary,
        track.id,
        options,
        capabilities,
        notes
      )
    );
  }

  const anyTranscode =
    [...video.values()].some((conversion) => conversion.transcode) ||
    [...audio.values()].some((conversion) => conversion.transcode);

  return { video, audio, notes, isNoop: !report.remux && !anyTranscode };
};
