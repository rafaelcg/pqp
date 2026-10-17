import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * The homepage redesign candidates, reviewed at /preview/home/<id>.
 *
 * Each version is its own lazy chunk, so none of them reaches the bundle of
 * the live landing at `/`. Every version speaks first to friend groups
 * leaving Discord; they differ in execution and art direction.
 */
export interface HomeVariant {
  id: string;
  /** Short name on the switcher. */
  name: string;
  /** One line on the index page. */
  idea: string;
  kind: "flagship" | "concept";
  Page: LazyExoticComponent<ComponentType>;
}

export const HOME_VARIANTS: HomeVariant[] = [
  {
    id: "flagship",
    name: "Principal",
    idea: "A versão completa: uma noite com a galera, contada pelo próprio app. A call do topo é de verdade, em HTML, e dá pra mexer.",
    kind: "flagship",
    Page: lazy(() => import("./flagship")),
  },
  {
    id: "c1",
    name: "Mudança de casa",
    idea: "A mudança como história inteira: o servidor do Discord de um lado, o do pqp do outro, e o que vem junto.",
    kind: "concept",
    Page: lazy(() => import("./concept-1")),
  },
  {
    id: "c2",
    name: "Lambe-lambe",
    idea: "Cartaz de rua e zine: tipografia enorme, fita, carimbo e meio-tom, em tinta e verde-limão.",
    kind: "concept",
    Page: lazy(() => import("./concept-2")),
  },
  {
    id: "c3",
    name: "Papo reto",
    idea: "A página é uma conversa de grupo. Cada mensagem abre um cartão com a parte do produto.",
    kind: "concept",
    Page: lazy(() => import("./concept-3")),
  },
  {
    id: "c4",
    name: "Monta o rolê",
    idea: "A home é um construtor: dá nome pro servidor, escolhe os canais e vê a sala nascer.",
    kind: "concept",
    Page: lazy(() => import("./concept-4")),
  },
];
