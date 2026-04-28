import { S3TRANSFERS_PREFIX, UNDATED_PREFIX } from '../utils/storage-paths.js';

export function buildDestinationKey(filename: string, itemId: string, createTime?: string): string {
	const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
	const date = createDatePath(createTime);
	return `${S3TRANSFERS_PREFIX}/${date}/${itemId}-${sanitized}`;
}

export function createDatePath(createTime?: string): string {
	if (createTime) {
		const date = new Date(createTime);
		if (!Number.isNaN(date.getTime())) {
			return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
		}
	}

	return UNDATED_PREFIX;
}
