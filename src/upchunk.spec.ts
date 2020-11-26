import * as nock from 'nock';

import { createUpload } from './upchunk';

beforeEach(() => {
  nock('https://example.com').options('/upload/endpoint').reply(200).persist();
});

afterEach(() => {
  nock.restore();
  nock.abortPendingRequests();
  nock.cleanAll();
  nock.enableNetConnect();
  nock.emitter.removeAllListeners();
  nock.activate();
});

// Just to go ahead and take care of all the inevitable options requests

const createUploadFixture = (
  testFileBytes: number = 524288,
  chunkSizeKb: number = 256
) => {
  const file = new File([new ArrayBuffer(testFileBytes)], 'test.mp4');

  return createUpload({
    file,
    endpoint: 'https://example.com/upload/endpoint',
    chunkSize: chunkSizeKb,
  });
};

test('a file is uploaded using the correct content-range headers', (done) => {
  const fileBytes = 524288;
  const upload = createUploadFixture(fileBytes);

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
  const scope = nock('https://example.com').put('/upload/endpoint').reply(500);

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

  const scope = nock('https://example.com')
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
  const scope = nock('https://example.com').put('/upload/endpoint').reply(502);

  const upload = createUploadFixture();

  upload.on('attemptFailure', (err) => {
    done();
  });
});

/* Still need to figure this test out. Unclear if it's currently an issue with Nock or UpChunk. */
test.skip('a single chunk failing is retried multiple times until successful', (done) => {
  let ATTEMPT_FAILURES = 0;

  nock('https://example.com')
    .put('/upload/endpoint')
    .times(2)
    .reply(502)
    .put('/upload/endpoint')
    .twice()
    .reply(200);

  const upload = createUploadFixture();

  upload.on('attemptFailure', (err) => {
    console.log(err.detail);
    ATTEMPT_FAILURES += 1;
  });

  upload.on('error', done);

  upload.on('success', () => {
    if (ATTEMPT_FAILURES === 2) {
      done();
    }

    done(`Expected 3 attempt failures, received ${ATTEMPT_FAILURES}`);
  });
});
