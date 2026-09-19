export interface ChannelMusicCardRights {
  canManageMusic: boolean;
  userId: string | null;
  roomSize: number;
}

const DEFAULT_RIGHTS: ChannelMusicCardRights = {
  canManageMusic: false,
  userId: null,
  roomSize: 0,
};

let rights: ChannelMusicCardRights = DEFAULT_RIGHTS;
const rightsListeners = new Set<() => void>();

export function setChannelMusicCardRights(next: ChannelMusicCardRights): void {
  if (
    next.canManageMusic === rights.canManageMusic &&
    next.userId === rights.userId &&
    next.roomSize === rights.roomSize
  ) {
    return;
  }
  rights = next;
  for (const listener of rightsListeners) {
    listener();
  }
}

export function getChannelMusicCardRights(): ChannelMusicCardRights {
  return rights;
}

export function subscribeChannelMusicCardRights(listener: () => void): () => void {
  rightsListeners.add(listener);
  return () => {
    rightsListeners.delete(listener);
  };
}

export function resetChannelMusicCardRightsForTests(): void {
  rights = DEFAULT_RIGHTS;
  rightsListeners.clear();
}
