/**
 * The seam between a `<video>` element and the transport that feeds it.
 *
 * WHY THIS EXISTS. LiveKit's `adaptiveStream` asks the SFU for a layer that
 * fits the element the picture is drawn into, and it can only measure an
 * element it has been introduced to: `RemoteVideoTrack.attach(element)` puts a
 * ResizeObserver and an IntersectionObserver on it. This codebase never called
 * `attach`. It hands every tile a plain `MediaStream` and sets `srcObject`
 * itself, which is the right shape for the mesh (there is no library there)
 * and, with adaptive streaming on, would be the one documented way to make a
 * track "never start": a track with no observed element has no size to report
 * and, after the first tab switch, reports itself invisible, at which point
 * the server stops sending it.
 *
 * So the LiveKit session registers, against each stream it hands out, how to
 * introduce an element to the track behind it, and the three places that set
 * `srcObject` call `bindRemoteVideo` instead of setting it directly. On the
 * mesh no stream is registered and the function is exactly the two lines the
 * components used to have. A stream is a good key because it is the one
 * object both sides already hold: the session made it, the peer carries it,
 * the tile receives it.
 *
 * Detaching deliberately does NOT use `track.detach(element)`. That removes
 * the track from the element's `MediaStream`, and the stream is *ours*, shared
 * by every tile showing the same share (a thumbnail and the stage, say), so
 * unmounting one tile would blank the others. Stopping observation is the
 * only half of `detach` this side wants.
 */

export interface RemoteVideoBinding {
  /** Introduce an element to the track so its size and visibility are measured. */
  attach(element: HTMLVideoElement): void;
  /** Stop measuring an element that is going away. Never touches `srcObject`. */
  detach(element: HTMLVideoElement): void;
}

const bindings = new WeakMap<MediaStream, RemoteVideoBinding>();

export function registerRemoteVideoBinding(
  stream: MediaStream,
  binding: RemoteVideoBinding,
): void {
  bindings.set(stream, binding);
}

/**
 * Point a `<video>` at a stream, and tell the transport about the element when
 * the transport wants to know. Returns the matching cleanup.
 */
export function bindRemoteVideo(
  video: HTMLVideoElement,
  stream: MediaStream | null,
): () => void {
  video.srcObject = stream;
  const binding = stream ? bindings.get(stream) : undefined;
  if (binding) {
    try {
      binding.attach(video);
    } catch (err) {
      // The picture is already on the element through `srcObject`; losing the
      // measurement costs bandwidth, never the video.
      console.warn("[pqp] could not attach remote video for adaptive stream", err);
    }
  }
  return () => {
    if (binding) {
      try {
        binding.detach(video);
      } catch {
        // Already gone, or never observed. Nothing to undo.
      }
    }
    video.srcObject = null;
  };
}
