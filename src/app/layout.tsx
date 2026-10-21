import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vaanijya — agentic commerce",
  description:
    "An Indian e-commerce platform where an agent shops in your language, prevents failed deliveries, and adjudicates complaints against a rule engine a person approves.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Fraunces for display (variable optical sizing), Inter for UI —
            Inter carries Devanagari/Kannada/Tamil coverage, so a complaint
            renders in its own script beside the English translation. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;450;500;550;600;650&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
