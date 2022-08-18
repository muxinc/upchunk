import { EventTarget, Event } from 'event-target-shim';
import xhr, { XhrUrlConfig, XhrHeaders, XhrResponse } from 'xhr';

const SUCCESSFUL_CHUNK_UPLOAD_CODES = [200, 201, 202, 204, 308];
const TEMPORARY_ERROR_CODES = [408, 502, 503, 504]; // These error codes imply a chunk may be retried

type EventName =
  | 'attempt'
  | 'attemptFailure'
  | 'chunkSuccess'
  | 'error'
  | 'offline'
  | 'online'
  | 'progress'
  | 'success';

// NOTE: This and the EventTarget definition below could be more precise
// by e.g. typing the detail of the CustomEvent per EventName.
type UpchunkEvent = CustomEvent & Event<EventName>;

type AllowedMethods =
  | 'PUT'
  | 'POST'
  | 'PATCH';

export interface UpChunkOptions {
  endpoint: string | ((file?: File) => Promise<string>);
  file: File;
  method?: AllowedMethods;
  headers?: XhrHeaders;
  maxFileSize?: number;
  chunkSize?: number;
  attempts?: number;
  delayBeforeAttempt?: number;
  dynamicChunkSize?: boolean;
  maxChunkSize?: number;
  minChunkSize?: number;
}

type chunkHistoryRecord = {
  chunk: number,
  attempts: number,
  chunkSize: number,
  timeInterval: number,
};

export class UpChunk  {
  public endpoint: string | ((file?: File) => Promise<string>);
  public file: File;
  public headers: XhrHeaders;
  public method: AllowedMethods;
  public chunkSize: number;
  public attempts: number;
  public delayBeforeAttempt: number;
  public dynamicChunkSize: boolean;

  private chunk: Blob;
  private chunkCount: number;
  private chunkByteSize: number;
  private maxFileBytes: number;
  private endpointValue: string;
  private totalChunks: number;
  private attemptCount: number;
  private offline: boolean;
  private paused: boolean;
  private success: boolean;
  private currentXhr?: XMLHttpRequest;
  private lastChunkStart: Date;
  private chunkHistory: chunkHistoryRecord[];
  private nextChunkRangeStart: number;
  private maxChunkSize: number;
  private minChunkSize: number;

  private reader: FileReader;
  private eventTarget: EventTarget<Record<EventName,UpchunkEvent>>;



  constructor(options: UpChunkOptions) {
    this.endpoint = options.endpoint;
    this.file = options.file;
    this.headers = options.headers || ({} as XhrHeaders);
    this.method = options.method || 'PUT';
    this.chunkSize = options.chunkSize || 30720;
    this.attempts = options.attempts || 5;
    this.delayBeforeAttempt = options.delayBeforeAttempt || 1;
    this.dynamicChunkSize = options.dynamicChunkSize || false;

    this.maxFileBytes = (options.maxFileSize || 0) * 1024;
    this.chunkCount = 0;
    this.chunkByteSize = this.chunkSize * 1024;
    this.totalChunks = Math.ceil(this.file.size / this.chunkByteSize);
    this.attemptCount = 0;
    this.offline = false;
    this.paused = false;
    this.success = false;
    this.chunkHistory = [];
    this.nextChunkRangeStart = 0;
    this.maxChunkSize = options.maxChunkSize || 512000; // in kB
    this.minChunkSize = options.minChunkSize || 256; // in kB

    this.reader = new FileReader();
    this.eventTarget = new EventTarget();

    this.validateOptions();
    this.getEndpoint().then(() => this.sendChunks());

    // restart sync when back online
    // trigger events when offline/back online
    if (typeof(window) !== 'undefined') {
      window.addEventListener('online', () => {
        if (!this.offline) {
          return;
        }

        this.offline = false;
        this.dispatch('online');
        this.sendChunks();
      });

      window.addEventListener('offline', () => {
        this.offline = true;
        this.dispatch('offline');
      });
    }
  }

  /**
   * Subscribe to an event
   */
  public on(eventName: EventName, fn: (event: CustomEvent) => void) {
    this.eventTarget.addEventListener(eventName, fn as EventListener);
  }

  public abort() {
    this.pause();
    this.currentXhr?.abort();
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

  /**
   * Dispatch an event
   */
  private dispatch(eventName: EventName, detail?: any) {
    const event: UpchunkEvent = new CustomEvent(eventName, { detail }) as UpchunkEvent;

    this.eventTarget.dispatchEvent(event);
  }

  /**
   * Validate options and throw errors if expectations are violated.
   */
  private validateOptions() {
    if (
      !this.endpoint ||
      (typeof this.endpoint !== 'function' && typeof this.endpoint !== 'string')
    ) {
      throw new TypeError(
        'endpoint must be defined as a string or a function that returns a promise'
      );
    }
    if (!(this.file instanceof File)) {
      throw new TypeError('file must be a File object');
    }
    if (this.headers && typeof this.headers !== 'object') {
      throw new TypeError('headers must be null or an object');
    }
    if (
      this.chunkSize &&
      (typeof this.chunkSize !== 'number' ||
        this.chunkSize < 256 ||
        this.chunkSize % 256 !== 0 ||
        this.chunkSize < this.minChunkSize ||
        this.chunkSize > this.maxChunkSize)
    ) {
      throw new TypeError(
        `chunkSize must be a positive number in multiples of 256, between ${this.minChunkSize} and ${this.maxChunkSize}`
      );
    }
    if (
      this.maxChunkSize &&
      (typeof this.maxChunkSize !== 'number' ||
        this.maxChunkSize < 256 ||
        this.maxChunkSize % 256 !== 0 ||
        this.maxChunkSize < this.chunkSize ||
        this.maxChunkSize < this.minChunkSize)
    ) {
      throw new TypeError(
        `maxChunkSize must be a positive number in multiples of 256, and larger than or equal to both ${this.minChunkSize} and ${this.chunkSize}`
      );
    }
    if (
      this.minChunkSize &&
      (typeof this.minChunkSize !== 'number' ||
        this.minChunkSize < 256 ||
        this.minChunkSize % 256 !== 0 ||
        this.minChunkSize > this.chunkSize ||
        this.minChunkSize > this.maxChunkSize)
    ) {
      throw new TypeError(
        `minChunkSize must be a positive number in multiples of 256, and smaller than ${this.chunkSize} and ${this.maxChunkSize}`
      );
    }
    if (this.maxFileBytes > 0 && this.maxFileBytes < this.file.size) {
      throw new Error(
        `file size exceeds maximum (${this.file.size} > ${this.maxFileBytes})`
      );
    }
    if (
      this.attempts &&
      (typeof this.attempts !== 'number' || this.attempts <= 0)
    ) {
      throw new TypeError('retries must be a positive number');
    }
    if (
      this.delayBeforeAttempt &&
      (typeof this.delayBeforeAttempt !== 'number' ||
        this.delayBeforeAttempt < 0)
    ) {
      throw new TypeError('delayBeforeAttempt must be a positive number');
    }
  }

  /**
   * Endpoint can either be a URL or a function that returns a promise that resolves to a string.
   */
  private getEndpoint() {
    if (typeof this.endpoint === 'string') {
      this.endpointValue = this.endpoint;
      return Promise.resolve(this.endpoint);
    }

    return this.endpoint(this.file).then((value) => {
      this.endpointValue = value;
      return this.endpointValue;
    });
  }

  /**
   * Get portion of the file of x bytes corresponding to chunkSize
   */
  private getChunk() {
    return new Promise<void> ((resolve) => {
      // Since we start with 0-chunkSize for the range, we need to subtract 1.
      const length =
        this.totalChunks === 1 ? this.file.size : this.chunkByteSize;

      this.reader.onload = () => {
        if (this.reader.result !== null) {
          this.chunk = new Blob([this.reader.result], {
            type: 'application/octet-stream',
          });
        }
        resolve();
      };

      this.reader.readAsArrayBuffer(this.file.slice(this.nextChunkRangeStart, this.nextChunkRangeStart + length));
    });
  }

  private xhrPromise(options: XhrUrlConfig): Promise<XhrResponse> {
    const beforeSend = (xhrObject: XMLHttpRequest) => {
      xhrObject.upload.onprogress = (event: ProgressEvent) => {
        const remainingChunks = this.totalChunks - this.chunkCount;
        // const remainingBytes = this.file.size-(this.nextChunkRangeStart+event.loaded);
        const percentagePerChunk = (this.file.size-this.nextChunkRangeStart)/this.file.size/remainingChunks;
        const successfulPercentage = this.nextChunkRangeStart/this.file.size;
        const currentChunkProgress = event.loaded / (event.total ?? this.chunkByteSize);
        const chunkPercentage = currentChunkProgress * percentagePerChunk;
        this.dispatch('progress', Math.min((successfulPercentage + chunkPercentage)*100, 100));
      };
    };

    return new Promise((resolve, reject) => {
      this.currentXhr = xhr({ ...options, beforeSend }, (err, resp) => {
        this.currentXhr = undefined;
        if (err) {
          return reject(err);
        }

        return resolve(resp);
      });
    });
  }

  /**
   * Send chunk of the file with appropriate headers
   */
  protected async sendChunk() {
    const rangeStart = this.nextChunkRangeStart;
    const rangeEnd = rangeStart + this.chunk.size - 1;
    const headers = {
      ...this.headers,
      'Content-Type': this.file.type,
      'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${this.file.size}`,
    };

    this.dispatch('attempt', {
      chunkNumber: this.chunkCount,
      totalChunks: this.totalChunks,
      chunkSize: this.chunkSize,
    });

    return this.xhrPromise({
      headers,
      url: this.endpointValue,
      method: this.method,
      body: this.chunk,
    });
  }

  /**
   * Called on net failure. If retry counter !== 0, retry after delayBeforeAttempt
   */
  private manageRetries() {
    if (this.attemptCount < this.attempts) {
      setTimeout(() => this.sendChunks(), this.delayBeforeAttempt * 1000);
      this.dispatch('attemptFailure', {
        message: `An error occured uploading chunk ${this.chunkCount}. ${
          this.attempts - this.attemptCount
        } retries left.`,
        chunkNumber: this.chunkCount,
        attemptsLeft: this.attempts - this.attemptCount,
      });
      return;
    }

    this.dispatch('error', {
      message: `An error occured uploading chunk ${this.chunkCount}. No more retries, stopping upload`,
      chunk: this.chunkCount,
      attempts: this.attemptCount,
    });
  }

  /**
   * Manage the whole upload by calling getChunk & sendChunk
   * handle errors & retries and dispatch events
   */
  private sendChunks() {
    if (this.paused || this.offline || this.success) {
      return;
    }

    this.getChunk()
      .then(() => {
        this.attemptCount = this.attemptCount + 1;
        this.lastChunkStart = new Date();
        return this.sendChunk()
      })
      .then((res) => {
        if (SUCCESSFUL_CHUNK_UPLOAD_CODES.includes(res.statusCode)) {
          const lastChunkEnd = new Date();
          const lastChunkInterval = (lastChunkEnd.getTime() - this.lastChunkStart.getTime()) / 1000;

          this.chunkHistory.push({
            chunk: this.chunkCount,
            attempts: this.attemptCount,
            chunkSize: this.chunk.size/1024,
            timeInterval: lastChunkInterval,
          });

          this.dispatch('chunkSuccess', {
            chunk: this.chunkCount,
            chunkSize: this.chunkSize,
            realChunkSize: this.chunk.size,
            attempts: this.attemptCount,
            timeInterval: lastChunkInterval,
            response: res,
          });

          this.attemptCount = 0;
          this.chunkCount = this.chunkCount + 1;
          this.nextChunkRangeStart = this.nextChunkRangeStart + this.chunkByteSize;

          if (this.chunkCount < this.totalChunks) {
            // dynamic chunk sizing
            if (this.dynamicChunkSize) {
              if (lastChunkInterval < 10)
              {
                this.chunkSize = Math.min(this.chunkSize * 2,this.maxChunkSize);
              } else if (lastChunkInterval > 30) {
                this.chunkSize = Math.max(this.chunkSize / 2,this.minChunkSize);
              }

              // Now update the new chunkByteSize to the newly calculated chunk size
              this.chunkByteSize = this.chunkSize * 1024;

              // Re-estimate the total number of chunks, by adding the completed
              // chunks to the remaining chunks
              const remainingChunks = (this.file.size-this.nextChunkRangeStart)/this.chunkByteSize;
              this.totalChunks = Math.ceil(this.chunkCount + remainingChunks);
            }
            this.sendChunks();
          } else {
            this.success = true;
            this.dispatch('success');
          }

        } else if (TEMPORARY_ERROR_CODES.includes(res.statusCode)) {
          if (this.paused || this.offline) {
            return;
          }
	  console.warn('DEBUG: Caught a temporary error: %j',res);
          this.manageRetries();
        } else {
          if (this.paused || this.offline) {
            return;
          }

          this.dispatch('error', {
            message: `Server responded with ${res.statusCode}. Stopping upload.`,
            chunkNumber: this.chunkCount,
            attempts: this.attemptCount,
          });
        }
      })
      .catch((err) => {
        if (this.paused || this.offline) {
          return;
        }

	console.warn('DEBUG: Caught an error: %j',err);
        // this type of error can happen after network disconnection on CORS setup
        this.manageRetries();
      });
  }

  protected getChunkHistory() {
    return this.chunkHistory;
  }
}

export const createUpload = (options: UpChunkOptions) => new UpChunk(options);
