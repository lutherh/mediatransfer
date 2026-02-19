import { Readable } from 'node:stream';

/**
 * Metadata for a single object in a cloud storage bucket/container.
 */
export type ObjectInfo = {
  /** Full key / path of the object (e.g. "photos/2026/img001.jpg") */
  key: string;
  /** Size in bytes */
  size: number;
  /** Last-modified timestamp */
  lastModified: Date;
  /** Optional content type (MIME) */
  contentType?: string;
};

/**
 * Options for listing objects.
 */
export type ListOptions = {
  /** Only return objects whose key starts with this prefix */
  prefix?: string;
  /** Maximum number of results to return (provider may impose its own cap) */
  maxResults?: number;
};

/**
 * A cloud storage provider that can list, download, upload, and delete objects.
 *
 * Every provider implementation must satisfy this interface.
 */
export interface CloudProvider {
  /** Human-readable name of the provider (e.g. "AWS S3", "Google Cloud Storage") */
  readonly name: string;

  /**
   * List objects in the configured bucket / container.
   */
  list(options?: ListOptions): Promise<ObjectInfo[]>;

  /**
   * Download a single object and return it as a Node.js Readable stream.
   */
  download(key: string): Promise<Readable>;

  /**
   * Upload data from the given Readable stream to the specified key.
   * @param key  Destination key / path in the bucket.
   * @param stream  The data to upload.
   * @param contentType  Optional MIME type.
   */
  upload(key: string, stream: Readable, contentType?: string): Promise<void>;

  /**
   * Delete a single object by key.
   */
  delete(key: string): Promise<void>;
}

/**
 * Configuration required to initialise a provider instance.
 * The exact shape is provider-specific; this is the common envelope.
 */
export type ProviderConfig = {
  /** Provider identifier (e.g. "s3", "gcs", "azure-blob", "scaleway") */
  provider: string;
  /** Provider-specific configuration (bucket name, region, credentials, …) */
  [key: string]: unknown;
};

/**
 * A factory function that creates a CloudProvider from configuration.
 */
export type ProviderFactory = (config: ProviderConfig) => CloudProvider;
