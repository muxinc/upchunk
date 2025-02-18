/**
 * This is more of an integration test. We can't test these in TS, because
 * our handy dandy typechecks will make it so we can't compile with invalid
 * parameters. We don't have that luxury in normal JS, however, so make sure
 * we still yell when we're supposed to.
 */

import { expect } from '@open-wc/testing';
import { createUpload, UpChunk, isIncompleteChunkUploadNeedingRetry } from '../src/upchunk';

const fakeFile = () => {
  return new File(['foo'], 'foo.mp4', {
    type: 'video/mp4',
  });
};

describe('option validation', () => {
  const buildParams = (options = {}) => ({
    endpoint: '/foo',
    file: fakeFile(),
    headers: {},
    chunkSize: 256,
    attempts: 1,
    delayBeforeAttempt: 1,
    ...options,
  });

  it('returns a new UpChunk instance when given valid params', () => {
    const upload = createUpload(buildParams());
    expect(upload).to.be.an.instanceOf(UpChunk);
  });

  it('accepts a function that returns a promise for endpoint', () => {
    const upload = createUpload(
      buildParams({ endpoint: () => Promise.resolve('/foo') })
    );
    expect(upload).to.be.an.instanceOf(UpChunk);
  });

  it('accepts a function that returns headers', () => {
    const upload = createUpload(
      buildParams({ headers: (() => {}) })
    );
    expect(upload).to.be.an.instanceOf(UpChunk);
  })

  describe('throws', () => {
    it('endpoint is not included', () => {
      const params = buildParams({ endpoint: undefined });

      expect(() => createUpload(params)).to.throw(TypeError);
    });

    it('endpoint is an empty string', () => {
      const params = buildParams({ endpoint: '' });

      expect(() => createUpload(params)).to.throw(TypeError);
    });

    it('file is not included', () => {
      const params = buildParams({ file: undefined });

      expect(() => createUpload(params)).to.throw(TypeError);
    });

    it('file is not a File', () => {
      const params = buildParams({ file: 'neato' });

      expect(() => createUpload(params)).to.throw(TypeError);
    });

    it('headers are specified and not an object', () => {
      const params = buildParams({ headers: 'hey neato' });

      expect(() => createUpload(params)).to.throw(TypeError);
    });

    it('chunkSize is not a number', () => {
      const params = buildParams({ chunkSize: 'cool' });

      expect(() => createUpload(params)).to.throw(TypeError);
    });

    it('chunkSize is a positive integer', () => {
      const params = buildParams({ chunkSize: -256 });

      expect(() => createUpload(params)).to.throw(TypeError);
    });

    it('chunkSize is not a multiple of 256', () => {
      const params = buildParams({ chunkSize: 100 });

      expect(() => createUpload(params)).to.throw(TypeError);
    });

    it('attempts is not a number', () => {
      const params = buildParams({ attempts: 'foo' });

      expect(() => createUpload(params)).to.throw(TypeError);
    });

    it('attempts is not a positive number', () => {
      const params = buildParams({ attempts: -1 });

      expect(() => createUpload(params)).to.throw(TypeError);
    });

    it('delayBeforeAttempt is not a positive number', () => {
      const params = buildParams({ delayBeforeAttempt: -1 });

      expect(() => createUpload(params)).to.throw(TypeError);
    });

    it('an error is thrown if input file is larger than max', () => {
      const params = buildParams({ maxFileSize: (fakeFile().size - 1) / 1024 });

      expect(() => createUpload(params)).to.throw(Error);
    });
  });
});

describe('isIncompleteChunkUploadNeedingRetry function', () => {
  const mockXhrResponse = (statusCode, rangeHeader) => ({
    statusCode,
    headers: { 'range': rangeHeader }
  });

  it('returns false for a successful chunk upload', () => {
    const res1 = mockXhrResponse(308, 'bytes=0-999');
    const res2 = mockXhrResponse(308, 'bytes=500-999');
    const options = { currentChunkEndByte: 999 };

    expect(isIncompleteChunkUploadNeedingRetry(res1, options)).to.be.false;
    expect(isIncompleteChunkUploadNeedingRetry(res2, options)).to.be.false;
  });

  it('returns true for a partial chunk upload', () => {
    const res = mockXhrResponse(308, 'bytes=0-998');
    const options = { currentChunkEndByte: 999 };

    expect(isIncompleteChunkUploadNeedingRetry(res, options)).to.be.true;
  });

  it('returns false for non-308 response codes', () => {
    const res = mockXhrResponse(200, 'bytes=0-999');
    const options = { currentChunkEndByte: 999 };

    expect(isIncompleteChunkUploadNeedingRetry(res, options)).to.be.false;
  });

  it('handles missing or malformed Range header', () => {
    const res1 = mockXhrResponse(308, null);
    const res2 = mockXhrResponse(308, 'invalid-range');
    const res3 = null;
    const res4 = undefined;
    const options = { currentChunkEndByte: 999 };

    expect(isIncompleteChunkUploadNeedingRetry(res1, options)).to.be.false;
    expect(isIncompleteChunkUploadNeedingRetry(res2, options)).to.be.false;
    expect(isIncompleteChunkUploadNeedingRetry(res3, options)).to.be.false;
    expect(isIncompleteChunkUploadNeedingRetry(res4, options)).to.be.false;
  });
});
