export const metadata = {
  title: "AfterPack CLI Next.js fixture",
  description: "AfterPack framework-integration smoke fixture (CLI over .next/static/chunks)",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
