import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AfterPack Next.js fixture",
  description: "AfterPack framework-integration smoke fixture",
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
