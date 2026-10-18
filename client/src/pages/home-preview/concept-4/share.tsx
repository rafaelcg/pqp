import { LayoutGrid, MonitorUp, Smartphone, Globe, Volume2, VolumeX } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { AppWindow, CAST, CallControls, CallTile, SoundBars } from "../shared/mock";
import { CONTAINER, ExampleTag, MONO, PANEL, PanelHead, SectionHead } from "./ui";

/**
 * Section 02: a call with a screen share, and a small panel that sets what is
 * being shared. The sound line is the honest part: it follows the truth sheet
 * (a Chrome or Edge tab carries sound, the desktop app only on Windows 11).
 */

type Source = "tab" | "win11" | "other";

const SOURCES: {
  id: Source;
  title: string;
  hint: string;
  sound: boolean;
  result: string;
}[] = [
  {
    id: "tab",
    title: "Uma aba do Chrome ou do Edge",
    hint: "No navegador",
    sound: true,
    result: "O som da aba vai junto com a tela.",
  },
  {
    id: "win11",
    title: "O computador, no app",
    hint: "Windows 11",
    sound: true,
    result: "O som do computador vai junto com a tela.",
  },
  {
    id: "other",
    title: "O computador, no app",
    hint: "Mac, Linux ou Windows 10",
    sound: false,
    result: "Vai só o vídeo. O som fica de fora.",
  },
];

const QUALITIES = ["360p", "720p", "1080p"] as const;
type Quality = (typeof QUALITIES)[number];

const FACTS = [
  {
    icon: LayoutGrid,
    title: "Várias telas",
    text: "Duas ao mesmo tempo em salas menores, até quatro em salas grandes.",
  },
  {
    icon: Smartphone,
    title: "No celular também",
    text: "Quem está no celular assiste. No Android dá pra compartilhar.",
  },
  {
    icon: Globe,
    title: "Sem instalar",
    text: "Roda no navegador. O app de computador é opcional.",
  },
];

const FOCUS_RING =
  "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-signal";

function ShareMock({ source, quality }: { source: (typeof SOURCES)[number]; quality: Quality }) {
  return (
    <div className="relative rounded-2xl border border-white/10 bg-ink-2/40 p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className={MONO}>
          <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-signal align-middle" aria-hidden />
          Lobby, 4 na call
        </p>
        <ExampleTag>call de exemplo</ExampleTag>
      </div>
      <p className="sr-only">
        Exemplo de uma call com uma tela compartilhada. {source.result} Qualidade da tela: {quality}.
      </p>
      <AppWindow bodyClassName="p-3">
        <div aria-hidden>
          <div className="relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-rail">
            <img
              src="/images/watch-party/stage.webp"
              alt=""
              width={1152}
              height={768}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
            <span className="absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-[11px] text-white">
              <MonitorUp className="h-3.5 w-3.5 text-signal" />
              Zeca passa a tela
            </span>
            <span className="absolute right-2 top-2 rounded-md bg-black/60 px-2 py-1 font-mono text-[11px] text-white transition-opacity">
              {quality}
            </span>
            <span
              className={cn(
                "absolute bottom-2 left-2 inline-flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-[11px] text-white",
              )}
            >
              {source.sound ? (
                <>
                  <Volume2 className="h-3.5 w-3.5 text-signal" />
                  Som junto
                  <SoundBars className="text-signal" />
                </>
              ) : (
                <>
                  <VolumeX className="h-3.5 w-3.5 text-paper-muted" />
                  Só vídeo
                </>
              )}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <CallTile person={CAST.bia} speaking className="h-16 sm:h-20" />
            <CallTile person={CAST.caio} className="h-16 sm:h-20" />
            <CallTile person={CAST.nico} className="h-16 sm:h-20" />
          </div>
          <CallControls sharing className="mt-3" />
        </div>
      </AppWindow>
    </div>
  );
}

export function Tela() {
  const group = useId();
  const qualityGroup = useId();
  const [sourceId, setSourceId] = useState<Source>("tab");
  const [quality, setQuality] = useState<Quality>("720p");
  const source = SOURCES.find((s) => s.id === sourceId) ?? SOURCES[0];

  return (
    <section id="tela" className="relative scroll-mt-16 py-16 sm:py-20" aria-labelledby="tela-titulo">
      <div className={CONTAINER}>
        <SectionHead
          n="02"
          label="Tela com som"
          title={<span id="tela-titulo">Passa a tela, e o som pode ir junto.</span>}
          lede="A galera vê o jogo, o filme ou a aba do mapa que você abriu. Muda as opções ao lado e vê o que vai pra call."
        />

        <div className="mt-12 grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <ShareMock source={source} quality={quality} />

          <div className={cn(PANEL, "self-start")}>
            <PanelHead n="A" label="O que vai na tela" />
            <div className="grid gap-5 p-4">
              <fieldset>
                <legend className={MONO}>Compartilhar</legend>
                <div className="mt-2 grid gap-2">
                  {SOURCES.map((s) => {
                    const on = s.id === sourceId;
                    return (
                      <label key={s.id} className="relative block">
                        <input
                          type="radio"
                          name={group}
                          value={s.id}
                          checked={on}
                          onChange={() => setSourceId(s.id)}
                          className="peer sr-only"
                        />
                        <span
                          className={cn(
                            "flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 transition-colors",
                            on
                              ? "border-white/30 bg-white/[0.07]"
                              : "border-white/10 hover:border-white/20",
                            FOCUS_RING,
                          )}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              "grid h-4 w-4 shrink-0 place-items-center rounded-full border",
                              on ? "border-paper" : "border-white/25",
                            )}
                          >
                            {on && <span className="h-2 w-2 rounded-full bg-paper" />}
                          </span>
                          <span className="min-w-0">
                            <span className={cn("block text-sm", on ? "text-paper" : "text-paper-muted")}>
                              {s.title}
                            </span>
                            <span className="block text-xs text-paper-muted">{s.hint}</span>
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset>
                <legend className={MONO}>Qualidade</legend>
                <div className="mt-2 grid grid-cols-3 rounded-xl border border-white/10 bg-ink p-1">
                  {QUALITIES.map((q) => (
                    <label key={q} className="relative">
                      <input
                        type="radio"
                        name={qualityGroup}
                        value={q}
                        checked={quality === q}
                        onChange={() => setQuality(q)}
                        className="peer sr-only"
                      />
                      <span
                        className={cn(
                          "grid h-10 cursor-pointer place-items-center rounded-lg font-mono text-sm text-paper-muted transition-colors hover:text-paper peer-checked:bg-ink-3 peer-checked:text-paper sm:h-9",
                          FOCUS_RING,
                        )}
                      >
                        {q}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="rounded-xl border border-white/10 bg-ink px-4 py-3" aria-live="polite">
                <p className={MONO}>O que chega na call</p>
                <p className="mt-2 flex items-start gap-2 text-sm leading-snug text-paper">
                  {source.sound ? (
                    <Volume2 className="mt-0.5 h-4 w-4 shrink-0 text-signal" aria-hidden />
                  ) : (
                    <VolumeX className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
                  )}
                  {source.result}
                </p>
              </div>
            </div>
          </div>
        </div>

        <ul className="mt-4 grid gap-4 md:grid-cols-3">
          {FACTS.map((f) => (
            <li key={f.title} className={cn(PANEL, "flex gap-3 p-4")}>
              <f.icon className="mt-0.5 h-5 w-5 shrink-0 text-paper-muted" aria-hidden />
              <div>
                <h3 className="font-display text-base font-semibold">{f.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-paper-muted">{f.text}</p>
              </div>
            </li>
          ))}
        </ul>

        <p className="mt-6 max-w-3xl text-sm leading-relaxed text-paper-muted">
          O som depende do navegador e do sistema. Ele vai junto quando você compartilha uma aba do Chrome ou do
          Edge. No app de computador, o som do computador só vai no Windows 11. No Mac, no Linux e no Windows 10
          o app compartilha só o vídeo. A call e a tela acima são um exemplo, não uma gravação.
        </p>
      </div>
    </section>
  );
}
