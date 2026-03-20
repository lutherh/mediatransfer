import type { CloudUsageBucketType } from '@/lib/api';

export const BUCKET_TYPE_SETTING_KEY = 'cloudUsage.bucketType';

export function readBucketTypeSetting(): CloudUsageBucketType {
  if (
    typeof window === 'undefined' ||
    !window.localStorage ||
    typeof window.localStorage.getItem !== 'function'
  ) {
    return 'standard';
  }

  const stored = window.localStorage.getItem(BUCKET_TYPE_SETTING_KEY);
  if (stored === 'standard' || stored === 'infrequent' || stored === 'archive') {
    return stored;
  }

  return 'standard';
}

export function writeBucketTypeSetting(value: CloudUsageBucketType): void {
  if (
    typeof window !== 'undefined' &&
    window.localStorage &&
    typeof window.localStorage.setItem === 'function'
  ) {
    window.localStorage.setItem(BUCKET_TYPE_SETTING_KEY, value);
  }
}
