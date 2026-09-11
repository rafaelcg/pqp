/**
 * "Meu mic vai no stream": whether a watch party share carries the host's
 * microphone to the people watching from outside. On by default: a host
 * talking over a film expects to be heard, and the surprise the other way
 * (the room hears you, the stream does not) is the one nobody could see.
 * Per browser, like the other share preferences.
 */
const STORAGE_KEY = "pqp:mic-in-stream";

export function getMicInStream(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveMicInStream(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Storage denied: the choice holds for this session.
  }
}
