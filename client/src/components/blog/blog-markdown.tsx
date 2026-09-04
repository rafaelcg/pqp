import { Children, isValidElement, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { BlogMedia } from "@/components/blog/blog-media";

export function isBlogMediaElement(node: ReactNode): boolean {
  return isValidElement(node) && node.type === BlogMedia;
}

export const blogMediaMarkdown: Pick<Components, "img" | "p"> = {
  img: ({ src, alt, title }) => {
    if (!src) {
      return null;
    }
    return (
      <BlogMedia src={src} alt={alt ?? ""} caption={title || undefined} />
    );
  },
  p: ({ children }) => {
    const items = Children.toArray(children).filter((child) =>
      typeof child === "string" ? child.trim().length > 0 : true,
    );
    if (items.length === 1 && isBlogMediaElement(items[0])) {
      return items[0];
    }
    return <p>{children}</p>;
  },
};
