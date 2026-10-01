import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  CODE_SIGNING_ANCHOR,
  SIGNPATH_CREDIT,
  SIGNPATH_TERMS_URL,
  SIGNPATH_URL,
  SOURCE_REPO_URL,
} from "@/lib/downloads";
import { useTranslation } from "@/lib/i18n";

/**
 * The "Code signing policy" the SignPath Foundation asks every project it signs
 * for to publish on its download page: the credit sentence, who the roles are,
 * and a privacy statement.
 *
 * HONESTY IS THE POINT OF THE LAYOUT. Windows builds are NOT signed yet; the
 * application is pending. So the credit sentence sits under a sentence that says
 * so, and the SmartScreen guidance for unsigned builds stays right below it. The
 * day the program approves us, the status copy changes and nothing else here
 * has to.
 *
 * THE CREDIT SENTENCE IS NOT A LOCALE KEY. SignPath requires that exact English
 * text, so translating it would break the condition. It is rendered `lang="en"`
 * in every language, with a translated note beside it.
 *
 * PRIVACY IS WRITTEN, NOT BORROWED. SignPath's template sentence ("will not
 * transfer any information to other networked systems") would be false here: the
 * desktop app is a window onto pqp.gg (`DEFAULT_PROD_URL` in `electron/main.js`),
 * so it reaches the service and the third parties the privacy policy lists, and
 * the shell checks GitHub Releases for updates (`electron/lib/updater.js`). This
 * section says that instead and links the policy.
 */

const REPO_WORKFLOW_URL = `${SOURCE_REPO_URL}/blob/main/.github/workflows/electron.yml`;

const LINK =
  "underline decoration-paper-muted/40 underline-offset-4 transition-colors hover:text-signal hover:decoration-signal/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center";

interface Member {
  name: string;
  handle: string;
}

const RAFAEL: Member = { name: "Rafael Cammarano Guglielmi", handle: "rafaelcg" };
const ANDRE: Member = { name: "André", handle: "AndreCamm" };

const COMMITTERS: Member[] = [RAFAEL, ANDRE];
const APPROVERS: Member[] = [RAFAEL];

export function CodeSigningPolicy() {
  const { t } = useTranslation();

  return (
    <section
      id={CODE_SIGNING_ANCHOR}
      aria-labelledby="code-signing-heading"
      className="scroll-mt-24 border-t border-ink-4/40 pt-16"
    >
      <h2
        id="code-signing-heading"
        className="text-balance font-display text-3xl font-extrabold tracking-tight sm:text-4xl"
      >
        {t("codeSigning.title")}
      </h2>

      <div className="mt-6 max-w-2xl space-y-4 text-base leading-relaxed text-paper-muted">
        <p>{t("codeSigning.status")}</p>
        <blockquote
          lang="en"
          className="rounded-xl border border-ink-4 bg-ink-2/60 px-5 py-4 font-medium text-paper"
        >
          {SIGNPATH_CREDIT}
        </blockquote>
        <p className="text-sm">{t("codeSigning.creditNote")}</p>
        <p>{t("codeSigning.unsigned")}</p>
        <p className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <a href={SIGNPATH_URL} target="_blank" rel="noopener" className={LINK}>
            {t("codeSigning.link.signpath")}
          </a>
          <a
            href={SIGNPATH_TERMS_URL}
            target="_blank"
            rel="noopener"
            className={LINK}
          >
            {t("codeSigning.link.terms")}
          </a>
        </p>
      </div>

      <div className="mt-14 grid max-w-4xl gap-x-12 gap-y-12 md:grid-cols-2">
        <div>
          <h3 className="text-xl font-semibold tracking-tight">
            {t("codeSigning.team.title")}
          </h3>
          <dl className="mt-5 space-y-6">
            <Role
              term={t("codeSigning.team.committers")}
              description={t("codeSigning.team.committers.desc")}
              members={COMMITTERS}
            />
            <Role
              term={t("codeSigning.team.approvers")}
              description={t("codeSigning.team.approvers.desc")}
              members={APPROVERS}
            />
          </dl>
        </div>

        <div>
          <h3 className="text-xl font-semibold tracking-tight">
            {t("codeSigning.how.title")}
          </h3>
          <ul className="mt-5 list-disc space-y-3 pl-5 text-base leading-relaxed text-paper-muted marker:text-signal">
            <li>{t("codeSigning.how.build")}</li>
            <li>{t("codeSigning.how.approve")}</li>
            <li>{t("codeSigning.how.scope")}</li>
          </ul>
          <p className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-paper-muted">
            <a href={SOURCE_REPO_URL} target="_blank" rel="noopener" className={LINK}>
              {t("codeSigning.link.repo")}
            </a>
            <a href={REPO_WORKFLOW_URL} target="_blank" rel="noopener" className={LINK}>
              {t("codeSigning.link.workflow")}
            </a>
          </p>
        </div>
      </div>

      <div className="mt-14 max-w-2xl">
        <h3 className="text-xl font-semibold tracking-tight">
          {t("codeSigning.privacy.title")}
        </h3>
        <div className="mt-4 space-y-3 text-base leading-relaxed text-paper-muted">
          <p>{t("codeSigning.privacy.installer")}</p>
          <p>{t("codeSigning.privacy.app")}</p>
          <p>{t("codeSigning.privacy.signpath")}</p>
          <p className="text-sm">
            <Link to="/privacy" className={LINK}>
              {t("codeSigning.privacy.link")}
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

function Role({
  term,
  description,
  members,
}: {
  term: string;
  description: string;
  members: Member[];
}): ReactNode {
  return (
    <div>
      <dt className="font-medium text-paper">{term}</dt>
      <dd className="mt-1 text-sm leading-relaxed text-paper-muted">
        {description}
      </dd>
      <dd className="mt-2">
        <ul className="space-y-1 text-base text-paper">
          {members.map((m) => (
            <li key={m.handle}>
              {m.name}{" "}
              <a
                href={`https://github.com/${m.handle}`}
                target="_blank"
                rel="noopener"
                className={`text-paper-muted ${LINK}`}
              >
                @{m.handle}
              </a>
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}
