import { expect } from '@open-wc/testing';
import xhrMock from 'xhr-mock';
import xhr from 'xhr';
import { canEncodeAudio, canEncodeVideo } from 'mediabunny';
import { createUpload } from '../../src/upchunk';
import {
  analyzeFile,
  createMuxTranscoder,
  defaultEncoderCapabilities,
  MuxTranscodeError,
} from '../../src/mediabunny/index';
import type { MuxTranscodeResult } from '../../src/mediabunny/index';
import { inspectFile, makeFixture } from './fixtures';

const run = (file: File, options = {}) =>
  createMuxTranscoder(options)(file, {
    signal: new AbortController().signal,
    onProgress: () => {},
  }) as Promise<MuxTranscodeResult>;

describe('createMuxTranscoder (real mediabunny)', function () {
  this.timeout(60000);

  let avcEncodable = false;
  let aacEncodable = false;
  before(async () => {
    if (typeof VideoEncoder === 'undefined') {
      console.warn('WebCodecs unavailable; skipping mediabunny transcode tests');
      return;
    }
    avcEncodable = await canEncodeVideo('avc', { width: 64, height: 64 });
    aacEncodable = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 });
    if (!avcEncodable) {
      console.warn('H.264 encoding unavailable; skipping mediabunny transcode tests');
    }
    console.info(`mediabunny tests: avc=${avcEncodable} aac=${aacEncodable}`);
  });

  const skipUnlessEncodable = function (this: Mocha.Context) {
    if (!avcEncodable) this.skip();
  };

  it('passes through a random-bytes file as unrecognized input', async () => {
    const bytes = new Uint8Array(4096);
    crypto.getRandomValues(bytes);
    const file = new File([bytes], 'noise.bin');
    const result = await run(file);
    expect(result.file).to.equal(file);
    expect(result.transcoded).to.be.false;
    expect(result.reasons).to.deep.equal(['unrecognized_input']);
  });

  it('passes through files larger than the in-memory guard', async () => {
    const file = new File([new Uint8Array(1024)], 'big.mp4');
    const result = await run(file, { maxInputBytes: 512 });
    expect(result.file).to.equal(file);
    expect(result.reasons).to.deep.equal(['too_large_for_in_memory']);
  });

  it('transcodes a VP9/Opus WebM into an H.264 MP4', async function () {
    skipUnlessEncodable.call(this);
    const file = await makeFixture({ format: 'webm', videoCodec: 'vp9', audioCodec: 'opus', name: 'clip.webm' });
    const progress: number[] = [];
    const result = (await createMuxTranscoder()(file, {
      signal: new AbortController().signal,
      onProgress: (p) => progress.push(p),
    })) as MuxTranscodeResult;

    expect(result.transcoded).to.be.true;
    expect(result.reasons).to.include.members(['container', 'video_codec']);
    expect(result.file.type).to.equal('video/mp4');
    expect(result.file.name).to.equal('clip.mp4');
    expect(progress.length).to.be.greaterThan(0);
    expect(progress[progress.length - 1]).to.equal(1);

    const inspection = await inspectFile(result.file);
    expect(inspection.container).to.equal('MP4');
    expect(inspection.videoCodec).to.equal('avc');
    if (aacEncodable) {
      expect(inspection.audioCodec).to.equal('aac');
      expect(result.notes).to.deep.equal([]);
    } else {
      // Opus is MP4-compatible so it is copied rather than re-encoded when AAC is unavailable.
      expect(inspection.audioCodec).to.equal('opus');
      expect(result.notes).to.deep.equal(['aac_encoder_unavailable_copying_opus']);
    }
  });

  it('measures the keyframe interval and re-encodes only when it is over the limit', async function () {
    skipUnlessEncodable.call(this);
    // Some encoders (e.g. OpenH264 in Chrome on Linux) insert their own keyframes and ignore the
    // requested interval, so the fixture may or may not end up with a long GOP. Assert against
    // what was actually produced rather than what was requested.
    const file = await makeFixture({ format: 'mp4', videoCodec: 'avc', seconds: 25, fps: 5, keyFrameInterval: 30 });
    const before = await inspectFile(file);
    const { summary } = await analyzeFile(file);
    expect(summary.video[0].maxKeyFrameInterval).to.be.closeTo(before.maxKeyFrameInterval, 0.25);

    const result = await run(file, { keyFrameInterval: 2 });
    if (before.maxKeyFrameInterval > 20) {
      expect(result.transcoded).to.be.true;
      expect(result.reasons).to.deep.equal(['video_gop_size']);
      const after = await inspectFile(result.file);
      expect(after.videoCodec).to.equal('avc');
      expect(after.maxKeyFrameInterval).to.be.at.most(2.5);
    } else {
      console.info(`encoder produced a ${before.maxKeyFrameInterval.toFixed(1)} s GOP; long-GOP re-encode path not exercised here`);
      expect(result.transcoded).to.be.false;
      expect(result.reasons).to.deep.equal([]);
    }
  });

  it('leaves a conforming MP4 untouched', async function () {
    skipUnlessEncodable.call(this);
    const file = await makeFixture({ format: 'mp4', videoCodec: 'avc', keyFrameInterval: 1 });
    const result = await run(file);
    expect(result.file).to.equal(file);
    expect(result.transcoded).to.be.false;
    expect(result.reasons).to.deep.equal([]);
    expect(result.report?.standard).to.be.true;
  });

  it('remuxes a conforming Matroska file without re-encoding', async function () {
    skipUnlessEncodable.call(this);
    const file = await makeFixture({ format: 'mkv', videoCodec: 'avc', name: 'clip.mkv' });
    const before = await inspectFile(file);
    const result = await run(file);
    expect(result.transcoded).to.be.true;
    expect(result.reasons).to.deep.equal(['container']);
    const after = await inspectFile(result.file);
    expect(after.container).to.equal('MP4');
    expect(after.videoCodec).to.equal('avc');
    expect(after.firstVideoPacketByteLength).to.equal(before.firstVideoPacketByteLength);
  });

  it('transcodes a conforming file in always mode', async function () {
    skipUnlessEncodable.call(this);
    const file = await makeFixture({ format: 'mp4', videoCodec: 'avc', keyFrameInterval: 1 });
    const result = await run(file, { mode: 'always' });
    expect(result.transcoded).to.be.true;
    expect(result.reasons).to.deep.equal([]);
  });

  it('analyzeFile reports without transcoding', async function () {
    skipUnlessEncodable.call(this);
    const file = await makeFixture({ format: 'webm', videoCodec: 'vp9' });
    const { report, summary } = await analyzeFile(file);
    expect(summary.container).to.equal('WebM');
    expect(summary.video[0].codec).to.equal('vp9');
    expect(report.needsWork).to.be.true;
  });

  it('falls back to the original file when no H.264 encoder is available', async function () {
    skipUnlessEncodable.call(this);
    const file = await makeFixture({ format: 'webm', videoCodec: 'vp9' });
    const noVideoEncoder = {
      ...defaultEncoderCapabilities(),
      canEncodeVideo: async () => false,
    };
    const result = (await createMuxTranscoder({}, noVideoEncoder)(file, {
      signal: new AbortController().signal,
      onProgress: () => {},
    })) as MuxTranscodeResult;
    expect(result.file).to.equal(file);
    expect(result.transcoded).to.be.false;
    expect(result.notes).to.deep.equal(['transcode_failed_uploading_original']);
    expect(result.error).to.be.instanceOf(MuxTranscodeError);
    expect((result.error as MuxTranscodeError).code).to.equal('unsupported_encoder');
  });

  it('surfaces failures as an error when fallbackToOriginal is false', async function () {
    skipUnlessEncodable.call(this);
    const file = await makeFixture({ format: 'webm', videoCodec: 'vp9' });
    const noVideoEncoder = {
      ...defaultEncoderCapabilities(),
      canEncodeVideo: async () => false,
    };
    let error: unknown;
    try {
      await createMuxTranscoder({ fallbackToOriginal: false }, noVideoEncoder)(file, {
        signal: new AbortController().signal,
        onProgress: () => {},
      });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(MuxTranscodeError);
    expect((error as MuxTranscodeError).code).to.equal('unsupported_encoder');
  });

  describe('through createUpload', () => {
    const endpoint = 'https://this-is-a-fake-url.com/upload/endpoint';
    beforeEach(() => {
      xhrMock.setup();
      /** @ts-ignore */
      xhr.XMLHttpRequest = window.XMLHttpRequest;
    });
    afterEach(() => {
      xhrMock.teardown();
      /** @ts-ignore */
      xhr.XMLHttpRequest = window.XMLHttpRequest;
    });

    it('uploads the transcoded MP4 and can be aborted mid-transcode', async function () {
      skipUnlessEncodable.call(this);
      const file = await makeFixture({ format: 'webm', videoCodec: 'vp9', seconds: 6, fps: 10, name: 'clip.webm' });

      const uploadedRanges: string[] = [];
      xhrMock.put(endpoint, (req, res) => {
        uploadedRanges.push(req.header('Content-Range') as string);
        return res.status(200);
      });

      const completed = await new Promise<{ transcodedSize: number; contentType: string }>((resolve, reject) => {
        let transcodedSize = 0;
        const upload = createUpload({
          endpoint,
          file,
          chunkSize: 256,
          transcode: createMuxTranscoder(),
          headers: () => ({}),
        });
        upload.on('transcodeSuccess', ({ detail }) => {
          transcodedSize = detail.file.size;
        });
        upload.on('error', (e) => reject(new Error(e.detail.message)));
        upload.on('success', () => resolve({ transcodedSize, contentType: upload.file.type }));
      });

      expect(completed.contentType).to.equal('video/mp4');
      expect(uploadedRanges.length).to.be.greaterThan(0);
      expect(uploadedRanges[uploadedRanges.length - 1]).to.match(new RegExp(`/${completed.transcodedSize}$`));

      const aborted = await new Promise<boolean>((resolve) => {
        const upload = createUpload({
          endpoint,
          file,
          chunkSize: 256,
          transcode: createMuxTranscoder(),
        });
        let sawProgress = false;
        upload.on('transcodeProgress', () => {
          if (sawProgress) return;
          sawProgress = true;
          upload.abort();
          setTimeout(() => resolve(upload.paused && upload.transcoding === false), 300);
        });
        upload.on('transcodeSuccess', () => resolve(false));
        upload.on('error', () => resolve(false));
        upload.on('attempt', () => resolve(false));
      });
      expect(aborted).to.be.true;
    });
  });
});
