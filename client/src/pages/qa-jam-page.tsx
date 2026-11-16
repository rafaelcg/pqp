import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { isDesktopApp } from "@/lib/desktop";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import {
  JamEngine,
  type JamClockTick,
  type JamStemState,
  type JamTake,
  type LatencyResult,
  type LatencyStatus,
  computePeaks,
  listInputs,
  prepareStemUpload,
  tapTempo,
} from "@/lib/jam";
import { metronomeClick, pulseTrain } from "@/lib/jam/signals";

/**
 * `/qa/jam`: the jam audio engine on a bench, for a person with a real
 * instrument. Load two or three stems, play them, calibrate, record over
 * them, read the measured latency, hear the take, nudge it.
 *
 * Gated like `/qa/ui` (the dev auth bypass), plain on purpose, English only
 * on purpose: it is a test rig, not product UI, and the jam screens will not
 * reuse it. The checklist it serves is in docs/JAM_ENGINE.md.
 */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="font-display text-lg font-extrabold text-text">{title}</h2>
      {children}
    </section>
  );
}

function Btn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm font-semibold text-text hover:bg-surface-3 disabled:opacity-40 ${props.className ?? ""}`}
    />
  );
}

function Num({ label, value, onChange, step = 1, width = "w-24" }: { label: string; value: number; onChange: (v: number) => void; step?: number; width?: string }) {
  return (
    <label className="flex items-center gap-1 text-xs text-text-secondary">
      {label}
      <input
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${width} rounded border border-border bg-surface-0 px-1.5 py-1 text-sm tabular-nums text-text`}
      />
    </label>
  );
}

function Peaks({ peaks, trimStart, trimEnd }: { peaks: number[]; trimStart: number; trimEnd: number }) {
  const n = peaks.length || 1;
  return (
    <svg viewBox={`0 0 ${n} 40`} preserveAspectRatio="none" className="h-10 w-full rounded bg-surface-0">
      {peaks.map((p, i) => {
        const pos = i / n;
        const dim = pos < trimStart || pos > 1 - trimEnd;
        return <rect key={i} x={i} y={20 - p * 20} width={0.8} height={Math.max(0.5, p * 40)} className={dim ? "fill-text-tertiary/40" : "fill-accent"} />;
      })}
    </svg>
  );
}

const fmt = (ms: number) => `${(ms / 1000).toFixed(3)} s`;

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function describeLatency(r: LatencyResult | undefined) {
  if (!r) return "none";
  const v = Number.isFinite(r.roundTripMs) ? `${r.roundTripMs.toFixed(2)} ms` : "n/a";
  const spread = Number.isFinite(r.spreadMs) ? `, spread ${r.spreadMs.toFixed(2)} ms` : "";
  const count = r.played ? `, ${r.accepted}/${r.played} heard` : "";
  return `${r.method}: ${v} (${r.confidence}${spread}${count})`;
}

interface StemExtras {
  peaks: number[];
  video?: string;
  take?: JamTake;
}

export function QaJamPage() {
  if (!isDevAuthBypassEnabled()) {
    return <Navigate to={isDesktopApp() ? "/app" : "/"} replace />;
  }
  return <JamBench />;
}

/** A stem's picture, locked to the engine's clock for as long as it is mounted. */
function StemVideo({ engine, id, src }: { engine: JamEngine; id: string; src: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    return engine.player.attachVideo(id, ref.current);
  }, [engine, id, src]);
  return <video ref={ref} src={src} className="max-h-48 rounded" muted playsInline />;
}

function JamBench() {
  const engineRef = useRef<JamEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [clock, setClock] = useState<JamClockTick | null>(null);
  const [stems, setStems] = useState<JamStemState[]>([]);
  const [extras, setExtras] = useState<Record<string, StemExtras>>({});
  const [log, setLog] = useState<string[]>([]);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [inputOpen, setInputOpen] = useState(false);
  const [inputSettings, setInputSettings] = useState<string>("");
  const [status, setStatus] = useState<LatencyStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  const [bpm, setBpm] = useState(120);
  const [beatsPerBar, setBeatsPerBar] = useState(4);
  const [countBars, setCountBars] = useState<0 | 1 | 2>(1);
  const [metronome, setMetronome] = useState(false);
  const [withCamera, setWithCamera] = useState(false);
  const [monitor, setMonitor] = useState(false);
  const [recording, setRecording] = useState<null | { stop: () => Promise<JamTake>; cancel: () => Promise<void> }>(null);
  const [lastTake, setLastTake] = useState<JamTake | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const [loop, setLoop] = useState({ startMs: 0, endMs: 4000 });
  const taps = useRef<number[]>([]);
  const takeCount = useRef(0);
  const cameraRef = useRef<MediaStream | null>(null);

  const say = useCallback((line: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 60)), []);
  const refreshStems = useCallback(() => setStems(engineRef.current?.player.stems() ?? []), []);
  const refreshLatency = useCallback(async () => {
    const e = engineRef.current;
    if (e) setStatus(await e.latency());
  }, []);

  useEffect(() => {
    return () => {
      cameraRef.current?.getTracks().forEach((t) => t.stop());
      void engineRef.current?.destroy();
    };
  }, []);

  const start = async () => {
    const engine = await JamEngine.create();
    await engine.context.resume();
    engineRef.current = engine;
    engine.player.subscribe(setClock);
    engine.onDevicesChanged((s) => {
      setStatus(s);
      say(`devices changed: now ${s.devices.input.label || "?"} -> ${s.devices.output.label || "default output"}; latency in use ${describeLatency(s.current)}`);
    });
    setReady(true);
    const c = engine.context as AudioContext & { outputLatency?: number };
    say(`context ${engine.context.sampleRate} Hz, baseLatency ${(engine.context.baseLatency * 1000).toFixed(1)} ms, outputLatency ${((c.outputLatency ?? 0) * 1000).toFixed(1)} ms`);
    await refreshLatency();
  };

  const addFile = async (file: File) => {
    const e = engineRef.current!;
    const id = file.name.replace(/\.[^.]+$/, "").slice(0, 24) || `stem-${Date.now()}`;
    try {
      const st = await e.player.loadStem(id, file);
      const buf = e.player.buffer(id)!;
      const isVideo = file.type.startsWith("video/");
      setExtras((x) => ({
        ...x,
        [id]: { peaks: computePeaks([buf.getChannelData(0)]), video: isVideo ? URL.createObjectURL(file) : undefined },
      }));
      say(`loaded ${id}: ${fmt(st.durationMs)}, ${buf.numberOfChannels} ch${isVideo ? ", with video" : ""}`);
    } catch (err) {
      say(`could not decode ${file.name}: ${String(err)}`);
    }
    refreshStems();
  };

  const addClickTrack = () => {
    const e = engineRef.current!;
    const sr = e.context.sampleRate;
    const beat = Math.round((60 / bpm) * sr);
    const bars = 16;
    const at = Array.from({ length: bars * beatsPerBar }, (_, k) => k * beat);
    const accent = metronomeClick(sr, true);
    const plain = metronomeClick(sr, false);
    const x = pulseTrain(at.length * beat, plain, at.filter((_, k) => k % beatsPerBar !== 0));
    const acc = pulseTrain(at.length * beat, accent, at.filter((_, k) => k % beatsPerBar === 0));
    for (let i = 0; i < x.length; i++) x[i] += acc[i];
    const buf = e.context.createBuffer(1, x.length, sr);
    buf.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
    const id = `click ${bpm}`;
    e.player.addStem({ id, buffer: buf });
    setExtras((xs) => ({ ...xs, [id]: { peaks: computePeaks([x]) } }));
    refreshStems();
    say(`added a ${bpm} BPM click track, ${bars} bars of ${beatsPerBar}`);
  };

  const openInput = async () => {
    const e = engineRef.current!;
    setBusy("input");
    try {
      const input = await e.openInput({ deviceId: deviceId || undefined });
      setInputOpen(true);
      setInputs(await listInputs());
      const s = input.settings() as MediaTrackSettings & { latency?: number; voiceIsolation?: boolean };
      setInputSettings(
        `${input.label}: ${s.sampleRate ?? "?"} Hz, ${s.channelCount ?? "?"} ch, echoCancellation=${s.echoCancellation}, noiseSuppression=${s.noiseSuppression}, autoGainControl=${s.autoGainControl}, latency=${s.latency ?? "n/a"}`,
      );
      input.setMonitor(monitor);
      await refreshLatency();
      say(`input open: ${input.label}`);
    } catch (err) {
      say(`input failed: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const calibrate = async (method: "loopback" | "tap-along") => {
    const e = engineRef.current!;
    setBusy(method);
    try {
      const r = method === "loopback" ? await e.calibrate("loopback") : await e.calibrate("tap-along", { bpm: 100 });
      say(`${describeLatency(r)}${r.note ? ` (${r.note})` : ""}; lags ${(r.samples ?? []).map((v) => v.toFixed(2)).join(", ")}`);
      await refreshLatency();
    } catch (err) {
      say(`calibration failed: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const record = async () => {
    const e = engineRef.current!;
    try {
      if (withCamera && !cameraRef.current) {
        cameraRef.current = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      }
      const pos = e.player.positionMs();
      const handle = await e.record({
        fromMs: pos,
        countIn: countBars ? { bars: countBars, beatsPerBar, bpm } : null,
        metronome: metronome ? { bpm, beatsPerBar } : null,
        camera: withCamera ? cameraRef.current : null,
      });
      setRecording(handle);
      say(`recording from ${fmt(pos)} with ${describeLatency((await e.latency()).current)}`);
    } catch (err) {
      say(`could not start recording: ${String(err)}`);
    }
  };

  const stopRecording = async () => {
    const e = engineRef.current!;
    let take: JamTake;
    try {
      take = await recording!.stop();
    } catch (err) {
      say(`recording failed: ${String(err)}`);
      setRecording(null);
      return;
    } finally {
      setRecording(null);
    }
    takeCount.current += 1;
    const id = `take ${takeCount.current}`;
    e.addTake(id, take);
    setExtras((x) => ({
      ...x,
      [id]: { peaks: computePeaks([take.samples]), take, video: take.video ? URL.createObjectURL(take.video.blob) : undefined },
    }));
    setLastTake(take);
    refreshStems();
    say(
      `${id}: offset ${take.offsetMs} ms, trimStart ${take.trimStartMs.toFixed(0)} ms, ${fmt(take.durationMs)}, ` +
        `latency ${take.latency.roundTripMs.toFixed(2)} ms (${take.latency.method}), input ${take.monoChoice}, ` +
        `dropped ${take.inputDroppedMs ?? "n/a"} ms, gaps ${take.gapFrames}${take.captureTruncated ? ", TAIL MAY BE MISSING" : ""}` +
        (take.video
          ? `, video ${take.video.mimeType} aligned by ${take.video.alignment.method} (q ${take.video.alignment.quality.toFixed(2)}, timestamp guess off by ${(((take.video.alignment.timestampGuess - take.video.alignment.zeroFrame) / take.sampleRate) * 1000).toFixed(1)} ms)`
          : take.videoError
            ? `, video failed: ${take.videoError}`
            : ""),
    );
  };

  const update = (id: string, patch: Parameters<JamEngine["player"]["updateStem"]>[1]) => {
    engineRef.current?.player.updateStem(id, patch);
    refreshStems();
  };

  const tap = () => {
    taps.current = [...taps.current.filter((t) => performance.now() - t < 4000), performance.now()];
    const b = tapTempo(taps.current);
    if (b) setBpm(Math.round(b));
  };

  const e = engineRef.current;
  const duration = clock?.durationMs ?? 0;
  const bluetooth = status?.output.suitability === "bluetooth";

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 bg-surface-0 px-4 py-8 text-text">
      <h1 className="font-display text-2xl font-extrabold">jam engine bench</h1>
      <p className="text-sm text-text-secondary">
        Dev-only rig for the jam audio engine. Headphones or a monitor, a guitar or a mic. The checklist is in docs/JAM_ENGINE.md.
      </p>

      {!ready ? (
        <Btn onClick={() => void start()}>Start audio engine</Btn>
      ) : (
        <>
          <Section title="1. Stems">
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-sm">
                Load audio or video files:{" "}
                <input type="file" accept="audio/*,video/*" multiple onChange={(ev) => [...(ev.target.files ?? [])].forEach((f) => void addFile(f))} />
              </label>
              <Btn onClick={addClickTrack}>Add click track ({bpm} BPM)</Btn>
            </div>
            {stems.map((s) => {
              const x = extras[s.id];
              const trimStart = s.durationMs ? s.trimStartMs / s.durationMs : 0;
              const trimEnd = s.durationMs ? s.trimEndMs / s.durationMs : 0;
              return (
                <div key={s.id} className="space-y-2 rounded border border-border p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="min-w-24 text-sm">{s.id}</strong>
                    <Btn onClick={() => update(s.id, { muted: !s.muted })} className={s.muted ? "bg-danger/30" : ""}>
                      {s.muted ? "muted" : "mute"}
                    </Btn>
                    <Btn onClick={() => update(s.id, { solo: !s.solo })} className={s.solo ? "bg-accent/30" : ""}>
                      {s.solo ? "solo on" : "solo"}
                    </Btn>
                    <label className="flex items-center gap-1 text-xs">
                      gain
                      <input type="range" min={0} max={1.5} step={0.01} value={s.gain} onChange={(ev) => update(s.id, { gain: Number(ev.target.value) })} />
                      <span className="w-10 tabular-nums">{s.gain.toFixed(2)}</span>
                    </label>
                    <span className="text-xs text-text-secondary">nudge</span>
                    {[-10, -1, 1, 10].map((d) => (
                      <Btn key={d} onClick={() => update(s.id, { offsetMs: s.offsetMs + d })}>
                        {d > 0 ? `+${d}` : d} ms
                      </Btn>
                    ))}
                    <Num label="offset ms" value={s.offsetMs} onChange={(v) => update(s.id, { offsetMs: v })} />
                    <Num label="trim start" value={Math.round(s.trimStartMs)} onChange={(v) => update(s.id, { trimStartMs: v })} />
                    <Num label="trim end" value={Math.round(s.trimEndMs)} onChange={(v) => update(s.id, { trimEndMs: v })} />
                    <Btn
                      onClick={() => {
                        e?.player.removeStem(s.id);
                        if (x?.video) URL.revokeObjectURL(x.video);
                        setExtras((xs) => {
                          const { [s.id]: _gone, ...rest } = xs;
                          void _gone;
                          return rest;
                        });
                        refreshStems();
                      }}
                    >
                      remove
                    </Btn>
                    {x?.take && (
                      <Btn
                        onClick={async () => {
                          const up = await prepareStemUpload(x.take!);
                          download(up.audio, `${s.id}.flac`);
                          if (up.video) download(up.video, `${s.id}.${up.video.type.includes("mp4") ? "mp4" : "webm"}`);
                          say(`${s.id} upload: ${(up.audio.size / 1024).toFixed(0)} kB FLAC, ${JSON.stringify({ ...up, audio: undefined, video: undefined, peaks: `${up.peaks.length} values` })}`);
                        }}
                      >
                        download FLAC
                      </Btn>
                    )}
                  </div>
                  {x && <Peaks peaks={x.peaks} trimStart={trimStart} trimEnd={trimEnd} />}
                  {x?.video && e && <StemVideo engine={e} id={s.id} src={x.video} />}
                </div>
              );
            })}
          </Section>

          <Section title="2. Transport">
            <div className="flex flex-wrap items-center gap-2">
              <Btn onClick={() => void e?.player.play()} disabled={!stems.length}>
                Play
              </Btn>
              <Btn onClick={() => e?.player.pause()}>Pause</Btn>
              <Btn onClick={() => e?.player.stop()}>Stop</Btn>
              <span className="tabular-nums text-sm">
                {fmt(clock?.positionMs ?? 0)} / {fmt(duration)} ({clock?.state})
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(1, duration)}
              step={1}
              value={clock?.positionMs ?? 0}
              onChange={(ev) => e?.player.seek(Number(ev.target.value))}
              className="w-full"
            />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={loopOn}
                  onChange={(ev) => {
                    setLoopOn(ev.target.checked);
                    e?.player.setLoop(ev.target.checked ? loop : null);
                  }}
                />
                loop
              </label>
              <Num label="from ms" value={loop.startMs} onChange={(v) => setLoop((l) => ({ ...l, startMs: v }))} />
              <Num label="to ms" value={loop.endMs} onChange={(v) => setLoop((l) => ({ ...l, endMs: v }))} />
              <Btn onClick={() => loopOn && e?.player.setLoop(loop)}>apply loop</Btn>
              <Btn onClick={async () => e && download(await e.exportMix("flac"), "mix.flac")} disabled={!stems.length}>
                Export mix (FLAC)
              </Btn>
            </div>
          </Section>

          <Section title="3. Input and latency">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <select value={deviceId} onChange={(ev) => setDeviceId(ev.target.value)} className="rounded border border-border bg-surface-0 px-2 py-1">
                <option value="">default input</option>
                {inputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId.slice(0, 8)}
                  </option>
                ))}
              </select>
              <Btn onClick={() => void openInput()} disabled={busy !== null}>
                {inputOpen ? "Reopen input" : "Open input"}
              </Btn>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={monitor}
                  onChange={(ev) => {
                    setMonitor(ev.target.checked);
                    e?.input?.setMonitor(ev.target.checked);
                  }}
                />
                hear myself through the browser (adds a round trip of delay)
              </label>
            </div>
            {inputSettings && <p className="text-xs text-text-secondary">{inputSettings}</p>}
            {status && (
              <div className="space-y-1 text-sm">
                <p>
                  <strong>In use:</strong> {describeLatency(status.current)}
                </p>
                <p className="text-xs text-text-secondary">
                  Estimate {status.estimate.roundTripMs.toFixed(2)} ms = base {status.estimate.breakdown.baseMs?.toFixed(2) ?? "n/a"} + output{" "}
                  {status.estimate.breakdown.outputMs?.toFixed(2) ?? "n/a"} + input {status.estimate.breakdown.inputMs?.toFixed(2)} ({status.estimate.breakdown.inputSource}). {status.estimate.note}
                </p>
                <p className="text-xs text-text-secondary">
                  Stored for this pair: {status.stored.length ? status.stored.map((r) => `${describeLatency(r)}${r.stale ? " [stale]" : ""}`).join("; ") : "nothing"}
                </p>
                <p className="text-xs text-text-secondary">
                  Output: {status.devices.output.label || "unknown"}. Input: {status.devices.input.label || "not open"}.
                </p>
                {bluetooth && (
                  <p className="rounded bg-danger/20 p-2 text-sm">
                    Bluetooth output: {status.output.reason} Playback is fine; recording over it will not line up. Use wired headphones or speakers.
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Btn onClick={() => void calibrate("loopback")} disabled={!inputOpen || busy !== null}>
                {busy === "loopback" ? "Listening…" : "Calibrate: loopback (speakers, or a headphone cup on the mic)"}
              </Btn>
              <Btn onClick={() => void calibrate("tap-along")} disabled={!inputOpen || busy !== null}>
                {busy === "tap-along" ? "Tap on every click…" : "Calibrate: tap along (12 clicks at 100 BPM)"}
              </Btn>
              <Num label="manual round trip ms" value={manual} step={0.1} onChange={setManual} />
              <Btn onClick={async () => { await e?.setManualLatency(manual); await refreshLatency(); }} disabled={!inputOpen}>
                use manual
              </Btn>
              <Btn onClick={async () => { await e?.setManualLatency(null); await refreshLatency(); }} disabled={!inputOpen}>
                clear manual
              </Btn>
            </div>
          </Section>

          <Section title="4. Record">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Num label="BPM" value={bpm} onChange={setBpm} width="w-16" />
              <Btn onClick={tap}>tap tempo</Btn>
              <Num label="beats/bar" value={beatsPerBar} onChange={(v) => setBeatsPerBar(Math.max(1, Math.round(v)))} width="w-14" />
              <label className="flex items-center gap-1">
                count-in
                <select value={countBars} onChange={(ev) => setCountBars(Number(ev.target.value) as 0 | 1 | 2)} className="rounded border border-border bg-surface-0 px-1 py-1">
                  <option value={0}>none</option>
                  <option value={1}>1 bar</option>
                  <option value={2}>2 bars</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={metronome} onChange={(ev) => setMetronome(ev.target.checked)} />
                click during take
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={withCamera} onChange={(ev) => setWithCamera(ev.target.checked)} />
                camera
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!recording ? (
                <Btn onClick={() => void record()} disabled={!inputOpen} className="bg-danger/20">
                  ● Record from {fmt(clock?.positionMs ?? 0)}
                </Btn>
              ) : (
                <Btn onClick={() => void stopRecording()} className="bg-danger/40">
                  ■ Stop
                </Btn>
              )}
              {lastTake && (
                <span className="text-xs text-text-secondary">
                  last take: offset {lastTake.offsetMs} ms, compensated {lastTake.latency.roundTripMs.toFixed(2)} ms ({lastTake.latency.method}, {lastTake.latency.confidence})
                </span>
              )}
            </div>
          </Section>

          <Section title="Log">
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs text-text-secondary">{log.join("\n")}</pre>
          </Section>
        </>
      )}
    </main>
  );
}
