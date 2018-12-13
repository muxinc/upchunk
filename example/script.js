const picker = document.getElementById('picker');
picker.onchange = () => {
  const endpoint = document.getElementById('location').value;
  const file = picker.files[0];

  const upload = UpChunk.createUpload({
    endpoint,
    file,
    chunkSize: 5120,
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

  upload.on('success', () => {
    console.log('We did it!');
  });
};
