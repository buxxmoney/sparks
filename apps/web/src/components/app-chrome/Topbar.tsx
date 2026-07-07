"use client";

import { useRouter } from "next/navigation";
import { Building2, LogOut, User as UserIcon } from "lucide-react";
import { TopNav } from "@astryxdesign/core/TopNav";
import { MobileNavToggle } from "@astryxdesign/core/MobileNav";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Heading } from "@astryxdesign/core/Heading";
import { Badge } from "@astryxdesign/core/Badge";
import { useSession } from "@/lib/useSession";
import { useRPC } from "@/lib/useRPC";
import { useOrganization } from "@/lib/useOrganization";
import { client } from "@/lib/client";
import { signOut } from "@/lib/api";

export function Topbar({ title }: { title: string }) {
  const router = useRouter();
  const { session } = useSession();
  const { organizationId } = useOrganization();
  const { data: memberships } = useRPC(() => client.session.listMemberships(), []);

  const org = memberships?.find((m) => m.organizationId === organizationId);
  const email = session?.user?.email ?? "";

  const handleSignOut = async () => {
    await signOut();
    router.push("/auth/login");
  };

  return (
    <TopNav
      label="Top bar"
      heading={
        <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <MobileNavToggle />
          <Heading level={4}>{title}</Heading>
        </span>
      }
      endContent={
        <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Badge icon={<Building2 size={14} />} label={org?.organizationName ?? "Organization"} />
          <DropdownMenu
            button={{ label: email || "Account", variant: "ghost" }}
            items={[
              {
                type: "section",
                title: session?.user?.name ?? "Signed in",
                items: [{ label: "Account settings", icon: UserIcon, isDisabled: true }],
              },
              { type: "divider" },
              { label: "Sign out", icon: LogOut, onClick: handleSignOut },
            ]}
          />
        </span>
      }
    />
  );
}
