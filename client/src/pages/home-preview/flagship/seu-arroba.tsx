import { normalizeHandle, validateHandle } from "@pqp/shared";
import { ArrowRight, Check, EyeOff, UserPlus, Users } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import "../shared/mock.css";
import { BrowserFrame, Clip, Reveal, Tilt, stillImg } from "./cinema";
import "./mudanca.css";
import {
  BTN_DEMO,
  BTN_PRIMARY,
  CARD,
  CONTAINER,
  Caption,
  ExampleTag,
  Glow,
  H3,
  HEADER_GAP,
  Hi,
  Section,
  SectionHeader,
} from "./ui";

/**
 * "Seu endereço": type a name, watch pqp.gg/@nome become a profile page.
 * The field runs the same normaliser and validator as the real claim page
 * (`@pqp/shared`), so what it accepts here is what /garanta accepts. Whether
 * a name is free is the database's call, so this never says "disponível".
 *
 * Beside the playground, the real thing: Rafa's public page, recorded from
 * the app. At lg it stays in view (sticky) while the playground scrolls past.
 */

const PLACEHOLDER = "seunome";
const SETTLE_MS = 350;

/** The shared normaliser trims, which would eat a space typed mid-name. Keep it as `_`. */
function sanitize(raw: string): string {
  const clean = normalizeHandle(raw);
  return clean && /\s$/.test(raw) && clean.length < 20 ? `${clean}_` : clean;
}

function displayName(handle: string): string {
  return handle
    .split(/[_.-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const HINT: Record<string, string> = {
  empty: "Letras, números, ponto, traço ou _. De 3 a 20. Acento vira letra sem acento.",
  length: "Mínimo de três caracteres.",
  format: "Começa e termina com letra ou número.",
  reserved: "Esse é reservado. Tenta outro.",
  blocked: "Esse não dá. Tenta outro.",
};

export function SeuArroba() {
  const inputId = useId();
  const hintId = useId();
  const [value, setValue] = useState("");
  const [settled, setSettled] = useState(PLACEHOLDER);

  const problem = value ? validateHandle(value) : null;
  const valid = value.length > 0 && problem === null;

  // Turn the card over once typing pauses, never on every keystroke.
  useEffect(() => {
    const next = valid ? value : value ? null : PLACEHOLDER;
    if (next === null) return;
    const t = window.setTimeout(() => setSettled(next), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [value, valid]);

  const isPlaceholder = settled === PLACEHOLDER;
  const name = isPlaceholder ? "Seu Nome" : displayName(settled);
  const hint = !value ? HINT.empty : problem ? HINT[problem] : `Fica assim: pqp.gg/@${value}`;
  // The claim page reads `?handle=` and runs the same normaliser, so a valid
  // name arrives there already typed. The button follows what is typed now,
  // not the card, which waits for typing to pause.
  const claimHref = valid ? `/garanta?handle=${encodeURIComponent(value)}` : "/garanta";

  return (
    <Section id="arroba" labelledBy="arroba-title" className="overflow-x-clip">
      <Glow intensity="soft" className="-right-40 top-1/3 h-[620px] w-[820px] max-w-[140vw]" />
      <div className={cn(CONTAINER, "relative")}>
        <SectionHeader
          eyebrow="Seu @"
          titleId="arroba-title"
          title={
            <>
              Seu endereço, com <Hi>mural de depoimentos</Hi>.
            </>
          }
          lede="Pega o seu pqp.gg/@ e manda pra quem quiser te achar. A galera escreve depoimento, igual no Orkut, e só aparece o que você aprovar."
        />

        <div className={cn(HEADER_GAP, "grid grid-cols-1 gap-14 lg:grid-cols-12 lg:items-start lg:gap-12")}>
          {/* The playground: type a name, the claim button and the card follow. */}
          <div className="w-full max-w-2xl lg:col-span-5 lg:max-w-none">
            <Reveal delay={80}>
              <label
                htmlFor={inputId}
                className="block text-[11px] font-semibold uppercase tracking-[0.22em] text-paper-muted"
              >
                seu nome
              </label>
              <div
                className={cn(
                  "mt-3 flex h-16 items-center gap-1 rounded-2xl border bg-ink-2/80 pl-4 pr-3 transition-colors focus-within:border-signal/60 sm:h-20 sm:pl-6 sm:pr-4 lg:h-[4.5rem] lg:pl-5",
                  problem ? "border-white/20" : "border-white/10",
                )}
              >
                <span aria-hidden className="shrink-0 font-handle text-lg text-paper-muted sm:text-3xl lg:text-2xl">
                  pqp.gg/@
                </span>
                <input
                  id={inputId}
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={20}
                  value={value}
                  placeholder={PLACEHOLDER}
                  aria-describedby={hintId}
                  aria-invalid={problem ? true : undefined}
                  onChange={(e) => setValue(sanitize(e.target.value))}
                  className="h-full min-w-0 flex-1 bg-transparent font-handle text-lg font-semibold text-paper caret-signal outline-none placeholder:text-paper-muted/40 sm:text-3xl lg:text-2xl"
                />
                <span
                  aria-hidden
                  className={cn(
                    "grid h-8 w-8 shrink-0 place-items-center rounded-full transition-[opacity,transform] duration-200 sm:h-10 sm:w-10",
                    valid ? "scale-100 bg-signal text-ink opacity-100" : "scale-75 opacity-0",
                  )}
                >
                  <Check className="h-4 w-4 sm:h-5 sm:w-5" strokeWidth={3} />
                </span>
              </div>
              {/* Two lines reserved: the empty hint wraps and the others do not, and the button below must not jump. */}
              <p
                id={hintId}
                aria-live="polite"
                className={cn(
                  "mt-3 min-h-10 text-sm",
                  problem && problem !== "length" ? "text-amber-300" : "text-paper-muted",
                )}
              >
                {valid ? (
                  <>
                    Fica assim: pqp.gg/<span className="font-handle text-paper">@{value}</span>
                  </>
                ) : (
                  hint
                )}
              </p>

              <div className="mt-5 flex flex-col items-start gap-3">
                <Link to={claimHref} className={cn(BTN_PRIMARY, "max-w-full")}>
                  <span className="min-w-0 truncate">
                    {valid ? (
                      <>
                        Garantir <span className="font-handle">@{value}</span>
                      </>
                    ) : (
                      "Garantir meu @"
                    )}
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
                </Link>
                <p className="text-sm text-paper-muted">Quem pega primeiro leva. Dá pra trocar uma vez a cada 30 dias.</p>
              </div>
            </Reveal>

            {/* The profile page that name would open. */}
            <Reveal delay={120} className="mt-10">
              <article aria-label="Prévia da página de perfil">
                <BrowserFrame url={`pqp.gg/@${settled}`} bodyClassName="overflow-hidden">
                  <ExampleTag className="absolute right-3 top-3 z-[1] border-white/25 bg-ink/70 text-paper backdrop-blur-sm" />
                  {/* Identity. Turns over when the name settles; fades under reduced motion. */}
                  <div key={settled} className="mu-arroba-flip relative">
                    <div
                      aria-hidden
                      className="relative h-28 overflow-hidden bg-gradient-to-br from-violet-500/50 via-rose-500/35 to-amber-400/30 sm:h-36"
                    >
                      <div className="hp-grain absolute inset-0 opacity-60" />
                      <div className="absolute -bottom-10 right-6 h-32 w-32 rounded-full bg-amber-300/25 blur-2xl" />
                    </div>
                    <div className="px-6 pb-7 sm:px-8">
                      <span
                        aria-hidden
                        className="relative -mt-12 grid h-24 w-24 place-items-center rounded-full bg-signal font-display text-4xl font-bold text-ink ring-4 ring-ink"
                      >
                        {name.charAt(0)}
                      </span>
                      <p
                        className={cn(
                          "mt-4 break-words font-display text-2xl font-bold sm:text-3xl",
                          isPlaceholder && "text-paper/70",
                        )}
                      >
                        {name}
                      </p>
                      <p className="mt-0.5 break-all font-handle text-lg text-signal">@{settled}</p>
                      <p className="mt-1 text-sm text-paper-muted">No pqp desde outubro de 2026</p>
                      {/* A picture of the page's own button, not a control. */}
                      <span aria-hidden className={cn(BTN_DEMO, "pointer-events-none mt-5")}>
                        <UserPlus className="h-4 w-4" />
                        Me adiciona no pqp
                      </span>

                      <div className="mt-6">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-paper-muted">Conexões</p>
                        <ul className="mt-2.5 flex flex-wrap gap-2">
                          {["Steam", "Battle.net", "Twitch"].map((c) => (
                            <li
                              key={c}
                              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 text-xs font-medium text-paper"
                            >
                              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
                              {c}
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2.5 text-xs leading-relaxed text-paper-muted">
                          Opcionais. Só ficam públicas se você quiser.
                        </p>
                      </div>
                    </div>
                  </div>
                </BrowserFrame>
              </article>
            </Reveal>
          </div>

          {/* The real page, recorded from the app. */}
          <div className="order-first lg:sticky lg:top-24 lg:order-none lg:col-span-7 lg:self-center">
            <RealProfile />
          </div>
        </div>

        <Community />
      </div>
    </Section>
  );
}

/** Communities get an address too: a poster, never a member list. */
function Community() {
  return (
    <div className="mt-20 grid items-center gap-8 sm:mt-24 lg:grid-cols-12 lg:gap-12">
      <Reveal className="lg:col-span-6">
        <H3 size="lg">Comunidade também ganha endereço.</H3>
        <p className="mt-3 font-mono text-sm text-paper-muted">pqp.gg/c/nome</p>
        <p className="mt-4 max-w-md leading-relaxed text-paper-muted text-pretty">
          Vira um cartaz com nome, foto e quantos membros tem. Quem tá lá dentro não aparece: a lista de membros
          nunca fica pública.
        </p>
      </Reveal>

      <Reveal delay={80} variant="scale" className="lg:col-span-6">
        <Tilt max={5} className="mx-auto max-w-md rounded-3xl lg:mx-0">
          <article aria-label="Exemplo de cartaz de comunidade" className={cn(CARD, "relative overflow-hidden")}>
            {/* A drawn banner, not a photo: the painting already plays twice in the night above. It fades into the card's own fill. */}
            <div className="relative h-36 overflow-hidden sm:h-44">
              <div
                aria-hidden
                className="absolute inset-0 bg-gradient-to-br from-sky-500/45 via-indigo-500/40 to-fuchsia-500/30 [mask-image:linear-gradient(to_bottom,black_45%,transparent)]"
              >
                <div className="hp-grain absolute inset-0 opacity-60" />
                <div className="absolute -top-12 left-1/4 h-32 w-48 rounded-full bg-sky-200/20 blur-2xl" />
              </div>
              <ExampleTag className="absolute right-3 top-3 border-white/25 bg-ink/70 text-paper backdrop-blur-sm" />
            </div>
            <div className="relative -mt-8 px-5 pb-5">
              <span
                aria-hidden
                className="grid h-14 w-14 place-items-center rounded-2xl bg-amber-400 font-display text-xl font-bold text-zinc-950 ring-4 ring-ink-2"
              >
                C
              </span>
              <p className="mt-3 font-display text-xl font-bold">Cineclube da Madrugada</p>
              <p className="mt-0.5 text-sm text-paper-muted">Filme toda sexta. A pipoca é por sua conta.</p>
              <p className="mt-1 font-mono text-xs text-paper-muted">pqp.gg/c/cineclube</p>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-paper">
                  <Users className="h-3.5 w-3.5" aria-hidden />
                  128 membros
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-paper-muted ring-1 ring-inset ring-white/10">
                  <EyeOff className="h-3.5 w-3.5" aria-hidden />
                  lista de membros fechada
                </span>
              </div>
            </div>
          </article>
        </Tilt>
      </Reveal>
    </div>
  );
}

/**
 * Rafa's public page, the real footage. The page is a centred card on a wide
 * screen, so the frame is squarer than the recording and the footage is
 * pushed in a little: the card and its depoimentos fill the window instead
 * of sitting small in the middle of empty margins.
 */
function RealProfile() {
  return (
    <Reveal variant="scale" as="figure">
      <BrowserFrame url="pqp.gg/@rafa" bodyClassName="aspect-[4/5] overflow-hidden sm:aspect-[16/10]">
        <Clip
          name="profile"
          fallbackStill={stillImg(
            "profile",
            "A página pública do Rafa no pqp, pqp.gg/@rafa, com dois depoimentos aprovados, de Bia e de Caio. Gente de exemplo.",
            "(min-width: 1024px) 760px, 100vw",
          )}
          label="A página pública do Rafa no pqp, rolando devagar até os depoimentos aprovados. Gente de exemplo."
          position="object-center"
          className="absolute inset-0 [&_img]:origin-[50%_9%] [&_img]:scale-100 [&_video]:origin-[50%_9%] [&_video]:scale-100 sm:[&_img]:scale-[1.4] sm:[&_video]:scale-[1.4]"
          // Top right: the bottom of the window fades out (below).
          controlsClassName="bottom-auto top-3"
        />
        {/* The recording scrolls down to the site's footer; let it fade out. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-[35%] bg-gradient-to-t from-ink from-[8%] via-ink/70 to-transparent"
        />
      </BrowserFrame>
      <figcaption>
        <Caption example>O app de verdade: a página do @rafa, com os depoimentos que ele aprovou. Gente de exemplo.</Caption>
        <p className="mt-3 flex items-start gap-2 text-sm text-paper-muted">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
          Amigo escreve, você aprova. Até lá, não aparece pra mais ninguém.
        </p>
      </figcaption>
    </Reveal>
  );
}
