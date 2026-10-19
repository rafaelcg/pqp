import { strict as assert } from "node:assert";
import test from "node:test";
import "../site/novo-model.js";

/**
 * The Apps screen's data layer (`novo-model.js`, the "apps" block). What is
 * pinned here is what an operator would act on without being able to check it
 * by looking: why a switch will not move, what the destructive confirmation
 * promises, and which servers can be switched on.
 */
const M = globalThis.PQPNovo;

function version(over) {
  return Object.assign({
    version: "1.0.2", source: "repo", isCurrent: true, reviewStatus: "pending", reviewChecklist: {},
    reviewedBy: null, reviewedAt: null, reviewNote: null, createdAt: "2026-10-18T00:00:00.000Z",
    manifest: { name: "Sala de jogos", category: "emulator" }
  }, over || {});
}

function app(over) {
  return Object.assign({
    id: "sala-de-jogos", name: "Sala de jogos", publisher: { id: "pqp", displayName: "pqp", kind: "first_party" },
    status: "live", globalEnabled: true, communityUnlocked: false, currentVersion: "1.0.2", currentApproved: true,
    goLiveBlocker: null, category: "emulator", serversOn: 3, serversOwnerOff: 0, liveSessions: 4,
    versions: [version({ reviewStatus: "approved", reviewChecklist: { sandbox: true, noNetwork: true, license: true, romPolicy: true, i18n: true, presence: true } })]
  }, over || {});
}

test("the state badge names the four states and never throws on an unknown one", () => {
  assert.deepEqual(M.appStatus("live"), { label: "No ar", tone: "ok" });
  assert.equal(M.appStatus("review").label, "Em revisão");
  assert.equal(M.appStatus("draft").label, "Rascunho");
  assert.equal(M.appStatus("retired").label, "Aposentado");
  assert.equal(M.appStatus("novo").label, "novo");
  assert.equal(M.appStatus(undefined).label, "desconhecido");
});

test("the title line carries the version and the publisher", () => {
  assert.equal(M.appSubtitle(app()), "v1.0.2, por pqp");
  assert.equal(M.appSubtitle(app({ currentVersion: null })), "sem versão, por pqp");
});

test("an app without an approved current version cannot be switched on, and says why in words", () => {
  const review = app({ status: "review", globalEnabled: false, goLiveBlocker: "not-reviewed", currentApproved: false });
  const sw = M.globalSwitch(review);
  assert.equal(sw.checked, false);
  assert.equal(sw.disabled, true);
  assert.equal(sw.reason, "Em revisão: só liga depois que a caixa isolada e o manifesto passarem.");

  const draft = M.globalSwitch(app({ status: "draft", globalEnabled: false, goLiveBlocker: "not-reviewed" }));
  assert.equal(draft.disabled, true);
  assert.match(draft.reason, /^Rascunho: /);
});

test("an approved app's switch moves, and one that is already on can always be switched off", () => {
  const off = M.globalSwitch(app({ status: "draft", globalEnabled: false, goLiveBlocker: null }));
  assert.equal(off.disabled, false);
  assert.equal(off.reason, null);
  // The reviewer withdrew the approval of a version that is live: the way off stays open.
  const on = M.globalSwitch(app({ goLiveBlocker: "not-reviewed" }));
  assert.equal(on.checked, true);
  assert.equal(on.disabled, false);
});

test("on but not live is said out loud, not drawn as a plain yes", () => {
  const sw = M.globalSwitch(app({ status: "retired", globalEnabled: true }));
  assert.equal(sw.checked, true);
  assert.match(sw.note, /só aparece com o estado No ar/);
  assert.equal(M.globalSwitch(app()).note, null);
});

test("N de M servidores is the operator's switches over every server", () => {
  assert.equal(M.serversText(app({ serversOn: 0 }), 412), "0 de 412");
  assert.equal(M.serversText(app({ serversOn: 3 }), 1248), "3 de 1.248");
});

test("the review column shows ok lines for an approved app and what is missing otherwise", () => {
  const approved = M.reviewSummary(app());
  assert.equal(approved.tone, "ok");
  assert.deepEqual(approved.chips.map((c) => c.label), [
    "Caixa isolada ok", "Sem rede ok", "Licença ok", "Política de ROM ok", "Textos em pt-BR, en e es ok", "Linha de presença ok"
  ]);
  const tool = M.reviewSummary(app({ versions: [version({ reviewStatus: "approved", manifest: { category: "tool" }, reviewChecklist: { sandbox: true, romPolicy: true } })] }));
  assert.deepEqual(tool.chips.map((c) => c.label), ["Caixa isolada ok"], "the ROM line is never asked of an app that is not an emulator");

  const pending = M.reviewSummary(app({ versions: [version({ version: "0.4.0" })] }));
  assert.equal(pending.text, "Falta revisar o manifesto v0.4.0");
  assert.equal(pending.tone, "warn");
  assert.match(M.reviewSummary(app({ versions: [version({ reviewStatus: "rejected", reviewNote: "Sem caixa isolada." })] })).text, /Reprovada na revisão: Sem caixa isolada\./);
  assert.equal(M.reviewSummary(app({ versions: [version({ reviewStatus: "withdrawn" })] })).text, "Revisão retirada");
  assert.equal(M.reviewSummary(app({ versions: [] })).text, "Sem versão para revisar");
  // Only the CURRENT version speaks for the app.
  const old = M.reviewSummary(app({ versions: [version({ isCurrent: false, reviewStatus: "approved" }), version({ version: "1.1.0", reviewStatus: "pending" })] }));
  assert.equal(old.text, "Falta revisar o manifesto v1.1.0");
});

test("the checklist asks the ROM line only of an emulator, and an approval needs every line", () => {
  assert.equal(M.checklistItems("emulator").length, 6);
  assert.equal(M.checklistItems("tool").length, 5);
  const full = { sandbox: true, noNetwork: true, license: true, i18n: true, presence: true };
  assert.equal(M.checklistComplete(full, "tool"), true);
  assert.equal(M.checklistComplete(full, "emulator"), false);
  assert.equal(M.checklistComplete(Object.assign({}, full, { romPolicy: true }), "emulator"), true);
  assert.equal(M.checklistComplete(Object.assign({}, full, { noNetwork: false }), "tool"), false);
  assert.equal(M.checklistComplete(undefined, "tool"), false);
});

test("the sessions line promises the warning only when there is something to warn about", () => {
  assert.match(M.sessionsLine(0), /^0 sessões ativas agora\. Quando houver, o botão “Desligar em todos” avisa/);
  assert.equal(M.sessionsLine(1), "1 sessão ativa agora.");
  assert.equal(M.sessionsLine(4), "4 sessões ativas agora.");
});

test("the confirmation says how many sessions end, how many servers lose the app, and how to come back", () => {
  const c = M.disableConfirm(app(), 4, 3);
  assert.equal(c.title, "Desligar Sala de jogos em todos os servidores?");
  assert.equal(c.lines[0], "4 sessões ativas vão terminar agora, com um aviso pra quem está dentro.");
  assert.equal(c.lines[1], "O app some dos 3 servidores onde estava ligado.");
  assert.match(c.lines[2], /Pra voltar, liga o interruptor global de novo/);
  assert.equal(c.confirm, "Desligar tudo", "the button repeats the verb of the title");
  assert.equal(c.cancel, "Cancelar");
  assert.match(M.disableConfirm(app(), 1, 1).lines[0], /^1 sessão ativa vai terminar agora/);
  assert.equal(M.disableConfirm(app(), 1, 1).lines[1], "O app some do 1 servidor onde estava ligado.");
  assert.equal(M.disableConfirm(app(), 0, 0).lines[0], "Nenhuma sessão ativa agora.");
  assert.equal(M.disableConfirm(app(), 0, 0).lines[1], "O app não está ligado em nenhum servidor.");
});

test("a community's lock is a decision with its own confirmation, both ways", () => {
  const open = M.communityConfirm(app(), true);
  assert.match(open.title, /^Liberar Sala de jogos para comunidades públicas\?/);
  assert.match(open.lines[0], /docs\/CONTENT_SAFETY\.md/);
  const shut = M.communityConfirm(app(), false);
  assert.match(shut.title, /^Travar /);
  assert.match(shut.lines[0], /continua ligado/);
});

test("a server row says what kind of server it is, and locks a community until the app is unlocked", () => {
  const priv = M.serverRow({ name: "Turma do Fundão", memberCount: 12, isCommunity: false, locked: false, operatorEnabled: true, ownerEnabled: null, appsFlag: true, liveSessions: 0 });
  assert.equal(priv.subtitle, "Privado, 12 membros");
  assert.equal(priv.initials, "TF");
  assert.equal(priv.badge, null);
  assert.equal(priv.locked, false);
  assert.deepEqual(priv.chips, []);

  const qg = M.serverRow({ name: "QG", memberCount: 1248, isCommunity: true, locked: true, operatorEnabled: null, ownerEnabled: null, appsFlag: false, liveSessions: 0 });
  assert.equal(qg.subtitle, "Comunidade, 1.248 membros");
  assert.deepEqual(qg.badge, { text: "Comunidade", tone: "accent" });
  assert.equal(qg.locked, true);
  assert.deepEqual(qg.chips, [], "a server that is off has nothing to warn about");

  // Already on in a locked community: the way off stays open.
  assert.equal(M.serverRow({ name: "QG", memberCount: 2, isCommunity: true, locked: true, operatorEnabled: true, appsFlag: true }).locked, false);
  assert.equal(M.serverRow({ name: "Sandbox", memberCount: 1, isCommunity: false }).subtitle, "Privado, 1 membro");
});

test("a server that is on says what keeps it from showing: the owner, the apps flag, a live session", () => {
  const row = M.serverRow({ name: "Sandbox", memberCount: 4, isCommunity: false, locked: false, operatorEnabled: true, ownerEnabled: false, appsFlag: false, liveSessions: 2 });
  assert.deepEqual(row.chips.map((c) => c.text), ["o dono desligou", "flag apps desligada aqui", "2 sessões ativas"]);
});

test("initials: first and last word, or the first two letters", () => {
  assert.equal(M.initials("Turma do Fundão"), "TF");
  assert.equal(M.initials("Sandbox"), "SA");
  assert.equal(M.initials("  "), "?");
  assert.equal(M.initials(null), "?");
});

test("a refused write says the reason the API gave, and anything else is the plain failure", () => {
  assert.match(M.appsWriteError("not-reviewed"), /^Em revisão: só liga depois/);
  assert.match(M.appsWriteError("community-locked"), /Comunidade pública/);
  assert.match(M.appsWriteError("checklist-incomplete"), /Falta marcar/);
  assert.match(M.appsWriteError("version-in-use"), /Essa versão está no ar/);
  assert.equal(M.appsWriteError("http 500"), "Não deu pra salvar. O interruptor voltou pro que estava.");
  assert.equal(M.appsWriteError(null), "Não deu pra salvar. O interruptor voltou pro que estava.");
});

test("the history reads before and after for every kind of change", () => {
  assert.equal(M.auditText({ action: "global", before: { globalEnabled: false }, after: { globalEnabled: true } }), "Global: desligado para ligado");
  assert.equal(M.auditText({ action: "status", before: { status: "review" }, after: { status: "live" } }), "Estado: Em revisão para No ar");
  assert.equal(M.auditText({ action: "operator-server", serverName: "Sandbox", before: { operatorEnabled: null }, after: { operatorEnabled: true } }), "Sandbox: sem decisão para ligado");
  assert.equal(M.auditText({ action: "community-unlock", before: { communityUnlocked: false }, after: { communityUnlocked: true } }), "Comunidades: travadas para liberadas");
  assert.equal(M.auditText({ action: "current-version", before: { currentVersion: "1.0.0" }, after: { currentVersion: "1.1.0" } }), "Versão atual: 1.0.0 para 1.1.0");
  assert.equal(M.auditText({ action: "review", appVersion: "1.0.2", before: {}, after: { reviewStatus: "approved" } }), "Revisão da v1.0.2: approved");
  assert.equal(M.auditText({ action: "disable-everywhere", sessionsEnded: 4 }), "Desligado em todos, 4 sessões encerradas");
  assert.equal(M.auditText({ action: "outra" }), "outra");
});

test("the line under an opened app says where it stands, on or off", () => {
  assert.equal(M.appSummary(app({ serversOn: 2 }), 3), "Sala de jogos v1.0.2, no ar. Global: ligado, 2 de 3 servidores escolhidos.");
  assert.equal(
    M.appSummary(app({ status: "review", globalEnabled: false }), 3),
    "Sala de jogos v1.0.2, em revisão. Global: desligado, não aparece em servidor nenhum.",
  );
});

test("no sentence on this screen has an em dash or the word você", () => {
  const all = [
    M.sessionsLine(0), M.LOCK_NOTE, ...M.disableConfirm(app(), 2, 2).lines, ...M.communityConfirm(app(), true).lines,
    ...M.communityConfirm(app(), false).lines, M.appsWriteError("x"), M.appsWriteError("not-reviewed"),
    M.disableFailure(404).text, M.disableFailure(401).text, M.disableFailure(400).text
  ].join(" ");
  assert.equal(all.includes("—"), false);
  assert.equal(/voc[eê]/i.test(all), false);
});

test("a failed 'Desligar em todos' says 'Nada mudou' only for an answer that comes before any change", () => {
  // answered before the API touches anything: the Worker's guard, access, a missing route, a bad body, the limiter
  for (const status of [400, 401, 403, 404, 415, 429]) {
    const f = M.disableFailure(status);
    assert.equal(f.known, true, String(status));
    assert.match(f.text, /Nada mudou\.$/);
  }
  // may come after the switch went off and sessions ended: never "Nada mudou"
  for (const status of [undefined, 0, 409, 410, 422, 500, 502, 503]) {
    assert.deepEqual(M.disableFailure(status), { known: false, text: null }, String(status));
  }
});
