import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
  InputAudioTrack,
  InputVideoTrack,
  IsobmffInputFormat,
} from 'mediabunny';
import type {
  AudioTrackSummary,
  MediaSummary,
  ResolvedMuxTranscoderOptions,
  VideoTrackSummary,
} from './types';

const ABORT_CHECK_INTERVAL = 250;

export const createAbortError = () =>
  new DOMException('The transcode was aborted', 'AbortError');

export const openInput = (file: File) =>
  new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

const swallow = async <T>(
  promise: Promise<T> | T,
  fallback: T
): Promise<T> => {
  try {
    return await promise;
  } catch (e) {
    return fallback;
  }
};

interface GopStats {
  averageBitrate: number | null;
  maxKeyFrameInterval: number | null;
  maxGopBitrate: number | null;
  complete: boolean;
}

// Single metadata-only pass over the packets to find the longest keyframe interval, the
// peak per-GOP bitrate and the average bitrate. Stops early when the scan budget is spent.
const scanPackets = async (
  track: InputVideoTrack,
  options: ResolvedMuxTranscoderOptions,
  signal: AbortSignal | undefined
): Promise<GopStats> => {
  const sink = new EncodedPacketSink(track);
  const budget = options.gopScan;
  const startedAt = performance.now();

  let packetCount = 0;
  let totalBytes = 0;
  let firstTimestamp: number | null = null;
  let lastEnd = 0;
  let lastKeyTimestamp: number | null = null;
  let gopBytes = 0;
  let maxKeyFrameInterval = 0;
  let maxGopBitrate = 0;
  let sawKeyFrame = false;
  let complete = true;

  const closeGop = (end: number) => {
    if (lastKeyTimestamp === null) return;
    const gap = end - lastKeyTimestamp;
    if (gap <= 0) return;
    maxKeyFrameInterval = Math.max(maxKeyFrameInterval, gap);
    maxGopBitrate = Math.max(maxGopBitrate, (gopBytes * 8) / gap);
  };

  for await (const packet of sink.packets(undefined, undefined, {
    metadataOnly: true,
  })) {
    if (signal?.aborted) throw createAbortError();
    packetCount += 1;
    totalBytes += packet.byteLength;
    if (firstTimestamp === null) firstTimestamp = packet.timestamp;
    lastEnd = Math.max(lastEnd, packet.timestamp + packet.duration);

    if (packet.type === 'key') {
      sawKeyFrame = true;
      closeGop(packet.timestamp);
      lastKeyTimestamp = packet.timestamp;
      gopBytes = 0;
    }
    gopBytes += packet.byteLength;

    if (packetCount % ABORT_CHECK_INTERVAL === 0) {
      const scannedSeconds = lastEnd - (firstTimestamp ?? 0);
      if (
        packetCount >= budget.maxPackets ||
        scannedSeconds >= budget.maxSeconds ||
        performance.now() - startedAt >= budget.timeBudgetMs
      ) {
        complete = false;
        break;
      }
    }
  }

  if (complete) closeGop(lastEnd);

  const span = lastEnd - (firstTimestamp ?? 0);
  return {
    complete,
    averageBitrate: span > 0 ? (totalBytes * 8) / span : null,
    maxKeyFrameInterval: sawKeyFrame ? maxKeyFrameInterval : null,
    maxGopBitrate: sawKeyFrame ? maxGopBitrate : null,
  };
};

const summarizeVideoTrack = async (
  track: InputVideoTrack,
  options: ResolvedMuxTranscoderOptions,
  signal: AbortSignal | undefined
): Promise<VideoTrackSummary> => {
  const codec = await swallow(track.getCodec(), null);
  const frameRateMetrics = await swallow(track.computeFrameRateMetrics(), null);
  const gop = await scanPackets(track, options, signal);

  return {
    codec,
    id: track.id,
    codecString: await swallow(track.getCodecParameterString(), null),
    codedWidth: await track.getCodedWidth(),
    codedHeight: await track.getCodedHeight(),
    displayWidth: await track.getDisplayWidth(),
    displayHeight: await track.getDisplayHeight(),
    rotation: await track.getRotation(),
    frameRate: frameRateMetrics?.bestGuessFrameRate ?? null,
    averageBitrate: gop.averageBitrate,
    maxKeyFrameInterval: gop.maxKeyFrameInterval,
    maxGopBitrate: gop.maxGopBitrate,
    gopScanComplete: gop.complete,
    hdr: await swallow(track.hasHighDynamicRange(), false),
    canDecode: await swallow(track.canDecode(), false),
  };
};

const summarizeAudioTrack = async (
  track: InputAudioTrack
): Promise<AudioTrackSummary> => ({
  id: track.id,
  codec: await swallow(track.getCodec(), null),
  codecString: await swallow(track.getCodecParameterString(), null),
  channels: await track.getNumberOfChannels(),
  sampleRate: await track.getSampleRate(),
  canDecode: await swallow(track.canDecode(), false),
});

export const summarizeInput = async (
  input: Input,
  options: ResolvedMuxTranscoderOptions,
  signal?: AbortSignal
): Promise<MediaSummary> => {
  let format;
  try {
    format = await input.getFormat();
  } catch (e) {
    return {
      container: 'unknown',
      isIsobmff: false,
      durationSeconds: null,
      video: [],
      audio: [],
    };
  }

  const videoTracks = await input.getVideoTracks();
  const audioTracks = await input.getAudioTracks();
  const video: VideoTrackSummary[] = [];
  for (const track of videoTracks) {
    video.push(await summarizeVideoTrack(track, options, signal));
  }
  const audio: AudioTrackSummary[] = [];
  for (const track of audioTracks) {
    audio.push(await summarizeAudioTrack(track));
  }

  return {
    video,
    audio,
    container: format.name,
    isIsobmff: format instanceof IsobmffInputFormat,
    durationSeconds: await swallow(input.computeDuration(), null),
  };
};
