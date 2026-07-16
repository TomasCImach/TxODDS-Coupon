import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { AppProviders } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "GoalDrop — Every goal is a race",
    template: "%s · GoalDrop",
  },
  description:
    "Gasless, first-come fan reward drops triggered by football goals on Solana Devnet.",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_WEB_ORIGIN ?? "http://localhost:3000",
  ),
  openGraph: {
    title: "GoalDrop",
    description: "Every goal is a race.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#07110e",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AppProviders>
          <header className="site-header">
            <Link className="brand" href="/" aria-label="GoalDrop home">
              <span>GOAL</span>
              <b>DROP</b>
            </Link>
            <nav aria-label="Primary navigation">
              <Link href="/">Matches</Link>
              <Link href="/demo">Demo Mode</Link>
              <Link href="/sponsor">For sponsors</Link>
            </nav>
            <span className="network-pill">
              <i aria-hidden="true" /> Solana Devnet
            </span>
          </header>
          <main>{children}</main>
          <footer className="site-footer">
            <div>
              <span className="brand mini">
                <span>GOAL</span>
                <b>DROP</b>
              </span>
              <p>Football energy. Verifiable rewards.</p>
            </div>
            <div>
              <p>Devnet MVP · Rewards are promotional tokens, not wagers.</p>
              <p>
                Powered by TxLINE match data and Solana. ·{" "}
                <Link href="/privacy">Privacy</Link>
              </p>
            </div>
          </footer>
        </AppProviders>
      </body>
    </html>
  );
}
