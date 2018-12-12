import { EventTarget } from 'event-target-shim';

interface IOptions {
  endpoint: string | ((file?: File) => Promise<string>);
  file: File;
  headers?: Headers;
  chunkSize?: number;
  retries?: number;
  delayBeforeRetry?: number;
}

export class UpChunk {
  endpoint: string | ((file?: File) => Promise<string>);
  file: File;
  headers: Headers;
  chunkSize: number;
  retries: number;
  delayBeforeRetry: number;

  private chunk: Blob;
  private chunkCount: number;
  private chunkByteSize: number;
  private totalChunks: number;
  private retriesCount: number;
  private offline: boolean;
  private paused: boolean;

  private reader: FileReader;
  private eventTarget: EventTarget;

  constructor(options: IOptions) {
    this.endpoint = options.endpoint;
    this.file = options.file;
    this.headers = options.headers || ({} as Headers);
    this.chunkSize = options.chunkSize || 5120;
    this.retries = options.retries || 5;
    this.delayBeforeRetry = options.delayBeforeRetry || 1;

    this.chunkCount = 0;
    this.chunkByteSize = this.chunkSize * 1024;
    this.totalChunks = Math.ceil(this.file.size / this.chunkByteSize);
    this.retriesCount = 0;
    this.offline = false;
    this.paused = false;

    this.reader = new FileReader();
    this.eventTarget = new EventTarget();

    this.validateOptions();
    this.sendChunks();

    // restart sync when back online
    // trigger events when offline/back online
    window.addEventListener('online', () => {
      if (!this.offline) return;

      this.offline = false;
      this.eventTarget.dispatchEvent(new Event('online'));
      this.sendChunks();
    });

    window.addEventListener('offline', () => {
      this.offline = true;
      this.eventTarget.dispatchEvent(new Event('offline'));
    });
  }

  /**
   * Subscribe to an event
   */
  public on(eType: string, fn: (event: Event) => void) {
    this.eventTarget.addEventListener(eType, fn);
  }

  /**
   * Validate options and throw error if not of the right type
   */
  private validateOptions() {
    if (
      !this.endpoint ||
      (typeof this.endpoint !== 'function' && typeof this.endpoint !== 'string')
    )
      throw new TypeError(
        'endpoint must be defined as a string or a function that returns a promise'
      );
    if (this.file instanceof File === false)
      throw new TypeError('file must be a File object');
    if (this.headers && typeof this.headers !== 'object')
      throw new TypeError('headers must be null or an object');
    if (
      this.chunkSize &&
      (typeof this.chunkSize !== 'number' ||
        this.chunkSize <= 0 ||
        this.chunkSize % 256 !== 0)
    )
      throw new TypeError(
        'chunkSize must be a positive number in multiples of 256'
      );
    if (this.retries && (typeof this.retries !== 'number' || this.retries <= 0))
      throw new TypeError('retries must be a positive number');
    if (
      this.delayBeforeRetry &&
      (typeof this.delayBeforeRetry !== 'number' || this.delayBeforeRetry < 0)
    )
      throw new TypeError('delayBeforeRetry must be a positive number');
  }

  /**
   * Endpoint can either be a URL or a function that returns a promise that resolves to a string.
   */
  private getEndpoint() {
    if (typeof this.endpoint === 'string') {
      return Promise.resolve(this.endpoint);
    } else {
      return this.endpoint(this.file);
    }
  }

  /**
   * Get portion of the file of x bytes corresponding to chunkSize
   */
  private getChunk() {
    return new Promise(resolve => {
      // Since we start with 0-chunkSize for the range, we need to subtract 1.
      const length =
        this.totalChunks === 1 ? this.file.size : this.chunkByteSize;
      const start = length * this.chunkCount;

      this.reader.onload = () => {
        if (this.reader.result !== null) {
          this.chunk = new Blob([this.reader.result], {
            type: 'application/octet-stream',
          });
        }
        resolve();
      };

      this.reader.readAsArrayBuffer(this.file.slice(start, start + length));
    });
  }

  /**
   * Send chunk of the file with appropriate headers and add post parameters if it's last chunk
   */
  private sendChunk() {
    const rangeStart = this.chunkCount * this.chunkByteSize;
    const rangeEnd = rangeStart + this.chunk.size - 1;
    const headers = {
      ...this.headers,
      'Content-Type': this.file.type,
      'Content-Length': this.chunk.size,
      'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${this.file.size}`,
    };

    console.log({ headers, size: this.chunk.size });

    return this.getEndpoint().then(endpoint =>
      fetch(endpoint, {
        headers,
        method: 'PUT',
        body: this.chunk,
      })
    );
  }

  /**
   * Called on net failure. If retry counter !== 0, retry after delayBeforeRetry
   */
  private manageRetries() {
    if (this.retriesCount++ < this.retries) {
      setTimeout(() => this.sendChunks(), this.delayBeforeRetry * 1000);
      this.eventTarget.dispatchEvent(
        new CustomEvent('fileRetry', {
          detail: {
            message: `An error occured uploading chunk ${
              this.chunkCount
            }. ${this.retries - this.retriesCount} retries left`,
            chunk: this.chunkCount,
            retriesLeft: this.retries - this.retriesCount,
          },
        })
      );
      return;
    }

    this.eventTarget.dispatchEvent(
      new CustomEvent('error', {
        detail: `An error occured uploading chunk ${
          this.chunkCount
        }. No more retries, stopping upload`,
      })
    );
  }

  /**
   * Manage the whole upload by calling getChunk & sendChunk
   * handle errors & retries and dispatch events
   */
  private sendChunks() {
    if (this.paused || this.offline) return;

    this.getChunk()
      .then(() => this.sendChunk())
      .then(res => {
        if (
          res.status === 308 ||
          res.status === 200 ||
          res.status === 201 ||
          res.status === 204
        ) {
          if (++this.chunkCount < this.totalChunks) this.sendChunks();
          else this.eventTarget.dispatchEvent(new Event('finish'));

          const percentProgress = Math.round(
            (100 / this.totalChunks) * this.chunkCount
          );
          this.eventTarget.dispatchEvent(
            new CustomEvent('progress', { detail: percentProgress })
          );
        }

        // errors that might be temporary, wait a bit then retry
        else if ([408, 502, 503, 504].includes(res.status)) {
          if (this.paused || this.offline) return;
          this.manageRetries();
        } else {
          if (this.paused || this.offline) return;
          this.eventTarget.dispatchEvent(
            new CustomEvent('error', {
              detail: `Server responded with ${res.status}. Stopping upload`,
            })
          );
        }
      })
      .catch(err => {
        if (this.paused || this.offline) return;

        // this type of error can happen after network disconnection on CORS setup
        this.manageRetries();
      });
  }

  public pause() {
    this.paused = true;
  }

  public resume() {
    if (this.paused) {
      this.paused = false;

      this.sendChunks();
    }
  }
}

export const createUpload = (options: IOptions) => new UpChunk(options);
