/** Canonical media-file extension sets (with leading dot). */

export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.heic', '.heif', '.avif', '.dng', '.tif', '.tiff',
]);

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.avi', '.m4v', '.3gp', '.3g2', '.mkv', '.webm',
]);

/** Union of IMAGE_EXTENSIONS and VIDEO_EXTENSIONS. */
export const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
