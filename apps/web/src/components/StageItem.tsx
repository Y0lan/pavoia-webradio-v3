import { Link } from "@tanstack/react-router";
import type { Stage } from "@pavoia/shared";

interface StageItemProps {
  stage: Stage;
  isActive: boolean;
}

/**
 * A single stage row in the sidebar. v1's pattern, modernized:
 *   - left accent border in the stage's own color
 *   - active state fills the row with a subtle accent tint
 *   - disabled stages (Bus) render but don't navigate
 *
 * Hover preview popover is deferred to Slice F.
 */
export function StageItem({ stage, isActive }: StageItemProps) {
  const accent = stage.accent;
  const baseClasses =
    "group block rounded-lg border-l-4 bg-slate-900/40 px-4 py-3 transition-all hover:bg-slate-800/60";
  const activeClasses = isActive
    ? "ring-1 ring-inset"
    : "";

  if (stage.disabled) {
    // Bus is a UI-only easter egg — interactive but not navigable.
    // Slice F will wire up the BusMysteryCard dialog. For now,
    // render visually but disable navigation to /stage/:id.
    return (
      <div
        role="button"
        aria-disabled="true"
        className={`${baseClasses} ${activeClasses} cursor-default opacity-60`}
        style={{
          borderLeftColor: accent,
        }}
      >
        <Inner stage={stage} />
      </div>
    );
  }

  return (
    <Link
      to="/stage/$stageId"
      params={{ stageId: stage.id }}
      aria-current={isActive ? "page" : undefined}
      className={`${baseClasses} ${activeClasses}`}
      style={{
        borderLeftColor: accent,
        ...(isActive
          ? {
              backgroundColor: `${accent}1a`, // 10% alpha
              boxShadow: `inset 0 0 0 1px ${accent}40`, // 25% alpha
            }
          : {}),
      }}
    >
      <Inner stage={stage} />
    </Link>
  );
}

function Inner({ stage }: { stage: Stage }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-2xl leading-none">{stage.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-slate-100">
          {stage.fallbackTitle}
        </div>
        <div className="mt-0.5 line-clamp-2 text-xs text-slate-400">
          {stage.fallbackDescription}
        </div>
      </div>
    </div>
  );
}
