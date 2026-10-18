import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { Hero } from "./hero";
import { Nav } from "./nav";
import { Posters, Ticker } from "./posters";
import { Closer, Codigo, ImportPoster, Mural } from "./rest";

export default function Page() {
  return (
    <div className="hp-grain min-h-screen overflow-x-clip bg-ink text-paper">
      <Nav />
      <main id="conteudo">
        <Hero />
        <Ticker />
        <Posters />
        <ImportPoster />
        <Mural />
        <Codigo />
        <Closer />
      </main>
      <MarketingFooter />
    </div>
  );
}
