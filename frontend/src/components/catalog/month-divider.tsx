import { useState } from 'react';
import { catalogThumbnailUrl } from '@/lib/api';
import type { CatalogItem } from '@/lib/api';

/**
 * "Best of [Month]" cover card — shown at the start of each new month group
 * in the timeline. Uses the first image item as the cover photo, displaying
 * the month name and a highlights count.
 *
 * @pattern Google Photos monthly memories card
 */
export function MonthDivider({
  monthLabel,
  year,
  itemCount,
  coverItem,
  apiToken,
}: {
  monthLabel: string;
  year: string;
  itemCount: number;
  coverItem: CatalogItem | undefined;
  apiToken: string | undefined;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const coverUrl = coverItem
    ? catalogThumbnailUrl(coverItem.encodedKey, 'small', apiToken)
    : null;

  return (
    <div className="py-2" data-testid="month-divider">
      <h2 className="mb-2 text-lg font-bold text-slate-800">{monthLabel}</h2>
      <div
        className="relative h-36 w-full max-w-sm overflow-hidden rounded-xl bg-slate-200 sm:h-40"
        role="img"
        aria-label={`Best of ${monthLabel} ${year}`}
      >
        {/* Cover photo */}
        {coverUrl && !imgFailed && (
          <img
            src={coverUrl}
            loading="lazy"
            decoding="async"
            className={`h-full w-full object-cover transition-opacity duration-500 ${
              imgLoaded ? 'opacity-100' : 'opacity-0'
            }`}
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgFailed(true)}
            draggable={false}
          />
        )}

        {/* Fallback gradient when no image or failed */}
        {(!coverUrl || imgFailed) && (
          <div className="absolute inset-0 bg-gradient-to-br from-slate-300 to-slate-400" />
        )}

        {/* Dark overlay for text readability */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />

        {/* Text overlay */}
        <div className="absolute bottom-0 left-0 p-3">
          <p className="text-sm font-semibold text-white drop-shadow-sm">
            Best of {monthLabel}
          </p>
          <p className="text-xs text-white/80">
            {itemCount} highlight{itemCount !== 1 ? 's' : ''}
          </p>
        </div>
      </div>
    </div>
  );
}
