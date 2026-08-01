import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** Shown instead of the full-page fallback for a contained subtree. */
  fallback?: (reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Without this, one bad render — a malformed message body, an unexpected shape
 * from the server — unmounts the entire app and leaves a blank page with the
 * reason only in the console.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[pqp] render error:", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback(this.reset);
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
