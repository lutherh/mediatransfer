// Cloud provider implementations
export type {
  CloudProvider,
  ObjectInfo,
  ListOptions,
  ProviderConfig,
  ProviderFactory,
} from './types.js';
export {
  registerProvider,
  getProviderFactory,
  listProviderNames,
  clearProviders,
} from './registry.js';
export {
  ScalewayProvider,
  createScalewayProvider,
  resolveScalewayEndpoint,
  validateScalewayConfig,
  type ScalewayConfig,
} from './scaleway.js';

// Photos provider types
export type {
  PhotosProvider,
  Album,
  MediaItem,
  ListMediaItemsOptions,
  MediaItemsPage,
  AlbumsPage,
} from './photos-types.js';

// Google Photos auth
export {
  createOAuth2Client,
  getAuthUrl,
  getAuthUrlForScopes,
  exchangeCode,
  setTokens,
  getValidAccessToken,
  isTokenExpired,
  GOOGLE_PHOTOS_SCOPES,
  GOOGLE_PHOTOS_READONLY_SCOPE,
  GOOGLE_PHOTOS_APPENDONLY_SCOPE,
  GOOGLE_PHOTOS_PICKER_SCOPE,
  type GoogleAuthConfig,
  type GoogleTokens,
} from './google-photos-auth.js';

// Google Photos provider
export { GooglePhotosProvider } from './google-photos.js';

// Google Photos Picker API client
export {
  GooglePhotosPickerClient,
  type PickerSession,
  type PickerPollingConfig,
  type PickedMediaItem,
  type PickedMediaItemsPage,
} from './google-photos-picker.js';
