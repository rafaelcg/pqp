import { applyTheme, connect, type PqpApp } from "@pqp/app-sdk";
import { PollController, type View } from "./controller";
import { fill, pickLocale, STRINGS, resultTextFor, votersLine, votesLine, type Strings } from "./i18n";
import {
  bit,
  hasBit,
  MAX_OPTIONS,
  MIN_OPTIONS,
  OPTION_MAX_LENGTH,
  percent,
  shownTally,
  validateDraft,
  winnerIndexes,
  type DraftProblem,
  type Poll,
} from "./model";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const root = el<HTMLElement>("enq");
const statusLine = el<HTMLElement>("status");
const waitingView = el<HTMLElement>("v-waiting");
const setupView = el<HTMLElement>("v-setup");
const pollView = el<HTMLElement>("v-poll");
const notice = el<HTMLElement>("notice");
const endedLine = el<HTMLElement>("ended");
const live = el<HTMLElement>("live");

const questionInput = el<HTMLTextAreaElement>("question");
const optionRows = el<HTMLOListElement>("option-rows");
const addOptionButton = el<HTMLButtonElement>("add-option");
const modeMulti = el<HTMLInputElement>("mode-multi");
const setupError = el<HTMLElement>("setup-error");
const startButton = el<HTMLButtonElement>("start");

const pollQuestion = el<HTMLElement>("poll-question");
const pollHint = el<HTMLElement>("poll-hint");
const optionList = el<HTMLUListElement>("options");
const clearVote = el<HTMLButtonElement>("clear-vote");
const votersLineEl = el<HTMLElement>("voters");
const closedBox = el<HTMLElement>("closed");
const closedTag = el<HTMLElement>("closed-tag");
const winnerEl = el<HTMLElement>("winner");
const hostBox = el<HTMLElement>("host");
const closeButton = el<HTMLButtonElement>("close");
const confirmBox = el<HTMLElement>("confirm");
const confirmText = el<HTMLElement>("confirm-text");
const confirmYes = el<HTMLButtonElement>("confirm-yes");
const confirmNo = el<HTMLButtonElement>("confirm-no");
const endButton = el<HTMLButtonElement>("end");
const hostNote = el<HTMLElement>("host-note");

type Screen = "connecting" | "waiting" | "setup" | "poll" | "outside";

function show(screen: Screen) {
  root.dataset.view = screen;
  waitingView.hidden = screen !== "waiting";
  setupView.hidden = screen !== "setup";
  pollView.hidden = screen !== "poll";
}

function setText(id: string, text: string) {
  el(id).textContent = text;
}

/** One row of the poll as drawn: the pieces `renderPoll` updates in place, so focus survives a vote. */
interface OptionRow {
  item: HTMLLIElement;
  input: HTMLInputElement;
  text: HTMLElement;
  count: HTMLElement;
  share: HTMLElement;
  fill: HTMLElement;
}

async function main() {
  const locale = pickLocale(navigator.language || "en");
  let lang = locale;
  let t: Strings = STRINGS[locale];

  function applyLabels() {
    document.documentElement.lang = lang;
    setText("title", t.title);
    setText("waiting", t.waiting);
    setText("waiting-hint", t.waitingHint);
    setText("setup-title", t.setupTitle);
    setText("question-label", t.questionLabel);
    questionInput.placeholder = t.questionPlaceholder;
    setText("options-label", t.optionsLabel);
    addOptionButton.textContent = t.addOption;
    setText("mode-label", t.modeLabel);
    setText("mode-single-text", t.modeSingle);
    setText("mode-multi-text", t.modeMulti);
    startButton.textContent = t.start;
    clearVote.textContent = t.clearVote;
    closeButton.textContent = t.closeVote;
    confirmText.textContent = t.closeAsk;
    confirmYes.textContent = t.closeConfirm;
    confirmNo.textContent = t.closeCancel;
    endButton.textContent = t.endPoll;
    closedTag.textContent = t.closedBanner;
    renumberRows();
  }

  document.documentElement.lang = lang;
  statusLine.textContent = t.connecting;
  show("connecting");

  let app: PqpApp;
  try {
    app = await connect();
  } catch {
    statusLine.textContent = "";
    endedLine.textContent = t.outside;
    endedLine.hidden = false;
    show("outside");
    return;
  }

  // the host's locale wins over the browser's: it is the one the person picked in pqp
  lang = pickLocale(app.hello.locale);
  t = STRINGS[lang];

  if (app.hello.reducedMotion) document.documentElement.dataset.reducedMotion = "true";
  applyTheme(app.hello.theme);
  app.on("theme", (theme) => applyTheme(theme));

  // ---- setup form (the host) ------------------------------------------------

  function optionInputs(): HTMLInputElement[] {
    return Array.from(optionRows.querySelectorAll<HTMLInputElement>("input.enq-option-input"));
  }

  function renumberRows() {
    const rows = Array.from(optionRows.children) as HTMLLIElement[];
    rows.forEach((row, index) => {
      const n = String(index + 1);
      const input = row.querySelector<HTMLInputElement>("input");
      const remove = row.querySelector<HTMLButtonElement>("button");
      if (input) {
        input.setAttribute("aria-label", fill(t.optionLabel, "n", n));
        input.placeholder = fill(t.optionPlaceholder, "n", n);
      }
      if (remove) {
        remove.setAttribute("aria-label", fill(t.removeOption, "n", n));
        remove.disabled = rows.length <= MIN_OPTIONS;
      }
    });
    addOptionButton.disabled = rows.length >= MAX_OPTIONS;
  }

  function addRow(focus: boolean): void {
    if (optionRows.children.length >= MAX_OPTIONS) return;
    const row = document.createElement("li");
    row.className = "enq-row";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "enq-input enq-option-input";
    input.maxLength = OPTION_MAX_LENGTH;
    input.autocomplete = "off";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "enq-icon-button";
    remove.textContent = "×";

    remove.addEventListener("click", () => {
      if (optionRows.children.length <= MIN_OPTIONS) return;
      const siblings = optionInputs();
      const at = siblings.indexOf(input);
      row.remove();
      renumberRows();
      const rest = optionInputs();
      (rest[Math.min(at, rest.length - 1)] ?? questionInput).focus();
    });

    input.addEventListener("input", () => {
      if (!setupError.hidden) showSetupError(null);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const all = optionInputs();
      const at = all.indexOf(input);
      const next = all[at + 1];
      if (next) next.focus();
      else addRow(true);
    });

    row.append(input, remove);
    optionRows.append(row);
    renumberRows();
    if (focus) input.focus();
  }

  addRow(false);
  addRow(false);
  addOptionButton.addEventListener("click", () => addRow(true));

  const problemText = (problem: DraftProblem): string =>
    ({
      question: t.errQuestion,
      options: t.errOptions,
      duplicate: t.errDuplicate,
      characters: t.errCharacters,
      "too-long": t.errTooLong,
    })[problem];

  function showSetupError(text: string | null) {
    setupError.hidden = text === null;
    setupError.textContent = text ?? "";
    questionInput.setAttribute("aria-invalid", text === t.errQuestion ? "true" : "false");
  }

  // ---- the controller -------------------------------------------------------

  let rows: OptionRow[] = [];
  let rowsKey = "";
  let lastScreen: Screen = "connecting";
  let lastClosed = false;
  let starting = false;

  const controller = new PollController(app, app.hello.self.seatId, (view) => render(view), {
    resultText: resultTextFor(t, lang),
  });

  function buildRows(poll: Poll) {
    optionList.replaceChildren();
    rows = poll.options.map((name, index) => {
      const item = document.createElement("li");
      item.className = "enq-option";

      const label = document.createElement("label");
      label.className = "enq-option-label";

      const input = document.createElement("input");
      input.type = poll.multi ? "checkbox" : "radio";
      input.name = "choice";
      input.value = String(index);
      input.className = "enq-option-input-native";
      input.addEventListener("change", () => {
        const view = controller.view;
        if (poll.multi) {
          const without = view.myMask - (hasBit(view.myMask, index) ? bit(index) : 0);
          controller.vote(input.checked ? without + bit(index) : without);
        } else {
          controller.vote(input.checked ? bit(index) : 0);
        }
      });

      const mark = document.createElement("span");
      mark.className = "enq-mark";
      mark.setAttribute("aria-hidden", "true");

      const text = document.createElement("span");
      text.className = "enq-option-text";
      text.textContent = name;

      const count = document.createElement("span");
      count.className = "enq-option-count";
      const share = document.createElement("span");
      share.className = "enq-option-share";

      const bar = document.createElement("span");
      bar.className = "enq-bar";
      bar.setAttribute("aria-hidden", "true");
      const barFill = document.createElement("span");
      barFill.className = "enq-fill";
      bar.append(barFill);

      label.append(input, mark, text, count, share, bar);
      item.append(label);
      optionList.append(item);
      return { item, input, text, count, share, fill: barFill };
    });
  }

  function renderPoll(view: View) {
    const poll = view.state.poll;
    const shown = shownTally(view.state);
    if (!poll || !shown) return;

    const key = JSON.stringify([poll.question, poll.options, poll.multi]);
    if (key !== rowsKey) {
      rowsKey = key;
      pollQuestion.textContent = poll.question;
      pollHint.textContent = poll.multi ? t.hintMulti : t.hintSingle;
      buildRows(poll);
    }

    const closed = view.state.closed !== null;
    const locked = closed || view.ended || view.connection !== "online";
    const winners = winnerIndexes(shown.counts);

    rows.forEach((row, index) => {
      const count = shown.counts[index] ?? 0;
      const pct = percent(count, shown.voters);
      const mine = hasBit(view.myMask, index);
      row.input.checked = mine;
      row.input.disabled = locked;
      row.item.dataset.mine = mine ? "true" : "false";
      row.item.dataset.winner = closed && winners.includes(index) ? "true" : "false";
      row.item.dataset.locked = locked ? "true" : "false";
      // the count is part of the label so a screen reader hears "Sim, 3 votos"
      row.count.textContent = votesLine(t, lang, count);
      row.share.textContent = `${pct}%`;
      row.fill.style.width = `${pct}%`;
    });

    votersLineEl.textContent = shown.voters === 0 ? t.nobodyYet : votersLine(t, lang, shown.voters);
    pollHint.hidden = closed;

    clearVote.hidden = locked || view.myMask === 0;
    if (clearVote.hidden && document.activeElement === clearVote) rows[0]?.input.focus();

    closedBox.hidden = !closed;
    if (closed) {
      const names = winners.map((i) => poll.options[i] ?? "").join(", ");
      winnerEl.textContent =
        winners.length === 0 ? t.noWinner : fill(winners.length > 1 ? t.tie : t.winner, "names", names);
      if (!lastClosed) live.textContent = `${t.closedBanner}. ${winnerEl.textContent}`;
    }
    lastClosed = closed;

    // host controls: close the vote first, then end the poll
    const canHost = view.amHost && !view.ended;
    hostBox.hidden = !canHost;
    closeButton.hidden = closed || confirmBox.hidden === false;
    endButton.hidden = !closed;
    if (closed) confirmBox.hidden = true;
    closeButton.disabled = view.connection !== "online";
    endButton.disabled = view.connection !== "online";
    hostNote.hidden = canHost || view.ended;
    hostNote.textContent = closed ? t.hostOnlyEnd : t.hostOnlyClose;
  }

  function render(view: View) {
    statusLine.textContent = view.ended ? "" : view.connection === "online" ? t.online : t.reconnecting;
    root.dataset.connection = view.connection;

    if (view.notice === "failed") notice.textContent = t.failed;
    else if (view.notice === "cannot-vote") notice.textContent = t.cannotVote;
    notice.hidden = view.notice === null;

    endedLine.hidden = !view.ended;
    endedLine.textContent = view.ended ? t.ended : "";

    let screen: Screen;
    if (view.state.poll) screen = "poll";
    else if (view.amHost && !view.ended) screen = "setup";
    else screen = "waiting";
    show(screen);

    if (screen === "poll") renderPoll(view);
    if (screen === "setup") {
      startButton.disabled = view.connection !== "online" || starting;
      if (lastScreen !== "setup") questionInput.focus();
    }
    if (screen === "poll" && lastScreen === "setup") pollQuestion.focus();
    lastScreen = screen;
  }

  // ---- wiring ---------------------------------------------------------------

  startButton.addEventListener("click", async () => {
    if (starting) return;
    const draft = validateDraft(
      questionInput.value,
      optionInputs().map((input) => input.value),
      modeMulti.checked,
    );
    if (!draft.ok) {
      showSetupError(problemText(draft.problem));
      if (draft.problem === "question") questionInput.focus();
      return;
    }
    showSetupError(null);
    starting = true;
    startButton.textContent = t.starting;
    startButton.disabled = true;
    await controller.start(draft.poll);
    starting = false;
    startButton.textContent = t.start;
    startButton.disabled = controller.view.connection !== "online";
  });
  questionInput.addEventListener("input", () => {
    if (!setupError.hidden) showSetupError(null);
  });

  clearVote.addEventListener("click", () => controller.vote(0));

  closeButton.addEventListener("click", () => {
    confirmBox.hidden = false;
    closeButton.hidden = true;
    confirmNo.focus();
  });
  confirmNo.addEventListener("click", () => {
    confirmBox.hidden = true;
    closeButton.hidden = false;
    closeButton.focus();
  });
  confirmYes.addEventListener("click", async () => {
    confirmYes.disabled = true;
    const done = await controller.close();
    confirmYes.disabled = false;
    if (!done && controller.view.state.closed === null) {
      // it did not close: put the button back and let the notice say so
      confirmBox.hidden = true;
      closeButton.hidden = false;
      closeButton.focus();
    } else {
      endButton.focus();
    }
  });
  endButton.addEventListener("click", () => {
    void controller.end();
  });

  app.on("connection", (status) => controller.setConnection(status));
  app.on("ended", () => controller.setEnded());

  applyLabels();
  await controller.init({ connection: app.connection });
}

void main();
