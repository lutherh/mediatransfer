import type { PipelineStage } from '@/pages/pipeline-page';
import { Card } from '@/components/ui/card';

/* ─── Detail content per stage ─────────────────────────────────── */
const STAGE_DETAILS: Record<
  Exclude<PipelineStage, null>,
  {
    title: string;
    icon: string;
    color: string;
    description: string;
    steps: string[];
    safetyNote?: string;
  }
> = {
  'google-photos': {
    title: 'Google Photos',
    icon: '📸',
    color: 'border-blue-500/40',
    description:
      'This is where your photos and videos live today. Google Photos stores your memories in the cloud, but you don\'t truly own them — Google can change terms, compress quality, or limit storage at any time.',
    steps: [
      'We connect securely to your Google account using OAuth (you never share your password)',
      'You choose which photos and albums to move',
      'Google Takeout packages your selected photos into archives',
      'Original quality is always preserved — no compression',
    ],
    safetyNote: 'Your Google Photos are never deleted — we only copy them.',
  },
  'takeout-download': {
    title: 'Takeout & Processing',
    icon: '📦',
    color: 'border-amber-500/40',
    description:
      'Google Takeout creates downloadable archives of your photos. We automatically download, extract, and organize them — fixing dates, matching sidecar metadata, and preparing everything for upload.',
    steps: [
      'Archives are downloaded automatically in the background',
      'Each archive is extracted and photos are matched with their metadata files',
      'Dates, GPS locations, and descriptions are embedded directly into each photo',
      'HEIC photos are kept in original format (Immich handles conversion)',
      'Duplicates are detected by content hash — no wasted space',
    ],
    safetyNote:
      'If anything goes wrong during processing, the original archives are kept safe so we can retry.',
  },
  'cloud-storage': {
    title: 'Cloud Storage (S3)',
    icon: '☁️',
    color: 'border-purple-500/40',
    description:
      'Your photos are uploaded to Scaleway S3 — an affordable, European cloud storage service. This is your permanent, encrypted archive. Even if your local computer fails, your photos are safe here.',
    steps: [
      'Photos are uploaded to your private S3 bucket in the EU (GDPR-compliant)',
      'Storage class ONEZONE_IA keeps costs very low (about €6/TB/month)',
      'Every upload is verified — the file size in S3 must match the local file exactly',
      'Once verified in S3, local copies can optionally be removed to free disk space',
    ],
    safetyNote:
      'Files are only deleted locally AFTER a triple-safety verification: directory check, per-file size check, and S3 confirmation.',
  },
  'immich-library': {
    title: 'Immich Library',
    icon: '🏠',
    color: 'border-emerald-500/40',
    description:
      'Immich is your private, self-hosted photo library — it looks and works like Google Photos, but runs on YOUR hardware. You own everything. No subscriptions, no AI training on your photos, no storage limits.',
    steps: [
      'Immich reads photos directly from S3 — no extra copies needed',
      'Face recognition, location maps, and search work automatically',
      'You can access your library from any device via the Immich app',
      'Albums, favorites, and sharing work just like Google Photos',
      'Thumbnails and video transcoding are generated locally for fast browsing',
    ],
    safetyNote:
      'Immich is the viewer — your actual photos are safely stored in S3. If Immich breaks, your photos are still safe.',
  },
};

export function PipelineStageDetail({
  stage,
  onClose,
}: {
  stage: Exclude<PipelineStage, null>;
  onClose: () => void;
}) {
  const detail = STAGE_DETAILS[stage];

  return (
    <Card
      className={`border-2 ${detail.color}`}
      style={{
        animation: 'pipelineSlideDown 0.3s ease-out',
      }}
    >

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{detail.icon}</span>
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{detail.title}</h2>
            <p className="text-sm text-slate-400 mt-0.5 leading-relaxed">
              {detail.description}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 rounded-lg p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors"
          aria-label="Close details"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Steps */}
      <div className="mt-4">
        <p className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-2">
          What happens here
        </p>
        <ol className="space-y-2">
          {detail.steps.map((step, i) => (
            <li
              key={i}
              className="flex items-start gap-3 text-sm text-slate-300"
              style={{
                animation: `pipelineSlideDown 0.3s ease-out ${0.1 * (i + 1)}s both`,
              }}
            >
              <span className="flex-shrink-0 flex items-center justify-center h-5 w-5 rounded-full bg-slate-700 text-xs font-semibold text-slate-300 mt-0.5">
                {i + 1}
              </span>
              <span className="leading-relaxed">{step}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Safety note */}
      {detail.safetyNote && (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/20 p-3">
          <span className="text-lg flex-shrink-0">🛡️</span>
          <p className="text-sm text-emerald-300/90 leading-relaxed">
            <span className="font-semibold">Safety:</span> {detail.safetyNote}
          </p>
        </div>
      )}
    </Card>
  );
}
