import { expect } from '@open-wc/testing';
import {
  analyzeMediaSummary,
  parseVideoProfile,
  resolveOptions,
} from '../../src/mediabunny/index';
import type {
  AudioTrackSummary,
  MediaSummary,
  VideoTrackSummary,
} from '../../src/mediabunny/index';

const video = (overrides: Partial<VideoTrackSummary> = {}): VideoTrackSummary => ({
  id: 1,
  codec: 'avc',
  codecString: 'avc1.640028',
  codedWidth: 1920,
  codedHeight: 1080,
  displayWidth: overrides.codedWidth ?? 1920,
  displayHeight: overrides.codedHeight ?? 1080,
  rotation: 0,
  frameRate: 30,
  averageBitrate: 5e6,
  maxKeyFrameInterval: 2,
  maxGopBitrate: 7e6,
  gopScanComplete: true,
  hdr: false,
  canDecode: true,
  ...overrides,
});

const audio = (overrides: Partial<AudioTrackSummary> = {}): AudioTrackSummary => ({
  id: 2,
  codec: 'aac',
  codecString: 'mp4a.40.2',
  channels: 2,
  sampleRate: 48000,
  canDecode: true,
  ...overrides,
});

const summary = (overrides: Partial<MediaSummary> = {}): MediaSummary => ({
  container: 'MP4',
  isIsobmff: true,
  durationSeconds: 60,
  video: [video()],
  audio: [audio()],
  ...overrides,
});

const analyze = (
  mediaSummary: MediaSummary,
  options: Parameters<typeof resolveOptions>[0] = {}
) => analyzeMediaSummary(mediaSummary, resolveOptions(options));

describe('parseVideoProfile', () => {
  it('parses AVC profiles from the codec string', () => {
    expect(parseVideoProfile('avc1.640028')).to.deep.equal({ family: 'avc', profile: 100 });
    expect(parseVideoProfile('avc1.4d401f')).to.deep.equal({ family: 'avc', profile: 77 });
    expect(parseVideoProfile('avc1.6e0028')).to.deep.equal({ family: 'avc', profile: 110 });
  });

  it('parses HEVC profiles from the codec string', () => {
    expect(parseVideoProfile('hvc1.1.6.L93.B0')).to.deep.equal({ family: 'hevc', profile: 1 });
    expect(parseVideoProfile('hvc1.2.4.L120.B0')).to.deep.equal({ family: 'hevc', profile: 2 });
    expect(parseVideoProfile('hev1.A4.10.L120.B0')).to.deep.equal({ family: 'hevc', profile: 4 });
  });

  it('returns an unknown profile for other codecs or garbage', () => {
    expect(parseVideoProfile('vp09.00.10.08')).to.deep.equal({ family: 'other', profile: null });
    expect(parseVideoProfile(null)).to.deep.equal({ family: 'other', profile: null });
  });
});

describe('analyzeMediaSummary', () => {
  it('reports a conforming MP4 as standard with nothing to do', () => {
    const report = analyze(summary());
    expect(report.standard).to.be.true;
    expect(report.needsWork).to.be.false;
    expect(report.remux).to.be.false;
    expect(report.reasons).to.deep.equal([]);
    expect(report.video[0].transcode).to.be.false;
    expect(report.audio[0].transcode).to.be.false;
  });

  it('reports unrecognized containers without attempting any work', () => {
    const report = analyze(summary({ container: 'unknown', video: [], audio: [] }));
    expect(report.reasons).to.deep.equal(['unrecognized_input']);
    expect(report.needsWork).to.be.false;
  });

  it('only remuxes a conforming file in a non-ISOBMFF container', () => {
    const report = analyze(summary({ container: 'Matroska', isIsobmff: false }));
    expect(report.reasons).to.deep.equal(['container']);
    expect(report.remux).to.be.true;
    expect(report.needsWork).to.be.true;
    expect(report.video[0].transcode).to.be.false;
    expect(report.audio[0].transcode).to.be.false;
  });

  it('flags non-standard video codecs', () => {
    const report = analyze(summary({ video: [video({ codec: 'vp9', codecString: 'vp09.00.10.08' })] }));
    expect(report.video[0].reasons).to.deep.equal(['video_codec']);
    expect(report.video[0].transcode).to.be.true;
  });

  it('flags 10-bit AVC as an unsupported pixel format', () => {
    const report = analyze(summary({ video: [video({ codecString: 'avc1.6e0028' })] }));
    expect(report.video[0].reasons).to.deep.equal(['unsupported_pixel_format']);
  });

  it('accepts HEVC Main 10', () => {
    const report = analyze(summary({ video: [video({ codec: 'hevc', codecString: 'hvc1.2.4.L120.B0' })] }));
    expect(report.standard).to.be.true;
  });

  it('applies codec-specific keyframe interval limits', () => {
    const avc = analyze(summary({ video: [video({ maxKeyFrameInterval: 12 })] }));
    expect(avc.video[0].reasons).to.deep.equal([]);
    const hevc = analyze(
      summary({ video: [video({ codec: 'hevc', codecString: 'hvc1.1.6.L93.B0', maxKeyFrameInterval: 12 })] })
    );
    expect(hevc.video[0].reasons).to.deep.equal(['video_gop_size']);
  });

  it('flags a keyframe interval over the tier limit', () => {
    const report = analyze(summary({ video: [video({ maxKeyFrameInterval: 25 })] }));
    expect(report.video[0].reasons).to.deep.equal(['video_gop_size']);
    const report4k = analyze(summary({ video: [video({ maxKeyFrameInterval: 12 })] }), {
      maxResolutionTier: '2160p',
    });
    expect(report4k.video[0].reasons).to.deep.equal(['video_gop_size']);
  });

  it('downscales oversized video preserving aspect ratio with even dimensions', () => {
    const report = analyze(summary({ video: [video({ codedWidth: 3840, codedHeight: 2160 })] }));
    expect(report.video[0].reasons).to.deep.equal(['video_resolution']);
    expect(report.video[0].resize).to.be.true;
    expect(report.video[0].targetWidth).to.equal(2048);
    expect(report.video[0].targetHeight).to.equal(1152);

    const portrait = analyze(
      summary({ video: [video({ codedWidth: 3840, codedHeight: 2160, displayWidth: 2160, displayHeight: 3840, rotation: 90 })] })
    );
    expect(portrait.video[0].targetWidth).to.equal(1152);
    expect(portrait.video[0].targetHeight).to.equal(2048);

    const report4k = analyze(summary({ video: [video({ codedWidth: 3840, codedHeight: 2160 })] }), {
      maxResolutionTier: '2160p',
    });
    expect(report4k.video[0].reasons).to.deep.equal([]);
    expect(report4k.video[0].resize).to.be.false;
  });

  it('flags average and GOP-peak bitrates over the tier limits', () => {
    const average = analyze(summary({ video: [video({ averageBitrate: 9e6 })] }));
    expect(average.video[0].reasons).to.deep.equal(['video_bitrate']);
    const peak = analyze(summary({ video: [video({ maxGopBitrate: 17e6 })] }));
    expect(peak.video[0].reasons).to.deep.equal(['video_bitrate']);
    const fourK = analyze(summary({ video: [video({ averageBitrate: 15e6, maxGopBitrate: 30e6 })] }), {
      maxResolutionTier: '2160p',
    });
    expect(fourK.video[0].reasons).to.deep.equal([]);
  });

  it('caps the target bitrate under the tier limit and scales it with resolution', () => {
    const highSource = analyze(summary({ video: [video({ averageBitrate: 40e6 })] }));
    expect(highSource.video[0].targetBitrate).to.equal(8e6 * 0.85);

    const downscaled = analyze(
      summary({ video: [video({ codedWidth: 4096, codedHeight: 2304, averageBitrate: 6e6 })] })
    );
    expect(downscaled.video[0].targetBitrate).to.be.lessThan(6e6);
    expect(downscaled.video[0].targetBitrate).to.be.at.least(1e6);

    const override = analyze(summary({ video: [video({ averageBitrate: 40e6 })] }), {
      videoBitrate: 3e6,
    });
    expect(override.video[0].targetBitrate).to.equal(3e6);
  });

  it('caps high frame rates per tier and only reports very low ones', () => {
    const high = analyze(summary({ video: [video({ frameRate: 240 })] }));
    expect(high.video[0].reasons).to.deep.equal(['video_frame_rate']);
    expect(high.video[0].targetFrameRate).to.equal(120);
    expect(high.video[0].transcode).to.be.true;

    const high4k = analyze(summary({ video: [video({ frameRate: 90 })] }), {
      maxResolutionTier: '2160p',
    });
    expect(high4k.video[0].targetFrameRate).to.equal(60);

    const low = analyze(summary({ video: [video({ frameRate: 1 })] }));
    expect(low.video[0].reasons).to.deep.equal(['video_frame_rate']);
    expect(low.video[0].transcode).to.be.false;
    expect(low.standard).to.be.false;
    expect(low.needsWork).to.be.false;
  });

  it('flags non-AAC audio and odd channel layouts', () => {
    const opus = analyze(summary({ audio: [audio({ codec: 'opus', codecString: null })] }));
    expect(opus.audio[0].reasons).to.deep.equal(['audio_codec']);

    const eight = analyze(summary({ audio: [audio({ channels: 8 })] }));
    expect(eight.audio[0].reasons).to.deep.equal(['audio_channels']);
    expect(eight.audio[0].targetChannels).to.equal(6);

    const four = analyze(summary({ audio: [audio({ channels: 4 })] }));
    expect(four.audio[0].targetChannels).to.equal(2);

    const surround = analyze(summary({ audio: [audio({ channels: 6 })] }));
    expect(surround.standard).to.be.true;
  });

  it('reports over-long durations without trying to fix them', () => {
    const report = analyze(summary({ durationSeconds: 13 * 60 * 60 }));
    expect(report.reasons).to.deep.equal(['duration']);
    expect(report.needsWork).to.be.false;
  });

  it('marks undecodable sources that would need a transcode', () => {
    const report = analyze(summary({ video: [video({ codec: 'vp9', canDecode: false })] }));
    expect(report.video[0].reasons).to.include('undecodable_source');
  });

  it('handles audio-only files', () => {
    const report = analyze(summary({ video: [], audio: [audio({ codec: 'mp3' })] }));
    expect(report.reasons).to.deep.equal(['audio_codec']);
    expect(report.needsWork).to.be.true;
  });

  it('transcodes every track in always mode even when conforming', () => {
    const report = analyze(summary(), { mode: 'always' });
    expect(report.standard).to.be.true;
    expect(report.needsWork).to.be.true;
    expect(report.video[0].transcode).to.be.true;
    expect(report.audio[0].transcode).to.be.true;
  });
});
