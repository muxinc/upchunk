import {
  BufferTarget,
  canEncodeAudio,
  canEncodeVideo,
  Conversion,
  ConversionAudioOptions,
  ConversionVideoOptions,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
} from 'mediabunny';
import type { TranscodeContext, TranscodeFn } from '../upchunk';
import { analyzeMediaSummary } from './conformance';
import { buildConversionPlan, EncoderCapabilities } from './plan';
import { createAbortError, openInput, summarizeInput } from './summary';
import {
  AudioTrackConversion,
  ConformanceReport,
  ConversionPlan,
  MediaSummary,
  MuxTranscodeError,
  MuxTranscoderOptions,
  MuxTranscodeResult,
  NonStandardReason,
  ResolvedMuxTranscoderOptions,
  resolveOptions,
  VideoTrackConversion,
} from './types';

const isAbortError = (error: unknown) =>
  (error as { name?: string } | undefined)?.name === 'AbortError' ||
  (error as { name?: string } | undefined)?.name === 'ConversionCanceledError';

export const defaultEncoderCapabilities = (): EncoderCapabilities => ({
  canEncodeVideo: (codec, options) => canEncodeVideo(codec, options),
  canEncodeAudio: (codec, options) => canEncodeAudio(codec, options),
  mp4AudioCodecs: new Mp4OutputFormat().getSupportedAudioCodecs(),
});

const toVideoOptions = (
  conversion: VideoTrackConversion | undefined
): ConversionVideoOptions => {
  if (!conversion || !conversion.transcode) return {};
  return {
    codec: conversion.codec,
    width: conversion.width,
    height: conversion.height,
    frameRate: conversion.frameRate,
    keyFrameInterval: conversion.keyFrameInterval,
    hardwareAcceleration: conversion.hardwareAcceleration,
    quality: new Quality({ bitrate: conversion.bitrate }),
    forceTranscode: true,
  };
};

const toAudioOptions = (
  conversion: AudioTrackConversion | undefined
): ConversionAudioOptions => {
  if (!conversion || !conversion.transcode) return {};
  return {
    codec: conversion.codec,
    numberOfChannels: conversion.numberOfChannels,
    sampleRate: conversion.sampleRate,
    forceTranscode: true,
  };
};

const replaceExtension = (name: string, extension: string) => {
  const base = name.replace(/\.[^./\\]+$/, '');
  return `${base || 'upload'}.${extension}`;
};

const runConversion = async (
  file: File,
  input: Input,
  plan: ConversionPlan,
  context: TranscodeContext
): Promise<File> => {
  if (context.signal.aborted) throw createAbortError();

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new BufferTarget(),
  });
  const conversion = await Conversion.init({
    input,
    output,
    showWarnings: false,
    video: (track) => toVideoOptions(plan.video.get(track.id)),
    audio: (track) => toAudioOptions(plan.audio.get(track.id)),
  });

  const unexpectedDiscards = conversion.discardedTracks.filter(
    (discarded) =>
      discarded.reason !== 'discarded_by_user' &&
      (plan.video.has(discarded.track.id) ||
        plan.audio.has(discarded.track.id))
  );
  if (!conversion.isValid || unexpectedDiscards.length > 0) {
    await conversion.cancel();
    throw new MuxTranscodeError(
      'conversion_invalid',
      `Unable to convert input: ${unexpectedDiscards
        .map((discarded) => `track ${discarded.track.id} ${discarded.reason}`)
        .join(', ')}`,
      unexpectedDiscards.map((discarded) => discarded.reason)
    );
  }

  conversion.onProgress = (progress) => context.onProgress(progress);
  const onAbort = () => {
    conversion.cancel();
  };
  context.signal.addEventListener('abort', onAbort);
  try {
    await conversion.execute();
  } catch (e) {
    if (isAbortError(e) || context.signal.aborted) throw createAbortError();
    throw new MuxTranscodeError(
      'conversion_failed',
      (e as Error)?.message ?? 'Conversion failed',
      e
    );
  } finally {
    context.signal.removeEventListener('abort', onAbort);
  }
  if (context.signal.aborted) throw createAbortError();

  const buffer = output.target.buffer;
  if (!buffer) {
    throw new MuxTranscodeError(
      'conversion_failed',
      'Conversion produced no output'
    );
  }
  return new File([buffer], replaceExtension(file.name, 'mp4'), {
    type: 'video/mp4',
    lastModified: file.lastModified,
  });
};

const passThrough = (
  file: File,
  reasons: NonStandardReason[],
  notes: string[],
  extra: Partial<MuxTranscodeResult> = {}
): MuxTranscodeResult => ({
  file,
  reasons,
  notes,
  transcoded: false,
  ...extra,
});

export interface FileAnalysis {
  summary: MediaSummary;
  report: ConformanceReport;
}

// Inspects a file and reports how it measures up against the Mux standard input spec,
// without transcoding anything. Useful for showing users what will happen before uploading.
export const analyzeFile = async (
  file: File,
  options: MuxTranscoderOptions = {},
  signal?: AbortSignal
): Promise<FileAnalysis> => {
  const resolved = resolveOptions(options);
  const summary = await summarizeInput(openInput(file), resolved, signal);
  return { summary, report: analyzeMediaSummary(summary, resolved) };
};

export const transcodeForMux = async (
  file: File,
  context: TranscodeContext,
  options: ResolvedMuxTranscoderOptions,
  capabilities: EncoderCapabilities
): Promise<MuxTranscodeResult> => {
  if (file.size > options.maxInputBytes) {
    return passThrough(file, ['too_large_for_in_memory'], []);
  }

  const input = openInput(file);
  const summary = await summarizeInput(input, options, context.signal);
  const report = analyzeMediaSummary(summary, options);
  const details = { summary, report };

  if (summary.container === 'unknown' || !report.needsWork) {
    return passThrough(file, report.reasons, [], details);
  }

  const plan = await buildConversionPlan(report, summary, options, capabilities);
  if (plan.isNoop) {
    return passThrough(file, report.reasons, plan.notes, details);
  }

  context.onProgress(0);
  const transcodedFile = await runConversion(file, input, plan, context);
  return {
    ...details,
    file: transcodedFile,
    transcoded: true,
    reasons: report.reasons,
    notes: plan.notes,
  };
};

export const createMuxTranscoder = (
  options: MuxTranscoderOptions = {},
  capabilities: EncoderCapabilities = defaultEncoderCapabilities()
): TranscodeFn => {
  const resolved = resolveOptions(options);
  return async (file, context) => {
    try {
      return await transcodeForMux(file, context, resolved, capabilities);
    } catch (e) {
      if (isAbortError(e) || context.signal.aborted) throw createAbortError();
      if (!resolved.fallbackToOriginal) throw e;
      console.warn(
        '[upchunk] Client-side transcode failed; uploading the original file instead.',
        e
      );
      return passThrough(file, [], ['transcode_failed_uploading_original'], {
        error: e,
      });
    }
  };
};
