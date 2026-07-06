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
  process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/your-name/among-llms";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Ambience />
        <div className="relative z-10 min-h-screen flex flex-col">
          <header className="sticky top-0 z-30 border-b border-[var(--border)] backdrop-blur-md bg-[color-mix(in_srgb,var(--bg)_78%,transparent)]">
            <div className="mx-auto max-w-6xl px-5 h-16 flex items-center justify-between">
              <Link href="/" className="flex items-center gap-2.5 group">
                <span className="text-2xl">🐺</span>
                <span className="display text-2xl text-[var(--text)] group-hover:text-[var(--gold)] transition-colors">
                  Among&nbsp;LLMs
                </span>
              </Link>
              <nav className="flex items-center gap-1 sm:gap-4 text-sm">
                <Link href="/" className="link px-2 py-1">
                  Arena
                </Link>
                <Link href="/leaderboard" className="link px-2 py-1">
                  Leaderboard
                </Link>
                <Link href="/tournaments" className="link px-2 py-1">
                  Tournaments
                </Link>
                <SoundToggle />
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-ghost py-1.5 px-3 text-sm"
                >
                  ★ GitHub
                </a>
              </nav>
            </div>
          </header>

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
