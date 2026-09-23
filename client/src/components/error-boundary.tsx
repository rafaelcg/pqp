import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  recoverFromChunkLoadError,
  type ChunkErrorAction,
} from "@/lib/chunk-reload";
import { isInCall } from "@/lib/in-call-state";
import { setStaleChunkBannerVisible } from "@/lib/stale-chunk-state";

interface Props {
  children: ReactNode;
  /** Shown instead of the full-page fallback for a contained subtree. */
  fallback?: (reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
  /**
   * Set in `componentDidCatch` when `error` is a stale-chunk failure (a lazy
   * route or `React.lazy` component whose asset the deploy already deleted).
   * `null` for every other kind of render error, which still gets the
   * generic "Something broke" fallback below.
   */
  chunkAction: ChunkErrorAction | null;
}

/**
 * Without this, one bad render — a malformed message body, an unexpected shape
 * from the server — unmounts the entire app and leaves a blank page with the
 * reason only in the console.
 *
 * A dynamic `import()` that 404s because a deploy rotated the asset hashes
 * out from under this tab throws here too: that is how a `React.lazy`
 * failure reaches React at all, so this is also where "outside Vite's
 * preload helper" chunk failures are caught (`vite:preloadError`, the other
 * half, never touches render and is handled in `main.tsx`). Both funnel
 * through the one guarded helper in `lib/chunk-reload.ts` so there is a
 * single answer to "did we already try reloading for this."
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, chunkAction: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, chunkAction: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[pqp] render error:", error, info.componentStack);
    const action = recoverFromChunkLoadError(error, {
      isInCall,
      onDeferred: () => setStaleChunkBannerVisible(true),
    });
    if (action !== "ignored") {
      this.setState({ chunkAction: action });
    }
  }

  reset = () => {
    this.setState({ error: null, chunkAction: null });
  };

  render() {
    const { error, chunkAction } = this.state;
    if (!error) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback(this.reset);
    }

    if (chunkAction === "reloaded") {
      // The page is already being replaced by the reload triggered in
      // componentDidCatch; this is only ever on screen for an instant.
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="font-display text-lg font-bold">Updating pqp…</p>
        </div>
      );
    }

    if (chunkAction === "deferred") {
      // In an active call: never reload out from under it. Same message as
      // the corner card (`StaleChunkBanner`), inline here because this
      // particular subtree has nothing else to show in its place.
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="font-display text-xl font-bold">pqp updated</p>
          <p className="max-w-md text-sm text-paper-muted">
            You are in a call, so this waits for you. Reload when you hang up
            to finish loading the page.
          </p>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="font-display text-3xl font-bold">Something broke</p>
        <p className="max-w-md text-sm text-paper-muted">
          The app hit an unexpected error and stopped rendering. Reloading
          usually clears it.
        </p>
        <pre className="max-w-lg overflow-x-auto rounded-md border border-ink-4 bg-ink px-3 py-2 text-left text-xs text-danger">
          {error.message}
        </pre>
        <div className="flex gap-2">
          <Button onClick={() => window.location.reload()}>Reload</Button>
          <Button variant="secondary" onClick={this.reset}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
}
