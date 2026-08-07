import { Input } from "@/components/ui/input";

/**
 * The one avatar picker in the app.
 *
 * Lifted out of `settings-modal.tsx` when onboarding needed the same control:
 * two pickers would mean two preset lists, and the day one of them gained a
 * ninth shape the other would quietly be missing it. The presets are remote
 * SVGs rather than bundled assets, which is also why there is exactly one place
 * that names them.
 */
export const AVATAR_PRESETS = [
  "https://api.dicebear.com/9.x/shapes/svg?seed=signal",
  "https://api.dicebear.com/9.x/shapes/svg?seed=phosphor",
  "https://api.dicebear.com/9.x/shapes/svg?seed=desk",
  "https://api.dicebear.com/9.x/shapes/svg?seed=mesh",
  "https://api.dicebear.com/9.x/shapes/svg?seed=lobby",
  "https://api.dicebear.com/9.x/shapes/svg?seed=relay",
  "https://api.dicebear.com/9.x/bottts-neutral/svg?seed=pqp1",
  "https://api.dicebear.com/9.x/bottts-neutral/svg?seed=pqp2",
];

interface AvatarPickerProps {
  value: string;
  onChange: (next: string) => void;
  /** Drawn as an initial when nothing is chosen. */
  fallbackName: string;
  /** Labels, so the caller's language owns the copy rather than this file. */
  labels: {
    urlPlaceholder: string;
    urlLabel: string;
    presetLabel: string;
    clear: string;
  };
}

export function AvatarPicker({
  value,
  onChange,
  fallbackName,
  labels,
}: AvatarPickerProps) {
  return (
    <>
      <div className="mb-2 flex items-center gap-3">
        {value ? (
          <img
            src={value}
            alt=""
            className="h-12 w-12 shrink-0 rounded-md object-cover ring-1 ring-ink-4"
          />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-signal font-display text-lg font-bold text-ink">
            {(fallbackName || "?").slice(0, 1).toUpperCase()}
          </div>
        )}
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={labels.urlPlaceholder}
          aria-label={labels.urlLabel}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {AVATAR_PRESETS.map((url) => (
          <button
            key={url}
            type="button"
            aria-label={labels.presetLabel}
            aria-pressed={value === url}
            className={`h-9 w-9 overflow-hidden rounded-md border ${
              value === url
                ? "border-signal ring-1 ring-signal"
                : "border-ink-4 hover:border-signal/50"
            }`}
            onClick={() => onChange(url)}
          >
            <img src={url} alt="" className="h-full w-full object-cover" />
          </button>
        ))}
        <button
          type="button"
          className="rounded-md border border-ink-4 px-2 text-xs text-paper-muted hover:border-signal/50"
          onClick={() => onChange("")}
        >
          {labels.clear}
        </button>
      </div>
    </>
  );
}
