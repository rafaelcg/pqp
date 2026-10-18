import { Link } from "react-router-dom";
import { BetaTag } from "@/components/ui/beta-tag";
import { cn } from "@/lib/utils";
import { JoinButton, SignInButton } from "../shared/auth-buttons";
import { CONTAINER } from "./ui";

const LINKS = [
  { href: "#cartazes", label: "Em cartaz" },
  { href: "#import", label: "Vindo do Discord" },
  { href: "#mural", label: "O mural" },
  { href: "#codigo", label: "Código aberto" },
];

/** The wall's own header: dark, so the shared tag and sign-in button read as designed. */
export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-paper/10 bg-ink/95">
      <div className={cn(CONTAINER, "flex h-16 items-center gap-3")}>
        <Link
          to="/preview/home/c2"
          className="flex items-center gap-2 rounded-sm font-brand text-xl tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
        >
          pqp
          <BetaTag />
        </Link>
        <nav aria-label="Seções" className="ml-4 hidden items-center gap-1 lg:flex">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-sm px-2.5 py-1.5 font-display text-[12px] font-bold uppercase tracking-[0.14em] text-paper-muted transition-colors hover:bg-signal hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <SignInButton className="inline-flex h-10 items-center rounded-sm px-3 text-sm font-semibold text-paper-muted transition-colors hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal" />
          <JoinButton className="inline-flex h-10 items-center rounded-md border-2 border-signal bg-signal px-4 font-display text-[13px] font-bold uppercase tracking-[0.05em] text-ink shadow-[3px_3px_0_0_var(--color-text)] transition-[transform,box-shadow] hover:-translate-x-px hover:-translate-y-px hover:shadow-[4px_4px_0_0_var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper focus-visible:ring-offset-2 focus-visible:ring-offset-ink active:translate-x-[2px] active:translate-y-[2px] active:shadow-none motion-reduce:transition-none">
            Começar
          </JoinButton>
        </div>
      </div>
    </header>
  );
}
