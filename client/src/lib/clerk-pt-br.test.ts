import { ptBR } from "@clerk/localizations/pt-BR";
import { describe, expect, it } from "vitest";
import { withPqpPtBrCopy } from "./clerk-pt-br";

describe("withPqpPtBrCopy", () => {
  const merged = withPqpPtBrCopy(ptBR);

  it("carries the pqp wording on the sign-in and sign-up start screens", () => {
    expect(merged.signIn?.start?.title).toBe("Entrar no pqp");
    expect(merged.signIn?.start?.subtitle).toBe("Que bom te ver de novo");
    expect(merged.signIn?.start?.actionText).toBe("Não tem conta?");
    expect(merged.signIn?.start?.actionLink).toBe("Criar conta");
    expect(merged.signUp?.start?.title).toBe("Criar sua conta no pqp");
    expect(merged.signUp?.start?.actionText).toBe("Já tem conta?");
    expect(merged.signUp?.start?.actionLink).toBe("Entrar");
    expect(merged.formFieldInputPlaceholder__emailAddress).toBe("seu@email.com");
  });

  it("keeps stock Clerk copy for everything else", () => {
    expect(merged.formButtonPrimary).toBe(ptBR.formButtonPrimary);
    expect(merged.formFieldLabel__emailAddress).toBe(ptBR.formFieldLabel__emailAddress);
    expect(merged.signIn?.start?.actionLink__use_phone).toBe(
      ptBR.signIn?.start?.actionLink__use_phone,
    );
    expect(merged.signIn?.password).toEqual(ptBR.signIn?.password);
    expect(merged.unstable__errors).toEqual(ptBR.unstable__errors);
  });

  it("does not mutate Clerk's catalogue", () => {
    expect(ptBR.signIn?.start?.title).toBe("Entrar");
  });

  it("uses no em dashes", () => {
    expect(JSON.stringify(merged.signIn?.start)).not.toContain("—");
    expect(JSON.stringify(merged.signUp?.start)).not.toContain("—");
  });
});
