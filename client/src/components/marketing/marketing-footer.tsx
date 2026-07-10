import { Link } from "react-router-dom";

export function MarketingFooter() {
  return (
    <footer className="border-t border-ink-4/40 bg-ink px-5 py-10 sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-brand text-2xl tracking-tight">pqp</p>
          <p className="mt-2 max-w-xs text-sm text-paper-muted">
            Group chat you own. Self-host or use pqp.gg — same chaos either way.
          </p>
        </div>

        <div className="flex flex-wrap gap-x-10 gap-y-6 text-sm">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-paper-muted">
              Product
            </p>
            <Link to="/app" className="text-paper hover:text-signal">
              Open the app
            </Link>
            <a href="/#how" className="text-paper hover:text-signal">
              How it works
            </a>
            <a href="/#hosting" className="text-paper hover:text-signal">
              Self-host
            </a>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-paper-muted">
              Legal
            </p>
            <Link to="/privacy" className="text-paper hover:text-signal">
              Privacy
            </Link>
            <Link to="/terms" className="text-paper hover:text-signal">
              Terms
            </Link>
            <Link to="/cookies" className="text-paper hover:text-signal">
              Cookies
            </Link>
          </div>
        </div>
      </div>
      <p className="mx-auto mt-10 max-w-5xl text-xs text-paper-muted">
        © {new Date().getFullYear()} pqp. Open source. Built for the group that
        won&apos;t shut up.
      </p>
    </footer>
  );
}
