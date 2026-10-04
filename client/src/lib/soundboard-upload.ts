import { audioDurationMs, soundboardClipRejection, SOUNDBOARD_MAX_BYTES, SOUNDBOARD_MAX_DURATION_MS } from "@pqp/shared";
import {
  claimSoundboardSound,
  createSoundboardUpload,
  type SoundboardSoundDto,
} from "@/lib/api";

export type SoundboardFileError = "type" | "too_big" | "too_long" | "unreadable";

export function soundboardContentType(file: File): "audio/mpeg" | "audio/ogg" | null {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  if (type === "audio/mpeg" || type === "audio/mp3" || name.endsWith(".mp3")) {
    return "audio/mpeg";
  }
  if (type === "audio/ogg" || name.endsWith(".ogg")) {
    return "audio/ogg";
  }
  return null;
}

/** Reject before the bytes leave the machine. The server checks again. */
export async function inspectSoundboardFile(
  file: File,
): Promise<{ contentType: "audio/mpeg" | "audio/ogg" } | SoundboardFileError> {
  const contentType = soundboardContentType(file);
  if (!contentType) {
    return "type";
  }
  if (file.size <= 0 || file.size > SOUNDBOARD_MAX_BYTES) {
    return "too_big";
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const durationMs = audioDurationMs(bytes, contentType);
  const rejection = soundboardClipRejection(
    file.size,
    durationMs,
    SOUNDBOARD_MAX_BYTES,
    SOUNDBOARD_MAX_DURATION_MS,
  );
  if (rejection === "too_big" || rejection === "too_long" || rejection === "unreadable") {
    return rejection;
  }
  return { contentType };
}

export async function uploadSoundboardFile(input: {
  serverId: string;
  file: File;
  contentType: "audio/mpeg" | "audio/ogg";
  name: string;
  emoji: string;
  volume?: number;
}): Promise<SoundboardSoundDto> {
  const minted = await createSoundboardUpload(input.serverId, {
    contentType: input.contentType,
    byteSize: input.file.size,
  });
  const response = await fetch(minted.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": input.contentType },
    body: input.file,
  });
  if (!response.ok) {
    throw new Error("storage");
  }
  const claimed = await claimSoundboardSound(input.serverId, {
    key: minted.key,
    name: input.name,
    emoji: input.emoji,
    volume: input.volume,
  });
  return claimed.sound;
}
