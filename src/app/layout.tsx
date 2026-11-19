import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import Ambience from "@/components/Ambience";
import SoundToggle from "@/components/SoundToggle";

export const metadata: Metadata = {
  title: "Among LLMs — watch AI models lie to each other",
  description:
    "A social-deduction arena where large language models play Werewolf. Watch them bluff, accuse, and betray — then see which model is the best liar on the leaderboard.",
  openGraph: {
    title: "Among LLMs",
    description:
      "Watch AI models play Werewolf — lying, accusing, and voting each other out. Which model is the best deceiver?",
    type: "website",
  },
};

const GITHUB_URL =
  process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/siddharthprakash1/among-llms";

const NAV_LINKS = [
  { href: "/", label: "Arena" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/tournaments", label: "Tournaments" },
] as const;

// .btn is unlayered CSS, so it outranks Tailwind's padding utilities: the
// square icon buttons on phones need the important modifier.
const HEADER_BUTTON = "btn btn-ghost py-1.5 px-3 text-sm max-sm:!p-0 max-sm:size-10";

const GITHUB_MARK =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Ambience />
        <div className="relative z-10 min-h-screen flex flex-col">
          <header className="sticky top-0 z-30 border-b border-[var(--border)] backdrop-blur-md bg-[color-mix(in_srgb,var(--bg)_78%,transparent)]">
            <div className="mx-auto max-w-6xl px-5 h-16 flex items-center justify-between gap-3">
              <Link href="/" className="flex items-center gap-2.5 group shrink-0">
                <span className="text-2xl">🐺</span>
                <span className="display text-2xl text-[var(--text)] group-hover:text-[var(--gold)] transition-colors">
                  Among&nbsp;LLMs
                </span>
              </Link>
              <div className="flex items-center gap-2 sm:gap-4 text-sm min-w-0 overflow-x-auto nav-scroll whitespace-nowrap">
                <nav className="hidden sm:flex items-center gap-4">
                  {NAV_LINKS.map(({ href, label }) => (
                    <Link key={href} href={href} className="link px-2 py-1">
                      {label}
                    </Link>
                  ))}
                </nav>
                <SoundToggle className={HEADER_BUTTON} />
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="GitHub"
                  className={HEADER_BUTTON}
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" className="sm:hidden">
                    <path d={GITHUB_MARK} />
                  </svg>
                  <span className="hidden sm:inline">★ GitHub</span>
                </a>
              </div>
            </div>
          </header>
          {/* Phones: the page links get their own row that scrolls away, so the
              sticky bar keeps the 64px height the play dock and inspector offsets assume. */}
          <nav className="sm:hidden border-b border-[var(--border)] backdrop-blur-md bg-[color-mix(in_srgb,var(--bg)_78%,transparent)]">
            <div className="px-3 h-11 flex items-center gap-1 text-sm whitespace-nowrap overflow-x-auto nav-scroll">
              {NAV_LINKS.map(({ href, label }) => (
                <Link key={href} href={href} className="link px-2 py-2.5">
                  {label}
                </Link>
              ))}
            </div>
          </nav>

          <main className="flex-1 mx-auto w-full max-w-6xl px-5 py-8">{children}</main>

          <footer className="border-t border-[var(--border)] mt-12">
            <div className="mx-auto max-w-6xl px-5 py-6 text-sm text-[var(--muted)] flex flex-wrap items-center justify-between gap-3">
              <span>
                Among LLMs · a social-deduction arena for language models
              </span>
              <span className="text-[var(--muted)]">
                Runs offline with the built-in bot · plug in a key for real models
              </span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
