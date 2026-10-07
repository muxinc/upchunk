import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  EncodedPacketSink,
  Input,
  MkvOutputFormat,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from 'mediabunny';

export interface FixtureOptions {
  format: 'webm' | 'mkv' | 'mp4';
  videoCodec?: 'vp9' | 'avc';
  audioCodec?: 'opus' | 'aac';
  seconds?: number;
  fps?: number;
  keyFrameInterval?: number;
  name?: string;
}

const MIME_TYPES = {
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp4: 'video/mp4',
};

const outputFormatFor = (format: FixtureOptions['format']) => {
  if (format === 'webm') return new WebMOutputFormat();
  if (format === 'mkv') return new MkvOutputFormat();
  return new Mp4OutputFormat({ fastStart: false });
};

export const makeFixture = async ({
  format,
  videoCodec = 'avc',
  audioCodec,
  seconds = 2,
  fps = 10,
  keyFrameInterval = 1,
  name = `fixture.${format}`,
}: FixtureOptions): Promise<File> => {
  const canvas = new OffscreenCanvas(64, 64);
  const ctx = canvas.getContext('2d')!;
  const output = new Output({
    format: outputFormatFor(format),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, {
    codec: videoCodec,
    bitrate: 200_000,
    keyFrameInterval,
  });
  output.addVideoTrack(videoSource);

  let audioSource: AudioBufferSource | undefined;
  if (audioCodec) {
    audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 64_000 });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  const frameCount = Math.round(seconds * fps);
  for (let i = 0; i < frameCount; i += 1) {
    ctx.fillStyle = `hsl(${(i * 37) % 360}, 80%, 50%)`;
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#fff';
    ctx.fillRect((i * 7) % 56, (i * 11) % 56, 8, 8);
    await videoSource.add(i / fps, 1 / fps);
  }
  videoSource.close();

  if (audioSource) {
    const sampleRate = 48000;
    const buffer = new AudioBuffer({
      sampleRate,
      length: Math.round(sampleRate * seconds),
      numberOfChannels: 2,
    });
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) {
        data[i] = Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 0.2;
      }
    }
    await audioSource.add(buffer);
    audioSource.close();
  }

  await output.finalize();
  return new File([output.target.buffer!], name, { type: MIME_TYPES[format] });
};

export interface Inspection {
  container: string;
  videoCodec: string | null;
  audioCodec: string | null;
  maxKeyFrameInterval: number;
  firstVideoPacketByteLength: number;
  width: number;
  height: number;
}

export const inspectFile = async (file: File): Promise<Inspection> => {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const format = await input.getFormat();
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();

  let maxKeyFrameInterval = 0;
  let firstVideoPacketByteLength = 0;
  if (video) {
    const sink = new EncodedPacketSink(video);
    let lastKey: number | null = null;
    let lastEnd = 0;
    let first = true;
    for await (const packet of sink.packets(undefined, undefined, {
      metadataOnly: true,
    })) {
      if (first) {
        firstVideoPacketByteLength = packet.byteLength;
        first = false;
      }
      lastEnd = Math.max(lastEnd, packet.timestamp + packet.duration);
      if (packet.type === 'key') {
        if (lastKey !== null) {
          maxKeyFrameInterval = Math.max(
            maxKeyFrameInterval,
            packet.timestamp - lastKey
          );
        }
        lastKey = packet.timestamp;
      }
    }
    if (lastKey !== null) {
      maxKeyFrameInterval = Math.max(maxKeyFrameInterval, lastEnd - lastKey);
    }
  }

  return {
    maxKeyFrameInterval,
    firstVideoPacketByteLength,
    container: format.name,
    videoCodec: video ? await video.getCodec() : null,
    audioCodec: audio ? await audio.getCodec() : null,
    width: video ? await video.getCodedWidth() : 0,
    height: video ? await video.getCodedHeight() : 0,
  };
};
