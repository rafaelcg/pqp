import { type ReactNode } from "react";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";

interface LegalPageProps {
  title: string;
  description: string;
  path: string;
  heading: string;
  updated: string;
  children: ReactNode;
}

export function LegalPage({
  title,
  description,
  path,
  heading,
  updated,
  children,
}: LegalPageProps) {
  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo title={title} description={description} path={path} />
      <MarketingNav variant="solid" />
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8 sm:py-16">
        <p className="text-xs uppercase tracking-[0.2em] text-signal">Legal</p>
        <h1 className="mt-3 font-display text-4xl font-extrabold tracking-tight sm:text-5xl">
          {heading}
        </h1>
        <p className="mt-3 text-sm text-paper-muted">Last updated: {updated}</p>
        <div className="legal-prose mt-10 space-y-6 text-[15px] leading-relaxed text-paper/90">
          {children}
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
