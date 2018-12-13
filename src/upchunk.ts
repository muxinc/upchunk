import { EventTarget } from 'event-target-shim';

const SUCCESSFUL_CHUNK_UPLOAD_CODES = [200, 201, 202, 204, 308];
const TEMPORARY_ERROR_CODES = [408, 502, 503, 504]; // These error codes imply a chunk may be retried

type EventName =
  | 'attempt'
  | 'attemptFailure'
  | 'error'
  | 'offline'
  | 'online'
  | 'progress'
  | 'success';

interface IOptions {
  endpoint: string | ((file?: File) => Promise<string>);
  file: File;
  headers?: Headers;
  chunkSize?: number;
  attempts?: number;
  delayBeforeRetry?: number;
}

export class UpChunk {
  endpoint: string | ((file?: File) => Promise<string>);
  file: File;
  headers: Headers;
  chunkSize: number;
  attempts: number;
  delayBeforeRetry: number;

  private chunk: Blob;
  private chunkCount: number;
  private chunkByteSize: number;
  private endpointValue: string;
  private totalChunks: number;
  private attemptCount: number;
  private offline: boolean;
  private paused: boolean;

  private reader: FileReader;
  private eventTarget: EventTarget;

  constructor(options: IOptions) {
    this.endpoint = options.endpoint;
    this.file = options.file;
    this.headers = options.headers || ({} as Headers);
    this.chunkSize = options.chunkSize || 5120;
    this.attempts = options.attempts || 5;
    this.delayBeforeRetry = options.delayBeforeRetry || 1;

    this.chunkCount = 0;
    this.chunkByteSize = this.chunkSize * 1024;
    this.totalChunks = Math.ceil(this.file.size / this.chunkByteSize);
    this.attemptCount = 0;
    this.offline = false;
    this.paused = false;

    this.reader = new FileReader();
    this.eventTarget = new EventTarget();

    this.validateOptions();
    this.getEndpoint().then(() => this.sendChunks());

    // restart sync when back online
    // trigger events when offline/back online
    window.addEventListener('online', () => {
      if (!this.offline) return;

      this.offline = false;
      this.dispatch('online');
      this.sendChunks();
    });

    window.addEventListener('offline', () => {
      this.offline = true;
      this.dispatch('offline');
    });
  }

  /**
   * Subscribe to an event
   */
  public on(eventName: EventName, fn: (event: Event) => void) {
    this.eventTarget.addEventListener(eventName, fn);
  }

  /**
   * Dispatch an event
   */
  private dispatch(eventName: EventName, detail?: any) {
    const event = new CustomEvent(eventName, { detail });

    this.eventTarget.dispatchEvent(event);
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
    if (
      this.attempts &&
      (typeof this.attempts !== 'number' || this.attempts <= 0)
    )
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
      this.endpointValue = this.endpoint;
      return Promise.resolve(this.endpoint);
    } else {
      return this.endpoint(this.file).then(value => {
        this.endpointValue = value;
        return this.endpointValue;
      });
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

    this.dispatch('attempt', {
      chunkNumber: this.chunkCount,
      chunkSize: this.chunk.size,
    });

    return fetch(this.endpointValue, {
      headers,
      method: 'PUT',
      body: this.chunk,
    });
  }

  /**
   * Called on net failure. If retry counter !== 0, retry after delayBeforeRetry
   */
  private manageRetries() {
    if (this.attemptCount++ < this.attempts) {
      setTimeout(() => this.sendChunks(), this.delayBeforeRetry * 1000);
      this.dispatch('attemptFailure', {
        message: `An error occured uploading chunk ${this.chunkCount}. ${this
          .attempts - this.attemptCount} retries left.`,
        chunkNumber: this.chunkCount,
        attemptsLeft: this.attempts - this.attemptCount,
      });
      return;
    }

    this.dispatch('error', {
      message: `An error occured uploading chunk ${
        this.chunkCount
      }. No more retries, stopping upload`,
      chunk: this.chunkCount,
      attempts: this.attemptCount,
    });
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
        if (SUCCESSFUL_CHUNK_UPLOAD_CODES.includes(res.status)) {
          if (++this.chunkCount < this.totalChunks) this.sendChunks();
          else this.dispatch('success');

          const percentProgress = Math.round(
            (100 / this.totalChunks) * this.chunkCount
          );

          this.dispatch('progress', percentProgress);
        }

        // errors that might be temporary, wait a bit then retry
        else if (TEMPORARY_ERROR_CODES.includes(res.status)) {
          if (this.paused || this.offline) return;
          this.manageRetries();
        } else {
          if (this.paused || this.offline) return;

          this.dispatch('error', {
            message: `Server responded with ${res.status}. Stopping upload.`,
            chunkNumber: this.chunkCount,
            attempts: this.attemptCount,
          });
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
