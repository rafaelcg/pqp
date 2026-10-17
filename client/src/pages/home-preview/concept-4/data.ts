import { CAST, type Person } from "../shared/mock";

/** What the builder offers and what the preview draws. Sample content only. */

export type ChannelId =
  | "geral"
  | "memes"
  | "jogos"
  | "filmes"
  | "fichas"
  | "lobby"
  | "bastidores";

export type ChannelKind = "text" | "voice" | "private";

export interface ChannelDef {
  id: ChannelId;
  name: string;
  kind: ChannelKind;
}

export const CHANNELS: readonly ChannelDef[] = [
  { id: "geral", name: "geral", kind: "text" },
  { id: "memes", name: "memes", kind: "text" },
  { id: "jogos", name: "jogos", kind: "text" },
  { id: "filmes", name: "filmes", kind: "text" },
  { id: "fichas", name: "fichas", kind: "text" },
  { id: "lobby", name: "Lobby", kind: "voice" },
  { id: "bastidores", name: "secreto", kind: "private" },
];

export type ColorId = "rose" | "amber" | "emerald" | "sky" | "violet" | "neutral";

/** Server icon colours. Light fills, so one dark ink works on all of them. */
export const COLORS: readonly { id: ColorId; label: string; cls: string }[] = [
  { id: "rose", label: "Rosa", cls: "bg-rose-400" },
  { id: "amber", label: "Âmbar", cls: "bg-amber-400" },
  { id: "emerald", label: "Verde", cls: "bg-emerald-400" },
  { id: "sky", label: "Azul", cls: "bg-sky-400" },
  { id: "violet", label: "Violeta", cls: "bg-violet-400" },
  { id: "neutral", label: "Cinza", cls: "bg-zinc-200" },
];

export const NAME_MAX = 24;

export const SUGGESTIONS = [
  "A Mesa",
  "Sexta de Filme",
  "Turma da Call",
  "O Fundão",
  "Quinteto",
  "Casa da Tia",
] as const;

export interface Msg {
  who: Person;
  time: string;
  text: string;
  reactions?: { emoji: string; count: number }[];
}

/** The sample chat each channel shows in the preview. Labelled "exemplo". */
export const MESSAGES: Record<Exclude<ChannelId, "lobby">, Msg[]> = {
  geral: [
    { who: CAST.rafa, time: "21:40", text: "Bora hoje à noite? Eu levo o macarrão." },
    { who: CAST.bia, time: "21:41", text: "Eu topo. Cai na call às nove." },
  ],
  memes: [
    {
      who: CAST.caio,
      time: "21:38",
      text: "Achei o meme que descreve o Nico.",
      reactions: [{ emoji: "😂", count: 4 }],
    },
    { who: CAST.nico, time: "21:39", text: "Isso é perseguição." },
  ],
  jogos: [
    { who: CAST.leo, time: "21:36", text: "Quem tá no ranked hoje?" },
    { who: CAST.duda, time: "21:37", text: "Eu e o Eli. Falta mais um." },
  ],
  filmes: [
    { who: CAST.lara, time: "21:30", text: "Sexta tem filme? Voto em terror." },
    { who: CAST.rafa, time: "21:32", text: "Fechado. Quem escolhe a pipoca?" },
  ],
  fichas: [
    { who: CAST.gabi, time: "21:20", text: "Atualizei a ficha do paladino." },
    { who: CAST.rafa, time: "21:22", text: "Mesa sábado às 20h. Traz dado." },
  ],
  bastidores: [
    { who: CAST.rafa, time: "21:10", text: "Aqui só entra quem eu liberar." },
    { who: CAST.bia, time: "21:11", text: "Perfeito. Já posso contar a surpresa?" },
  ],
};

/** Who is "in the Lobby" in the preview. */
export const LOBBY_PEOPLE: readonly Person[] = [CAST.rafa, CAST.bia, CAST.caio];
