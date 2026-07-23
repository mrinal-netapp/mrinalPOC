import type { ReactElement } from "react";
import {
  IconEye,
  IconUser,
  IconUsers,
  IconUserShield,
} from "@tabler/icons-react";

import { Card } from "@/ui-lib/base-components/card/card";
import { CardContentLayout } from "@/ui-lib/base-components/card/card.content-layout";
import { CardBlock, CardBlockMetric } from "@/ui-lib/base-components/card/card.block";
import { ADMINISTRATION_MEMBERS_STRINGS } from "./administration-members.consts";
import type { MemberRoleSummary } from "./administration-members.utils";

interface AdministrationMembersSummaryProps {
  summary: MemberRoleSummary;
}

const SUMMARY_CARDS = [
  {
    key: "total",
    subtitle: ADMINISTRATION_MEMBERS_STRINGS.SUMMARY_TOTAL,
    icon: IconUsers,
  },
  {
    key: "admins",
    subtitle: ADMINISTRATION_MEMBERS_STRINGS.SUMMARY_ADMINS,
    icon: IconUserShield,
  },
  {
    key: "members",
    subtitle: ADMINISTRATION_MEMBERS_STRINGS.SUMMARY_MEMBERS,
    icon: IconUser,
  },
  {
    key: "viewers",
    subtitle: ADMINISTRATION_MEMBERS_STRINGS.SUMMARY_VIEWERS,
    icon: IconEye,
  },
] as const;

function AdministrationMembersSummary({
  summary,
}: AdministrationMembersSummaryProps): ReactElement {
  return (
    <Card className="administration-members-summary">
      <CardContentLayout columns={4}>
        {SUMMARY_CARDS.map(({ key, subtitle, icon: Icon }, index) => (
          <CardBlock
            key={key}
            type="metric"
            hasSideSeparator={index < SUMMARY_CARDS.length - 1}
          >
            <CardBlockMetric
              value={String(summary[key])}
              subtitle={subtitle}
              icon={<Icon aria-hidden />}
              orientation="horizontal"
              valueSize="fs20"
            />
          </CardBlock>
        ))}
      </CardContentLayout>
    </Card>
  );
}

export { AdministrationMembersSummary };
