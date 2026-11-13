import type { SVGProps } from "react";

/**
 * The few icons the public jam site draws, as inline SVG. The app's icon set
 * (`lucide-react`) is one shared chunk of every icon the whole app uses
 * (about 30 kB gzipped); the public site needs eighteen of them, so it carries
 * their paths itself. Generated from lucide-react (ISC licence, the same
 * artwork the app shows): 24x24, stroke 2, round caps and joins, `currentColor`.
 */

type Node = ReadonlyArray<readonly [string, Record<string, string>]>;

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { strokeWidth?: number };
export type IconComponent = (props: IconProps) => React.JSX.Element;

function make(node: Node): IconComponent {
  return function Icon({ strokeWidth = 2, ...rest }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...rest}
      >
        {node.map(([tag, attrs], index) => {
          const Tag = tag as "path";
          return <Tag key={index} {...attrs} />;
        })}
      </svg>
    );
  };
}

export const ArrowLeftIcon = make([
  ["path", {"d":"m12 19-7-7 7-7"}],
  ["path", {"d":"M19 12H5"}],
]);

export const DrumIcon = make([
  ["path", {"d":"m2 2 8 8"}],
  ["path", {"d":"m22 2-8 8"}],
  ["ellipse", {"cx":"12","cy":"9","rx":"10","ry":"5"}],
  ["path", {"d":"M7 13.4v7.9"}],
  ["path", {"d":"M12 14v8"}],
  ["path", {"d":"M17 13.4v7.9"}],
  ["path", {"d":"M2 9v8a10 5 0 0 0 20 0V9"}],
]);

export const EllipsisIcon = make([
  ["circle", {"cx":"12","cy":"12","r":"1"}],
  ["circle", {"cx":"19","cy":"12","r":"1"}],
  ["circle", {"cx":"5","cy":"12","r":"1"}],
]);

export const FlagIcon = make([
  ["path", {"d":"M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"}],
]);

export const GuitarIcon = make([
  ["path", {"d":"m11.9 12.1 4.514-4.514"}],
  ["path", {"d":"M20.1 2.3a1 1 0 0 0-1.4 0l-1.114 1.114A2 2 0 0 0 17 4.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 17.828 7h1.344a2 2 0 0 0 1.414-.586L21.7 5.3a1 1 0 0 0 0-1.4z"}],
  ["path", {"d":"m6 16 2 2"}],
  ["path", {"d":"M8.23 9.85A3 3 0 0 1 11 8a5 5 0 0 1 5 5 3 3 0 0 1-1.85 2.77l-.92.38A2 2 0 0 0 12 18a4 4 0 0 1-4 4 6 6 0 0 1-6-6 4 4 0 0 1 4-4 2 2 0 0 0 1.85-1.23z"}],
]);

export const HeartIcon = make([
  ["path", {"d":"M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"}],
]);

export const Link2Icon = make([
  ["path", {"d":"M9 17H7A5 5 0 0 1 7 7h2"}],
  ["path", {"d":"M15 7h2a5 5 0 1 1 0 10h-2"}],
  ["line", {"x1":"8","x2":"16","y1":"12","y2":"12"}],
]);

export const LoaderIcon = make([
  ["path", {"d":"M21 12a9 9 0 1 1-6.219-8.56"}],
]);

export const MicIcon = make([
  ["path", {"d":"M12 19v3"}],
  ["path", {"d":"M19 10v2a7 7 0 0 1-14 0v-2"}],
  ["rect", {"x":"9","y":"2","width":"6","height":"13","rx":"3"}],
]);

export const MicVocalIcon = make([
  ["path", {"d":"m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12"}],
  ["path", {"d":"M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5"}],
  ["circle", {"cx":"16","cy":"7","r":"5"}],
]);

export const MoonIcon = make([
  ["path", {"d":"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"}],
]);

export const MusicIcon = make([
  ["path", {"d":"M21 16V3a1 1 0 0 0-1.28-.96l-10 2.917a1 1 0 0 0-.72.96V19"}],
  ["circle", {"cx":"18","cy":"16","r":"3"}],
  ["circle", {"cx":"6","cy":"19","r":"3"}],
]);

export const Music2Icon = make([
  ["path", {"d":"m19 6-5.2-3.9a.5.5 0 0 0-.8.4V18"}],
  ["circle", {"cx":"9","cy":"18","r":"4"}],
]);

export const PauseIcon = make([
  ["rect", {"x":"14","y":"3","width":"5","height":"18","rx":"1"}],
  ["rect", {"x":"5","y":"3","width":"5","height":"18","rx":"1"}],
]);

export const PianoIcon = make([
  ["path", {"d":"M10 13v4"}],
  ["path", {"d":"M14 13v4"}],
  ["path", {"d":"M18 13v4"}],
  ["path", {"d":"M2 13h20"}],
  ["path", {"d":"M22 11.5A3.5 3.5 0 0018.5 8a3.52 3.52 0 01-3.173-2A7 7 0 002 9v10a2 2 0 002 2h16a2 2 0 002-2z"}],
  ["path", {"d":"M6 13v4"}],
]);

export const PlayIcon = make([
  ["path", {"d":"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"}],
]);

export const Share2Icon = make([
  ["circle", {"cx":"18","cy":"5","r":"3"}],
  ["circle", {"cx":"6","cy":"12","r":"3"}],
  ["circle", {"cx":"18","cy":"19","r":"3"}],
  ["line", {"x1":"8.59","x2":"15.42","y1":"13.51","y2":"17.49"}],
  ["line", {"x1":"15.41","x2":"8.59","y1":"6.51","y2":"10.49"}],
]);

export const SunIcon = make([
  ["circle", {"cx":"12","cy":"12","r":"4"}],
  ["path", {"d":"M12 2v2"}],
  ["path", {"d":"M12 20v2"}],
  ["path", {"d":"m4.93 4.93 1.41 1.41"}],
  ["path", {"d":"m17.66 17.66 1.41 1.41"}],
  ["path", {"d":"M2 12h2"}],
  ["path", {"d":"M20 12h2"}],
  ["path", {"d":"m6.34 17.66-1.41 1.41"}],
  ["path", {"d":"m19.07 4.93-1.41 1.41"}],
]);

export const XIcon = make([
  ["path", {"d":"M18 6 6 18"}],
  ["path", {"d":"m6 6 12 12"}],
]);

