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
- Optionally transcode non-standard media in the browser (via mediabunny) so Mux can process it faster.

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

  URL to upload the file to. This can be either a string of the authenticated URL to upload to, or a function that returns a promise that resolves that URL string. The function will be passed the `file` that is about to be uploaded as its first parameter. When the `transcode` option is used this is the transcoded file, and a second parameter `{ originalFile, transcoded, reasons }` describes what happened.

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

- `transcode` <small>type: `function`</small>

  An async function `(file, { signal, onProgress }) => Promise<File | { file, transcoded, reasons? }>` that runs before the upload starts and returns the file that should actually be uploaded. Call `onProgress(fraction)` with a value between 0 and 1 to drive `transcodeProgress` events, and stop work when `signal` aborts. Resolving with the original `File` (or `transcoded: false`) uploads it untouched. See [Optional: client-side transcoding](#optional-client-side-transcoding-to-mux-standard-input) for the ready-made Mux transcoder built on mediabunny. Note that `maxFileSize` is checked against both the original and the transcoded file.

### UpChunk Instance Properties

- `offline` <small>type: `(readonly) boolean` default: `false`</small>

  Indicates whether or not currently offline. While offline, uploading will pause and resume automatically once back online. See also: `offline` and `online` events, below.

- `paused` <small>type: `(readonly) boolean` default: `false`</small>

  Indicates whether or not uploading has been temporarily paused via the `pause()` method. See also: `pause()` and `resume()` methods, below.

- `transcoding` <small>type: `(readonly) boolean` default: `false`</small>

  `true` while a `transcode` function is running, before any chunk has been uploaded.

- `file` <small>type: `(readonly) File`</small>

  The file being uploaded. When a `transcode` function was supplied this becomes the transcoded file once transcoding finishes.

- `originalFile` <small>type: `(readonly) File`</small>

  The `File` originally passed in via options, regardless of transcoding.

### UpChunk Instance Methods

- `pause()`

  Pauses an upload after the current in-flight chunk is finished uploading. If called while a `transcode` function is still running, the transcode continues but no chunks are uploaded until `resume()` is called.

- `resume()`

  Resumes an upload that was previously paused.

- `abort()`

  The same behavior as `pause()`, but also aborts the in-flight XHR request and cancels an in-flight `transcode`.

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

- `transcodeProgress` <small>`{ detail: [0..100] }`</small>

  Fired while a `transcode` function is running, with the percentage it has reported so far. Only fired when the `transcode` option is used.

- `transcodeSuccess` <small>`{ detail: { file: File, originalFile: File, transcoded: Boolean, reasons?: String[] } }`</small>

  Fired once a `transcode` function has resolved, immediately before the upload starts. `transcoded` is `false` when the original file is being uploaded untouched. The Mux transcoder below adds `notes`, `report` and `summary` to the detail. Transcode failures are reported via the `error` event with a message starting with `Transcode failed`.

## Optional: client-side transcoding to Mux standard input

Mux processes files that match its [standard input specification](https://www.mux.com/docs/guides/minimize-processing-time#standard-input-specs) much faster than files that do not (for example screen recordings in WebM, VP9 or AV1, HEVC with long keyframe intervals, very high bitrates, 4K sources on the 1080p tier, or non-AAC audio). UpChunk ships an optional transcoder built on [mediabunny](https://mediabunny.dev) that inspects a file in the browser using WebCodecs and, only when needed, rewrites it into an H.264/AAC MP4 that meets the spec before uploading.

It is opt-in and lives in a separate entry point so the core `@mux/upchunk` bundle stays small. `mediabunny` is an optional peer dependency.

```
npm install --save @mux/upchunk mediabunny
```

```javascript
import * as UpChunk from '@mux/upchunk';
import { createMuxTranscoder } from '@mux/upchunk/mediabunny';

const upload = UpChunk.createUpload({
  endpoint: getUploadUrl,
  file: picker.files[0],
  transcode: createMuxTranscoder({ maxResolutionTier: '1080p' }),
});

upload.on('transcodeProgress', ({ detail }) => console.log(`Transcoding: ${detail}%`));
upload.on('transcodeSuccess', ({ detail }) => {
  // detail.transcoded tells you whether anything changed, detail.reasons why.
  console.log(detail.transcoded ? `Transcoded because: ${detail.reasons.join(', ')}` : 'Uploading as-is');
});
```

Or with a script tag, which exposes a `UpChunkMediabunny` global and bundles mediabunny for you:

```
<script src="https://unpkg.com/@mux/upchunk@3"></script>
<script src="https://unpkg.com/@mux/upchunk@3/dist/upchunk-mediabunny.js"></script>
```

### What it does

1. Reads the container and track metadata (no decoding) and scans the video packets to find the longest keyframe interval and the bitrate.
2. Compares against the Mux spec for the chosen `maxResolutionTier`: H.264 or HEVC video, 8-bit 4:2:0 (10-bit allowed for HEVC), resolution, average and per-GOP bitrate, keyframe interval, frame rate, and AAC mono/stereo/5.1 audio.
3. If everything conforms and the container is MP4/MOV, the original file is uploaded untouched.
4. Otherwise it converts to MP4. Tracks that already conform are copied without re-encoding; only the offending tracks are transcoded (video to H.264, audio to AAC). A conforming file in a WebM or Matroska container is simply remuxed.

Use `analyzeFile(file, options)` from the same entry point to get the report without transcoding, for example to warn users before they start.

To see the difference for yourself, run `yarn start` and open [`/compare.html`](example/compare.html), which uploads a file with and without transcoding side by side.

### Options for `createMuxTranscoder(options)`

- `maxResolutionTier` <small>`'1080p' | '2160p'`, default `'1080p'`</small>: match the `max_resolution_tier` of your Mux asset. Controls the resolution, bitrate, keyframe interval and frame rate limits applied.
- `mode` <small>`'auto' | 'always'`, default `'auto'`</small>: `'always'` re-encodes every track even when the input already conforms.
- `keyFrameInterval` <small>seconds, default `5`</small>: keyframe interval used when video is re-encoded.
- `videoBitrate` <small>bits per second</small>: override the target video bitrate. By default the source bitrate is kept, capped at 85% of the tier limit and scaled with any downscale.
- `hardwareAcceleration` <small>`'no-preference' | 'prefer-hardware' | 'prefer-software'`</small>: passed through to WebCodecs.
- `audioFallback` <small>`'opus' | 'none'`, default `'opus'`</small>: what to do when the browser cannot encode AAC. See browser support below.
- `fallbackToOriginal` <small>boolean, default `true`</small>: when transcoding fails or the browser lacks a usable encoder, upload the original file and report the failure in `transcodeSuccess` (`detail.notes` includes `transcode_failed_uploading_original` and `detail.error` carries the cause). Set to `false` to receive an `error` event instead.
- `maxInputBytes` <small>bytes, default 2 GiB</small>: the transcoded file is currently held in memory before upload. Files larger than this are uploaded untouched.
- `gopScan` <small>`{ maxPackets, maxSeconds, timeBudgetMs }`</small>: bounds for the keyframe scan on very long files. If the budget is exhausted without finding a violation the file is treated as conforming.

### Browser support and caveats

- Requires WebCodecs: Chromium 94+, Safari 16.4+ (audio encoding from Safari 26), Firefox 130+ on desktop. Without WebCodecs the file is uploaded untouched.
- H.264 encoding is available in all of those. AAC encoding is **not** available in Firefox or in any browser on desktop Linux. In that case audio that MP4 can carry (Opus, MP3, FLAC) is copied and other audio is encoded to Opus; Mux then transcodes just the audio server-side. To get AAC everywhere, install `@mediabunny/aac-encoder` and call its `registerAacEncoder()` before uploading.
- Only what mediabunny can see is checked. Open GOPs, edit lists and exotic pixel formats are not detectable client-side, so Mux may still report `non_standard_input_reasons` for some files.
- HEVC that conforms is copied, not re-encoded. Re-encoded video is always H.264.
- The transcoded MP4 is buffered in memory (see `maxInputBytes`). Expect roughly the output file size in RAM during the upload.
- TypeScript consumers of the `@mux/upchunk/mediabunny` entry need `skipLibCheck: true` (or `lib: ["esnext"]`) because mediabunny's own type declarations rely on newer library types.
- `dist/upchunk-mediabunny.js` bundles mediabunny, which is licensed under the MPL-2.0. The notice is emitted alongside it in `dist/upchunk-mediabunny.js.LEGAL.txt`.

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
