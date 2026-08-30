/**
 * Quiet platform marks for the download picker. Not official logos — a
 * monitor, an iPhone-shaped phone, and an Android-shaped phone, so the
 * three choices read at a glance without a trademark fight.
 */

export function DesktopMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <rect
        x="4"
        y="6"
        width="24"
        height="16"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M12 26h8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M16 22v4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IosMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <rect
        x="9"
        y="3"
        width="14"
        height="26"
        rx="3.5"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M13 6.5h6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="16" cy="25" r="1" fill="currentColor" />
    </svg>
  );
}

export function AndroidMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <rect
        x="9"
        y="5"
        width="14"
        height="24"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M12 8.5h8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M13 26.5h6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
