![UpChunk](banner.png)

# UpChunk <img src="https://github.com/muxinc/upchunk/workflows/CI/badge.svg" alt="Build Status">

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
<script src="https://unpkg.com/@mux/upchunk@2"></script>
```

## Basic Usage

### Getting an upload URL from Mux.

You'll need to have a route in your application that returns an upload URL from Mux. If you're using the [Mux Node SDK](https://github.com/muxinc/mux-node-sdk), you might do something that looks like this.

```javascript
const { Video } = new Mux();

module.exports = async (req, res) => {
  // This ultimately just makes a POST request to https://api.mux.com/video/v1/uploads with the supplied options.
  const upload = await Video.Uploads.create({
    cors_origin: 'https://your-app.com',
    new_asset_settings: {
      playback_policy: 'public',
    },
  });

  // Save the Upload ID in your own DB somewhere, then
  // return the upload URL to the end-user.
  res.end(upload.url);
};
```

### Then, in the browser

```javascript
import * as UpChunk from '@mux/upchunk';

// Pretend you have an HTML page with an input like: <input id="picker" type="file" />
const picker = document.getElementById('picker');

picker.onchange = () => {
  const getUploadUrl = () =>
    fetch('/the-endpoint-above').then(res =>
      res.ok ? res.text() : throw new Error('Error getting an upload URL :(')
    );

  const upload = UpChunk.createUpload({
    endpoint: getUploadUrl,
    file: picker.files[0],
    chunkSize: 5120, // Uploads the file in ~5mb chunks
  });

  // subscribe to events
  upload.on('error', err => {
    console.error('💥 🙀', err.detail);
  });

  upload.on('progress', progress => {
    console.log(`So far we've uploaded ${progress.detail}% of this file.`);
  });

  upload.on('success', () => {
    console.log("Wrap it up, we're done here. 👋");
  });
};
```

## API

### `createUpload(options)`

Returns an instance of `UpChunk` and begins uploading the specified `File`.

#### `options` object parameters

- `endpoint` <small>type: `string` | `function` (required)</small>

  URL to upload the file to. This can be either a string of the authenticated URL to upload to, or a function that returns a promise that resolves that URL string. The function will be passed the `file` as a parameter.

- `file` <small>type: [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File) (required)</small>

  The file you'd like to upload. For example, you might just want to use the file from an input with a type of "file".

- `headers` <small>type: `Object`</small>

  An object with any headers you'd like included with the `PUT` request for each chunk.

- `chunkSize` <small>type: `integer`, default:`5120`</small>

  The size in kb of the chunks to split the file into, with the exception of the final chunk which may be smaller. This parameter should be in multiples of 256.

- `maxFileSize` <small>type: `integer`</small>

  The maximum size of the file in kb of the input file to be uploaded. The maximum size can technically be smaller than the chunk size, and in that case there would be exactly one chunk.

- `retries` <small>type: `integer`, default: `5`</small>

  The number of times to retry any given chunk.

- `delayBeforeRetry` <small>type: `integer`, default: `1`</small>

  The time in seconds to wait before attempting to upload a chunk again.

- `method` <small>type: `"PUT" | "PATCH" | "POST"`, default: `PUT`</small>

  The HTTP method to use when uploading each chunk.

### UpChunk Instance Methods

- `pause()`

  Pauses an upload after the current in-flight chunk is finished uploading.

- `resume()`

  Resumes an upload that was previously paused.

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

## Credit

The original idea and base for this came from the awesome [huge uploader](https://github.com/Buzut/huge-uploader) project, which is what you need if you're looking to do multipart form data uploads. 👏

Also, @gabrielginter ported upchunk to [Flutter](https://github.com/gabrielginter/flutter-upchunk).
