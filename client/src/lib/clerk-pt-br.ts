import type { ptBR } from "@clerk/localizations/pt-BR";

type ClerkPtBR = typeof ptBR;

/**
 * pqp's own pt-BR wording for the first screen of Clerk's sign-in and sign-up
 * modals, laid over Clerk's stock catalogue. Only the entry screens and the
 * link between them are ours (short, `você`, what to click, per AGENTS.md
 * "PT-BR voice"); errors, MFA and the account screens keep Clerk's copy.
 *
 * It is applied inside the lazy `@clerk/localizations/pt-BR` load, so English
 * visitors still download none of the catalogue. The type import above is
 * erased at build time, and this file is a few hundred bytes.
 *
 * Key names are Clerk's own (`LocalizationResource`); a rename in a Clerk
 * upgrade fails the typecheck here instead of silently showing stock copy.
 */
export function withPqpPtBrCopy(base: ClerkPtBR): ClerkPtBR {
  return {
    ...base,
    formFieldInputPlaceholder__emailAddress: "seu@email.com",
    signIn: {
      ...base.signIn,
      start: {
        ...base.signIn?.start,
        title: "Entrar no pqp",
        subtitle: "Que bom te ver de novo",
        actionText: "Não tem conta?",
        actionLink: "Criar conta",
      },
    },
    signUp: {
      ...base.signUp,
      start: {
        ...base.signUp?.start,
        title: "Criar sua conta no pqp",
        actionText: "Já tem conta?",
        actionLink: "Entrar",
      },
    },
  };
}
