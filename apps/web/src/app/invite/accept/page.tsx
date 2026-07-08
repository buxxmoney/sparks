"use client";

import { AuthShell } from "@/components/AuthShell";
import { client } from "@/lib/client";
import { signOut } from "@/lib/api";
import { setSelectedOrganization } from "@/lib/useOrganizationContext";
import { useSession } from "@/lib/useSession";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function AcceptInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const { session, loading: sessionLoading } = useSession();

  const [error, setError] = useState("");
  const [accepting, setAccepting] = useState(false);

  const accept = async () => {
    setAccepting(true);
    setError("");
    try {
      const result = await client.siteInvites.accept({ token });
      // Select the org the invite belongs to, then land on the site.
      setSelectedOrganization(result.organizationId);
      router.push(`/sites/${result.siteId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept invitation");
      setAccepting(false);
    }
  };

  if (!token) {
    return <Banner status="error" title="This invitation link is missing its token." />;
  }

  if (sessionLoading) {
    return <Text type="supporting">Loading…</Text>;
  }

  // Must be signed in as the invited email to accept.
  if (!session?.user) {
    const next = encodeURIComponent(`/invite/accept?token=${token}`);
    return (
      <Stack gap={4}>
        <Text>Sign in (or create your account) to accept this site invitation.</Text>
        <Stack direction="horizontal" gap={3}>
          <Button label="Sign in" variant="primary" href={`/auth/login?next=${next}`} />
          <Button label="Create account" variant="secondary" href={`/auth/signup?next=${next}`} />
        </Stack>
      </Stack>
    );
  }

  // Invitations are tied to a specific email. If the person is signed in as a
  // different account, accepting fails server-side ("sent to a different email").
  // Let them switch accounts here instead of getting stuck (the "mix up").
  const switchAccount = async () => {
    await signOut();
    const next = encodeURIComponent(`/invite/accept?token=${token}`);
    window.location.href = `/auth/login?next=${next}`;
  };

  return (
    <Stack gap={4}>
      <Text>
        You&apos;re signed in as <strong>{session.user.email}</strong>. Accept this invitation to
        get access to the site.
      </Text>
      {error ? <Banner status="error" title={error} /> : null}
      <Stack direction="horizontal" gap={3}>
        <Button
          label={accepting ? "Accepting…" : "Accept invitation"}
          variant="primary"
          isLoading={accepting}
          onClick={accept}
        />
        <Link href="/dashboard">Not now</Link>
      </Stack>
      <Text type="supporting" size="sm">
        Invited on a different email?{" "}
        <button
          type="button"
          onClick={switchAccount}
          style={{
            border: "none",
            background: "none",
            padding: 0,
            color: "hsl(221 83% 53%)",
            cursor: "pointer",
            textDecoration: "underline",
            font: "inherit",
          }}
        >
          Sign in with a different account
        </button>
      </Text>
    </Stack>
  );
}

export default function AcceptInvitePage() {
  return (
    <AuthShell title="Site invitation" subtitle="Accept access to a Sparks site">
      <Suspense fallback={<Text type="supporting">Loading…</Text>}>
        <AcceptInner />
      </Suspense>
    </AuthShell>
  );
}
