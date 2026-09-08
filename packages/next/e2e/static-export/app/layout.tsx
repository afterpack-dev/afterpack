import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AfterPack Next.js static-export fixture",
  description: "AfterPack framework-integration smoke fixture (output: export)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
