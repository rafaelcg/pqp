export function writeRefusal(
  headers: { get(name: string): string | null },
  workerOrigin: string,
): { status: number; error: string } | null;
