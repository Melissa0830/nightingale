import AppShell from "@/components/AppShell";

// Server Component: no browser APIs needed here. All auth-check/redirect
// logic lives inside AppShell (a Client Component), keeping this route's
// own boundary minimal per the client/server-boundary rule.
export default function Home() {
  return (
    <AppShell>
      <h1>Welcome to Nightingale</h1>
      <p>Patient workspace will be available in the next block.</p>
    </AppShell>
  );
}
