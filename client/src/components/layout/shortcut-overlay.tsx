import { defaultPushToTalkBinding, type KeyBinding } from "@/components/voice/push-to-talk";
import { bindingKeycaps } from "@/components/voice/key-binding-field";
import { Dialog } from "@/components/ui/dialog";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  SHORTCUT_GROUPS,
  type ShortcutAction,
} from "@/lib/keyboard-shortcuts";

const ACTION_LABEL: Record<ShortcutAction | "pushToTalk", MessageKey> = {
  toggleMute: "shortcuts.action.toggleMute",
  toggleDeafen: "shortcuts.action.toggleDeafen",
  openUserSettings: "shortcuts.action.openUserSettings",
  previousChannel: "shortcuts.action.previousChannel",
  nextChannel: "shortcuts.action.nextChannel",
  previousUnreadChannel: "shortcuts.action.previousUnreadChannel",
  nextUnreadChannel: "shortcuts.action.nextUnreadChannel",
  toggleOverlay: "shortcuts.action.toggleOverlay",
  pushToTalk: "shortcuts.action.pushToTalk",
  openNewDm: "shortcuts.newDm",
};

const GROUP_LABEL: Record<(typeof SHORTCUT_GROUPS)[number]["id"], MessageKey> = {
  voice: "shortcuts.group.voice",
  navigation: "shortcuts.group.navigation",
  app: "shortcuts.group.app",
};

function ShortcutKeys({ binding }: { binding: KeyBinding }) {
  const { t } = useTranslation();
  const { keys: parts, label } = bindingKeycaps(binding, undefined, t);
  return (
    <span
      role="img"
      aria-label={label}
      className="flex flex-wrap items-center justify-end gap-1"
    >
      {parts.map((part, index) => (
        <kbd
          key={`${part}-${index}`}
          className="rounded border border-ink-4 bg-ink-3 px-1.5 py-0.5 font-mono text-[11px] text-paper"
        >
          {part}
        </kbd>
      ))}
    </span>
  );
}

function ShortcutRow({
  label,
  binding,
  off = false,
}: {
  label: string;
  binding: KeyBinding;
  /** The key does nothing right now, so it is not drawn as if it did. */
  off?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="min-w-0 text-sm text-paper">{label}</span>
      {off ? (
        <span className="rounded-full border border-ink-4 px-2.5 py-0.5 text-xs text-paper-muted">
          {t("settings.keyboard.pttOff")}
        </span>
      ) : (
        <ShortcutKeys binding={binding} />
      )}
    </div>
  );
}

interface ShortcutOverlayProps {
  open: boolean;
  bindings: Record<ShortcutAction, KeyBinding>;
  pushToTalkKey?: KeyBinding;
  /**
   * Whether the input mode is push-to-talk. On voice activity the key does
   * nothing, so the map says "Off" instead of listing it as a shortcut.
   */
  pushToTalkOn?: boolean;
  onClose: () => void;
}

export function ShortcutOverlay({
  open,
  bindings,
  pushToTalkKey = defaultPushToTalkBinding,
  pushToTalkOn = true,
  onClose,
}: ShortcutOverlayProps) {
  const { t } = useTranslation();

  return (
    // Dismissing the map with a click on its backdrop closes it on the
    // mousedown, and the browser then moves focus off whatever the dialog
    // handed it back to ("Ver o mapa" in Atalhos), onto the page. Cancelling
    // that default keeps the focus where the dialog put it. The wrapper draws
    // nothing: the dialog is portalled, and React bubbles its events here.
    <div
      className="contents"
      onMouseDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.hasAttribute("data-dialog-layer")
        ) {
          event.preventDefault();
        }
      }}
    >
      <Dialog
        open={open}
        eyebrow={t("shortcuts.overlay.eyebrow")}
        title={t("shortcuts.overlay.title")}
        description={t("shortcuts.overlay.description")}
        size="lg"
        onClose={onClose}
      >
        <div className="grid gap-6 px-5 py-5 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.id}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-paper-muted">
                {t(GROUP_LABEL[group.id])}
              </h3>
              <div className="divide-y divide-ink-4/70">
                {group.id === "voice" && (
                  <>
                    {group.actions.map((action) => (
                      <ShortcutRow
                        key={action}
                        label={t(ACTION_LABEL[action])}
                        binding={bindings[action]}
                      />
                    ))}
                    <ShortcutRow
                      label={t(ACTION_LABEL.pushToTalk)}
                      binding={pushToTalkKey}
                      off={!pushToTalkOn}
                    />
                  </>
                )}
                {group.id !== "voice" &&
                  group.actions.map((action) => (
                    <ShortcutRow
                      key={action}
                      label={t(ACTION_LABEL[action])}
                      binding={bindings[action]}
                    />
                  ))}
              </div>
            </section>
          ))}
        </div>
      </Dialog>
    </div>
  );
}

export { ACTION_LABEL, GROUP_LABEL };
