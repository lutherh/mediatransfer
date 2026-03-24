export function buildDestinationKey(filename: string, itemId: string, createTime?: string): string {
	const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
	const date = createDatePath(createTime);
	return `transfers/${date}/${itemId}-${sanitized}`;
}

export function createDatePath(createTime?: string): string {
	if (createTime) {
		const date = new Date(createTime);
		if (!Number.isNaN(date.getTime())) {
			return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
		}
	}

	return 'unknown-date';
}
