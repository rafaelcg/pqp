import { Hash } from "lucide-react";
import { Link } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { BetaTag } from "@/components/ui/beta-tag";
import { cn } from "@/lib/utils";
import { JoinButton, SignInButton } from "../shared/auth-buttons";
import "../shared/mock.css";
import { CloserCard, CallCard, ImportCard, LimitsCard, PinnedCard, RegionsCard, ShareCard, WatchPartyNote } from "./cards";
import { CAST, CHAPTERS, CHAPTER_IDS, FOCUS_RING, PQP } from "./data";
import { useActiveChapter } from "./hooks";
import { Divider, Msg, TypingRow } from "./thread";

/**
 * Papo reto: the page is a group chat. "pqp" (the product) answers what a
 * friend group asks, and each answer opens a card with the real feature.
 * The friends are scripted and every one of them carries "exemplo".
 */
export default function PapoReto() {
  return (
    <div className="min-h-screen overflow-x-clip bg-ink text-paper">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-full focus:bg-paper focus:px-5 focus:py-3 focus:text-sm focus:font-semibold focus:text-ink"
      >
        Pular pro conteúdo
      </a>
      <Header />
      <main id="conteudo" tabIndex={-1} className="outline-none">
        <div className="mx-auto w-full max-w-[760px] px-4 pb-24 pt-2 sm:px-6 sm:pb-32">
          <ol className="list-none">
            <Divider>hoje</Divider>

            <Msg person={PQP} time="21:02" instant>
              <h1 className="text-balance font-display text-[40px] font-extrabold leading-[1.02] tracking-[-0.025em] sm:text-6xl">
                Ei, vem pra cá.
              </h1>
              <p className="mt-4 max-w-[34rem] text-pretty text-[18px] leading-snug text-paper-muted sm:text-xl">
                Esse é o pqp: call, tela compartilhada e o papo de sempre. Grátis e de código aberto.
              </p>
            </Msg>
            <Msg person={PQP} cont instant card={<PinnedCard />}>
              <p className="sr-only">Os botões pra entrar estão na mensagem fixada logo abaixo.</p>
            </Msg>

            {/* 1. cai na call? */}
            <Msg
              id="cai-na-call"
              person={CAST.bia}
              time="21:04"
              example
              typingMs={800}
              reactions={[{ emoji: "🙋", count: 3 }]}
            >
              cai na call?
            </Msg>
            <Msg person={CAST.caio} time="21:04" example typingMs={600}>
              tô entrando. quem mais tá aí?
            </Msg>
            <Msg person={PQP} time="21:05" card={<CallCard />}>
              Cai sim. Não precisa instalar nada: abre no navegador e entra. Esta sala é um exemplo, entra aí pra testar.
            </Msg>

            <Divider>21:40</Divider>

            {/* 2. passa a tela */}
            <Msg id="passa-a-tela" person={CAST.nico} time="21:40" example typingMs={800}>
              passa a tela aí, quero ver o vídeo junto com vocês
            </Msg>
            <Msg person={PQP} time="21:41" card={<ShareCard />}>
              Passa sim. O som vai junto, com uma condição: depende de onde você compartilha.
            </Msg>
            <Msg person={PQP} cont className="pt-6">
              <WatchPartyNote />
            </Msg>

            <Divider>ontem</Divider>

            {/* 3. e o servidor do Discord? */}
            <Msg id="traz-o-servidor" person={CAST.leo} time="19:12" example typingMs={800}>
              e o servidor do Discord? já tá todo arrumado lá, não quero montar tudo de novo
            </Msg>
            <Msg person={PQP} time="19:13" card={<ImportCard />}>
              Não precisa montar. Cola o link do modelo do servidor e você vê a prévia antes de criar qualquer coisa.
            </Msg>

            <Divider>hoje</Divider>

            {/* 4. onde fica o servidor? */}
            <Msg id="onde-fica" person={CAST.eli} time="20:31" example typingMs={800}>
              onde fica o servidor? tô no Recife e não quero lag
            </Msg>
            <Msg person={PQP} time="20:32" card={<RegionsCard />}>
              Call grande usa o servidor de voz mais perto de quem está no seu servidor: São Paulo, Miami ou Londres. DM e
              servidor pequeno falam direto entre as pessoas. Aqui o estado de agora:
            </Msg>

            {/* 5. o que ainda não tem? */}
            <Msg id="o-que-falta" person={CAST.gabi} time="20:36" example typingMs={800}>
              e o que ainda não tem?
            </Msg>
            <Msg person={PQP} time="20:37" card={<LimitsCard />}>
              Boa pergunta. A resposta honesta é essa:
            </Msg>

            <TypingRow>
              <span>
                Rafa está digitando <span className="text-xs">(exemplo)</span>
              </span>
            </TypingRow>

            {/* closer */}
            <Msg person={CAST.rafa} time="20:41" example typingMs={900}>
              bora criar a sala da galera?
            </Msg>
            <Msg person={PQP} time="20:41" card={<CloserCard />}>
              Bora. Entra com Google, Apple ou Twitch e cria a sala.
            </Msg>
          </ol>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}

function Header() {
  const active = useActiveChapter(CHAPTER_IDS);
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.07] bg-ink/85 backdrop-blur-xl">
      <div className="mx-auto flex h-14 w-full max-w-[760px] items-center gap-3 px-4 sm:px-6">
        <Link
          to="/preview/home/c3"
          className={cn("flex items-center gap-2 rounded-md font-brand text-xl tracking-tight", FOCUS_RING)}
        >
          pqp
          <BetaTag />
        </Link>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <SignInButton
            className={cn(
              "hidden h-10 items-center rounded-full px-3 text-sm font-medium text-paper-muted transition-colors hover:text-paper sm:inline-flex",
              FOCUS_RING,
            )}
          />
          <JoinButton
            className={cn(
              "inline-flex h-10 items-center rounded-full bg-paper px-4 text-sm font-semibold text-ink transition-colors hover:bg-signal",
              FOCUS_RING,
            )}
          >
            Começar
          </JoinButton>
        </div>
      </div>
      <nav aria-label="Capítulos da conversa" className="border-t border-white/[0.05]">
        <ul className="mx-auto flex h-10 w-full max-w-[760px] items-center gap-1 overflow-x-auto px-3 sm:px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {CHAPTERS.map((c) => (
            <li key={c.id} className="shrink-0">
              <a
                href={`#${c.id}`}
                aria-current={active === c.id ? "location" : undefined}
                className={cn(
                  "inline-flex h-8 items-center gap-1 rounded-md px-2 text-[13px] font-medium transition-colors",
                  active === c.id ? "bg-white/[0.08] text-paper" : "text-paper-muted hover:text-paper",
                  FOCUS_RING,
                )}
              >
                <Hash className="h-3.5 w-3.5 opacity-60" aria-hidden />
                {c.channel}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
