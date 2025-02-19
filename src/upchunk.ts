import { EventTarget, Event } from 'event-target-shim';
import xhr from 'xhr';
// NOTE: Need duplicate imports for Typescript version compatibility reasons (CJP)
/* tslint:disable-next-line no-duplicate-imports */
import type { XhrUrlConfig, XhrHeaders, XhrResponse } from 'xhr';

type XhrResponseLike = Partial<XhrResponse> & Pick<XhrResponse, 'statusCode'>;

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

export interface ChunkedIterable extends AsyncIterable<Blob> {
  chunkSize: number;
  readonly chunkByteSize: number;
  readonly minChunkSize: number;
  readonly maxChunkSize: number;
  readonly error: Error | undefined;
}

// An Iterable that accepts a readableStream of binary data (Blob | Uint8Array) and provides
// an asyncIterator which yields Blob values of the current chunkSize until done. Note that
// chunkSize may change between iterations.
export class ChunkedStreamIterable implements ChunkedIterable {
  protected _chunkSize: number | undefined;
  protected defaultChunkSize: number;
  protected _error: Error | undefined;
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

  get error() {
    return this._error;
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
    } catch (e) {
      // There are edge case errors when attempting to read() from ReadableStream reader.
      this._error = e;
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

export class ChunkedFileIterable implements ChunkedIterable {
  protected _chunkSize: number | undefined;
  protected defaultChunkSize: number;
  protected _error: Error | undefined;
  public readonly minChunkSize: number;
  public readonly maxChunkSize: number;

  constructor(
    protected file: File,
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

  get error() {
    return this._error;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Blob> {
    const reader = new FileReader();
    let nextChunkRangeStart = 0;
    /**
     * Get portion of the file of x bytes corresponding to chunkSize
     */
    const getChunk = () => {
      return new Promise<Blob | undefined>((resolve) => {
        if (nextChunkRangeStart >= this.file.size) {
          resolve(undefined);
          return;
        }
        // We either want to slize a "chunkByteSize-worth" of the file or
        // slice to the end of the file (if less than a "chunkByteSize-worth" is left)
        const length = Math.min(
          this.chunkByteSize,
          this.file.size - nextChunkRangeStart
        );
        reader.onload = () => {
          if (reader.result !== null) {
            resolve(
              new Blob([reader.result], {
                type: 'application/octet-stream',
              })
            );
          } else {
            resolve(undefined);
          }
        };

        reader.readAsArrayBuffer(
          this.file.slice(nextChunkRangeStart, nextChunkRangeStart + length)
        );
      });
    };
    try {
      while (true) {
        const nextChunk = await getChunk();
        if (!!nextChunk) {
          nextChunkRangeStart += nextChunk.size;
          yield nextChunk;
        } else {
          break;
        }
      }
    } catch (e) {
      this._error = e;
    }
  }
}

const SUCCESSFUL_CHUNK_UPLOAD_CODES = [200, 201, 202, 204, 308];
const TEMPORARY_ERROR_CODES = [408, 502, 503, 504]; // These error codes imply a chunk may be retried
const RESUME_INCOMPLETE_CODES = [308];

type UploadPredOptions = {
  retryCodes?: typeof TEMPORARY_ERROR_CODES;
  attempts: number;
  attemptCount: number;
};
const isSuccessfulChunkUpload = (
  res: XhrResponseLike | undefined,
  _options?: any
): res is XhrResponse =>
  !!res && SUCCESSFUL_CHUNK_UPLOAD_CODES.includes(res.statusCode);

const isRetriableChunkUpload = (
  res: XhrResponseLike | undefined,
  { retryCodes = TEMPORARY_ERROR_CODES }: UploadPredOptions
) => !res || retryCodes.includes(res.statusCode);

const isFailedChunkUpload = (
  res: XhrResponseLike | undefined,
  options: UploadPredOptions
): res is XhrResponseLike => {
  return (
    options.attemptCount >= options.attempts ||
    !(isSuccessfulChunkUpload(res) || isRetriableChunkUpload(res, options))
  );
};

/**
 * Checks if an upload chunk was partially received (HTTP 308) and needs a retry.
 * Validates against the 'Range' header to ensure the full chunk was processed.
 */
export const isIncompleteChunkUploadNeedingRetry = (
  res: XhrResponseLike | undefined,
  _options?: any
): res is XhrResponseLike => {
  if (
    !res ||
    !RESUME_INCOMPLETE_CODES.includes(res.statusCode) ||
    !res.headers?.['range']
  ) {
    return false;
  }

  const range = res.headers['range'].match(/bytes=(\d+)-(\d+)/);
  if (!range) {
    return false;
  }

  const endByte = parseInt(range[2], 10);
  // NOTE: Since the endpoint may have been used previously and uploaded multiple chunks,
  // only treat as an incomplete chunk upload if the end byte from the response header is
  // less than the current chunk's end byte.
  return endByte < _options.currentChunkEndByte;
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
  headers?: XhrHeaders | (() => XhrHeaders) | (() => Promise<XhrHeaders>);
  maxFileSize?: number;
  chunkSize?: number;
  attempts?: number;
  delayBeforeAttempt?: number;
  retryCodes?: number[];
  dynamicChunkSize?: boolean;
  maxChunkSize?: number;
  minChunkSize?: number;
  useLargeFileWorkaround?: boolean;
}

export class UpChunk {
  public static createUpload(options: UpChunkOptions) {
    return new UpChunk(options);
  }

  public endpoint: string | ((file?: File) => Promise<string>);
  public file: File;
  public headers: XhrHeaders | (() => XhrHeaders) | (() => Promise<XhrHeaders>);
  public method: AllowedMethods;
  public attempts: number;
  public delayBeforeAttempt: number;
  public retryCodes: number[];
  public dynamicChunkSize: boolean;
  protected chunkedIterable: ChunkedIterable;
  protected chunkedIterator;

  protected pendingChunk?: Blob;
  private chunkCount: number;
  private maxFileBytes: number;
  private endpointValue: string;
  private totalChunks: number;
  private attemptCount: number;
  private _offline: boolean;
  private _paused: boolean;
  private success: boolean;
  private currentXhr?: XMLHttpRequest;
  private lastChunkStart: Date;
  private nextChunkRangeStart: number;

  private eventTarget: EventTarget<Record<EventName, UpchunkEvent>>;

  constructor(options: UpChunkOptions) {
    this.eventTarget = new EventTarget();

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
    // Initialize offline to the current offline state, where
    // offline is false if
    // 1. we're not running in the browser (aka window is undefined) -OR-
    // 2. we're not online (as advertised by navigator.onLine)
    this._offline = typeof window !== 'undefined' && !window.navigator.onLine;
    this._paused = false;
    this.success = false;
    this.nextChunkRangeStart = 0;

    if (options.useLargeFileWorkaround) {
      const readableStreamErrorCallback = (event: CustomEvent) => {
        // In this case, assume the error is a result of file reading via ReadableStream.
        // Retry using ChunkedFileIterable, which reads the file into memory instead
        // of a stream.
        if (this.chunkedIterable.error) {
          console.warn(
            `Unable to read file of size ${this.file.size} bytes via a ReadableStream. Falling back to in-memory FileReader!`
          );
          event.stopImmediatePropagation();

          // Re-set everything up with the fallback iterable and corresponding
          // iterator
          this.chunkedIterable = new ChunkedFileIterable(this.file, {
            ...options,
            defaultChunkSize: options.chunkSize,
          });
          this.chunkedIterator = this.chunkedIterable[Symbol.asyncIterator]();
          this.getEndpoint()
            .then(() => {
              this.sendChunks();
            })
            .catch((e) => {
              const message = e?.message ? `: ${e.message}` : '';
              this.dispatch('error', {
                message: `Failed to get endpoint${message}`,
              });
            });
          this.off('error', readableStreamErrorCallback);
        }
      };
      this.on('error', readableStreamErrorCallback);
    }

    // Types appear to be getting confused in env setup, using the overloaded NodeJS Blob definition, which uses NodeJS.ReadableStream instead
    // of the DOM type definitions. For definitions, See consumers.d.ts vs. lib.dom.d.ts. (CJP)
    this.chunkedIterable = new ChunkedStreamIterable(
      this.file.stream() as unknown as ReadableStream<Uint8Array>,
      { ...options, defaultChunkSize: options.chunkSize }
    );
    this.chunkedIterator = this.chunkedIterable[Symbol.asyncIterator]();

    // NOTE: Since some of upchunk's properties defer "source of truth" to
    // chunkedIterable, we need to do these after it's been created (CJP).
    this.totalChunks = Math.ceil(this.file.size / this.chunkByteSize);
    this.validateOptions();

    this.getEndpoint()
      .then(() => this.sendChunks())
      .catch((e) => {
        const message = e?.message ? `: ${e.message}` : '';
        this.dispatch('error', {
          message: `Failed to get endpoint${message}`,
        });
      });

    // restart sync when back online
    // trigger events when offline/back online
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (!this.offline) return;

        this._offline = false;
        this.dispatch('online');
        this.sendChunks();
      });

      window.addEventListener('offline', () => {
        if (this.offline) return;

        this._offline = true;
        this.dispatch('offline');
      });
    }
  }

  protected get maxChunkSize() {
    return this.chunkedIterable?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  }

  protected get minChunkSize() {
    return this.chunkedIterable?.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;
  }

  public get chunkSize() {
    return this.chunkedIterable?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  public set chunkSize(value) {
    this.chunkedIterable.chunkSize = value;
  }

  public get chunkByteSize() {
    return this.chunkedIterable.chunkByteSize;
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
    this.eventTarget.addEventListener(eventName, fn as EventListener, {
      once: true,
    });
  }

  /**
   * Unsubscribe to an event
   */
  public off(eventName: EventName, fn: (event: CustomEvent) => void) {
    this.eventTarget.removeEventListener(eventName, fn as EventListener);
  }

  public get offline() {
    return this._offline;
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

  public get successfulPercentage() {
    return this.nextChunkRangeStart / this.file.size;
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
    if (
      this.headers &&
      typeof this.headers !== 'function' &&
      typeof this.headers !== 'object'
    ) {
      throw new TypeError(
        'headers must be null, an object, or a function that returns an object or a promise'
      );
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
      if (typeof value !== 'string') {
        throw new TypeError('endpoint must return a string');
      }
      return this.endpointValue;
    });
  }

  private xhrPromise(options: XhrUrlConfig): Promise<XhrResponse> {
    const beforeSend = (xhrObject: XMLHttpRequest) => {
      xhrObject.upload.onprogress = (event: ProgressEvent) => {
        const remainingChunks = this.totalChunks - this.chunkCount;
        const percentagePerChunk =
          (this.file.size - this.nextChunkRangeStart) /
          this.file.size /
          remainingChunks;
        const currentChunkProgress =
          event.loaded / (event.total ?? this.chunkByteSize);
        const chunkPercentage = currentChunkProgress * percentagePerChunk;
        // NOTE: Since progress events are "eager" and do not (yet) have sufficient context
        // to "know" if the request was e.g. successful, we need to "recompute"/"rewind"
        // progress if/when we detect failures. See failedChunkUploadCb(), below. (CJP)
        this.dispatch(
          'progress',
          Math.min((this.successfulPercentage + chunkPercentage) * 100, 100)
        );
      };
    };

    return new Promise((resolve, reject) => {
      this.currentXhr = xhr({ ...options, beforeSend }, (err, resp) => {
        this.currentXhr = undefined;
        // NOTE: For at least some `err` cases, resp will still carry information. We may want to consider passing that on somehow
        // in our Promise reject (or instead of err) (CJP)
        // See: https://github.com/naugtur/xhr/blob/master/index.js#L93-L100
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
    const extraHeaders = await (typeof this.headers === 'function'
      ? this.headers()
      : this.headers);

    const headers = {
      ...extraHeaders,
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
    const failedChunkUploadCb = async (res: XhrResponseLike, _chunk?: Blob) => {
      this.dispatch('progress', Math.min(this.successfulPercentage * 100, 100));
      // Side effects
      this.dispatch('error', {
        message: `Server responded with ${res.statusCode}. Stopping upload.`,
        chunk: this.chunkCount,
        attempts: this.attemptCount,
        response: res,
      });

      return false;
    };

    // What to do if a chunk upload failed but is retriable and hasn't exceeded retry
    // count
    const retriableChunkUploadCb = async (
      res: XhrResponseLike | undefined,
      _chunk?: Blob
    ) => {
      // Side effects
      this.dispatch('attemptFailure', {
        message: `An error occured uploading chunk ${this.chunkCount}. ${
          this.attempts - this.attemptCount
        } retries left.`,
        chunkNumber: this.chunkCount,
        attemptsLeft: this.attempts - this.attemptCount,
        response: res,
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

    let res: XhrResponseLike | undefined;
    try {
      this.attemptCount = this.attemptCount + 1;
      this.lastChunkStart = new Date();
      res = await this.sendChunk(chunk);
    } catch (err: unknown) {
      // Account for failed attempts due to becoming offline while making a request.
      if (typeof (err as any)?.statusCode === 'number') {
        res = err as XhrResponseLike;
      }
    }
    const options = {
      retryCodes: this.retryCodes,
      attemptCount: this.attemptCount,
      attempts: this.attempts,
      currentChunkEndByte: this.nextChunkRangeStart + chunk.size - 1, // end byte is inclusive
    };
    if (isIncompleteChunkUploadNeedingRetry(res, options)) {
      return retriableChunkUploadCb(res, chunk);
    }
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
    // uploading was _paused or the env is offline. Since this may be the last chunk,
    // we account for it outside of the loop.
    if (this.pendingChunk && !(this._paused || this.offline)) {
      const chunk = this.pendingChunk;
      this.pendingChunk = undefined;
      const chunkUploadSuccess = await this.sendChunkWithRetries(chunk);
      if (this.success && chunkUploadSuccess) {
        this.dispatch('success');
      }
    }

    while (!(this.success || this._paused || this.offline)) {
      const { value: chunk, done } = await this.chunkedIterator.next();
      // NOTE: When `done`, `chunk` is undefined, so default `chunkUploadSuccess`
      // to be `true` on this condition, otherwise `false`.
      let chunkUploadSuccess = !chunk && done;
      if (chunk) {
        chunkUploadSuccess = await this.sendChunkWithRetries(chunk);
      }

      if (this.chunkedIterable.error) {
        chunkUploadSuccess = false;
        this.dispatch('error', {
          message: `Unable to read file of size ${this.file.size} bytes. Try loading from another browser.`,
        });
        return;
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

export function createUpload(options: UpChunkOptions) {
  return UpChunk.createUpload(options);
}
