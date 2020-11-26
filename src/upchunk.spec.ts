import * as nock from 'nock';

import { createUpload } from './upchunk';

// Just to go ahead and take care of all the inevitable options requests
nock('https://example.com').options('/upload/endpoint').reply(200).persist();

test('a file is uploaded using the correct content-range headers', (done) => {
  const fileBytes = 524288; // 512kb
  const file = new File([new ArrayBuffer(fileBytes)], 'test.mp4');

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

  const upload = createUpload({
    file,
    endpoint: 'https://example.com/upload/endpoint',
    chunkSize: 256,
  });

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
  const fileBytes = 524288; // 512kb
  const file = new File([new ArrayBuffer(fileBytes)], 'test.mp4');

  const scope = nock('https://example.com').put('/upload/endpoint').reply(500);

  const upload = createUpload({
    file,
    endpoint: 'https://example.com/upload/endpoint',
    chunkSize: 256,
  });

  upload.on('error', (err) => {
    done();
  });

  upload.on('success', () => {
    done('Ironic failure, should not have been successful');
  });
});

test('fires an attempt event before each attempt', (done) => {
  const fileBytes = 524288; // 512kb
  const file = new File([new ArrayBuffer(fileBytes)], 'test.mp4');
  let ATTEMPT_COUNT = 0;
  const MAX_ATTEMPTS = 2; // because we set the chunk size to 256kb, half of our file size in bytes.

  const scope = nock('https://example.com')
    .put('/upload/endpoint')
    .reply(200)
    .put('/upload/endpoint')
    .reply(200);

  const upload = createUpload({
    file,
    endpoint: 'https://example.com/upload/endpoint',
    chunkSize: 256,
  });

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
