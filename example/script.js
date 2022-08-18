const picker = document.getElementById('picker');
picker.onchange = () => {
  const endpoint = document.getElementById('location').value;
  const file = picker.files[0];

  const upload = UpChunk.createUpload({
    endpoint,
    file,
    chunkSize: 30720,
    dynamicChunkSize: false,
  });

  // subscribe to events
  upload.on('error', err => {
    console.error('It all went wrong!', err.detail);
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
    console.log('Chunk history: ',upload.getChunkHistory());
  });
};
