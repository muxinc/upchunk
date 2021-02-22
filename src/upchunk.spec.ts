import * as nock from 'nock';

import { UpChunk, createUpload, UpChunkOptions } from './upchunk';

beforeEach(() => {
  if (!nock.isActive()) {
    nock.activate();
  }
});

afterEach(() => {
  nock.restore();
  nock.cleanAll();
});

const createUploadFixture = (
  options?: Partial<UpChunkOptions>,
  specifiedFile?: File
) => {
  const file = specifiedFile || new File([new ArrayBuffer(524288)], 'test.mp4');

  return createUpload({
    file,
    endpoint: `https://example.com/upload/endpoint`,
    chunkSize: 256,
    ...options,
  });
};

test('files can be uploading using POST', (done) => {
  nock('https://example.com')
    .post('/upload/endpoint')
    .twice()
    .reply(200)

  const upload = createUploadFixture({
    method: 'POST',
  });

  upload.on('success', () => {
    done();
  });
});

test('files can be uploading using PATCH', (done) => {
  nock('https://example.com')
    .patch('/upload/endpoint')
    .twice()
    .reply(200);

  const upload = createUploadFixture({
    method: 'PATCH',
  });

  upload.on('success', () => {
    done();
  });
});

test('a file is uploaded using the correct content-range headers', (done) => {
  const fileBytes = 524288;
  const upload = createUploadFixture(
    {},
    new File([new ArrayBuffer(fileBytes)], 'test.mp4')
  );

  const scopes = [
    nock('https://example.com')
      .matchHeader('content-range', `bytes 0-${fileBytes / 2 - 1}/${fileBytes}`)
      .put('/upload/endpoint')
      .reply(200),

    nock('https://example.com')
      .matchHeader(
        'content-range',
        `bytes ${fileBytes / 2}-${fileBytes - 1}/${fileBytes}`
      )
      .put('/upload/endpoint')
      .reply(200),
  ];

  upload.on('error', (err) => {
    done(err);
  });

  upload.on('success', () => {
    scopes.forEach((scope) => {
      if (!scope.isDone()) {
        done('All scopes not completed');
      }
    });

    done();
  });
});

test('an error is thrown if a request does not complete', (done) => {
  nock('https://example.com').put('/upload/endpoint').reply(500);

  const upload = createUploadFixture();

  upload.on('error', (err) => {
    done();
  });

  upload.on('success', () => {
    done('Ironic failure, should not have been successful');
  });
});

test('fires an attempt event before each attempt', (done) => {
  let ATTEMPT_COUNT = 0;
  const MAX_ATTEMPTS = 2; // because we set the chunk size to 256kb, half of our file size in bytes.

  nock('https://example.com')
    .put('/upload/endpoint')
    .reply(200)
    .put('/upload/endpoint')
    .reply(200);

  const upload = createUploadFixture();

  upload.on('attempt', (err) => {
    ATTEMPT_COUNT += 1;
  });

  upload.on('success', () => {
    if (ATTEMPT_COUNT === MAX_ATTEMPTS) {
      done();
    } else {
      done(
        `Attempted ${ATTEMPT_COUNT} times and it should have been ${MAX_ATTEMPTS}`
      );
    }
  });
});

test('a chunk failing to upload fires an attemptFailure event', (done) => {
  nock('https://example.com').put('/upload/endpoint').reply(502);

  const upload = createUploadFixture();

  upload.on('attemptFailure', (err) => {
    upload.pause();
    done();
  });
});

test('a single chunk failing is retried multiple times until successful', (done) => {
  let ATTEMPT_FAILURE_COUNT = 0;
  const FAILURES = 2;

  nock('https://example.com')
    .put('/upload/endpoint')
    .times(FAILURES)
    .reply(502)
    .put('/upload/endpoint')
    .twice()
    .reply(200);

  const upload = createUploadFixture({ delayBeforeAttempt: 0.1 });

  upload.on('attemptFailure', (err) => {
    ATTEMPT_FAILURE_COUNT += 1;
  });

  upload.on('error', done);

  upload.on('success', () => {
    if (ATTEMPT_FAILURE_COUNT === FAILURES) {
      return done();
    }

    done(
      `Expected ${FAILURES} attempt failures, received ${ATTEMPT_FAILURE_COUNT}`
    );
  });
});

test('a single chunk failing the max number of times fails the upload', (done) => {
  nock('https://example.com')
    .put('/upload/endpoint')
    .times(5)
    .reply(502)
    .put('/upload/endpoint')
    .twice()
    .reply(200);

  const upload = createUploadFixture({ delayBeforeAttempt: 0.1 });

  upload.on('error', (err) => {
    try {
      expect(err.detail.chunk).toBe(0);
      expect(err.detail.attempts).toBe(5);
      done();
    } catch (err) {
      done(err);
    }
  });

  upload.on('success', () => {
    done(`Expected upload to fail due to failed attempts`);
  });
});

test('chunkSuccess event is fired after each successful upload', (done) => {
  nock('https://example.com')
    .put('/upload/endpoint')
    .reply(200)
    .put('/upload/endpoint')
    .reply(200);

  const upload = createUploadFixture();

  const successCallback = jest.fn();

  upload.on('chunkSuccess', successCallback);

  upload.on('success', () => {
    expect(successCallback).toBeCalledTimes(2);
    done();
  });
});

const isNumberArraySorted = (a: number[]): boolean => {
  for (let i = 0; i < a.length - 1; i += 1) {
    if (a[i] > a[i + 1]) {
      return false;
    }
  }
  return true;
};

test('progress event fires the correct upload percentage', (done) => {
  const fileBytes = 1048576;
  const upload = createUploadFixture(
    {},
    new File([new ArrayBuffer(fileBytes)], 'test.mp4')
  );

  const scopes = [
    nock('https://example.com')
      .matchHeader('content-range', `bytes 0-${fileBytes / 4 - 1}/${fileBytes}`)
      .put('/upload/endpoint')
      .reply(200),
    nock('https://example.com')
      .matchHeader(
        'content-range',
        `bytes ${fileBytes / 4}-${fileBytes / 2 - 1}/${fileBytes}`
      )
      .put('/upload/endpoint')
      .reply(200),
    nock('https://example.com')
      .matchHeader(
        'content-range',
        `bytes ${fileBytes / 2}-${3 * fileBytes / 4 - 1}/${fileBytes}`
      )
      .put('/upload/endpoint')
      .reply(200),
    nock('https://example.com')
      .matchHeader(
        'content-range',
        `bytes ${3 * fileBytes / 4}-${fileBytes - 1}/${fileBytes}`
      )
      .put('/upload/endpoint')
      .reply(200),
  ];

  const progressCallback = jest.fn((percentage) => percentage);

  upload.on('error', (err) => {
    done(err);
  });

  upload.on('progress', (progress) => {
    progressCallback(progress.detail);
  });

  upload.on('success', () => {
    scopes.forEach((scope) => {
      if (!scope.isDone()) {
        done('All scopes not completed');
      }
    });
    expect(progressCallback).toHaveBeenCalledTimes(7);
    const progressPercentageArray = progressCallback.mock.calls.map(([percentage]) => percentage);
    expect(isNumberArraySorted(progressPercentageArray)).toBeTruthy();
    done();
  });
}, 10000);

test('abort pauses the upload and cancels the current XHR request', (done) => {
  /*
    This is hacky and I don't love it, but the gist is:
    - Set up a chunkSuccess callback listener
    - We abort the upload during the first request stub before responding
    - In the attempt callback, we'll set a short timeout, where we check if the scope is done, meaning all the stubs have been called. If that's the case, make sure that chunkSuccess was never called.
  */
  let upload: UpChunk;

  const scope = nock('https://example.com')
    .put('/upload/endpoint')
    .reply(() => {
      upload.abort();

      return [200, 'success'];
    });

  upload = createUploadFixture();

  const chunkSuccessCallback = jest.fn();

  upload.on('attempt', (e) => {
    setTimeout(() => {
      expect(scope.isDone()).toBeTruthy();
      expect(chunkSuccessCallback).toHaveBeenCalledTimes(0);
      done();
    }, 10);
  });

  // upload.on('chunkSuccess', chunkSuccessCallback);
  upload.on('chunkSuccess', (e) => console.log(e.detail))

  upload.on('success', () => {
    done('Upload should not have successfully completed');
  });
});
