import { Readable } from 'node:stream';

// ── Album ──────────────────────────────────────────────────────

/** A Google Photos album. */
export type Album = {
  /** Album ID. */
  id: string;
  /** Album title. */
  title: string;
  /** Number of media items in the album (may be approximate). */
  mediaItemsCount: number;
  /** Cover photo URL. */
  coverPhotoBaseUrl?: string;
};

// ── MediaItem ──────────────────────────────────────────────────

/** Metadata for a single media item (photo or video). */
export type MediaItem = {
  /** Unique media item ID. */
  id: string;
  /** Original filename (e.g. "IMG_1234.jpg"). */
  filename: string;
  /** MIME type (e.g. "image/jpeg", "video/mp4"). */
  mimeType: string;
  /** Creation time (camera EXIF or upload time). */
  createdAt: Date;
  /** Image/video width in pixels. */
  width: number;
  /** Image/video height in pixels. */
  height: number;
  /**
   * Base URL for accessing the media.
   * Append size parameters (e.g. `=w1920-h1080`) for images or `=dv` for video download.
   * These URLs are **temporary** and expire after ~60 minutes.
   */
  baseUrl: string;
};

// ── Listing options ────────────────────────────────────────────

/** Options for listing media items. */
export type ListMediaItemsOptions = {
  /** Only return items from this album. */
  albumId?: string;
  /** Maximum number of items to return. */
  maxResults?: number;
  /** Page token for pagination. */
  pageToken?: string;
};

/** A paginated page of media items. */
export type MediaItemsPage = {
  items: MediaItem[];
  /** Token for the next page, or undefined if this is the last page. */
  nextPageToken?: string;
};

/** A paginated page of albums. */
export type AlbumsPage = {
  albums: Album[];
  /** Token for the next page, or undefined if this is the last page. */
  nextPageToken?: string;
};

// ── Provider interface ─────────────────────────────────────────

/**
 * Interface for album-based photo providers (e.g. Google Photos).
 *
 * Separate from `CloudProvider` which models flat key-value object storage.
 * This interface models hierarchical album → media-item access with
 * OAuth2-style authentication.
 */
export interface PhotosProvider {
  /** Human-readable name (e.g. "Google Photos"). */
  readonly name: string;

  /**
   * List albums. Supports pagination.
   */
  listAlbums(pageToken?: string): Promise<AlbumsPage>;

  /**
   * List media items, optionally scoped to an album. Supports pagination.
   */
  listMediaItems(options?: ListMediaItemsOptions): Promise<MediaItemsPage>;

  /**
   * Get a single media item by ID.
   */
  getMediaItem(id: string): Promise<MediaItem>;

  /**
   * Download the full-resolution media item as a Node.js Readable stream.
   */
  downloadMedia(mediaItemId: string): Promise<Readable>;
}
