import { EventTarget, Event } from 'event-target-shim';
import xhr from 'xhr';
// NOTE: Need duplicate imports for Typescript version compatibility reasons (CJP)
/* tslint:disable-next-line no-duplicate-imports */
import type { XhrUrlConfig, XhrHeaders, XhrResponse } from 'xhr';

const DEFAULT_CHUNK_SIZE = 30720;
const DEFAULT_MAX_CHUNK_SIZE = 512000; // in kB
const DEFAULT_MIN_CHUNK_SIZE = 256; // in kB

// Predicate function that returns true if a given `chunkSize` is valid, otherwise false.
// For `chunkSize` validity, we constrain by a min/max chunk size and conform to GCS:
// "The chunk size should be a multiple of 256 KiB (256 x 1024 bytes), unless it's the last 
// chunk that completes the upload." (See: https://cloud.google.com/storage/docs/performing-resumable-uploads)
export const isValidChunkSize = (
  chunkSize: any,
  {
    minChunkSize = DEFAULT_MIN_CHUNK_SIZE,
    maxChunkSize = DEFAULT_MAX_CHUNK_SIZE,
  } = {}
): chunkSize is number | null | undefined => {
  return (
    chunkSize == null ||
    (typeof chunkSize === 'number' &&
      chunkSize >= 256 &&
      chunkSize % 256 === 0 &&
      chunkSize >= minChunkSize &&
      chunkSize <= maxChunkSize)
  );
};

// Projection function that returns an error associated with invalid `chunkSize` values.
export const getChunkSizeError = (
  chunkSize: any,
  {
    minChunkSize = DEFAULT_MIN_CHUNK_SIZE,
    maxChunkSize = DEFAULT_MAX_CHUNK_SIZE,
  } = {}
) => {
  return new TypeError(
    `chunkSize ${chunkSize} must be a positive number in multiples of 256, between ${minChunkSize} and ${maxChunkSize}`
  );
};

export type ChunkedStreamIterableOptions = {
  defaultChunkSize?: number;
  minChunkSize?: number;
  maxChunkSize?: number;
};

// An Iterable that accepts a readableStream of binary data (Blob | Uint8Array) and provides
// an asyncIterator which yields Blob values of the current chunkSize until done. Note that
// chunkSize may change between iterations.
export class ChunkedStreamIterable implements AsyncIterable<Blob> {
  protected _chunkSize: number | undefined;
  protected defaultChunkSize: number;
  public readonly minChunkSize: number;
  public readonly maxChunkSize: number;

  constructor(
    protected readableStream: ReadableStream<Uint8Array | Blob>,
    options: ChunkedStreamIterableOptions = {}
  ) {
    if (!isValidChunkSize(options.defaultChunkSize, options)) {
      throw getChunkSizeError(options.defaultChunkSize, options);
    }
    this.defaultChunkSize = options.defaultChunkSize ?? DEFAULT_CHUNK_SIZE;
    this.minChunkSize = options.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;
    this.maxChunkSize = options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  }

  get chunkSize() {
    return this._chunkSize ?? this.defaultChunkSize;
  }

  set chunkSize(value) {
    if (!isValidChunkSize(value, this)) {
      throw getChunkSizeError(value, this);
    }
    this._chunkSize = value;
  }

  get chunkByteSize() {
    return this.chunkSize * 1024;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Blob> {
    let chunk;
    const reader = this.readableStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Last chunk, if any bits remain
          if (chunk) {
            const outgoingChunk = chunk;
            chunk = undefined;
            yield outgoingChunk;
          }
          break;
        }

        const normalizedBlobChunk =
          value instanceof Uint8Array
            ? new Blob([value], { type: 'application/octet-stream' })
            : value;

        chunk = chunk
          ? new Blob([chunk, normalizedBlobChunk])
          : normalizedBlobChunk;

        // NOTE: Since we don't know how big the next chunk needs to be, we should
        // just have a single blob that we "peel away bytes from" for each chunk
        // as we iterate.
        while (chunk) {
          if (chunk.size === this.chunkByteSize) {
            const outgoingChunk = chunk;
            chunk = undefined;
            yield outgoingChunk;
            break;
          } else if (chunk.size < this.chunkByteSize) {
            break;
          } else {
            const outgoingChunk = chunk.slice(0, this.chunkByteSize);
            chunk = chunk.slice(this.chunkByteSize);
            yield outgoingChunk;
          }
        }
      }
    } finally {
      // Last chunk, if any bits remain
      if (chunk) {
        const outgoingChunk = chunk;
        chunk = undefined;
        yield outgoingChunk;
      }
      reader.releaseLock();
      return;
    }
  }
}

const SUCCESSFUL_CHUNK_UPLOAD_CODES = [200, 201, 202, 204, 308];
const TEMPORARY_ERROR_CODES = [408, 502, 503, 504]; // These error codes imply a chunk may be retried

type UploadPredOptions = {
  retryCodes?: typeof TEMPORARY_ERROR_CODES;
  attempts: number;
  attemptCount: number;
};
const isSuccessfulChunkUpload = (
  res: XhrResponse | undefined,
  _options?: any
): res is XhrResponse =>
  !!res && SUCCESSFUL_CHUNK_UPLOAD_CODES.includes(res.statusCode);

const isRetriableChunkUpload = (
  res: XhrResponse | undefined,
  { retryCodes = TEMPORARY_ERROR_CODES }: UploadPredOptions
) => !res || retryCodes.includes(res.statusCode);

const isFailedChunkUpload = (
  res: XhrResponse | undefined,
  options: UploadPredOptions
): res is XhrResponse => {
  return (
    options.attemptCount >= options.attempts ||
    !(isSuccessfulChunkUpload(res) || isRetriableChunkUpload(res, options))
  );
};

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

type AllowedMethods = 'PUT' | 'POST' | 'PATCH';

export interface UpChunkOptions {
  endpoint: string | ((file?: File) => Promise<string>);
  file: File;
  method?: AllowedMethods;
  headers?: XhrHeaders;
  maxFileSize?: number;
  chunkSize?: number;
  attempts?: number;
  delayBeforeAttempt?: number;
  retryCodes?: number[];
  dynamicChunkSize?: boolean;
  maxChunkSize?: number;
  minChunkSize?: number;
}

export class UpChunk {
  public endpoint: string | ((file?: File) => Promise<string>);
  public file: File;
  public headers: XhrHeaders;
  public method: AllowedMethods;
  public attempts: number;
  public delayBeforeAttempt: number;
  public retryCodes: number[];
  public dynamicChunkSize: boolean;
  protected chunkedStreamIterable: ChunkedStreamIterable;
  protected chunkedStreamIterator;

  protected pendingChunk?: Blob;
  private chunkCount: number;
  private maxFileBytes: number;
  private endpointValue: string;
  private totalChunks: number;
  private attemptCount: number;
  private offline: boolean;
  private _paused: boolean;
  private success: boolean;
  private currentXhr?: XMLHttpRequest;
  private lastChunkStart: Date;
  private nextChunkRangeStart: number;

  private eventTarget: EventTarget<Record<EventName, UpchunkEvent>>;

  constructor(options: UpChunkOptions) {
    this.endpoint = options.endpoint;
    this.file = options.file;

    this.headers = options.headers || ({} as XhrHeaders);
    this.method = options.method || 'PUT';
    this.attempts = options.attempts || 5;
    this.delayBeforeAttempt = options.delayBeforeAttempt || 1;
    this.retryCodes = options.retryCodes || TEMPORARY_ERROR_CODES;
    this.dynamicChunkSize = options.dynamicChunkSize || false;

    this.maxFileBytes = (options.maxFileSize || 0) * 1024;
    this.chunkCount = 0;
    this.attemptCount = 0;
    this.offline = false;
    this._paused = false;
    this.success = false;
    this.nextChunkRangeStart = 0;

    // Types appear to be getting confused in env setup, using the overloaded NodeJS Blob definition, which uses NodeJS.ReadableStream instead
    // of the DOM type definitions. For definitions, See consumers.d.ts vs. lib.dom.d.ts. (CJP)
    this.chunkedStreamIterable = new ChunkedStreamIterable(
      this.file.stream() as unknown as ReadableStream<Uint8Array>,
      { ...options, defaultChunkSize: options.chunkSize }
    );
    this.chunkedStreamIterator =
      this.chunkedStreamIterable[Symbol.asyncIterator]();

    this.totalChunks = Math.ceil(this.file.size / this.chunkByteSize);

    this.eventTarget = new EventTarget();

    this.validateOptions();
    this.getEndpoint().then(() => this.sendChunks());

    // restart sync when back online
    // trigger events when offline/back online
    if (typeof window !== 'undefined') {
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

  protected get maxChunkSize() {
    return this.chunkedStreamIterable?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  }

  protected get minChunkSize() {
    return this.chunkedStreamIterable?.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;
  }

  public get chunkSize() {
    return this.chunkedStreamIterable?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  public set chunkSize(value) {
    this.chunkedStreamIterable.chunkSize = value;
  }

  public get chunkByteSize() {
    return this.chunkedStreamIterable.chunkByteSize;
  }

  public get totalChunkSize() {
    return Math.ceil(this.file.size / this.chunkByteSize);
  }

  /**
   * Subscribe to an event
   */
  public on(eventName: EventName, fn: (event: CustomEvent) => void) {
    this.eventTarget.addEventListener(eventName, fn as EventListener);
  }

  /**
   * Subscribe to an event once
   */
  public once(eventName: EventName, fn: (event: CustomEvent) => void) {
    this.eventTarget.addEventListener(eventName, fn as EventListener, { once: true });
  }

  /**
   * Unsubscribe to an event
   */
  public off(eventName: EventName, fn: (event: CustomEvent) => void) {
    this.eventTarget.removeEventListener(eventName, fn as EventListener);
  }

  public get paused() {
    return this._paused;
  }

  public abort() {
    this.pause();
    this.currentXhr?.abort();
  }

  public pause() {
    this._paused = true;
  }

  public resume() {
    if (this._paused) {
      this._paused = false;

      this.sendChunks();
    }
  }

  /**
   * Dispatch an event
   */
  private dispatch(eventName: EventName, detail?: any) {
    const event: UpchunkEvent = new CustomEvent(eventName, {
      detail,
    }) as UpchunkEvent;

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
      !isValidChunkSize(this.chunkSize, {
        maxChunkSize: this.maxChunkSize,
        minChunkSize: this.minChunkSize,
      })
    ) {
      throw getChunkSizeError(this.chunkSize, {
        maxChunkSize: this.maxChunkSize,
        minChunkSize: this.minChunkSize,
      });
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

  private xhrPromise(options: XhrUrlConfig): Promise<XhrResponse> {
    const beforeSend = (xhrObject: XMLHttpRequest) => {
      xhrObject.upload.onprogress = (event: ProgressEvent) => {
        const remainingChunks = this.totalChunks - this.chunkCount;
        // const remainingBytes = this.file.size-(this.nextChunkRangeStart+event.loaded);
        const percentagePerChunk =
          (this.file.size - this.nextChunkRangeStart) /
          this.file.size /
          remainingChunks;
        const successfulPercentage = this.nextChunkRangeStart / this.file.size;
        const currentChunkProgress =
          event.loaded / (event.total ?? this.chunkByteSize);
        const chunkPercentage = currentChunkProgress * percentagePerChunk;
        this.dispatch(
          'progress',
          Math.min((successfulPercentage + chunkPercentage) * 100, 100)
        );
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
  protected async sendChunk(chunk: Blob) {
    const rangeStart = this.nextChunkRangeStart;
    const rangeEnd = rangeStart + chunk.size - 1;
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
      body: chunk,
    });
  }

  protected async sendChunkWithRetries(chunk: Blob): Promise<boolean> {
    // What to do if a chunk was successfully uploaded
    const successfulChunkUploadCb = async (res: XhrResponse, _chunk?: Blob) => {
      // Side effects
      const lastChunkEnd = new Date();
      const lastChunkInterval =
        (lastChunkEnd.getTime() - this.lastChunkStart.getTime()) / 1000;

      this.dispatch('chunkSuccess', {
        chunk: this.chunkCount,
        chunkSize: this.chunkSize,
        attempts: this.attemptCount,
        timeInterval: lastChunkInterval,
        response: res,
      });

      this.attemptCount = 0;
      this.chunkCount = (this.chunkCount ?? 0) + 1;
      this.nextChunkRangeStart = this.nextChunkRangeStart + this.chunkByteSize;
      if (this.dynamicChunkSize) {
        let unevenChunkSize = this.chunkSize;
        if (lastChunkInterval < 10) {
          unevenChunkSize = Math.min(this.chunkSize * 2, this.maxChunkSize);
        } else if (lastChunkInterval > 30) {
          unevenChunkSize = Math.max(this.chunkSize / 2, this.minChunkSize);
        }
        // ensure it's a multiple of 256k
        this.chunkSize = Math.ceil(unevenChunkSize / 256) * 256;

        // Re-estimate the total number of chunks, by adding the completed
        // chunks to the remaining chunks
        const remainingChunks =
          (this.file.size - this.nextChunkRangeStart) / this.chunkByteSize;
        this.totalChunks = Math.ceil(this.chunkCount + remainingChunks);
      }

      return true;
    };

    // What to do if a chunk upload failed, potentially after retries
    const failedChunkUploadCb = async (res: XhrResponse, _chunk?: Blob) => {
      // Side effects
      this.dispatch('error', {
        message: `Server responded with ${
          (res as XhrResponse).statusCode
        }. Stopping upload.`,
        chunk: this.chunkCount,
        attempts: this.attemptCount,
      });

      return false;
    };

    // What to do if a chunk upload failed but is retriable and hasn't exceeded retry
    // count
    const retriableChunkUploadCb = async (
      _res: XhrResponse | undefined,
      _chunk?: Blob
    ) => {
      // Side effects
      this.dispatch('attemptFailure', {
        message: `An error occured uploading chunk ${this.chunkCount}. ${
          this.attempts - this.attemptCount
        } retries left.`,
        chunkNumber: this.chunkCount,
        attemptsLeft: this.attempts - this.attemptCount,
      });

      return new Promise<boolean>((resolve) => {
        setTimeout(async () => {
          // Handle mid-flight _paused/offline cases here by storing the
          // "still retriable but yet to be uploaded chunk" in state.
          // See also: `sendChunks()`
          if (this._paused || this.offline) {
            this.pendingChunk = chunk;
            resolve(false);
            return;
          }
          const chunkUploadSuccess = await this.sendChunkWithRetries(chunk);
          resolve(chunkUploadSuccess);
        }, this.delayBeforeAttempt * 1000);
      });
    };

    let res: XhrResponse | undefined;
    try {
      this.attemptCount = this.attemptCount + 1;
      this.lastChunkStart = new Date();
      res = await this.sendChunk(chunk);
    } catch (_err) {
      // this type of error can happen after network disconnection on CORS setup
    }
    const options = {
      retryCodes: this.retryCodes,
      attemptCount: this.attemptCount,
      attempts: this.attempts,
    };
    if (isSuccessfulChunkUpload(res, options)) {
      return successfulChunkUploadCb(res, chunk);
    }
    if (isFailedChunkUpload(res, options)) {
      return failedChunkUploadCb(res, chunk);
    }
    // Retriable case
    return retriableChunkUploadCb(res, chunk);
  }

  /**
   * Manage the whole upload by calling getChunk & sendChunk
   * handle errors & retries and dispatch events
   */
  private async sendChunks() {
    // A "pending chunk" is a chunk that was unsuccessful but still retriable when
    // uploading was _paused or the env is offline. Since this may be the last
    if (this.pendingChunk && !(this._paused || this.offline)) {
      const chunk = this.pendingChunk;
      this.pendingChunk = undefined;
      const chunkUploadSuccess = await this.sendChunkWithRetries(chunk);
      if (this.success && chunkUploadSuccess) {
        this.dispatch('success');
      }
    }

    while (!(this.success || this._paused || this.offline)) {
      const { value: chunk, done } = await this.chunkedStreamIterator.next();
      // NOTE: When `done`, `chunk` is undefined, so default `chunkUploadSuccess` 
      // to be `true` on this condition, otherwise `false`.
      let chunkUploadSuccess = !chunk && done;
      if (chunk) {
        chunkUploadSuccess = await this.sendChunkWithRetries(chunk);
      }
      // NOTE: Need to disambiguate "last chunk to upload" (done) vs. "successfully"
      // uploaded last chunk to upload" (depends on status of sendChunkWithRetries),
      // specifically for "pending chunk" cases for the last chunk.
      this.success = !!done;
      if (this.success && chunkUploadSuccess) {
        this.dispatch('success');
      }
      if (!chunkUploadSuccess) {
        return;
      }
    }
  }
}

export const createUpload = (options: UpChunkOptions) => new UpChunk(options);
