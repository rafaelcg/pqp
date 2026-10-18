import { ChevronUp, LayoutGrid, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { HOME_VARIANTS } from "../variants";

const COLLAPSED_KEY = "pqp:home-preview-bar-collapsed";

function readCollapsed(): boolean {
  try {
    return window.sessionStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean) {
  try {
    window.sessionStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // Private mode or blocked storage: the bar simply forgets.
  }
}

/**
 * Review chrome, not part of any design: a small floating pill to jump
 * between the versions. Keys 1 to 5 switch too, unless a field has focus.
 */
export function PreviewBar({ current }: { current: string }) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const index = Number(event.key) - 1;
      const variant = HOME_VARIANTS[index];
      if (variant && variant.id !== current) {
        void navigate(`/preview/home/${variant.id}`);
        window.scrollTo({ top: 0 });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, navigate]);

  const setAndStore = (value: boolean) => {
    setCollapsed(value);
    writeCollapsed(value);
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setAndStore(false)}
        className="fixed bottom-4 right-4 z-[60] grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/80 text-white shadow-lg backdrop-blur-md transition-colors hover:bg-black"
        aria-label="Mostrar as versões"
      >
        <ChevronUp className="h-4 w-4" aria-hidden />
      </button>
    );
  }

  return (
    <nav
      aria-label="Versões da prévia"
      className="fixed bottom-4 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-full border border-white/15 bg-black/80 p-1 text-xs text-white shadow-2xl backdrop-blur-md"
    >
      <Link
        to="/preview/home"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        aria-label="Todas as versões"
        title="Todas as versões"
      >
        <LayoutGrid className="h-4 w-4" aria-hidden />
      </Link>
      {HOME_VARIANTS.map((variant, i) => (
        <Link
          key={variant.id}
          to={`/preview/home/${variant.id}`}
          onClick={() => window.scrollTo({ top: 0 })}
          aria-current={variant.id === current ? "page" : undefined}
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 font-medium transition-colors",
            variant.id === current
              ? "bg-white text-black"
              : "text-white/75 hover:bg-white/10 hover:text-white",
          )}
        >
          <span className="tabular-nums opacity-60">{i + 1}</span>
          {variant.name}
        </Link>
      ))}
      <Link
        to="/"
        className="flex h-8 shrink-0 items-center whitespace-nowrap rounded-full px-3 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
      >
        Atual
      </Link>
      <button
        type="button"
        onClick={() => setAndStore(true)}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        aria-label="Esconder as versões"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </nav>
  );
}
