import { createContext, useContext, type ReactNode } from "react";

/**
 * Which server the call in progress belongs to, and whether this person may
 * invite to it. Read by the invite card in the voice room (`room-cards.tsx`).
 * `App` provides it once; a call in a DM has no server and no right to invite.
 */
type BringFriendsServerValue = {
  serverId: string | null;
  canCreateInvite: boolean;
};

const BringFriendsServerContext = createContext<BringFriendsServerValue>({
  serverId: null,
  canCreateInvite: false,
});

export function BringFriendsServerProvider({
  serverId,
  canCreateInvite,
  children,
}: {
  serverId: string | null;
  canCreateInvite: boolean;
  children: ReactNode;
}) {
  return (
    <BringFriendsServerContext.Provider value={{ serverId, canCreateInvite }}>
      {children}
    </BringFriendsServerContext.Provider>
  );
}

export function useBringFriendsServer(): BringFriendsServerValue {
  return useContext(BringFriendsServerContext);
}
