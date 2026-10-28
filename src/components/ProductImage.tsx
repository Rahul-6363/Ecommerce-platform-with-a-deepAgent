"use client";

import { useState } from "react";

/**
 * A product photograph, with the emoji as a real fallback.
 *
 * One component rather than an `<img>` in four places, because the fallback is
 * the part worth getting right and it has to behave the same everywhere. A
 * card whose photo is missing must show the emoji on its accent tint — the way
 * the whole catalogue looked before photographs existed — rather than a broken
 * image icon, which is the one outcome that makes a storefront look abandoned.
 *
 * Three cases it handles, and they are all reachable:
 *
 *  - **No `src` at all.** A product seeded before photographs existed, or one
 *    added without one. Renders the emoji, no network request.
 *  - **A `src` that fails.** The file was deleted, or the path is wrong.
 *    `onError` swaps to the emoji once; React will not retry it.
 *  - **A `src` that loads.** The common case.
 *
 * The photographs ship in `public/products/<sku>.jpg` rather than being
 * hotlinked from an image CDN. Six of the original URLs 404'd during the
 * import — hotlinking would have shipped that failure to a buyer instead of
 * to the person running the import.
 */
export default function ProductImage({
  src,
  emoji,
  alt,
  accent = "#3d4a9e",
  /** `card` for a grid tile, `hero` for a detail page, `thumb` for a list row. */
  size = "card",
  className = "",
  priority = false,
}: {
  src?: string;
  emoji?: string;
  alt: string;
  accent?: string;
  size?: "card" | "hero" | "thumb";
  className?: string;
  /** Skip lazy loading for images above the fold. */
  priority?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const showPhoto = Boolean(src) && !failed;

  return (
    <div
      className={`pimg pimg-${size} ${className}`}
      // The tint is always painted, so a photograph that is still loading
      // shows the product's own colour rather than a flash of white.
      style={{ background: `${accent}14` }}
    >
      {showPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element -- these are
        // local files of known dimensions; next/image adds an optimiser round
        // trip and a config surface for no benefit at this size.
        <img
          src={src}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          width={600}
          height={450}
          onError={() => setFailed(true)}
        />
      ) : (
        // `aria-hidden` because the alt text above already named the product;
        // a screen reader announcing "package emoji" adds nothing.
        <span className="pimg-emoji" aria-hidden>
          {emoji || "📦"}
        </span>
      )}
    </div>
  );
}
