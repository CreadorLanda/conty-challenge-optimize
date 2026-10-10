import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type ReachRow = { creator_id: string; reach: number };
type DeliveryRow = { creator_id: string; n: number };

const REACH_SQL = `
SELECT sa.creator_id AS creator_id, SUM(latest.views) AS reach
  FROM social_accounts sa
  JOIN (
    SELECT account_id, views
      FROM (
        SELECT account_id,
               views,
               ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY captured_at DESC, id DESC) AS rn
          FROM metrics
      )
     WHERE rn = 1
  ) latest ON latest.account_id = sa.id
 GROUP BY sa.creator_id
`;

const DELIVERIES_SQL = `
SELECT creator_id, COUNT(*) AS n
  FROM deliveries
 WHERE delivered_at >= ?
 GROUP BY creator_id
`;

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT niches_json FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  const campaignNiches = new Set(JSON.parse(campaign.niches_json) as string[]);

  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const reachRows = await all<ReachRow>(db, REACH_SQL);
  const deliveryRows = await all<DeliveryRow>(db, DELIVERIES_SQL, deliveriesSince());

  const reachByCreator = new Map<string, number>();
  for (const row of reachRows) reachByCreator.set(row.creator_id, Number(row.reach));

  const deliveriesByCreator = new Map<string, number>();
  for (const row of deliveryRows) deliveriesByCreator.set(row.creator_id, Number(row.n));

  const scored: CreatorMatch[] = [];
  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const niche of creatorNiches) {
      if (campaignNiches.has(niche)) nicheScore += 1;
    }
    if (nicheScore === 0) continue;

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: reachByCreator.get(creator.id) ?? 0,
      deliveries_90d: deliveriesByCreator.get(creator.id) ?? 0,
    });
  }

  scored.sort(compareCreators);
  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: scored.slice(input.offset, input.offset + input.limit),
  };
}
