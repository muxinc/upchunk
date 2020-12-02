/**
 * This is more of an integration test. We can't test these in TS, because
 * our handy dandy typechecks will make it so we can't compile with invalid
 * parameters. We don't have that luxury in normal JS, however, so make sure
 * we still yell when we're supposed to.
 */

const { createUpload, UpChunk } = require('./upchunk');

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

  test('returns a new UpChunk instance when given valid params', () => {
    const upload = createUpload(buildParams());
    expect(upload).toBeInstanceOf(UpChunk);
  });

  test('accepts a function that returns a promise for endpoint', () => {
    const upload = createUpload(
      buildParams({ endpoint: () => Promise.resolve('/foo') })
    );
    expect(upload).toBeInstanceOf(UpChunk);
  });

  describe('throws', () => {
    test('endpoint is not included', () => {
      const params = buildParams({ endpoint: undefined });

      expect(() => createUpload(params)).toThrow(TypeError);
    });

    test('endpoint is an empty string', () => {
      const params = buildParams({ endpoint: '' });

      expect(() => createUpload(params)).toThrow(TypeError);
    });

    test('file is not included', () => {
      const params = buildParams({ file: undefined });

      expect(() => createUpload(params)).toThrow(TypeError);
    });

    test('file is not a File', () => {
      const params = buildParams({ file: 'neato' });

      expect(() => createUpload(params)).toThrow(TypeError);
    });

    test('headers are specified and not an object', () => {
      const params = buildParams({ headers: 'hey neato' });

      expect(() => createUpload(params)).toThrow(TypeError);
    });

    test('chunkSize is not a number', () => {
      const params = buildParams({ chunkSize: 'cool' });

      expect(() => createUpload(params)).toThrow(TypeError);
    });

    test('chunkSize is a positive integer', () => {
      const params = buildParams({ chunkSize: -256 });

      expect(() => createUpload(params)).toThrow(TypeError);
    });

    test('chunkSize is not a multiple of 256', () => {
      const params = buildParams({ chunkSize: 100 });

      expect(() => createUpload(params)).toThrow(TypeError);
    });

    test('attempts is not a number', () => {
      const params = buildParams({ attempts: 'foo' });

      expect(() => createUpload(params)).toThrow(TypeError);
    });

    test('attempts is not a positive number', () => {
      const params = buildParams({ attempts: -1 });

      expect(() => createUpload(params)).toThrow(TypeError);
    });

    test('delayBeforeAttempt is not a positive number', () => {
      const params = buildParams({ delayBeforeAttempt: -1 });

      expect(() => createUpload(params)).toThrow(TypeError);
    });

    test('an error is thrown if input file is larger than max', () => {
      const params = buildParams({ maxFileSize: (fakeFile().size - 1) / 1024 });

      expect(() => createUpload(params)).toThrow(Error);
    });
  });
});
