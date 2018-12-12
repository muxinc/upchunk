# UpChunk

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
<script src="https://unpkg.com/@mux/upchunk"></script>
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

  upload.on('finish', () => {
    console.log("Wrap it up, we're done here. 👋");
  });
};
```

## Options Object

- ### `endpoint` <small>required</small>

  `string` | `function`

  URL to upload the file to. This can be either a string of the authenticated URL to upload to, or a function that returns a promise that resolves that URL string. The function will be passed the `file` as a parameter.

- ### `file` <small>required</small>

  [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File)

  The file you'd like to upload. For example, you might just want to use the file from an input with a type of "file".

- ### `headers`

  `object`

  An object with any headers you'd like included with the `PUT` request for each chunk.

- ### `chunkSize`

  `integer` default: `5120`

  The size in kb of the chunks to split the file into, with the exception of the final chunk which may be smaller. This parameter should be in multiples of 256.

- ### `retries`

  `integer` default: `5`

  The number of times to retry any given chunk.

- ### `delayBeforeRetry`

  `integer` default: `1`

  The time in seconds to wait before attempting to upload a chunk again.

## Methods

### `pause`

Pauses an upload after the current in-flight chunk is finished uploading.

### `resume`

Resumes an upload that was previously paused.

## Credit

A lot of this original code came from the awesome [huge uploader](https://github.com/Buzut/huge-uploader) project, which is what you need if you're looking to do multipart form data uploads. 👏
