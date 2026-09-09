import { expect } from '@open-wc/testing';
import {
  analyzeMediaSummary,
  buildConversionPlan,
  MuxTranscodeError,
  resolveOptions,
} from '../../src/mediabunny/index';
import type {
  EncoderCapabilities,
  MediaSummary,
  MuxTranscoderOptions,
} from '../../src/mediabunny/index';

const summary = (
  videoCodec: string,
  audioCodec: string,
  channels = 2
): MediaSummary => ({
  container: 'WebM',
  isIsobmff: false,
  durationSeconds: 10,
  video: [
    {
      id: 1,
      codec: videoCodec,
      codecString: null,
      codedWidth: 1280,
      codedHeight: 720,
      displayWidth: 1280,
      displayHeight: 720,
      rotation: 0,
      frameRate: 30,
      averageBitrate: 2e6,
      maxKeyFrameInterval: null,
      maxGopBitrate: null,
      gopScanComplete: false,
      hdr: false,
      canDecode: true,
    },
  ],
  audio: [
    {
      id: 2,
      channels,
      codec: audioCodec,
      codecString: null,
      sampleRate: 48000,
      canDecode: true,
    },
  ],
});

const capabilities = ({
  video = true,
  aac = true,
  aacSurround = aac,
  opus = true,
}: { video?: boolean; aac?: boolean; aacSurround?: boolean; opus?: boolean } = {}): EncoderCapabilities => ({
  canEncodeVideo: async () => video,
  canEncodeAudio: async (codec, { numberOfChannels }) => {
    if (codec === 'opus') return opus;
    return numberOfChannels > 2 ? aacSurround : aac;
  },
  mp4AudioCodecs: ['aac', 'opus', 'mp3', 'flac'],
});

const plan = (
  mediaSummary: MediaSummary,
  caps: EncoderCapabilities,
  options: MuxTranscoderOptions = {}
) => {
  const resolved = resolveOptions(options);
  const report = analyzeMediaSummary(mediaSummary, resolved);
  return buildConversionPlan(report, mediaSummary, resolved, caps);
};

describe('buildConversionPlan', () => {
  it('transcodes offending tracks to avc and aac when encoders are available', async () => {
    const result = await plan(summary('vp9', 'vorbis'), capabilities());
    expect(result.video.get(1)).to.deep.include({ transcode: true, codec: 'avc', keyFrameInterval: 5 });
    expect(result.video.get(1)).to.not.have.any.keys('width', 'height');
    expect(result.audio.get(2)).to.deep.include({ transcode: true, codec: 'aac', numberOfChannels: 2 });
    expect(result.isNoop).to.be.false;
    expect(result.notes).to.deep.equal([]);
  });

  it('constrains only the longer side when downscaling', async () => {
    const landscape = summary('avc', 'aac');
    Object.assign(landscape.video[0], { codedWidth: 3840, codedHeight: 2160, displayWidth: 3840, displayHeight: 2160 });
    const result = await plan(landscape, capabilities());
    expect(result.video.get(1)).to.deep.include({ transcode: true, width: 2048 });
    expect(result.video.get(1)).to.not.have.property('height');

    const portrait = summary('avc', 'aac');
    Object.assign(portrait.video[0], { codedWidth: 3840, codedHeight: 2160, displayWidth: 2160, displayHeight: 3840, rotation: 90 });
    const portraitPlan = await plan(portrait, capabilities());
    expect(portraitPlan.video.get(1)).to.deep.include({ transcode: true, height: 2048 });
    expect(portraitPlan.video.get(1)).to.not.have.property('width');
  });

  it('copies conforming tracks', async () => {
    const result = await plan(summary('avc', 'aac'), capabilities());
    expect(result.video.get(1)).to.deep.equal({ transcode: false });
    expect(result.audio.get(2)).to.deep.equal({ transcode: false });
    expect(result.isNoop).to.be.false; // WebM still needs a remux
  });

  it('copies MP4-compatible audio when AAC cannot be encoded', async () => {
    const result = await plan(summary('avc', 'opus'), capabilities({ aac: false }));
    expect(result.audio.get(2)).to.deep.equal({ transcode: false });
    expect(result.notes).to.deep.equal(['aac_encoder_unavailable_copying_opus']);
  });

  it('falls back to opus when AAC cannot be encoded and the source cannot be copied', async () => {
    const result = await plan(summary('avc', 'vorbis'), capabilities({ aac: false }));
    expect(result.audio.get(2)).to.deep.include({ transcode: true, codec: 'opus', numberOfChannels: 2, sampleRate: 48000 });
    expect(result.notes).to.deep.equal(['aac_encoder_unavailable_using_opus']);
  });

  it('downmixes to stereo AAC when 5.1 AAC cannot be encoded', async () => {
    const result = await plan(summary('avc', 'vorbis', 6), capabilities({ aacSurround: false }));
    expect(result.audio.get(2)).to.deep.include({ transcode: true, codec: 'aac', numberOfChannels: 2 });
    expect(result.notes).to.deep.equal(['aac_5_1_encoder_unavailable_using_stereo']);
  });

  it('throws when no audio encoder is usable and opus fallback is disabled', async () => {
    let error: unknown;
    try {
      await plan(summary('avc', 'vorbis'), capabilities({ aac: false }), { audioFallback: 'none' });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(MuxTranscodeError);
    expect((error as MuxTranscodeError).code).to.equal('unsupported_encoder');
  });

  it('throws when H.264 cannot be encoded', async () => {
    let error: unknown;
    try {
      await plan(summary('vp9', 'aac'), capabilities({ video: false }));
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(MuxTranscodeError);
    expect((error as MuxTranscodeError).code).to.equal('unsupported_encoder');
  });

  it('is a no-op when nothing needs transcoding and no remux is required', async () => {
    const isobmff = { ...summary('avc', 'opus'), container: 'MP4', isIsobmff: true };
    const result = await plan(isobmff, capabilities({ aac: false }));
    expect(result.isNoop).to.be.true;
  });
});
