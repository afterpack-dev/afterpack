import { GuestbookForm } from "./GuestbookForm";
import { SubscribeForm } from "./SubscribeForm";

export default function Guestbook() {
  return (
    <main>
      <h1 data-testid="title">Guestbook</h1>
      <GuestbookForm />
      <h2>Newsletter</h2>
      <SubscribeForm />
    </main>
  );
}
