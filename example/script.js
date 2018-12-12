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
    console.error('Something bad happened', err.detail);
  });

  upload.on('progress', progress => {
    console.log(`The upload is at ${progress.detail}%`);
  });

  upload.on('finish', () => {
    console.log('yeahhh');
  });
};
