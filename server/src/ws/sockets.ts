import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

export interface AuthenticatedSocket {
  socket: WebSocket;
  user: DbUser;
}

const sockets = new Map<WebSocket, AuthenticatedSocket>();

export function setAuthenticatedSocket(
  socket: WebSocket,
  user: DbUser,
): void {
  sockets.set(socket, { socket, user });
}

export function getSocketUser(socket: WebSocket): DbUser | null {
  return sockets.get(socket)?.user ?? null;
}

export function getAuthenticatedSocket(
  socket: WebSocket,
): AuthenticatedSocket | undefined {
  return sockets.get(socket);
}

export function deleteAuthenticatedSocket(socket: WebSocket): void {
  sockets.delete(socket);
}

export function forEachAuthenticatedSocket(
  callback: (socket: WebSocket, user: DbUser) => void,
): void {
  for (const entry of sockets.values()) {
    callback(entry.socket, entry.user);
  }
}
