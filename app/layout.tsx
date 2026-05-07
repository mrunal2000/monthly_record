import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Paper Rectangle Accordion",
  description: "A Paper-inspired interactive rectangle accordion built with canvas.",
  icons: {
    icon: "/favicon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="paper" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
