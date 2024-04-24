<p align="center">
  <a href="https://mux.com/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://user-images.githubusercontent.com/360826/233653989-11cd8603-c20f-4008-8bf7-dc15b743c52b.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://user-images.githubusercontent.com/360826/233653583-50dda726-cbe7-4182-a113-059a91ae83e6.svg">
      <img alt="Mux Logo" src="https://user-images.githubusercontent.com/360826/233653583-50dda726-cbe7-4182-a113-059a91ae83e6.svg">
    </picture>
    <h1 align="center">UpChunk</h1>
  </a>
</p>

<img src="https://github.com/muxinc/upchunk/workflows/CI/badge.svg" alt="Build Status">

UpChunk uploads chunks of files! It's a JavaScript module for handling large file uploads via chunking and making a `put` request for each chunk with the correct range request headers. Uploads can be paused and resumed, they're fault tolerant,
and it should work just about anywhere.

UpChunk is designed to be used with [Mux](https://mux.com) direct uploads, but should work with any server that supports resumable uploads in the same manner. This library will:

- Split a file into chunks (in multiples of 256KB).
- Make a `PUT` request for each chunk, specifying the correct `Content-Length` and `Content-Range` headers for each one.
- Retry a chunk upload on failures.
- Allow for pausing and resuming an upload.

## Installation

### NPM

```
npm install --save @mux/upchunk
```

### Yarn

```
yarn add @mux/upchunk
```

### Script Tags

```
<script src="https://unpkg.com/@mux/upchunk@3"></script>
```

## Basic Usage

### Getting an upload URL from Mux.

You'll need to have a route in your application that returns an upload URL from Mux. If you're using the [Mux Node SDK](https://github.com/muxinc/mux-node-sdk), you might do something that looks like this.

```javascript
const Mux = require('@mux/mux-node');
const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET,
});

module.exports = async (req, res) => {
  // This ultimately just makes a POST request to https://api.mux.com/video/v1/uploads with the supplied options.
  const upload = await mux.video.uploads.create({
    cors_origin: 'https://your-app.com',
    new_asset_settings: {
      playback_policy: ['public'],
    },
  });

  // Save the Upload ID in your own DB somewhere, then
  // return the upload URL to the end-user.
  res.end(upload.url);
};
```

### Then, in the browser with plain Javascript

```javascript
import * as UpChunk from '@mux/upchunk';

// Pretend you have an HTML page with an input like: <input id="picker" type="file" />
const picker = document.getElementById('picker');

picker.onchange = () => {
  const getUploadUrl = () =>
    fetch('/the-endpoint-above').then((res) =>
      res.ok ? res.text() : throw new Error('Error getting an upload URL :(')
    );

  const upload = UpChunk.createUpload({
    endpoint: getUploadUrl,
    file: picker.files[0],
    chunkSize: 30720, // Uploads the file in ~30 MB chunks
  });

  // subscribe to events
  upload.on('error', (err) => {
    console.error('💥 🙀', err.detail);
  });

  upload.on('progress', (progress) => {
    console.log(`So far we've uploaded ${progress.detail}% of this file.`);
  });

  upload.on('success', () => {
    console.log("Wrap it up, we're done here. 👋");
  });
};
```

### Or, in the browser with React

```javascript
import React, { useState } from 'react';
import * as UpChunk from '@mux/upchunk';

function Page() {
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState(null);

  const handleUpload = async (inputRef) => {
    try {
      const response = await fetch('/your-server-endpoint', { method: 'POST' });
      const url = await response.text();

      const upload = UpChunk.createUpload({
        endpoint: url, // Authenticated url
        file: inputRef.files[0], // File object with your video file’s properties
        chunkSize: 30720, // Uploads the file in ~30 MB chunks
      });

      // Subscribe to events
      upload.on('error', (error) => {
        setStatusMessage(error.detail);
      });

      upload.on('progress', (progress) => {
        setProgress(progress.detail);
      });

      upload.on('success', () => {
        setStatusMessage("Wrap it up, we're done here. 👋");
      });
    } catch (error) {
      setErrorMessage(error);
    }
  };

  return (
    <div className="page-container">
      <h1>File upload button</h1>
      <label htmlFor="file-picker">Select a video file:</label>
      <input
        type="file"
        onChange={(e) => handleUpload(e.target)}
        id="file-picker"
        name="file-picker"
      />

      <label htmlFor="upload-progress">Downloading progress:</label>
      <progress value={progress} max="100" />

      <em>{statusMessage}</em>
    </div>
  );
}

export default Page;
```

## API

### `createUpload(options)`

Returns an instance of `UpChunk` and begins uploading the specified `File`.

#### `options` object parameters

- `endpoint` <small>type: `string` (url) | `function` (required)</small>

  URL to upload the file to. This can be either a string of the authenticated URL to upload to, or a function that returns a promise that resolves that URL string. The function will be passed the `file` as a parameter.

- `file` <small>type: [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File) (required)</small>

  The file you'd like to upload. For example, you might just want to use the file from an input with a type of "file".

- `headers` <small>type: `Object` | `function`</small>

  An object, a function that returns an object, or a function that returns a promise of an object. The resulting object contains any headers you'd like included with the `PUT` request for each chunk.

- `chunkSize` <small>type: `integer` (kB), default:`30720`</small>

  The size in kB of the chunks to split the file into, with the exception of the final chunk which may be smaller. This parameter must be in multiples of 256.

- `maxFileSize` <small>type: `integer`</small>

  The maximum size of the file in kb of the input file to be uploaded. The maximum size can technically be smaller than the chunk size, and in that case there would be exactly one chunk.

- `attempts` <small>type: `integer`, default: `5`</small>

  The number of times to retry any given chunk if the upload attempt fails with a retriable response status (see: `retryCodes`, below). After attempting `attempts` times, an error event will be dispatched and uploading will halt.

- `delayBeforeAttempt` <small>type: `number` (seconds), default: `1.0`</small>

  The time in seconds to wait before attempting to upload a chunk again.

- `retryCodes` <small>type: `number[]` (HTTP Status), default: `[408, 502, 503, 504]`</small>

  The HTTP Status codes that indicate a given (failed) chunk upload request attempt is retriable. See also: `attempts` option, above.

- `method` <small>type: `"PUT" | "PATCH" | "POST"`, default: `PUT`</small>

  The HTTP method to use when uploading each chunk.

- `dynamicChunkSize` <small>type: `boolean`, default: `false`</small>

  Whether or not the system should dynamically scale the `chunkSize` up and down to adjust to network conditions.

- `maxChunkSize` <small>type: `integer` (kB), default: `512000`</small>

  When `dynamicChunkSize` is `true`, the largest chunk size that will be used, in kB.

- `minChunkSize` <small>type: `integer` (kB), default: `256`</small>

  When `dynamicChunkSize` is `true`, the smallest chunk size that will be used, in kB.

- `useLargeFileWorkaround` <small>type: `boolean`, default: `false`</small>

  Falls back to reading entire file into memory for cases where support for streams is unreliable (see, e.g. [this upchunk issue](https://github.com/muxinc/upchunk/issues/134) and the corresponding [webkit bug report](https://bugs.webkit.org/show_bug.cgi?id=272600)).

### UpChunk Instance Properties

- `offline` <small>type: `(readonly) boolean` default: `false`</small>

  Indicates whether or not currently offline. While offline, uploading will pause and resume automatically once back online. See also: `offline` and `online` events, below.

- `paused` <small>type: `(readonly) boolean` default: `false`</small>

  Indicates whether or not uploading has been temporarily paused via the `pause()` method. See also: `pause()` and `resume()` methods, below.

### UpChunk Instance Methods

- `pause()`

  Pauses an upload after the current in-flight chunk is finished uploading.

- `resume()`

  Resumes an upload that was previously paused.

- `abort()`

  The same behavior as `pause()`, but also aborts the in-flight XHR request.

### UpChunk Instance Events

Events are fired with a [`CustomEvent`](https://developer.mozilla.org/en-US/docs/Web/API/CustomEvent/CustomEvent) object. The `detail` key is null if an interface isn't specified.

- `attempt` <small>`{ detail: { chunkNumber: Integer, chunkSize: Integer } }`</small>

  Fired immediately before a chunk upload is attempted. `chunkNumber` is the number of the current chunk being attempted, and `chunkSize` is the size (in bytes) of that chunk.

- `attemptFailure` <small>`{ detail: { message: String, chunkNumber: Integer, attemptsLeft: Integer } }`</small>

  Fired when an attempt to upload a chunk fails.

- `chunkSuccess` <small>`{ detail: { chunk: Integer, attempts: Integer, response: XhrResponse } }`</small>

  Fired when an indvidual chunk is successfully uploaded.

- `error` <small>`{ detail: { message: String, chunkNumber: Integer, attempts: Integer } }`</small>

  Fired when a chunk has reached the max number of retries or the response code is fatal and implies that retries should not be attempted.

- `offline`

  Fired when the client has gone offline.

- `online`

  Fired when the client has gone online.

- `progress` <small>`{ detail: [0..100] }`</small>

  Fired continuously with incremental upload progress. This returns the current percentage of the file that's been uploaded.

- `success`

  Fired when the upload is finished successfully.

## FAQ

### How do I cancel an upload?

Our typical suggestion is to use `pause()` or `abort()`, and then clean up the UpChunk instance however you'd like. For example, you could do something like this:

```javascript
// upload is an UpChunk instance currently in-flight
upload.abort();

// In many cases, just `abort` should be fine assuming the instance will get picked up by garbage collection
// If you want to be sure, you can manually delete the instance.
delete upload;
```

## Credit

The original idea for this came from the awesome [huge uploader](https://github.com/Buzut/huge-uploader) project, which is what you need if you're looking to do multipart form data uploads. 👏

Also, @gabrielginter ported upchunk to [Flutter](https://github.com/gabrielginter/flutter-upchunk).
