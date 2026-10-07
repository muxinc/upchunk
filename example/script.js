const picker = document.getElementById('picker');
picker.onchange = () => {
  const endpoint = document.getElementById('location').value;
  const file = picker.files[0];
  const shouldTranscode = document.getElementById('transcode').checked;
  const maxResolutionTier = document.getElementById('tier').value;

  const upload = UpChunk.createUpload({
    endpoint,
    file,
    chunkSize: 30720,
    dynamicChunkSize: false,
    transcode: shouldTranscode
      ? UpChunkMediabunny.createMuxTranscoder({ maxResolutionTier })
      : undefined,
  });

  // subscribe to events
  upload.on('error', err => {
    console.error('It all went wrong!', err.detail);
  });

  upload.on('transcodeProgress', ({ detail: progress }) => {
    console.log(`Transcode progress: ${progress.toFixed(1)}%`);
  });

  upload.on('transcodeSuccess', ({ detail }) => {
    console.log(
      detail.transcoded
        ? `Transcoded ${detail.originalFile.name} (${detail.originalFile.size} bytes) to ${detail.file.name} (${detail.file.size} bytes)`
        : `Uploading ${detail.file.name} as-is`,
      { reasons: detail.reasons, notes: detail.notes, report: detail.report }
    );
  });

  upload.on('progress', ({ detail: progress }) => {
    console.log(`Progress: ${progress}%`);
  });

  upload.on('attempt', ({ detail }) => {
    console.log('There was an attempt!', detail);
  });

  upload.on('attemptFailure', ({ detail }) => {
    console.log('The attempt failed!', detail);
  });

  upload.on('chunkSuccess', ({ detail }) => {
    console.log('Chunk successfully uploaded!', detail);
  });

  upload.on('success', () => {
    console.log('We did it!');
  });
};
