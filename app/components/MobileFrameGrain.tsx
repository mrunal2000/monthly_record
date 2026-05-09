"use client";

import { GrainGradient } from "@paper-design/shaders-react";
import { useSyncExternalStore } from "react";
import { resolveCategoryHexForGrain, type FrameGrainTheme } from "../lib/frameGrainCategoryHex";
import { mobileFrameGrainPalette } from "../lib/mobileFrameGrainPalette";

function subscribeReducedMotion(cb: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function reducedMotionSnapshot() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function reducedMotionServer() {
  return false;
}

type Props = {
  theme: FrameGrainTheme;
  categoryId: string;
};

/**
 * Paper file AZ-0 — ShaderGrainGradient / GrainGradient (corners, grain, motion).
 * Colors come from theme + category slot hex (CSS vars cannot be passed to WebGL).
 */
export default function MobileFrameGrain({ theme, categoryId }: Props) {
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    reducedMotionSnapshot,
    reducedMotionServer,
  );

  const { frame, text } = resolveCategoryHexForGrain(theme, categoryId);
  const { colors, colorBack, baseHex } = mobileFrameGrainPalette(theme, frame, text);

  const motion = reducedMotion ? 0 : theme === "minimal" ? 0.55 : theme === "paper" ? 1.25 : 1.35;

  const sizing =
    theme === "minimal"
      ? { scale: 2.5, rotation: 52, offsetX: 0, offsetY: 0.1, softness: 0.82, intensity: 0.48, noise: 0.72 }
      : theme === "paper"
        ? {
            scale: 4,
            rotation: 68,
            offsetX: 0,
            offsetY: 0.14,
            softness: 0.69,
            intensity: 0.93,
            noise: 1,
          }
        : { scale: 4, rotation: 68, offsetX: 0, offsetY: 0.14, softness: 0.58, intensity: 0.88, noise: 0.95 };

  return (
    <GrainGradient
      shape="corners"
      speed={motion}
      frame={0}
      colors={colors}
      colorBack={colorBack}
      fit="cover"
      {...sizing}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        minHeight: "var(--accordion-mobile-collapsed-strip-min)",
        backgroundColor: baseHex,
      }}
    />
  );
}
