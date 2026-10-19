import { ArrowRight } from "lucide-react";
import { Suspense } from "react";
import { Link, useParams } from "react-router-dom";
import { Seo } from "@/components/marketing/seo";
import { PreviewBar } from "./shared/preview-bar";
import { HOME_VARIANTS } from "./variants";

/**
 * `/preview/home` and `/preview/home/:variant`: the homepage redesign
 * candidates, side by side for review. Not indexed, not linked from the site.
 * The live landing at `/` is untouched until one of these is chosen.
 */
export function HomePreviewRoute() {
  const { variant: id } = useParams();
  const variant = HOME_VARIANTS.find((v) => v.id === id);

  if (!variant) {
    return <PreviewIndex />;
  }

  return (
    <>
      <Seo
        title={`Prévia: ${variant.name} · pqp`}
        description="Prévia do novo site do pqp."
        path={`/preview/home/${variant.id}`}
        noIndex
      />
      <Suspense fallback={<div className="min-h-screen bg-ink" />}>
        <variant.Page />
      </Suspense>
      <PreviewBar current={variant.id} />
    </>
  );
}

function PreviewIndex() {
  return (
    <div className="min-h-screen bg-ink px-5 py-16 text-paper sm:px-8">
      <Seo
        title="Prévias da home · pqp"
        description="As versões do novo site do pqp."
        path="/preview/home"
        noIndex
      />
      <div className="mx-auto max-w-5xl">
        <p className="font-display text-xs font-bold uppercase tracking-[0.22em] text-signal">
          Prévia
        </p>
        <h1 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
          Novas versões da home
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-paper-muted">
          Uma versão completa e quatro conceitos mais simples. Todas falam
          primeiro com a galera que está saindo do Discord. A home atual
          continua em <Link to="/" className="text-signal underline underline-offset-4">pqp.gg</Link>.
        </p>
        <ul className="mt-12 grid gap-4 sm:grid-cols-2">
          {HOME_VARIANTS.map((variant, i) => (
            <li key={variant.id} className={variant.kind === "flagship" ? "sm:col-span-2" : undefined}>
              <Link
                to={`/preview/home/${variant.id}`}
                className="group flex h-full flex-col rounded-2xl border border-ink-4/60 bg-ink-2/60 p-6 transition-colors hover:border-signal/50"
              >
                <span className="text-xs font-medium uppercase tracking-[0.18em] text-paper-muted">
                  {i + 1} · {variant.kind === "flagship" ? "Versão completa" : "Conceito"}
                </span>
                <span className="mt-2 font-display text-2xl font-bold">{variant.name}</span>
                <span className="mt-2 text-paper-muted">{variant.idea}</span>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-5 text-sm font-medium text-signal">
                  Abrir <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-10 text-sm text-paper-muted">
          Dentro de uma versão, as teclas 1 a 5 trocam de versão.
        </p>
      </div>
    </div>
  );
}
