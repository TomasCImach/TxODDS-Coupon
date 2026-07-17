import type { Metadata } from "next";
import { DemoConsole } from "../../components/demo-console";
import { resolveDemoCampaign } from "../../lib/demo-config";

export const metadata: Metadata = {
  title: "Demo Match Mode",
  description:
    "Trigger a synthetic goal through the real GoalDrop Devnet economic path.",
};
export default function DemoPage() {
  return (
    <DemoConsole
      campaign={resolveDemoCampaign(
        process.env.NEXT_PUBLIC_DEMO_CAMPAIGN,
        process.env.DEMO_CAMPAIGN,
      )}
    />
  );
}
