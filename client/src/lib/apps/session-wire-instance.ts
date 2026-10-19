import { createAppSessionWire, type AppWireLink } from "./session-wire";

/**
 * The one wire this tab has. `App.tsx` points `appWireLink.current` at the
 * realtime transport once the socket exists and feeds every server frame to
 * `appSessionWire.dispatch`; the components only ever ask for a transport.
 */
export const appWireLink: { current: AppWireLink | null } = { current: null };
export const appSessionWire = createAppSessionWire(appWireLink);
