import type { ReactNode } from "react";

import { Dialog } from "./Dialog.tsx";

interface InfoDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * About / readme. The curator's first-person voice + social icons.
 * Tight enough to fit a 700-px viewport without internal scroll.
 */
export function InfoDialog({ open, onClose }: InfoDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} ariaLabel="About Pavoia">
      <div className="flex flex-col gap-3">
        {/* Logo hero */}
        <div className="text-center">
          <img
            src="/pavoia-logo.gif"
            alt="Pavoia"
            className="mx-auto h-14 w-auto md:h-16"
            style={{
              filter: "drop-shadow(0 0 18px rgba(232,80,32,0.25))",
            }}
          />
        </div>

        {/* Curator's note — single tight paragraph */}
        <p className="font-sans text-sm leading-relaxed text-[var(--color-text-soft)]">
          Hey, I'm{" "}
          <strong className="text-[var(--color-text)]">gaende</strong>.
          I listen to new music every day — full albums, front to
          back, every genre. Six years of that is what fed this whole
          database. Every track I fall for, I picture which stage of{" "}
          <strong className="text-[var(--color-text)]">Pâvoia</strong>{" "}
          it belongs to. The{" "}
          <strong className="text-[var(--color-text)]">eleven
          stages</strong>{" "}
          here are what grew out of that — pick one, the rest of the
          night carries on around you.
        </p>

        {/* Socials — pâvoia + the curator, side-by-side groups */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">
              <span className="text-[var(--color-accent-dim)]">//</span>{" "}
              follow pâvoia
            </p>
            <div className="flex gap-2">
              <SocialIconButton
                href="https://instagram.com/wearepavoia"
                label="Instagram @wearepavoia"
                icon={<InstagramIcon />}
              />
              <SocialIconButton
                href="https://soundcloud.com/pavoia"
                label="SoundCloud @pavoia"
                icon={<SoundcloudIcon />}
              />
              <SocialIconButton
                href="https://pavoia.com"
                label="pavoia.com"
                icon={<GlobeIcon />}
              />
            </div>
          </div>

          <div>
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">
              <span className="text-[var(--color-accent-dim)]">//</span>{" "}
              follow gaende
            </p>
            <div className="flex gap-2">
              <SocialIconButton
                href="https://instagram.com/gaende_music"
                label="Instagram @gaende_music"
                icon={<InstagramIcon />}
              />
              <SocialIconButton
                href="https://soundcloud.com/gaende"
                label="SoundCloud @gaende"
                icon={<SoundcloudIcon />}
              />
              <SocialIconButton
                href="https://open.spotify.com/user/gaende"
                label="Spotify @gaende"
                icon={<SpotifyIcon />}
              />
            </div>
          </div>
        </div>

        {/* Close */}
        <div className="flex items-center justify-between border-t border-[var(--color-card-border)] pt-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
            made with{" "}
            <span className="text-[var(--color-accent)]">♥</span> by gaende ·
            2026
          </span>
          <button
            type="button"
            onClick={onClose}
            className="border border-[var(--color-card-border-strong)] px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40"
          >
            close
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function SocialIconButton({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="flex size-10 items-center justify-center rounded-sm border border-[var(--color-card-border)] bg-[var(--color-bg-soft)] text-[var(--color-text-soft)] transition-colors hover:border-[var(--color-accent-dim)] hover:bg-[rgba(232,80,32,0.06)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40"
    >
      {icon}
    </a>
  );
}

function InstagramIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SoundcloudIcon() {
  return (
    <svg
      width="20"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 14v3" />
      <path d="M5 12v5" />
      <path d="M8 10v7" />
      <path d="M11 9v8" />
      <path d="M14 9c0-2.5 2-4.5 4.5-4.5S23 6.5 23 9" />
      <path d="M14 17h6c1.7 0 3-1.3 3-3s-1.3-3-3-3" />
    </svg>
  );
}

function SpotifyIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M7 9c3-1 8.5-1 11.5 1" />
      <path d="M7.5 13c2.5-.8 6.8-.7 9.5 1" />
      <path d="M8.5 16.5c2-.6 5-.5 7 .7" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2c2.5 3 4 6.5 4 10s-1.5 7-4 10" />
      <path d="M12 2c-2.5 3-4 6.5-4 10s1.5 7 4 10" />
    </svg>
  );
}
